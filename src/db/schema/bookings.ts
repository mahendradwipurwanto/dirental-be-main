import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { id, timestamps } from './_common.js';
import { bookingActor, bookingStatus, fulfillment, notificationType, pricingMode, proofStatus } from './enums.js';
import { listings } from './listings.js';
import { bankAccounts, tenants } from './tenants.js';
import { users } from './users.js';

export const bookings = pgTable(
  'bookings',
  {
    id: id(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    code: text().notNull().unique(),
    status: bookingStatus().notNull().default('pending_payment'),
    customerName: text().notNull(),
    customerPhone: text().notNull(),
    customerEmail: text().notNull(),
    customerNotes: text(),
    startAt: timestamp({ withTimezone: true }).notNull(),
    endAt: timestamp({ withTimezone: true }).notNull(),
    fulfillment: fulfillment().notNull().default('pickup'),
    deliveryAddress: text(),
    subtotal: integer().notNull(),
    depositAmount: integer().notNull().default(0),
    deliveryFee: integer().notNull().default(0),
    total: integer().notNull(),
    currency: text().notNull().default('IDR'),
    /** Customer-facing access token (hashed). Sent in the booking link and email. */
    accessTokenHash: text().notNull(),
    /** When pending payment lapses. Null once the booking leaves pending_payment. */
    expiresAt: timestamp({ withTimezone: true }),
    confirmedAt: timestamp({ withTimezone: true }),
    completedAt: timestamp({ withTimezone: true }),
    cancelledAt: timestamp({ withTimezone: true }),
    cancelledBy: bookingActor(),
    rejectedReason: text(),
    ownerNotes: text(),
    ...timestamps,
  },
  (t) => [
    index('bookings_tenant_status_created_idx').on(t.tenantId, t.status, t.createdAt),
    index('bookings_tenant_start_idx').on(t.tenantId, t.startAt),
    index('bookings_pending_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.status} = 'pending_payment'`),
    index('bookings_customer_email_idx').on(t.customerEmail),
    index('bookings_range_gist').using('gist', sql`tstzrange(${t.startAt}, ${t.endAt}, '[)')`),
    check('bookings_range_valid', sql`${t.endAt} > ${t.startAt}`),
  ],
);

export type ListingSnapshot = {
  name: string;
  slug: string;
  imageUrl: string | null;
  pricePerHour: number | null;
  pricePerDay: number | null;
  depositAmount: number;
};

export const bookingItems = pgTable(
  'booking_items',
  {
    id: id(),
    bookingId: uuid()
      .notNull()
      .references(() => bookings.id, { onDelete: 'cascade' }),
    listingId: uuid()
      .notNull()
      .references(() => listings.id, { onDelete: 'restrict' }),
    quantity: integer().notNull().default(1),
    pricingMode: pricingMode().notNull(),
    /** Number of hours or days billed. */
    units: integer().notNull(),
    unitPrice: integer().notNull(),
    lineTotal: integer().notNull(),
    listingSnapshot: jsonb().$type<ListingSnapshot>().notNull(),
  },
  (t) => [index('booking_items_booking_idx').on(t.bookingId), index('booking_items_listing_idx').on(t.listingId)],
);

export const bookingEvents = pgTable(
  'booking_events',
  {
    id: id(),
    bookingId: uuid()
      .notNull()
      .references(() => bookings.id, { onDelete: 'cascade' }),
    fromStatus: bookingStatus(),
    toStatus: bookingStatus().notNull(),
    actor: bookingActor().notNull(),
    actorUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    note: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('booking_events_booking_idx').on(t.bookingId, t.createdAt)],
);

export const paymentProofs = pgTable(
  'payment_proofs',
  {
    id: id(),
    bookingId: uuid()
      .notNull()
      .references(() => bookings.id, { onDelete: 'cascade' }),
    bankAccountId: uuid().references(() => bankAccounts.id, { onDelete: 'set null' }),
    /** Object key under the private storage prefix. Never exposed directly; streamed through the admin API. */
    pathname: text().notNull(),
    url: text().notNull(),
    contentType: text(),
    size: integer(),
    amountClaimed: integer(),
    transferredAt: timestamp({ withTimezone: true }),
    senderName: text(),
    status: proofStatus().notNull().default('submitted'),
    reviewedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: timestamp({ withTimezone: true }),
    note: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('payment_proofs_booking_idx').on(t.bookingId, t.createdAt)],
);

export const notificationLogs = pgTable(
  'notification_logs',
  {
    id: id(),
    bookingId: uuid().references(() => bookings.id, { onDelete: 'cascade' }),
    type: notificationType().notNull(),
    recipient: text().notNull(),
    /** Discriminator so one booking can get the same type again (e.g. proof resubmitted). */
    dedupeKey: text().notNull(),
    providerId: text(),
    status: text().notNull().default('sent'),
    error: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('notification_logs_dedupe_uq').on(t.dedupeKey)],
);

export type Booking = typeof bookings.$inferSelect;
export type NewBooking = typeof bookings.$inferInsert;
export type BookingItem = typeof bookingItems.$inferSelect;
export type BookingEvent = typeof bookingEvents.$inferSelect;
export type PaymentProof = typeof paymentProofs.$inferSelect;
