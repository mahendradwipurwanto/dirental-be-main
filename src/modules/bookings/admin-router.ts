import { and, eq } from 'drizzle-orm';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { availabilityBlocks, bookings, listings, paymentProofs, type BookingActor } from '../../db/schema/index.js';
import { audit } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';
import { getObject } from '../../lib/storage.js';
import { clientIp } from '../../lib/rate-limit.js';
import { revalidateListings } from '../../lib/revalidate.js';
import { createRouter } from '../../lib/route.js';
import { idParams, OK, okResponse } from '../../lib/schemas.js';
import { requireAuth, requireTrustedOrigin } from '../../middleware/auth.js';
import { authOf, resolveTenant, tenantOf } from '../../middleware/tenant.js';
import { getListing } from '../listings/service.js';
import * as s from './schemas.js';
import * as svc from './service.js';

const { router, route } = createRouter('/v1/admin', {
  tag: 'Admin',
  auth: 'cookie',
  middlewares: [requireTrustedOrigin, requireAuth, resolveTenant],
});

const actorRole = (req: Parameters<typeof authOf>[0] & { tenant?: { memberRole: string } }): BookingActor => {
  const role = req.tenant?.memberRole;
  return role === 'superadmin' ? 'superadmin' : role === 'owner' ? 'owner' : 'staff';
};

route({ method: 'get', path: '/dashboard/stats', operationId: 'adminDashboardStats', summary: 'KPIs and setup checklist for the overview page', response: s.dashboardStatsResponse }, async (req) =>
  svc.dashboardStats(tenantOf(req)),
);

route({ method: 'get', path: '/bookings', operationId: 'adminListBookings', summary: 'List bookings', query: s.listBookingsQuery, response: s.listBookingsResponse }, async (req) =>
  svc.listBookings(tenantOf(req).id, req.valid.query),
);

route({ method: 'get', path: '/bookings/calendar', operationId: 'adminCalendar', summary: 'Bookings and blocks in a date range', query: s.adminCalendarQuery, response: s.adminCalendarResponse }, async (req) => {
  const { start, end, listingId } = req.valid.query;
  return svc.calendar(tenantOf(req).id, start, end, listingId);
});

route(
  {
    method: 'post',
    path: '/bookings',
    operationId: 'adminCreateBooking',
    summary: 'Create a walk-in / offline booking on behalf of a customer',
    body: s.adminCreateBookingBody,
    response: s.bookingDetailSchema,
    status: 201,
  },
  async (req) => {
    const tenant = tenantOf(req);
    const auth = authOf(req);
    const { markConfirmed, ownerNotes, ...input } = req.valid.body;
    const { booking } = await svc.createBooking(tenant, input, { actor: actorRole(req), actorUserId: auth.userId, markConfirmed, ownerNotes });
    await audit(db, { tenantId: tenant.id, actorUserId: auth.userId, action: 'booking.create', entityType: 'booking', entityId: booking.id, ip: clientIp(req) });
    return svc.toBookingDetailDto(await svc.getBookingForTenant(tenant.id, booking.id));
  },
);

route({ method: 'get', path: '/bookings/:id', operationId: 'adminGetBooking', summary: 'Booking detail with events and proofs', params: idParams, response: s.bookingDetailSchema }, async (req) =>
  svc.toBookingDetailDto(await svc.getBookingForTenant(tenantOf(req).id, req.valid.params.id)),
);

route({ method: 'patch', path: '/bookings/:id/notes', operationId: 'adminBookingNotes', summary: 'Set internal notes', params: idParams, body: s.ownerNotesBody, response: s.bookingDetailSchema }, async (req) => {
  const tenant = tenantOf(req);
  await svc.getBookingForTenant(tenant.id, req.valid.params.id);
  await db.update(bookings).set({ ownerNotes: req.valid.body.ownerNotes }).where(and(eq(bookings.tenantId, tenant.id), eq(bookings.id, req.valid.params.id)));
  return svc.toBookingDetailDto(await svc.getBookingForTenant(tenant.id, req.valid.params.id));
});

