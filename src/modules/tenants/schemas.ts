import { z } from 'zod';
import { isoDate, isoDateNullable, moneySchema, phoneSchema } from '../../lib/schemas.js';

export const tenantStatusSchema = z.enum(['pending', 'active', 'suspended', 'archived']);

export const tenantContactSchema = z.object({
  phone: phoneSchema.optional(),
  whatsapp: phoneSchema.optional(),
  email: z.string().trim().toLowerCase().email().optional(),
  address: z.string().trim().max(300).optional(),
  city: z.string().trim().max(80).optional(),
  mapUrl: z
    .string()
    .trim()
    .max(2048)
    .refine((v) => v === '' || /^https:\/\/(www\.)?google\.com\/maps/.test(v) || /^https:\/\/maps\.app\.goo\.gl\//.test(v), 'Must be a Google Maps link')
    .optional(),
  instagram: z.string().trim().max(80).optional(),
});

export const bookingSettingsSchema = z.object({
  paymentWindowMinutes: z.number().int().min(15).max(72 * 60),
  minLeadHours: z.number().int().min(0).max(24 * 30),
  pickupEnabled: z.boolean(),
  deliveryEnabled: z.boolean(),
  deliveryFee: moneySchema,
  instructions: z.string().trim().max(2000),
  cancellationHours: z.number().int().min(0).max(24 * 30),
});

export const tenantSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  tagline: z.string().nullable(),
  status: tenantStatusSchema,
  ownerUserId: z.string().uuid(),
  timezone: z.string(),
  currency: z.string(),
  locale: z.string(),
  customDomain: z.string().nullable(),
  logoUrl: z.string().nullable(),
  contact: tenantContactSchema,
  bookingSettings: bookingSettingsSchema,
  suspendedReason: z.string().nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

export const updateTenantBody = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  tagline: z.string().trim().max(160).nullable().optional(),
  locale: z.enum(['id', 'en']).optional(),
  logoUrl: z.string().url().nullable().optional(),
  contact: tenantContactSchema.optional(),
});

export const updateBookingSettingsBody = bookingSettingsSchema.partial();

export const changeSlugBody = z.object({ slug: z.string().trim().toLowerCase() });

/** Storefront-safe view of a tenant (no owner id, no internal flags). */
export const publicTenantSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  tagline: z.string().nullable(),
  logoUrl: z.string().nullable(),
  timezone: z.string(),
  currency: z.string(),
  locale: z.string(),
  contact: tenantContactSchema,
  bookingSettings: bookingSettingsSchema,
});

export const directoryTenantSchema = z.object({
  slug: z.string(),
  name: z.string(),
  tagline: z.string().nullable(),
  logoUrl: z.string().nullable(),
  city: z.string().nullable(),
  coverImageUrl: z.string().nullable(),
  listingCount: z.number().int(),
});

export const directoryQuery = z.object({
  q: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(60).default(24),
});

export const memberSchema = z.object({
  userId: z.string().uuid(),
  email: z.string(),
  name: z.string(),
  role: z.enum(['owner', 'staff']),
  joinedAt: isoDate,
  lastLoginAt: isoDateNullable,
});

export const invitationSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  role: z.enum(['owner', 'staff']),
  expiresAt: isoDate,
  createdAt: isoDate,
});

export const membersResponse = z.object({ members: z.array(memberSchema), invitations: z.array(invitationSchema) });

export const inviteMemberBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(['owner', 'staff']).default('staff'),
});

export const memberParams = z.object({ userId: z.string().uuid() });
export const invitationIdParams = z.object({ id: z.string().uuid() });
