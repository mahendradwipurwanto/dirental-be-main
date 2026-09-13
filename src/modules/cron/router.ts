import { and, isNotNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { invitations, passwordResets, rateLimits, refreshTokens } from '../../db/schema/index.js';
import { createRouter } from '../../lib/route.js';
import { requireCronSecret } from '../../middleware/auth.js';
import { expireDueBookings } from '../bookings/service.js';

/**
 * Vercel Cron hits these with `Authorization: Bearer <CRON_SECRET>`. Everything here is idempotent
 * and bounded, because delivery is best-effort and may double-fire.
 */
const { router, route } = createRouter('/v1/internal', { tag: 'Internal', auth: 'cron', middlewares: [requireCronSecret] });

route(
  { method: 'get', path: '/cron/expire-bookings', operationId: 'cronExpireBookings', summary: 'Expire bookings whose payment window elapsed', response: z.object({ expired: z.number().int() }) },
  async () => ({ expired: await expireDueBookings(200) }),
);

route(
  { method: 'get', path: '/cron/purge-tokens', operationId: 'cronPurgeTokens', summary: 'Delete expired refresh tokens, reset tokens, invitations and rate-limit rows', response: z.object({ ok: z.literal(true) }) },
  async () => {
    const now = new Date();
    const monthAgo = new Date(now.getTime() - 30 * 24 * 3_600_000);
    await db.delete(refreshTokens).where(or(lt(refreshTokens.expiresAt, now), and(isNotNull(refreshTokens.revokedAt), lt(refreshTokens.revokedAt, monthAgo))));
    await db.delete(passwordResets).where(lt(passwordResets.expiresAt, monthAgo));
    await db.delete(invitations).where(and(lt(invitations.expiresAt, monthAgo), sql`${invitations.acceptedAt} is null`));
    await db.delete(rateLimits).where(lt(rateLimits.expiresAt, now));
    return { ok: true as const };
  },
);

export const cronRouter = router;
