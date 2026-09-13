import { and, asc, count, desc, eq, gte, ilike, inArray, isNotNull, lt, lte, or, sql, sum, type SQL } from 'drizzle-orm';
import { db, type DbOrTx } from '../../db/client.js';
import {
  availabilityBlocks,
  bankAccounts,
  bookingEvents,
  bookingItems,
  bookings,
  listings,
  paymentProofs,
  siteConfigs,
  users,
  type Booking,
  type BookingActor,
  type BookingEvent,
  type BookingItem,
  type BookingStatus,
  type Listing,
  type PaymentProof,
  type Tenant,
} from '../../db/schema/index.js';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { bookingCode, hashToken, randomToken, safeEqual } from '../../lib/tokens.js';
import { PROOF_CONTENT_TYPES, verifyObject } from '../../lib/storage.js';
import { env } from '../../config/env.js';
import { activeListingsByIds } from '../listings/service.js';
import { notify } from '../notifications/service.js';
import { availableUnits } from './availability.js';
import { checkLeadTime, deliveryFeeFor, priceLine, sumLines, type QuoteIssue, type QuoteLine } from './pricing.js';
import type { z } from 'zod';
import type { createBookingBody, listBookingsQuery, quoteBody } from './schemas.js';

type BookingWithItems = Booking & { items: (BookingItem & { listing?: Listing | null })[] };
type BookingFull = BookingWithItems & { events: (BookingEvent & { actorUser?: { name: string } | null })[]; proofs: PaymentProof[] };

// ---------- DTOs ----------

export const toItemDto = (i: BookingItem) => ({
  id: i.id,
  listingId: i.listingId,
  quantity: i.quantity,
  pricingMode: i.pricingMode,
  units: i.units,
  unitPrice: i.unitPrice,
  lineTotal: i.lineTotal,
  listing: { name: i.listingSnapshot.name, slug: i.listingSnapshot.slug, imageUrl: i.listingSnapshot.imageUrl },
});

const bookingCoreDto = (b: BookingWithItems) => ({
  id: b.id,
  code: b.code,
  status: b.status,
  customerName: b.customerName,
  customerPhone: b.customerPhone,
  customerEmail: b.customerEmail,
  customerNotes: b.customerNotes,
  startAt: b.startAt,
  endAt: b.endAt,
  fulfillment: b.fulfillment,
  deliveryAddress: b.deliveryAddress,
  subtotal: b.subtotal,
  depositAmount: b.depositAmount,
  deliveryFee: b.deliveryFee,
  total: b.total,
  currency: b.currency,
  expiresAt: b.expiresAt,
  confirmedAt: b.confirmedAt,
  completedAt: b.completedAt,
  cancelledAt: b.cancelledAt,
  cancelledBy: b.cancelledBy,
  rejectedReason: b.rejectedReason,
  items: b.items.map(toItemDto),
  createdAt: b.createdAt,
  updatedAt: b.updatedAt,
});

export const toBookingDto = (b: BookingWithItems & { proofs?: PaymentProof[] }) => ({
  ...bookingCoreDto(b),
  ownerNotes: b.ownerNotes,
  hasPendingProof: (b.proofs ?? []).some((p) => p.status === 'submitted'),
});

export const toProofDto = (p: PaymentProof) => ({
  id: p.id,
  bankAccountId: p.bankAccountId,
  amountClaimed: p.amountClaimed,
  transferredAt: p.transferredAt,
  senderName: p.senderName,
  status: p.status,
  note: p.note,
  contentType: p.contentType,
  size: p.size,
  reviewedAt: p.reviewedAt,
  createdAt: p.createdAt,
});

export const toBookingDetailDto = (b: BookingFull) => ({
  ...toBookingDto(b),
  events: b.events.map((e) => ({
    id: e.id,
    fromStatus: e.fromStatus,
    toStatus: e.toStatus,
    actor: e.actor,
    actorName: e.actorUser?.name ?? null,
    note: e.note,
    createdAt: e.createdAt,
  })),
  proofs: b.proofs.map(toProofDto),
});

