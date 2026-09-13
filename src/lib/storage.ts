import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { waitUntil } from '@vercel/functions';
import { randomBytes } from 'node:crypto';
import { env } from '../config/env.js';
import { AppError, badRequest } from './errors.js';
import { logger } from './logger.js';

/**
 * S3-compatible object storage (Sumopod / Cloudeka). Two prefixes:
 * - `public/…`  listing images, logos, site assets — readable anonymously via a bucket policy
 * - `private/…` payment proofs — only readable through the API
 * Browsers upload straight to the bucket with presigned PUT URLs (bucket CORS allows PUT), so the
 * 4.5 MB function body limit never applies. After the upload the client records the key and the API
 * verifies the object (size, content type) with a HEAD request before trusting it.
 */
export const IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const PROOF_CONTENT_TYPES = [...IMAGE_CONTENT_TYPES, 'application/pdf'];
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const PRESIGN_TTL_SECONDS = 5 * 60;

let client: S3Client | null = null;

function s3(): S3Client {
  if (!env.S3_ENDPOINT || !env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
    throw new AppError(503, 'STORAGE_NOT_CONFIGURED', 'Object storage is not configured on this environment');
  }
  if (!client) {
    client = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
    });
  }
  return client;
}

export const storageConfigured = () => Boolean(env.S3_ENDPOINT && env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY);

/** Public URL for a `public/…` key. Override with S3_PUBLIC_BASE_URL when a CDN sits in front of the bucket. */
export function publicUrl(key: string): string {
  const base = env.S3_PUBLIC_BASE_URL ?? `${env.S3_ENDPOINT}/${env.S3_BUCKET}`;
  return `${base.replace(/\/$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

export const isPublicKey = (key: string) => key.startsWith('public/');

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

/** `public/tenants/{id}/listings/{listingId}/{random}.jpg` — never trusts the client-provided filename. */
export function buildKey(scope: 'public' | 'private', parts: string[], contentType: string): string {
  const ext = EXT[contentType] ?? 'bin';
  const safe = parts.map((p) => p.replace(/[^a-zA-Z0-9_-]/g, ''));
  return `${scope}/${safe.join('/')}/${Date.now().toString(36)}-${randomBytes(6).toString('hex')}.${ext}`;
}

export function assertUpload(contentType: string, size: number, allowed: string[]) {
  if (!allowed.includes(contentType)) throw badRequest(`Unsupported file type ${contentType}`, 'UNSUPPORTED_TYPE');
  if (size <= 0 || size > MAX_UPLOAD_BYTES) throw badRequest(`File must be smaller than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`, 'FILE_TOO_LARGE');
}

/** Presigned PUT the browser uses to upload directly. The content type is part of the signature. */
export async function presignUpload(key: string, contentType: string) {
  const uploadUrl = await getSignedUrl(s3(), new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, ContentType: contentType }), { expiresIn: PRESIGN_TTL_SECONDS });
  return { key, uploadUrl, method: 'PUT' as const, headers: { 'content-type': contentType }, expiresInSeconds: PRESIGN_TTL_SECONDS };
}

/** Confirms an uploaded object exists and is within limits; returns its metadata. */
export async function verifyObject(key: string, allowed: string[]) {
  let head;
  try {
    head = await s3().send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
  } catch {
    throw badRequest('Uploaded file was not found in storage', 'UPLOAD_MISSING');
  }
  const size = head.ContentLength ?? 0;
  const contentType = head.ContentType ?? 'application/octet-stream';
  if (!allowed.includes(contentType) || size > MAX_UPLOAD_BYTES) {
    deleteObjectsLater([key]);
    throw badRequest('Uploaded file is not an allowed type or is too large', 'UPLOAD_REJECTED');
  }
  return { size, contentType };
}

/** Streams an object (used for private payment proofs). */
export async function getObject(key: string) {
  const res = await s3().send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
  return { body: res.Body, contentType: res.ContentType, contentLength: res.ContentLength };
}

/** Best-effort delete after the response has been sent. */
export function deleteObjectsLater(keys: string[]): void {
  if (keys.length === 0 || !storageConfigured()) return;
  // One DeleteObject per key: some S3-compatible stores reject the bulk DeleteObjects call
  // (Cloudeka wants a Content-MD5 header the SDK no longer sends).
  waitUntil(
    Promise.all(
      keys.map((Key) =>
        s3()
          .send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key }))
          .catch((err: unknown) => logger.warn({ err, key: Key }, 'storage delete failed')),
      ),
    ),
  );
}
