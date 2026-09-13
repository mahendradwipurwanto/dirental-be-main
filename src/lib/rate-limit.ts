import { sql } from 'drizzle-orm';
import type { RequestHandler } from 'express';
import { db } from '../db/client.js';
import { rateLimits } from '../db/schema/index.js';
import { tooMany } from './errors.js';

/**
 * Fixed-window counter in Postgres. One UPSERT per check. Windows are keyed by
 * `${scope}:${subject}:${windowIndex}` and expired rows are purged by the daily cron.
 */
export async function consumeRateLimit(scope: string, subject: string, limit: number, windowSeconds: number): Promise<void> {
  const now = Date.now();
  const windowIndex = Math.floor(now / 1000 / windowSeconds);
  const windowStart = new Date(windowIndex * windowSeconds * 1000);
  const expiresAt = new Date(windowStart.getTime() + windowSeconds * 1000 * 2);
  const key = `${scope}:${subject}:${windowIndex}`;

  const rows = await db
    .insert(rateLimits)
    .values({ key, count: 1, windowStart, expiresAt })
    .onConflictDoUpdate({ target: rateLimits.key, set: { count: sql`${rateLimits.count} + 1` } })
    .returning({ count: rateLimits.count });

  const count = rows[0]?.count ?? 0;
  if (count > limit) throw tooMany(`Too many requests. Try again in a few minutes.`);
}

export function clientIp(req: { ip?: string; header: (name: string) => string | undefined }): string {
  const forwarded = req.header('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first || req.ip || 'unknown';
}

/** Express middleware form: limits by client IP (plus an optional body field such as email). */
export const rateLimit =
  (scope: string, limit: number, windowSeconds: number, bodyField?: string): RequestHandler =>
  async (req, _res, next) => {
    try {
      const extra = bodyField ? String((req.body as Record<string, unknown> | undefined)?.[bodyField] ?? '').toLowerCase() : '';
      await consumeRateLimit(scope, `${clientIp(req)}${extra ? ':' + extra : ''}`, limit, windowSeconds);
      next();
    } catch (err) {
      next(err);
    }
  };