export async function toPublicBookingDto(b: BookingWithItems & { proofs: PaymentProof[] }, tenant: Tenant) {
  const accounts = await db.query.bankAccounts.findMany({ where: and(eq(bankAccounts.tenantId, tenant.id), eq(bankAccounts.isActive, true)), orderBy: [asc(bankAccounts.sortOrder)] });
  const now = new Date();
  const settings = tenant.bookingSettings;
  const cancelDeadline = b.startAt.getTime() - settings.cancellationHours * 3_600_000;
  return {
    ...bookingCoreDto(b),
    proofs: b.proofs.map((p) => ({ id: p.id, status: p.status, note: p.note, amountClaimed: p.amountClaimed, createdAt: p.createdAt })),
    bankAccounts: accounts.map((a) => ({ id: a.id, bankName: a.bankName, accountNumber: a.accountNumber, holderName: a.holderName, isPrimary: a.isPrimary })),
    instructions: settings.instructions,
    paymentWindowMinutes: settings.paymentWindowMinutes,
    cancellationHours: settings.cancellationHours,
    canCancel: (['pending_payment', 'awaiting_verification', 'rejected'] as BookingStatus[]).includes(b.status) || (b.status === 'confirmed' && now.getTime() < cancelDeadline),
    canUploadProof: (['pending_payment', 'rejected', 'awaiting_verification'] as BookingStatus[]).includes(b.status) && (!b.expiresAt || b.expiresAt.getTime() > now.getTime()),
    serverTime: now,
    tenant: { slug: tenant.slug, name: tenant.name, whatsapp: tenant.contact.whatsapp ?? null, logoUrl: tenant.logoUrl },
  };
}

// ---------- quoting ----------

export async function quote(dbx: DbOrTx, tenant: Tenant, input: z.infer<typeof quoteBody>) {
  const issues: QuoteIssue[] = [];
  const lead = checkLeadTime(input.startAt, tenant.bookingSettings);
  if (lead) issues.push(lead);
  if (input.endAt <= input.startAt) issues.push({ code: 'INVALID_RANGE', message: 'End must be after start' });

  const ids = [...new Set(input.items.map((i) => i.listingId))];
  const found = await activeListingsByIds(dbx, tenant.id, ids);
  const byId = new Map(found.map((l) => [l.id, l]));
  const lines: QuoteLine[] = [];
  let allowDelivery = found.length > 0;

  for (const item of input.items) {
    const listing = byId.get(item.listingId);
    if (!listing) {
      issues.push({ code: 'LISTING_UNAVAILABLE', message: 'Listing is not available', listingId: item.listingId });
      continue;
    }
    if (!listing.deliveryEnabled) allowDelivery = false;
    if (item.quantity > listing.stockQuantity) {
      issues.push({ code: 'QUANTITY', message: `Only ${listing.stockQuantity} unit(s) exist`, listingId: listing.id });
    }
    const available = input.endAt > input.startAt ? await availableUnits(dbx, listing.id, input.startAt, input.endAt) : 0;
    const priced = priceLine(listing, input.startAt, input.endAt, item.quantity, available);
    issues.push(...priced.issues);
    if (priced.line) lines.push(priced.line);
  }

  const delivery = deliveryFeeFor(input.fulfillment, tenant.bookingSettings, allowDelivery);
  if (delivery.issue) issues.push(delivery.issue);
  const totals = sumLines(lines, delivery.fee);
  const blocking = issues.filter((i) => !['MIN_HOURS', 'MIN_DAYS'].includes(i.code));
  return { ok: blocking.length === 0 && lines.length === input.items.length, issues, lines, ...totals, currency: tenant.currency, listings: found };
}

// ---------- creation ----------

