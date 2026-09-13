import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { listings } from '../../db/schema/index.js';
import { assertUpload, buildKey, presignUpload, PROOF_CONTENT_TYPES } from '../../lib/storage.js';
import { notFound } from '../../lib/errors.js';
import { consumeRateLimit, clientIp } from '../../lib/rate-limit.js';
import { createRouter } from '../../lib/route.js';
import { requireWebKey } from '../../middleware/auth.js';
import { loadPublicTenant } from '../public/router.js';
import { dailyAvailability, availableUnits } from './availability.js';
import * as s from './schemas.js';
import * as svc from './service.js';

const { router, route } = createRouter('/v1/public', { tag: 'Public', auth: 'none', middlewares: [loadPublicTenant] });

const listingSlugParams = z.object({ slug: z.string().min(1).max(60), listingSlug: z.string().min(1).max(80) });

async function activeListingBySlug(tenantId: string, slug: string) {
  const l = await db.query.listings.findFirst({ where: and(eq(listings.tenantId, tenantId), eq(listings.slug, slug), eq(listings.status, 'active')) });
  if (!l) throw notFound('Listing not found', 'LISTING_NOT_FOUND');
  return l;
}

route(
  {
    method: 'get',
    path: '/tenants/:slug/listings/:listingSlug/availability',
    operationId: 'publicAvailability',
    summary: 'Units available for a date range',
    params: listingSlugParams,
    query: s.availabilityQuery,
    response: s.availabilityResponse,
  },
  async (req) => {
    const l = await activeListingBySlug(req.publicTenant!.id, req.valid.params.listingSlug);
    const { start, end, qty } = req.valid.query;
    const available = end > start ? await availableUnits(db, l.id, start, end) : 0;
    return { available, requested: qty, ok: available >= qty };
  },
);

route(
  {
    method: 'get',
    path: '/tenants/:slug/listings/:listingSlug/calendar',
    operationId: 'publicCalendar',
    summary: 'Per-day availability for a month (for greying out the date picker)',
    params: listingSlugParams,
    query: s.calendarQuery,
    response: s.calendarResponse,
  },
  async (req) => {
    const tenant = req.publicTenant!;
    const l = await activeListingBySlug(tenant.id, req.valid.params.listingSlug);
    return dailyAvailability(db, l.id, req.valid.query.month, tenant.timezone);
  },
);

route(
  {
    method: 'post',
    path: '/tenants/:slug/quotes',
    operationId: 'publicQuote',
    summary: 'Price a prospective booking (server-computed; never trust client math)',
    params: z.object({ slug: z.string() }),
    body: s.quoteBody,
    response: s.quoteResponse,
  },
  async (req) => {
    const tenant = req.publicTenant!;
    await consumeRateLimit('quote', clientIp(req), 120, 60);
    const q = await svc.quote(db, tenant, req.valid.body);
    const { listings: _l, ...rest } = q;
    return rest;
  },
);

route(
  {
    method: 'post',
    path: '/tenants/:slug/bookings',
    operationId: 'publicCreateBooking',
    summary: 'Guest checkout: create a booking and start the payment window',
    description: 'Called server-side by rental-web (x-web-key). Returns the one-time access token used in the tracking link.',
    auth: 'webkey',
    params: z.object({ slug: z.string() }),
    body: s.createBookingBody,
    response: s.createBookingResponse,
    status: 201,
    middlewares: [requireWebKey],
  },
  async (req) => {
    const tenant = req.publicTenant!;
    await consumeRateLimit('booking-create', clientIp(req), 10, 600);
    await consumeRateLimit('booking-create-email', req.valid.body.customer.email, 6, 3600);
    const { booking, accessToken } = await svc.createBooking(tenant, req.valid.body, { actor: 'customer' });
    return { code: booking.code, accessToken, expiresAt: booking.expiresAt, total: booking.total };
  },
);

route(
  {
    method: 'get',
    path: '/tenants/:slug/bookings/:code',
    operationId: 'publicGetBooking',
    summary: 'Booking status page data (requires the access token)',
    params: s.bookingCodeParams,
    query: s.bookingTokenQuery,
    response: s.publicBookingSchema,
  },
  async (req) => {
    const tenant = req.publicTenant!;
    const b = await svc.getBookingByCode(tenant, req.valid.params.code, req.valid.query.token);
    return svc.toPublicBookingDto(b, tenant);
  },
);

route(
  {
    method: 'post',
    path: '/tenants/:slug/bookings/:code/proof-presign',
    operationId: 'publicProofPresign',
    summary: 'Presigned PUT URL for a payment proof (private storage)',
    description: 'Upload with `PUT uploadUrl` and the returned headers, then call `POST …/proof` with the `key`.',
    params: s.bookingCodeParams,
    body: s.proofPresignBody,
    response: s.proofPresignResponse,
  },
  async (req) => {
    const tenant = req.publicTenant!;
    const { token, contentType, size } = req.valid.body;
    const b = await svc.getBookingByCode(tenant, req.valid.params.code, token);
    if (!['pending_payment', 'rejected', 'awaiting_verification'].includes(b.status)) throw notFound('Booking no longer accepts proofs', 'PROOF_NOT_ACCEPTED');
    assertUpload(contentType, size, PROOF_CONTENT_TYPES);
    await consumeRateLimit('proof-presign', b.id, 10, 3600);
    const key = buildKey('private', ['tenants', tenant.id, 'proofs', b.id], contentType);
    return presignUpload(key, contentType);
  },
);

route(
  {
    method: 'post',
    path: '/tenants/:slug/bookings/:code/proof',
    operationId: 'publicSubmitProof',
    summary: 'Record an uploaded payment proof and move the booking to awaiting verification',
    auth: 'webkey',
    params: s.bookingCodeParams,
    body: s.submitProofBody,
    response: s.publicBookingSchema,
    middlewares: [requireWebKey],
  },
  async (req) => {
    const tenant = req.publicTenant!;
    const { token, ...input } = req.valid.body;
    const b = await svc.getBookingByCode(tenant, req.valid.params.code, token);
    await svc.submitProof(tenant, b, input);
    const fresh = await svc.getBookingByCode(tenant, req.valid.params.code, token);
    return svc.toPublicBookingDto(fresh, tenant);
  },
);

route(
  {
    method: 'post',
    path: '/tenants/:slug/bookings/:code/cancel',
    operationId: 'publicCancelBooking',
    summary: 'Customer cancels (allowed before payment, or before the cancellation deadline once confirmed)',
    auth: 'webkey',
    params: s.bookingCodeParams,
    body: s.cancelBookingBody,
    response: s.publicBookingSchema,
    middlewares: [requireWebKey],
  },
  async (req) => {
    const tenant = req.publicTenant!;
    const b = await svc.getBookingByCode(tenant, req.valid.params.code, req.valid.body.token);
    await svc.customerCancel(tenant, b, req.valid.body.reason);
    const fresh = await svc.getBookingByCode(tenant, req.valid.params.code, req.valid.body.token);
    return svc.toPublicBookingDto(fresh, tenant);
  },
);

export const publicBookingsRouter = router;
