import { z } from 'zod';

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim().length > 0 ? v : undefined));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  CRON_SECRET: z.string().min(1),
  WEB_API_KEY: z.string().min(1),
  REVALIDATE_SECRET: z.string().min(1),
  WEB_URL: z.string().url(),
  ADMIN_URL: z.string().url(),
  // S3-compatible object storage (Sumopod / Cloudeka). Optional locally: uploads return 503 until set.
  S3_ENDPOINT: optionalString,
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: optionalString,
  S3_ACCESS_KEY_ID: optionalString,
  S3_SECRET_ACCESS_KEY: optionalString,
  S3_FORCE_PATH_STYLE: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
  /** Optional CDN/base URL for public objects; defaults to `${S3_ENDPOINT}/${S3_BUCKET}`. */
  S3_PUBLIC_BASE_URL: optionalString,
  // SMTP (Sumopod). Optional locally: emails are logged to stdout until set.
  SMTP_HOST: optionalString,
  SMTP_PORT: z.coerce.number().int().positive().default(465),
  SMTP_SECURE: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
  SMTP_USER: optionalString,
  SMTP_PASS: optionalString,
  EMAIL_FROM: z.string().default('Rental Platform <noreply@example.com>'),
  SEED_SUPERADMIN_EMAIL: optionalString,
  SEED_SUPERADMIN_PASSWORD: optionalString,
  VERCEL_ENV: optionalString,
  VERCEL_URL: optionalString,
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
  throw new Error(`Invalid environment configuration:\n  ${issues}`);
}

export const env = {
  ...parsed.data,
  isProd: parsed.data.NODE_ENV === 'production',
  isTest: parsed.data.NODE_ENV === 'test',
  /** Cookies must be Secure whenever we're served over https (any Vercel env). */
  cookieSecure: parsed.data.NODE_ENV === 'production' || Boolean(parsed.data.VERCEL_ENV),
};

export type Env = typeof env;