export async function createBooking(
  tenant: Tenant,
  input: z.infer<typeof createBookingBody>,
  opts: { actor: BookingActor; actorUserId?: string; markConfirmed?: boolean; ownerNotes?: string },
) {
  const ids = [...new Set(input.items.map((i) => i.listingId))].sort();

  const created = await db.transaction(async (tx) => {
    // Serialise concurrent bookings of the same listings; ordered to avoid deadlocks.
    await tx.execute(sql`select id from listings where id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) order by id for update`);

    const q = await quote(tx, tenant, input);
    if (!q.ok) {
      const first = q.issues.find((i) => !['MIN_HOURS', 'MIN_DAYS'].includes(i.code)) ?? q.issues[0];
      const status = first?.code === 'UNAVAILABLE' || first?.code === 'LISTING_UNAVAILABLE' ? 409 : 422;
      throw new AppError(status, first?.code ?? 'QUOTE_FAILED', first?.message ?? 'Booking cannot be created', q.issues.map((i) => ({ path: i.listingId ?? 'items', message: i.message })));
    }

    const settings = tenant.bookingSettings;
    const now = new Date();
    const confirmed = Boolean(opts.markConfirmed);
    const accessToken = randomToken(24);

    let code = bookingCode();
    for (let i = 0; i < 5; i++) {
      const dup = await tx.query.bookings.findFirst({ where: eq(bookings.code, code), columns: { id: true } });
      if (!dup) break;
      code = bookingCode();
    }

    const [booking] = await tx
      .insert(bookings)
      .values({
        tenantId: tenant.id,
        code,
        status: confirmed ? 'confirmed' : 'pending_payment',
        customerName: input.customer.name,
        customerPhone: input.customer.phone,
        customerEmail: input.customer.email,
        customerNotes: input.customer.notes ?? null,
        startAt: input.startAt,
        endAt: input.endAt,
        fulfillment: input.fulfillment,
        deliveryAddress: input.fulfillment === 'delivery' ? (input.deliveryAddress ?? null) : null,
        subtotal: q.subtotal,
        depositAmount: q.depositAmount,
        deliveryFee: q.deliveryFee,
        total: q.total,
        currency: tenant.currency,
        accessTokenHash: hashToken(accessToken),
        expiresAt: confirmed ? null : new Date(now.getTime() + settings.paymentWindowMinutes * 60_000),
        confirmedAt: confirmed ? now : null,
        ownerNotes: opts.ownerNotes ?? null,
      })
      .returning();
    if (!booking) throw new Error('Failed to create booking');

    const listingById = new Map(q.listings.map((l) => [l.id, l]));
    const items = await tx
      .insert(bookingItems)
      .values(
        q.lines.map((line) => {
          const l = listingById.get(line.listingId)!;
          const cover = [...l.images].sort((a, b) => a.sortOrder - b.sortOrder)[0];
          return {
            bookingId: booking.id,
            listingId: line.listingId,
            quantity: line.quantity,
            pricingMode: line.pricingMode,
            units: line.units,
            unitPrice: line.unitPrice,
            lineTotal: line.lineTotal,
            listingSnapshot: { name: l.name, slug: l.slug, imageUrl: cover?.url ?? null, pricePerHour: l.pricePerHour, pricePerDay: l.pricePerDay, depositAmount: l.depositAmount },
          };
        }),
      )
      .returning();

    await tx.insert(bookingEvents).values({ bookingId: booking.id, fromStatus: null, toStatus: booking.status, actor: opts.actor, actorUserId: opts.actorUserId ?? null, note: confirmed ? 'Created as confirmed' : null });
    return { booking, items, accessToken };
  });

  if (opts.actor === 'customer') notify('booking_created', { booking: created.booking, items: created.items, tenant, accessToken: created.accessToken });
  return created;
}

// ---------- lookup ----------

const fullWith = { items: true, events: { with: { actorUser: { columns: { name: true } } } }, proofs: true } as const;

