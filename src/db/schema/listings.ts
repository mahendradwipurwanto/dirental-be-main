import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { id, timestamps } from './_common.js';
import { listingStatus } from './enums.js';
import { tenants } from './tenants.js';

/** Tiptap/ProseMirror document JSON. Rendered server-side with a fixed extension set. */
export type RichText = { type: 'doc'; content?: unknown[] };

export const listingCategories = pgTable(
  'listing_categories',
  {
    id: id(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    slug: text().notNull(),
    name: text().notNull(),
    sortOrder: integer().notNull().default(0),
    ...timestamps,
  },
  (t) => [uniqueIndex('listing_categories_tenant_slug_uq').on(t.tenantId, t.slug)],
);

export const listings = pgTable(
  'listings',
  {
    id: id(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    categoryId: uuid().references(() => listingCategories.id, { onDelete: 'set null' }),
    slug: text().notNull(),
    name: text().notNull(),
    summary: text(),
    description: jsonb().$type<RichText>(),
    status: listingStatus().notNull().default('draft'),
    stockQuantity: integer().notNull().default(1),
    /** IDR per hour; null = hourly rental not offered. */
    pricePerHour: integer(),
    /** IDR per day; null = daily rental not offered. */
    pricePerDay: integer(),
    minHours: integer().notNull().default(1),
    minDays: integer().notNull().default(1),
    maxDays: integer(),
    depositAmount: integer().notNull().default(0),
    pickupEnabled: boolean().notNull().default(true),
    deliveryEnabled: boolean().notNull().default(false),
    /** Minutes of turnaround added after each booking before the unit is available again. */
    bufferMinutes: integer().notNull().default(0),
    isFeatured: boolean().notNull().default(false),
    sortOrder: integer().notNull().default(0),
    attributes: jsonb().$type<Record<string, string>>().notNull().default({}),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('listings_tenant_slug_uq').on(t.tenantId, t.slug),
    index('listings_tenant_status_idx').on(t.tenantId, t.status),
    check('listings_stock_nonneg', sql`${t.stockQuantity} >= 0`),
    check('listings_price_present', sql`${t.pricePerHour} IS NOT NULL OR ${t.pricePerDay} IS NOT NULL`),
    check('listings_price_nonneg', sql`coalesce(${t.pricePerHour}, 0) >= 0 AND coalesce(${t.pricePerDay}, 0) >= 0`),
  ],
);

export const listingImages = pgTable(
  'listing_images',
  {
    id: id(),
    listingId: uuid()
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    url: text().notNull(),
    pathname: text().notNull(),
    alt: text(),
    width: integer(),
    height: integer(),
    sortOrder: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('listing_images_listing_idx').on(t.listingId, t.sortOrder)],
);

export const availabilityBlocks = pgTable(
  'availability_blocks',
  {
    id: id(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    listingId: uuid()
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    startAt: timestamp({ withTimezone: true }).notNull(),
    endAt: timestamp({ withTimezone: true }).notNull(),
    /** Units blocked; null blocks every unit. */
    quantity: integer(),
    reason: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('availability_blocks_listing_idx').on(t.listingId),
    index('availability_blocks_range_gist').using('gist', sql`tstzrange(${t.startAt}, ${t.endAt}, '[)')`),
    check('availability_blocks_range_valid', sql`${t.endAt} > ${t.startAt}`),
  ],
);

export type Listing = typeof listings.$inferSelect;
export type NewListing = typeof listings.$inferInsert;
export type ListingCategory = typeof listingCategories.$inferSelect;
export type ListingImage = typeof listingImages.$inferSelect;
export type AvailabilityBlock = typeof availabilityBlocks.$inferSelect;