for (const action of ['confirm', 'reject', 'activate', 'complete', 'cancel'] as const) {
  route(
    {
      method: 'post',
      path: `/bookings/:id/${action}`,
      operationId: `adminBooking${action[0]!.toUpperCase()}${action.slice(1)}`,
      summary: {
        confirm: 'Accept the payment proof and confirm the booking',
        reject: 'Reject the payment proof (customer may re-upload within a new payment window)',
        activate: 'Mark the items as handed over',
        complete: 'Mark the rental as returned / completed',
        cancel: 'Cancel the booking',
      }[action],
      params: idParams,
      body: action === 'reject' ? s.rejectBody : s.reasonBody,
      response: s.bookingDetailSchema,
    },
    async (req) => {
      const tenant = tenantOf(req);
      const auth = authOf(req);
      const b = await svc.getBookingForTenant(tenant.id, req.valid.params.id);
      await svc.ownerAction(tenant, b, action, { actorUserId: auth.userId, actorRole: actorRole(req), reason: req.valid.body.reason });
      await audit(db, { tenantId: tenant.id, actorUserId: auth.userId, action: `booking.${action}`, entityType: 'booking', entityId: b.id, diff: { reason: req.valid.body.reason }, ip: clientIp(req) });
      return svc.toBookingDetailDto(await svc.getBookingForTenant(tenant.id, b.id));
    },
  );
}

route(
  {
    method: 'get',
    path: '/bookings/:id/proofs/:proofId/file',
    operationId: 'adminProofFile',
    summary: 'Stream a payment proof from private storage (use as an <img> src through the admin rewrite)',
    params: s.proofParams,
  },
  async (req, res) => {
    const tenant = tenantOf(req);
    await svc.getBookingForTenant(tenant.id, req.valid.params.id);
    const proof = await db.query.paymentProofs.findFirst({ where: and(eq(paymentProofs.id, req.valid.params.proofId), eq(paymentProofs.bookingId, req.valid.params.id)) });
    if (!proof) throw notFound('Proof not found');
    let file;
    try {
      file = await getObject(proof.pathname);
    } catch {
      throw notFound('File not found in storage');
    }
    if (!file.body) throw notFound('File not found in storage');
    res.status(200);
    res.setHeader('content-type', proof.contentType ?? file.contentType ?? 'application/octet-stream');
    if (file.contentLength) res.setHeader('content-length', String(file.contentLength));
    res.setHeader('cache-control', 'private, max-age=300');
    const body = file.body as unknown as { transformToWebStream?: () => ReadableStream } & NodeJS.ReadableStream;
    const stream = typeof body.pipe === 'function' ? body : Readable.fromWeb(body.transformToWebStream!() as import('node:stream/web').ReadableStream);
    // Await the full transfer so the route helper sees a finished response instead of ending it early.
    await pipeline(stream, res);
    return undefined as never;
  },
);

// ---------- availability blocks ----------

route({ method: 'get', path: '/listings/:id/blocks', operationId: 'adminListBlocks', summary: 'Blackout periods for a listing', params: idParams, response: z.array(s.blockSchema) }, async (req) => {
  const tenant = tenantOf(req);
  await getListing(tenant.id, req.valid.params.id);
  return db.query.availabilityBlocks.findMany({ where: and(eq(availabilityBlocks.tenantId, tenant.id), eq(availabilityBlocks.listingId, req.valid.params.id)), orderBy: (t, { asc }) => asc(t.startAt) });
});

route(
  { method: 'post', path: '/listings/:id/blocks', operationId: 'adminCreateBlock', summary: 'Add a blackout period', params: idParams, body: s.createBlockBody, response: s.blockSchema, status: 201 },
  async (req) => {
    const tenant = tenantOf(req);
    const listing = await getListing(tenant.id, req.valid.params.id);
    const [row] = await db
      .insert(availabilityBlocks)
      .values({ tenantId: tenant.id, listingId: listing.id, startAt: req.valid.body.startAt, endAt: req.valid.body.endAt, quantity: req.valid.body.quantity ?? null, reason: req.valid.body.reason ?? null })
      .returning();
    revalidateListings(tenant.slug, listing.slug);
    return row!;
  },
);

route({ method: 'delete', path: '/listings/:id/blocks/:blockId', operationId: 'adminDeleteBlock', summary: 'Remove a blackout period', params: s.blockParams, response: okResponse }, async (req) => {
  const tenant = tenantOf(req);
  const [row] = await db.delete(availabilityBlocks).where(and(eq(availabilityBlocks.tenantId, tenant.id), eq(availabilityBlocks.listingId, req.valid.params.id), eq(availabilityBlocks.id, req.valid.params.blockId))).returning();
  if (!row) throw notFound('Block not found');
  const listing = await db.query.listings.findFirst({ where: eq(listings.id, row.listingId), columns: { slug: true } });
  if (listing) revalidateListings(tenant.slug, listing.slug);
  return OK;
});

export const adminBookingsRouter = router;