export async function getBookingForTenant(tenantId: string, id: string): Promise<BookingFull> {
  const row = await db.query.bookings.findFirst({ where: and(eq(bookings.tenantId, tenantId), eq(bookings.id, id)), with: fullWith });
  if (!row) throw notFound('Booking not found', 'BOOKING_NOT_FOUND');
  return expireIfDue(row as BookingFull);
}

export async function getBookingByCode(tenant: Tenant, code: string, token: string): Promise<BookingFull> {
  const row = await db.query.bookings.findFirst({ where: and(eq(bookings.tenantId, tenant.id), eq(bookings.code, code.toUpperCase())), with: fullWith });
  if (!row || !safeEqual(row.accessTokenHash, hashToken(token))) throw notFound('Booking not found', 'BOOKING_NOT_FOUND');
  return expireIfDue(row as BookingFull);
}

/** Lazy expiry so correctness never depends on the cron (Hobby crons run once a day). */
export async function expireIfDue<T extends BookingFull>(b: T): Promise<T> {
  if ((b.status === 'pending_payment' || b.status === 'rejected') && b.expiresAt && b.expiresAt.getTime() < Date.now()) {
    const updated = await transition(b, 'expired', { actor: 'system', note: 'Payment window elapsed' });
    return { ...b, ...updated, events: [...b.events] } as T;
  }
  return b;
}

// ---------- state machine ----------

const TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  pending_payment: ['awaiting_verification', 'expired', 'cancelled', 'confirmed'],
  awaiting_verification: ['confirmed', 'rejected', 'cancelled'],
  rejected: ['awaiting_verification', 'expired', 'cancelled', 'confirmed'],
  confirmed: ['active', 'completed', 'cancelled'],
  active: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
  expired: [],
};

export function canTransition(from: BookingStatus, to: BookingStatus) {
  return TRANSITIONS[from].includes(to);
}

export async function transition(
  b: Booking,
  to: BookingStatus,
  opts: { actor: BookingActor; actorUserId?: string; note?: string; extra?: Partial<typeof bookings.$inferInsert> },
  dbx: DbOrTx = db,
): Promise<Booking> {
  if (!canTransition(b.status, to)) throw conflict(`Cannot move a booking from ${b.status} to ${to}`, 'INVALID_TRANSITION');
  const now = new Date();
  const patch: Partial<typeof bookings.$inferInsert> = { status: to, ...opts.extra };
  if (to === 'confirmed') Object.assign(patch, { confirmedAt: now, expiresAt: null, rejectedReason: null });
  if (to === 'awaiting_verification') Object.assign(patch, { expiresAt: null });
  if (to === 'completed') Object.assign(patch, { completedAt: now });
  if (to === 'cancelled') Object.assign(patch, { cancelledAt: now, cancelledBy: opts.actor, expiresAt: null });
  if (to === 'expired') Object.assign(patch, { expiresAt: null });

  const [updated] = await dbx
    .update(bookings)
    .set(patch)
    .where(and(eq(bookings.id, b.id), eq(bookings.status, b.status)))
    .returning();
  if (!updated) throw conflict('Booking changed concurrently; reload and retry', 'STALE');
  await dbx.insert(bookingEvents).values({ bookingId: b.id, fromStatus: b.status, toStatus: to, actor: opts.actor, actorUserId: opts.actorUserId ?? null, note: opts.note ?? null });
  return updated;
}

// ---------- customer actions ----------

export const proofKeyPrefix = (tenantId: string, bookingId: string) => `private/tenants/${tenantId}/proofs/${bookingId}/`;

