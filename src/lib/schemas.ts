// Side effect: installs `.openapi()` on zod before any schema below is evaluated.
import './openapi.js';
import { z } from 'zod';

export const uuidSchema = z.string().uuid();
export const idParams = z.object({ id: uuidSchema });

export const isoDate = z.date().openapi({ type: 'string', format: 'date-time' });
export const isoDateNullable = isoDate.nullable();

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type Pagination = z.infer<typeof paginationQuery>;

export function paginated<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  });
}

export const okResponse = z.object({ ok: z.literal(true) });
export const OK = { ok: true as const };

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z.string().min(8).max(128);
export const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9]{8,15}$/, 'Phone must be 8–15 digits, optionally starting with +')
  .transform((v) => (v.startsWith('0') ? `+62${v.slice(1)}` : v.startsWith('+') ? v : `+${v}`));

export const moneySchema = z.number().int().min(0).max(1_000_000_000_000);
