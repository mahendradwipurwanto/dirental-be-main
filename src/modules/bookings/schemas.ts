import { z } from 'zod';
import { emailSchema, isoDate, isoDateNullable, moneySchema, paginated, paginationQuery, phoneSchema } from '../../lib/schemas.js';
import { publicBankAccountSchema } from '../bank-accounts/router.js';

export const bookingStatusSchema = z.enum(['pending_payment', 'awaiting_verification', 'confirmed', 'active', 'completed', 'cancelled', 'expired', 'rejected']);
export type BookingStatusValue = z.infer<typeof bookingStatusSchema>;
export const fulfillmentSchema = z.enum(['pickup', 'delivery']);
export const pricingModeSchema = z.enum(['hour', 'day']);
export const actorSchema = z.enum(['customer', 'owner', 'staff', 'system', 'superadmin']);

const dateInput = z.coerce.date().openapi({ type: 'string', format: 'date-time' });

export const bookingItemInput = z.object({
  listingId: z.string().uuid(),
  quantity: z.number().int().min(1).max(50).default(1),
});

export const quoteBody = z.object({
  items: z.array(bookingItemInput).min(1).max(5),
  startAt: dateInput,
  endAt: dateInput,
  fulfillment: fulfillmentSchema.default('pickup'),
});

export const quoteLineSchema = z.object({
  listingId: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  quantity: z.number().int(),
  pricingMode: pricingModeSchema,
  units: z.number().int(),
  unitPrice: z.number().int(),
  lineTotal: z.number().int(),
  deposit: z.number().int(),
  available: z.number().int(),
});

export const quoteResponse = z.object({
  ok: z.boolean(),
  issues: z.array(z.object({ code: z.string(), message: z.string(), listingId: z.string().uuid().optional() })),
  lines: z.array(quoteLineSchema),
  subtotal: z.number().int(),
  depositAmount: z.number().int(),
  deliveryFee: z.number().int(),
  total: z.number().int(),
  currency: z.string(),
});

export const customerInput = z.object({
  name: z.string().trim().min(2).max(80),
  phone: phoneSchema,
  email: emailSchema,
  notes: z.string().trim().max(1000).optional(),
});

export const createBookingBody = quoteBody.extend({
  customer: customerInput,
  deliveryAddress: z.string().trim().max(300).optional(),
  locale: z.enum(['id', 'en']).optional(),
});

export const availabilityQuery = z.object({
  start: dateInput,
  end: dateInput,
  qty: z.coerce.number().int().min(1).max(50).default(1),
});
export const availabilityResponse = z.object({
  available: z.number().int(),
  requested: z.number().int(),
  ok: z.boolean(),
});

export const calendarQuery = z.object({
  /** YYYY-MM in the tenant timezone. */
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
});
export const calendarResponse = z.object({
  month: z.string(),
  stock: z.number().int(),
  days: z.array(z.object({ date: z.string(), available: z.number().int() })),
});

export const bookingItemSchema = z.object({
  id: z.string().uuid(),
  listingId: z.string().uuid(),
  quantity: z.number().int(),
  pricingMode: pricingModeSchema,
  units: z.number().int(),
  unitPrice: z.number().int(),
  lineTotal: z.number().int(),
  listing: z.object({ name: z.string(), slug: z.string(), imageUrl: z.string().nullable() }),
});

export const bookingEventSchema = z.object({
  id: z.string().uuid(),
  fromStatus: bookingStatusSchema.nullable(),
  toStatus: bookingStatusSchema,
  actor: actorSchema,
  actorName: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: isoDate,
});

export const proofStatusSchema = z.enum(['submitted', 'accepted', 'rejected']);

export const proofSchema = z.object({
  id: z.string().uuid(),
  bankAccountId: z.string().uuid().nullable(),
  amountClaimed: z.number().int().nullable(),
  transferredAt: isoDateNullable,
  senderName: z.string().nullable(),
  status: proofStatusSchema,
  note: z.string().nullable(),
  contentType: z.string().nullable(),
  size: z.number().int().nullable(),
  reviewedAt: isoDateNullable,
  createdAt: isoDate,
});

export const publicProofSchema = proofSchema.pick({ id: true, status: true, note: true, amountClaimed: true, createdAt: true });

const bookingCore = {
  id: z.string().uuid(),
  code: z.string(),
  status: bookingStatusSchema,
  customerName: z.string(),
  customerPhone: z.string(),
  customerEmail: z.string(),
  customerNotes: z.string().nullable(),
  startAt: isoDate,
  endAt: isoDate,
  fulfillment: fulfillmentSchema,
  deliveryAddress: z.string().nullable(),
  subtotal: z.number().int(),
  depositAmount: z.number().int(),
  deliveryFee: z.number().int(),
  total: z.number().int(),
  currency: z.string(),
  expiresAt: isoDateNullable,
  confirmedAt: isoDateNullable,
  completedAt: isoDateNullable,
  cancelledAt: isoDateNullable,
  cancelledBy: actorSchema.nullable(),
  rejectedReason: z.string().nullable(),
  items: z.array(bookingItemSchema),
  createdAt: isoDate,
  updatedAt: isoDate,
};

export const bookingSchema = z.object({ ...bookingCore, ownerNotes: z.string().nullable(), hasPendingProof: z.boolean() });