export async function submitProof(
  tenant: Tenant,
  b: BookingFull,
  input: { key: string; bankAccountId?: string; amountClaimed?: number; transferredAt?: Date; senderName?: string },
) {
  if (!input.key.startsWith(proofKeyPrefix(tenant.id, b.id))) {
    throw unprocessable('Proof does not belong to this booking', [{ path: 'body.key', message: 'Invalid key' }]);
  }
  if (!['pending_payment', 'rejected', 'awaiting_verification'].includes(b.status)) throw conflict('This booking no longer accepts payment proofs', 'PROOF_NOT_ACCEPTED');
  if (b.expiresAt && b.expiresAt.getTime() < Date.now()) throw conflict('Payment window has elapsed', 'EXPIRED');
  const meta = await verifyObject(input.key, PROOF_CONTENT_TYPES);

  const { proof, booking } = await db.transaction(async (tx) => {
    const [proof] = await tx
      .insert(paymentProofs)
      .values({
        bookingId: b.id,
        bankAccountId: input.bankAccountId ?? null,
        pathname: input.key,
        url: `${env.S3_ENDPOINT ?? 's3:/'}/${env.S3_BUCKET ?? ''}/${input.key}`,
        contentType: meta.contentType,
        size: meta.size,
        amountClaimed: input.amountClaimed ?? null,
        transferredAt: input.transferredAt ?? null,
        senderName: input.senderName ?? null,
      })
      .returning();
    const booking = b.status === 'awaiting_verification' ? b : await transition(b, 'awaiting_verification', { actor: 'customer', note: 'Payment proof submitted' }, tx);
    return { proof: proof!, booking };
  });
  notify('proof_submitted', { booking, items: b.items, tenant }, proof.id);
  return { proof, booking };
}

export async function customerCancel(tenant: Tenant, b: BookingFull, reason?: string) {
  const settings = tenant.bookingSettings;
  const okStatuses: BookingStatus[] = ['pending_payment', 'awaiting_verification', 'rejected'];
  const deadline = b.startAt.getTime() - settings.cancellationHours * 3_600_000;
  if (!okStatuses.includes(b.status) && !(b.status === 'confirmed' && Date.now() < deadline)) {
    throw forbidden('This booking can no longer be cancelled', 'CANCEL_NOT_ALLOWED');
  }
  const updated = await transition(b, 'cancelled', { actor: 'customer', note: reason });
  notify('booking_cancelled', { booking: updated, items: b.items, tenant, reason });
  return updated;
}

// ---------- owner actions ----------

export async function ownerAction(
  tenant: Tenant,
  b: BookingFull,
  action: 'confirm' | 'reject' | 'activate' | 'complete' | 'cancel',
  opts: { actorUserId: string; actorRole: BookingActor; reason?: string },
) {
  const now = new Date();
  switch (action) {
    case 'confirm': {
      const updated = await db.transaction(async (tx) => {
        const u = await transition(b, 'confirmed', { actor: opts.actorRole, actorUserId: opts.actorUserId, note: opts.reason }, tx);
        await tx.update(paymentProofs).set({ status: 'accepted', reviewedBy: opts.actorUserId, reviewedAt: now }).where(and(eq(paymentProofs.bookingId, b.id), eq(paymentProofs.status, 'submitted')));
        return u;
      });
      notify('booking_confirmed', { booking: updated, items: b.items, tenant });
      return updated;
    }
    case 'reject': {
      const reason = opts.reason ?? 'Payment could not be verified';
      const updated = await db.transaction(async (tx) => {
        const u = await transition(
          b,
          'rejected',
          { actor: opts.actorRole, actorUserId: opts.actorUserId, note: reason, extra: { rejectedReason: reason, expiresAt: new Date(now.getTime() + tenant.bookingSettings.paymentWindowMinutes * 60_000) } },
          tx,
        );
        await tx.update(paymentProofs).set({ status: 'rejected', reviewedBy: opts.actorUserId, reviewedAt: now, note: reason }).where(and(eq(paymentProofs.bookingId, b.id), eq(paymentProofs.status, 'submitted')));
        return u;
      });
      notify('booking_rejected', { booking: updated, items: b.items, tenant, reason }, String(b.proofs.length));
      return updated;
    }
    case 'activate':
      return transition(b, 'active', { actor: opts.actorRole, actorUserId: opts.actorUserId, note: opts.reason });
    case 'complete': {
      const updated = await transition(b, 'completed', { actor: opts.actorRole, actorUserId: opts.actorUserId, note: opts.reason });
      notify('booking_completed', { booking: updated, items: b.items, tenant });
      return updated;
    }
    case 'cancel': {
      const updated = await transition(b, 'cancelled', { actor: opts.actorRole, actorUserId: opts.actorUserId, note: opts.reason });
      notify('booking_cancelled', { booking: updated, items: b.items, tenant, reason: opts.reason });
      return updated;
    }
  }
}

