import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { citext, id, timestamps } from './_common.js';
import { memberRole, tenantStatus } from './enums.js';
import { users } from './users.js';

export type TenantContact = {
  phone?: string;
  whatsapp?: string;
  email?: string;
  address?: string;
  city?: string;
  mapUrl?: string;
  instagram?: string;
};

export type BookingSettings = {
  /** Minutes a pending booking holds stock before it expires. */
  paymentWindowMinutes: number;
  /** Earliest a booking may start, in hours from now. */
  minLeadHours: number;
  pickupEnabled: boolean;
  deliveryEnabled: boolean;
  /** Flat delivery fee in IDR. */
  deliveryFee: number;
  /** Free-text payment instructions shown after checkout. */
  instructions: string;
  /** Hours the customer may cancel before start. */
  cancellationHours: number;
};

export const defaultBookingSettings: BookingSettings = {
  paymentWindowMinutes: 120,
  minLeadHours: 2,
  pickupEnabled: true,
  deliveryEnabled: false,
  deliveryFee: 0,
  instructions: '',
  cancellationHours: 24,
};

export const tenants = pgTable(
  'tenants',
  {
    id: id(),
    slug: citext().notNull().unique(),
    name: text().notNull(),
    tagline: text(),
    status: tenantStatus().notNull().default('active'),
    ownerUserId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    timezone: text().notNull().default('Asia/Jakarta'),
    currency: text().notNull().default('IDR'),
    locale: text().notNull().default('id'),
    customDomain: text(),
    logoUrl: text(),
    contact: jsonb().$type<TenantContact>().notNull().default({}),
    bookingSettings: jsonb().$type<BookingSettings>().notNull().default(defaultBookingSettings),
    suspendedReason: text(),
    ...timestamps,
  },
  (t) => [index('tenants_status_idx').on(t.status), index('tenants_owner_idx').on(t.ownerUserId)],
);

export const tenantMembers = pgTable(
  'tenant_members',
  {
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: memberRole().notNull().default('staff'),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.userId] }), index('tenant_members_user_idx').on(t.userId)],
);

export const invitations = pgTable(
  'invitations',
  {
    id: id(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    email: citext().notNull(),
    role: memberRole().notNull().default('staff'),
    tokenHash: text().notNull().unique(),
    invitedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    acceptedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('invitations_tenant_idx').on(t.tenantId)],
);

export const bankAccounts = pgTable(
  'bank_accounts',
  {
    id: id(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    bankName: text().notNull(),
    accountNumber: text().notNull(),
    holderName: text().notNull(),
    isPrimary: boolean().notNull().default(false),
    isActive: boolean().notNull().default(true),
    sortOrder: integer().notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index('bank_accounts_tenant_idx').on(t.tenantId),
    uniqueIndex('bank_accounts_primary_uq')
      .on(t.tenantId)
      .where(sql`${t.isPrimary} = true`),
  ],
);

export type PlatformSettings = {
  requireApproval: boolean;
  landing: {
    headline: string;
    subheadline: string;
    ctaLabel: string;
    featuredTenantSlugs: string[];
  };
};

export const defaultPlatformSettings: PlatformSettings = {
  requireApproval: false,
  landing: {
    headline: 'Sewa apa saja, dari siapa saja.',
    subheadline: 'Temukan penyedia rental terpercaya di sekitarmu, atau buka toko rentalmu sendiri dalam hitungan menit.',
    ctaLabel: 'Mulai rental',
    featuredTenantSlugs: [],
  },
};

export const platformSettings = pgTable('platform_settings', {
  id: integer().primaryKey().default(1),
  data: jsonb().$type<PlatformSettings>().notNull().default(defaultPlatformSettings),
  ...timestamps,
});

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
export type TenantMember = typeof tenantMembers.$inferSelect;
export type BankAccount = typeof bankAccounts.$inferSelect;
export type Invitation = typeof invitations.$inferSelect;