export const bookingDetailSchema = bookingSchema.extend({
  events: z.array(bookingEventSchema),
  proofs: z.array(proofSchema),
});

export const publicBookingSchema = z.object({
  ...bookingCore,
  proofs: z.array(publicProofSchema),
  bankAccounts: z.array(publicBankAccountSchema),
  instructions: z.string(),
  paymentWindowMinutes: z.number().int(),
  cancellationHours: z.number().int(),
  canCancel: z.boolean(),
  canUploadProof: z.boolean(),
  serverTime: isoDate,
  tenant: z.object({ slug: z.string(), name: z.string(), whatsapp: z.string().nullable(), logoUrl: z.string().nullable() }),
});

export const createBookingResponse = z.object({
  code: z.string(),
  accessToken: z.string(),
  expiresAt: isoDateNullable,
  total: z.number().int(),
});

export const bookingCodeParams = z.object({ slug: z.string().min(1).max(60), code: z.string().min(6).max(20) });
export const bookingTokenQuery = z.object({ token: z.string().min(10) });

export const proofPresignBody = z.object({
  token: z.string().min(10),
  filename: z.string().trim().min(1).max(200),
  contentType: z.string().min(3).max(100),
  size: z.number().int().positive(),
});
export const proofPresignResponse = z.object({
  key: z.string(),
  uploadUrl: z.string(),
  method: z.literal('PUT'),
  headers: z.record(z.string(), z.string()),
  expiresInSeconds: z.number().int(),
});

export const submitProofBody = z.object({
  token: z.string().min(10),
  /** Object key returned by the presign call, after the PUT succeeded. */
  key: z.string().min(1).max(500),
  bankAccountId: z.string().uuid().optional(),
  amountClaimed: moneySchema.optional(),
  transferredAt: dateInput.optional(),
  senderName: z.string().trim().max(80).optional(),
});

export const cancelBookingBody = z.object({ token: z.string().min(10), reason: z.string().trim().max(300).optional() });

// ---------- admin ----------

export const listBookingsQuery = paginationQuery.extend({
  status: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : undefined))
    .pipe(z.array(bookingStatusSchema).optional()),
  from: dateInput.optional(),
  to: dateInput.optional(),
  q: z.string().trim().max(80).optional(),
  listingId: z.string().uuid().optional(),
  sort: z.enum(['created_desc', 'start_asc', 'start_desc']).default('created_desc'),
});
export const listBookingsResponse = paginated(bookingSchema);

export const adminCreateBookingBody = createBookingBody.extend({
  /** Walk-in / offline bookings can be created already confirmed. */
  markConfirmed: z.boolean().default(true),
  ownerNotes: z.string().trim().max(1000).optional(),
});

export const reasonBody = z.object({ reason: z.string().trim().max(500).optional() });
export const rejectBody = z.object({ reason: z.string().trim().min(3).max(500) });
export const ownerNotesBody = z.object({ ownerNotes: z.string().trim().max(1000).nullable() });

export const proofParams = z.object({ id: z.string().uuid(), proofId: z.string().uuid() });

export const adminCalendarQuery = z.object({
  start: dateInput,
  end: dateInput,
  listingId: z.string().uuid().optional(),
});
export const adminCalendarResponse = z.object({
  bookings: z.array(
    z.object({
      id: z.string().uuid(),
      code: z.string(),
      status: bookingStatusSchema,
      customerName: z.string(),
      startAt: isoDate,
      endAt: isoDate,
      items: z.array(z.object({ listingId: z.string().uuid(), name: z.string(), quantity: z.number().int() })),
    }),
  ),
  blocks: z.array(
    z.object({
      id: z.string().uuid(),
      listingId: z.string().uuid(),
      listingName: z.string(),
      startAt: isoDate,
      endAt: isoDate,
      quantity: z.number().int().nullable(),
      reason: z.string().nullable(),
    }),
  ),
});

export const blockSchema = z.object({
  id: z.string().uuid(),
  listingId: z.string().uuid(),
  startAt: isoDate,
  endAt: isoDate,
  quantity: z.number().int().nullable(),
  reason: z.string().nullable(),
  createdAt: isoDate,
});
export const createBlockBody = z
  .object({
    startAt: dateInput,
    endAt: dateInput,
    quantity: z.number().int().min(1).max(10_000).nullable().optional(),
    reason: z.string().trim().max(200).optional(),
  })
  .refine((v) => v.endAt > v.startAt, { path: ['endAt'], message: 'End must be after start' });
export const blockParams = z.object({ id: z.string().uuid(), blockId: z.string().uuid() });

export const dashboardStatsResponse = z.object({
  counts: z.record(bookingStatusSchema, z.number().int()),
  pendingVerification: z.number().int(),
  upcoming7d: z.number().int(),
  activeNow: z.number().int(),
  revenueThisMonth: z.number().int(),
  revenueLastMonth: z.number().int(),
  bookingsThisMonth: z.number().int(),
  activeListings: z.number().int(),
  recent: z.array(bookingSchema),
  setup: z.object({
    hasBankAccount: z.boolean(),
    hasActiveListing: z.boolean(),
    hasPublishedSite: z.boolean(),
    hasContact: z.boolean(),
  }),
});