// ---------- admin queries ----------

export async function listBookings(tenantId: string, q: z.infer<typeof listBookingsQuery>) {
  const filters: SQL[] = [eq(bookings.tenantId, tenantId)];
  if (q.status?.length) filters.push(inArray(bookings.status, q.status));
  if (q.from) filters.push(gte(bookings.endAt, q.from));
  if (q.to) filters.push(lte(bookings.startAt, q.to));
  if (q.q) filters.push(or(ilike(bookings.code, `%${q.q}%`), ilike(bookings.customerName, `%${q.q}%`), ilike(bookings.customerPhone, `%${q.q}%`), ilike(bookings.customerEmail, `%${q.q}%`))!);
  if (q.listingId) filters.push(sql`exists (select 1 from booking_items bi where bi.booking_id = ${bookings.id} and bi.listing_id = ${q.listingId})`);
  const where = and(...filters);
  const orderBy = q.sort === 'start_asc' ? [asc(bookings.startAt)] : q.sort === 'start_desc' ? [desc(bookings.startAt)] : [desc(bookings.createdAt)];

  const [rows, [{ total = 0 } = {}]] = await Promise.all([
    db.query.bookings.findMany({ where, with: { items: true, proofs: true }, orderBy, limit: q.pageSize, offset: (q.page - 1) * q.pageSize }),
    db.select({ total: count() }).from(bookings).where(where),
  ]);
  return { items: rows.map(toBookingDto), total, page: q.page, pageSize: q.pageSize };
}

export async function calendar(tenantId: string, start: Date, end: Date, listingId?: string) {
  const rows = await db.query.bookings.findMany({
    where: and(
      eq(bookings.tenantId, tenantId),
      inArray(bookings.status, ['pending_payment', 'awaiting_verification', 'rejected', 'confirmed', 'active', 'completed']),
      lt(bookings.startAt, end),
      gte(bookings.endAt, start),
      listingId ? sql`exists (select 1 from booking_items bi where bi.booking_id = ${bookings.id} and bi.listing_id = ${listingId})` : undefined,
    ),
    with: { items: true },
    orderBy: [asc(bookings.startAt)],
    limit: 500,
  });
  const blocks = await db
    .select({ id: availabilityBlocks.id, listingId: availabilityBlocks.listingId, listingName: listings.name, startAt: availabilityBlocks.startAt, endAt: availabilityBlocks.endAt, quantity: availabilityBlocks.quantity, reason: availabilityBlocks.reason })
    .from(availabilityBlocks)
    .innerJoin(listings, eq(listings.id, availabilityBlocks.listingId))
    .where(and(eq(availabilityBlocks.tenantId, tenantId), lt(availabilityBlocks.startAt, end), gte(availabilityBlocks.endAt, start), listingId ? eq(availabilityBlocks.listingId, listingId) : undefined));
  return {
    bookings: rows.map((b) => ({ id: b.id, code: b.code, status: b.status, customerName: b.customerName, startAt: b.startAt, endAt: b.endAt, items: b.items.map((i) => ({ listingId: i.listingId, name: i.listingSnapshot.name, quantity: i.quantity })) })),
    blocks,
  };
}

