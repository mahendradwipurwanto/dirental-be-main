import { z } from 'zod';
import { isoDate, moneySchema, paginated, paginationQuery } from '../../lib/schemas.js';
import { richTextSchema } from '../site-config/site-schema.js';

export const listingStatusSchema = z.enum(['draft', 'active', 'archived']);

export const categorySchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  sortOrder: z.number().int(),
});

export const createCategoryBody = z.object({
  name: z.string().trim().min(1).max(60),
  slug: z.string().trim().toLowerCase().min(1).max(60).optional(),
});
export const updateCategoryBody = createCategoryBody.partial();
export const reorderBody = z.object({ ids: z.array(z.string().uuid()).min(1).max(200) });

export const listingImageSchema = z.object({
  id: z.string().uuid(),
  url: z.string(),
  pathname: z.string(),
  alt: z.string().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  sortOrder: z.number().int(),
});

const listingCore = {
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  summary: z.string().nullable(),
  description: richTextSchema.nullable(),
  category: categorySchema.pick({ id: true, slug: true, name: true }).nullable(),
  stockQuantity: z.number().int(),
  pricePerHour: z.number().int().nullable(),
  pricePerDay: z.number().int().nullable(),
  minHours: z.number().int(),
  minDays: z.number().int(),
  maxDays: z.number().int().nullable(),
  depositAmount: z.number().int(),
  pickupEnabled: z.boolean(),
  deliveryEnabled: z.boolean(),
  bufferMinutes: z.number().int(),
  isFeatured: z.boolean(),
  attributes: z.record(z.string(), z.string()),
  images: z.array(listingImageSchema),
};

export const listingSchema = z.object({
  ...listingCore,
  status: listingStatusSchema,
  sortOrder: z.number().int(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

/** Storefront view: only active listings are exposed, so no status/sortOrder. */
export const publicListingSchema = z.object(listingCore);
export const publicListingCardSchema = publicListingSchema.omit({ description: true });

const priceFields = {
  pricePerHour: moneySchema.nullable().optional(),
  pricePerDay: moneySchema.nullable().optional(),
};

export const createListingBody = z
  .object({
    name: z.string().trim().min(2).max(120),
    slug: z.string().trim().toLowerCase().max(80).optional(),
    categoryId: z.string().uuid().nullable().optional(),
    summary: z.string().trim().max(300).nullable().optional(),
    description: richTextSchema.nullable().optional(),
    status: listingStatusSchema.default('draft'),
    stockQuantity: z.number().int().min(0).max(10_000).default(1),
    ...priceFields,
    minHours: z.number().int().min(1).max(24).default(1),
    minDays: z.number().int().min(1).max(365).default(1),
    maxDays: z.number().int().min(1).max(365).nullable().optional(),
    depositAmount: moneySchema.default(0),
    pickupEnabled: z.boolean().default(true),
    deliveryEnabled: z.boolean().default(false),
    bufferMinutes: z.number().int().min(0).max(24 * 60).default(0),
    isFeatured: z.boolean().default(false),
    attributes: z.record(z.string().max(40), z.string().max(200)).default({}),
  })
  .refine((v) => (v.pricePerHour ?? null) !== null || (v.pricePerDay ?? null) !== null, {
    path: ['pricePerDay'],
    message: 'Set a price per hour, per day, or both',
  });

export const updateListingBody = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    slug: z.string().trim().toLowerCase().max(80).optional(),
    categoryId: z.string().uuid().nullable().optional(),
    summary: z.string().trim().max(300).nullable().optional(),
    description: richTextSchema.nullable().optional(),
    status: listingStatusSchema.optional(),
    stockQuantity: z.number().int().min(0).max(10_000).optional(),
    ...priceFields,
    minHours: z.number().int().min(1).max(24).optional(),
    minDays: z.number().int().min(1).max(365).optional(),
    maxDays: z.number().int().min(1).max(365).nullable().optional(),
    depositAmount: moneySchema.optional(),
    pickupEnabled: z.boolean().optional(),
    deliveryEnabled: z.boolean().optional(),
    bufferMinutes: z.number().int().min(0).max(24 * 60).optional(),
    isFeatured: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
    attributes: z.record(z.string().max(40), z.string().max(200)).optional(),
  })
  .strict();

export const listListingsQuery = paginationQuery.extend({
  status: listingStatusSchema.optional(),
  categoryId: z.string().uuid().optional(),
  q: z.string().trim().max(80).optional(),
});
export const listListingsResponse = paginated(listingSchema);

/** Records an object that the browser already uploaded to the presigned URL. */
export const addImageBody = z.object({
  key: z.string().min(1).max(500),
  alt: z.string().trim().max(160).nullable().optional(),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
});

export const presignBody = z.object({
  kind: z.enum(['listing', 'logo', 'site']),
  listingId: z.string().uuid().optional(),
  filename: z.string().trim().min(1).max(200),
  contentType: z.string().min(3).max(100),
  size: z.number().int().positive(),
});
export const presignResponse = z.object({
  key: z.string(),
  uploadUrl: z.string(),
  method: z.literal('PUT'),
  headers: z.record(z.string(), z.string()),
  expiresInSeconds: z.number().int(),
  /** Where the object will be readable once uploaded (public objects only). */
  publicUrl: z.string(),
});
export const reorderImagesBody = z.object({ imageIds: z.array(z.string().uuid()).min(1).max(30) });
export const imageParams = z.object({ id: z.string().uuid(), imageId: z.string().uuid() });

export const publicListingsQuery = z.object({
  category: z.string().trim().max(60).optional(),
  featured: z.coerce.boolean().optional(),
  q: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(60).default(24),
});
export const publicListingsResponse = z.object({
  items: z.array(publicListingCardSchema),
  categories: z.array(categorySchema.pick({ id: true, slug: true, name: true })),
});