export async function dashboardStats(tenant: Tenant) {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 7 * 3_600_000);
  const lastMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1) - 7 * 3_600_000);
  const in7d = new Date(now.getTime() + 7 * 24 * 3_600_000);
  const paid: BookingStatus[] = ['confirmed', 'active', 'completed'];

  const [countRows, [upcoming], [activeNow], [revThis], [revLast], [bookingsThis], [activeListings], recent, bank, published] = await Promise.all([
    db.select({ status: bookings.status, n: count() }).from(bookings).where(eq(bookings.tenantId, tenant.id)).groupBy(bookings.status),
    db.select({ n: count() }).from(bookings).where(and(eq(bookings.tenantId, tenant.id), eq(bookings.status, 'confirmed'), gte(bookings.startAt, now), lte(bookings.startAt, in7d))),
    db.select({ n: count() }).from(bookings).where(and(eq(bookings.tenantId, tenant.id), eq(bookings.status, 'active'))),
    db.select({ n: sum(bookings.subtotal) }).from(bookings).where(and(eq(bookings.tenantId, tenant.id), inArray(bookings.status, paid), gte(bookings.confirmedAt, monthStart))),
    db.select({ n: sum(bookings.subtotal) }).from(bookings).where(and(eq(bookings.tenantId, tenant.id), inArray(bookings.status, paid), gte(bookings.confirmedAt, lastMonthStart), lt(bookings.confirmedAt, monthStart))),
    db.select({ n: count() }).from(bookings).where(and(eq(bookings.tenantId, tenant.id), gte(bookings.createdAt, monthStart))),
    db.select({ n: count() }).from(listings).where(and(eq(listings.tenantId, tenant.id), eq(listings.status, 'active'))),
    db.query.bookings.findMany({ where: eq(bookings.tenantId, tenant.id), with: { items: true, proofs: true }, orderBy: [desc(bookings.createdAt)], limit: 8 }),
    db.select({ n: count() }).from(bankAccounts).where(and(eq(bankAccounts.tenantId, tenant.id), eq(bankAccounts.isActive, true))),
    db.query.siteConfigs.findFirst({ where: and(eq(siteConfigs.tenantId, tenant.id), isNotNull(siteConfigs.published)), columns: { id: true } }),
  ]);

  const counts = Object.fromEntries((['pending_payment', 'awaiting_verification', 'confirmed', 'active', 'completed', 'cancelled', 'expired', 'rejected'] as BookingStatus[]).map((s) => [s, 0])) as Record<BookingStatus, number>;
  for (const r of countRows) counts[r.status] = r.n;

  return {
    counts,
    pendingVerification: counts.awaiting_verification,
    upcoming7d: upcoming?.n ?? 0,
    activeNow: activeNow?.n ?? 0,
    revenueThisMonth: Number(revThis?.n ?? 0),
    revenueLastMonth: Number(revLast?.n ?? 0),
    bookingsThisMonth: bookingsThis?.n ?? 0,
    activeListings: activeListings?.n ?? 0,
    recent: recent.map(toBookingDto),
    setup: {
      hasBankAccount: (bank[0]?.n ?? 0) > 0,
      hasActiveListing: (activeListings?.n ?? 0) > 0,
      hasPublishedSite: Boolean(published),
      hasContact: Boolean(tenant.contact.whatsapp || tenant.contact.phone),
    },
  };
}

// ---------- cron ----------

export async function expireDueBookings(limit = 200): Promise<number> {
  const due = await db.query.bookings.findMany({
    where: and(inArray(bookings.status, ['pending_payment', 'rejected']), isNotNull(bookings.expiresAt), lt(bookings.expiresAt, new Date())),
    with: { items: true },
    limit,
  });
  let n = 0;
  for (const b of due) {
    try {
      const updated = await transition(b, 'expired', { actor: 'system', note: 'Payment window elapsed' });
      const tenant = await db.query.tenants.findFirst({ where: (t, { eq }) => eq(t.id, b.tenantId) });
      if (tenant) notify('booking_expired', { booking: updated, items: b.items, tenant });
      n++;
    } catch {
      /* raced with another transition; skip */
    }
  }
  return n;
}

export async function actorNameOf(userId: string | undefined) {
  if (!userId) return null;
  const u = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { name: true } });
  return u?.name ?? null;
}
