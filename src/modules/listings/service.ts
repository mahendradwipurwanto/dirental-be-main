import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { db, type DbOrTx } from '../../db/client.js';
import {
  listingCategories,
  listingImages,
  listings,
  type Listing,
  type ListingCategory,
  type ListingImage,
  type ListingStatus,
} from '../../db/schema/index.js';
import { conflict, notFound, unprocessable } from '../../lib/errors.js';
import { IMAGE_CONTENT_TYPES, publicUrl, verifyObject } from '../../lib/storage.js';
import { slugify, uniqueSlug } from '../../lib/slug.js';
import type { z } from 'zod';
import type { createListingBody, listListingsQuery, updateListingBody } from './schemas.js';

type ListingWithRelations = Listing & { images: ListingImage[]; category: ListingCategory | null };

export function toListingDto(l: ListingWithRelations) {
  return {
    id: l.id,
    slug: l.slug,
    name: l.name,
    summary: l.summary,
    description: l.description,
    category: l.category ? { id: l.category.id, slug: l.category.slug, name: l.category.name } : null,
    status: l.status,
    stockQuantity: l.stockQuantity,
    pricePerHour: l.pricePerHour,
    pricePerDay: l.pricePerDay,
    minHours: l.minHours,
    minDays: l.minDays,
    maxDays: l.maxDays,
    depositAmount: l.depositAmount,
    pickupEnabled: l.pickupEnabled,
    deliveryEnabled: l.deliveryEnabled,
    bufferMinutes: l.bufferMinutes,
    isFeatured: l.isFeatured,
    sortOrder: l.sortOrder,
    attributes: l.attributes,
    images: [...l.images].sort((a, b) => a.sortOrder - b.sortOrder).map(toImageDto),
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
  };
}

export const toImageDto = (i: ListingImage) => ({
  id: i.id,
  url: i.url,
  pathname: i.pathname,
  alt: i.alt,
  width: i.width,
  height: i.height,
  sortOrder: i.sortOrder,
});

export const toPublicListingDto = (l: ListingWithRelations) => {
  const { status: _s, sortOrder: _o, createdAt: _c, updatedAt: _u, ...rest } = toListingDto(l);
  return rest;
};

const withRelations = { images: true, category: true } as const;

async function slugExists(tenantId: string, slug: string, excludeId?: string) {
  const row = await db.query.listings.findFirst({
    where: and(eq(listings.tenantId, tenantId), eq(listings.slug, slug), excludeId ? sql`${listings.id} <> ${excludeId}` : undefined),
    columns: { id: true },
  });
  return Boolean(row);
}

export async function listListings(tenantId: string, query: z.infer<typeof listListingsQuery>) {
  const filters: SQL[] = [eq(listings.tenantId, tenantId)];
  if (query.status) filters.push(eq(listings.status, query.status));
  if (query.categoryId) filters.push(eq(listings.categoryId, query.categoryId));
  if (query.q) filters.push(or(ilike(listings.name, `%${query.q}%`), ilike(listings.slug, `%${query.q}%`))!);
  const where = and(...filters);

  const [rows, [{ total = 0 } = {}]] = await Promise.all([
    db.query.listings.findMany({
      where,
      with: withRelations,
      orderBy: [asc(listings.sortOrder), desc(listings.createdAt)],
      limit: query.pageSize,
      offset: (query.page - 1) * query.pageSize,
    }),
    db.select({ total: count() }).from(listings).where(where),
  ]);
  return { items: rows.map(toListingDto), total, page: query.page, pageSize: query.pageSize };
}

export async function getListing(tenantId: string, id: string) {
  const row = await db.query.listings.findFirst({ where: and(eq(listings.tenantId, tenantId), eq(listings.id, id)), with: withRelations });
  if (!row) throw notFound('Listing not found', 'LISTING_NOT_FOUND');
  return row;
}

async function assertCategory(tenantId: string, categoryId: string | null | undefined) {
  if (!categoryId) return;
  const cat = await db.query.listingCategories.findFirst({ where: and(eq(listingCategories.tenantId, tenantId), eq(listingCategories.id, categoryId)), columns: { id: true } });
  if (!cat) throw unprocessable('Category not found', [{ path: 'body.categoryId', message: 'Unknown category' }]);
}

export async function createListing(tenantId: string, input: z.infer<typeof createListingBody>) {
  await assertCategory(tenantId, input.categoryId);
  const slug = input.slug ? slugify(input.slug) : await uniqueSlug(input.name, (s) => slugExists(tenantId, s));
  if (!slug) throw unprocessable('Slug is invalid', [{ path: 'body.slug', message: 'Invalid slug' }]);
  if (input.slug && (await slugExists(tenantId, slug))) throw conflict('A listing with this slug already exists', 'SLUG_TAKEN');

  const [row] = await db
    .insert(listings)
    .values({ ...input, slug, tenantId, categoryId: input.categoryId ?? null, summary: input.summary ?? null, description: input.description ?? null, maxDays: input.maxDays ?? null })
    .returning();
  if (!row) throw new Error('Failed to create listing');
  return getListing(tenantId, row.id);
}

export async function updateListing(tenantId: string, id: string, input: z.infer<typeof updateListingBody>) {
  const existing = await getListing(tenantId, id);
  await assertCategory(tenantId, input.categoryId);

  const patch: Partial<typeof listings.$inferInsert> = { ...input };
  if (input.slug !== undefined) {
    const slug = slugify(input.slug);
    if (!slug) throw unprocessable('Slug is invalid', [{ path: 'body.slug', message: 'Invalid slug' }]);
    if (slug !== existing.slug && (await slugExists(tenantId, slug, id))) throw conflict('A listing with this slug already exists', 'SLUG_TAKEN');
    patch.slug = slug;
  }
  const pricePerHour = input.pricePerHour === undefined ? existing.pricePerHour : input.pricePerHour;
  const pricePerDay = input.pricePerDay === undefined ? existing.pricePerDay : input.pricePerDay;
  if (pricePerHour == null && pricePerDay == null) {
    throw unprocessable('Set a price per hour, per day, or both', [{ path: 'body.pricePerDay', message: 'At least one price is required' }]);
  }

  await db.update(listings).set(patch).where(and(eq(listings.tenantId, tenantId), eq(listings.id, id)));
  return getListing(tenantId, id);
}

export async function setListingStatus(tenantId: string, id: string, status: ListingStatus) {
  const existing = await getListing(tenantId, id);
  if (status === 'active' && existing.images.length === 0) {
    throw unprocessable('Add at least one photo before publishing', [{ path: 'images', message: 'At least one image required' }], 'NO_IMAGES');
  }
  await db.update(listings).set({ status }).where(eq(listings.id, id));
  return getListing(tenantId, id);
}

/** Deletes a listing that has never been booked; otherwise the FK on booking_items rejects it and we archive instead. */
export async function deleteListing(tenantId: string, id: string): Promise<{ deleted: boolean; images: string[] }> {
  const existing = await getListing(tenantId, id);
  try {
    await db.delete(listings).where(and(eq(listings.tenantId, tenantId), eq(listings.id, id)));
    return { deleted: true, images: existing.images.map((i) => i.pathname) };
  } catch (err) {
    const code = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
    if (code === '23503') {
      await db.update(listings).set({ status: 'archived' }).where(eq(listings.id, id));
      return { deleted: false, images: [] };
    }
    throw err;
  }
}

export async function reorderListings(tenantId: string, ids: string[]) {
  await db.transaction(async (tx) => {
    for (const [i, id] of ids.entries()) {
      await tx.update(listings).set({ sortOrder: i }).where(and(eq(listings.tenantId, tenantId), eq(listings.id, id)));
    }
  });
}

// ---------- images ----------

export async function addImage(tenantId: string, listingId: string, input: { key: string; alt?: string | null; width?: number | null; height?: number | null }) {
  const listing = await getListing(tenantId, listingId);
  if (listing.images.length >= 12) throw unprocessable('A listing can have at most 12 photos', [{ path: 'images', message: 'Too many images' }]);
  if (!input.key.startsWith(`public/tenants/${tenantId}/`)) throw unprocessable('Image does not belong to this tenant', [{ path: 'body.key', message: 'Invalid key' }]);
  await verifyObject(input.key, IMAGE_CONTENT_TYPES);
  const [img] = await db
    .insert(listingImages)
    .values({ listingId, url: publicUrl(input.key), pathname: input.key, alt: input.alt ?? null, width: input.width ?? null, height: input.height ?? null, sortOrder: listing.images.length })
    .returning();
  return img!;
}

export async function removeImage(tenantId: string, listingId: string, imageId: string) {
  await getListing(tenantId, listingId);
  const [img] = await db.delete(listingImages).where(and(eq(listingImages.listingId, listingId), eq(listingImages.id, imageId))).returning();
  if (!img) throw notFound('Image not found');
  return img;
}

export async function reorderImages(tenantId: string, listingId: string, imageIds: string[]) {
  const listing = await getListing(tenantId, listingId);
  const known = new Set(listing.images.map((i) => i.id));
  if (!imageIds.every((id) => known.has(id))) throw unprocessable('Unknown image id', [{ path: 'body.imageIds', message: 'Contains an image that is not on this listing' }]);
  await db.transaction(async (tx) => {
    for (const [i, id] of imageIds.entries()) {
      await tx.update(listingImages).set({ sortOrder: i }).where(eq(listingImages.id, id));
    }
  });
}

// ---------- categories ----------

export async function listCategories(dbx: DbOrTx, tenantId: string) {
  return dbx.query.listingCategories.findMany({ where: eq(listingCategories.tenantId, tenantId), orderBy: [asc(listingCategories.sortOrder), asc(listingCategories.name)] });
}

export async function createCategory(tenantId: string, input: { name: string; slug?: string }) {
  const existing = await listCategories(db, tenantId);
  if (existing.length >= 50) throw unprocessable('Too many categories', [{ path: 'body', message: 'Limit 50' }]);
  const taken = new Set(existing.map((c) => c.slug));
  const slug = input.slug ? slugify(input.slug) : await uniqueSlug(input.name, async (s) => taken.has(s));
  if (!slug) throw unprocessable('Slug is invalid', [{ path: 'body.slug', message: 'Invalid slug' }]);
  if (taken.has(slug)) throw conflict('Category slug already exists', 'SLUG_TAKEN');
  const [row] = await db.insert(listingCategories).values({ tenantId, name: input.name, slug, sortOrder: existing.length }).returning();
  return row!;
}

export async function updateCategory(tenantId: string, id: string, input: { name?: string; slug?: string }) {
  const patch: Partial<typeof listingCategories.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.slug !== undefined) {
    const slug = slugify(input.slug);
    if (!slug) throw unprocessable('Slug is invalid', [{ path: 'body.slug', message: 'Invalid slug' }]);
    const dup = await db.query.listingCategories.findFirst({ where: and(eq(listingCategories.tenantId, tenantId), eq(listingCategories.slug, slug), sql`${listingCategories.id} <> ${id}`), columns: { id: true } });
    if (dup) throw conflict('Category slug already exists', 'SLUG_TAKEN');
    patch.slug = slug;
  }
  const [row] = await db.update(listingCategories).set(patch).where(and(eq(listingCategories.tenantId, tenantId), eq(listingCategories.id, id))).returning();
  if (!row) throw notFound('Category not found');
  return row;
}

export async function deleteCategory(tenantId: string, id: string) {
  const [row] = await db.delete(listingCategories).where(and(eq(listingCategories.tenantId, tenantId), eq(listingCategories.id, id))).returning();
  if (!row) throw notFound('Category not found');
}

export async function reorderCategories(tenantId: string, ids: string[]) {
  await db.transaction(async (tx) => {
    for (const [i, id] of ids.entries()) {
      await tx.update(listingCategories).set({ sortOrder: i }).where(and(eq(listingCategories.tenantId, tenantId), eq(listingCategories.id, id)));
    }
  });
}

// ---------- public ----------

export async function publicListings(tenantId: string, query: { category?: string; featured?: boolean; q?: string; limit: number }) {
  const filters: SQL[] = [eq(listings.tenantId, tenantId), eq(listings.status, 'active')];
  if (query.featured) filters.push(eq(listings.isFeatured, true));
  if (query.q) filters.push(or(ilike(listings.name, `%${query.q}%`), ilike(listings.summary, `%${query.q}%`))!);
  const categories = await listCategories(db, tenantId);
  if (query.category) {
    const cat = categories.find((c) => c.slug === query.category);
    if (!cat) return { items: [], categories };
    filters.push(eq(listings.categoryId, cat.id));
  }
  const rows = await db.query.listings.findMany({
    where: and(...filters),
    with: withRelations,
    orderBy: [desc(listings.isFeatured), asc(listings.sortOrder), desc(listings.createdAt)],
    limit: query.limit,
  });
  return { items: rows.map((r) => { const { description: _d, ...card } = toPublicListingDto(r); return card; }), categories };
}

export async function publicListing(tenantId: string, slug: string) {
  const row = await db.query.listings.findFirst({ where: and(eq(listings.tenantId, tenantId), eq(listings.slug, slug), eq(listings.status, 'active')), with: withRelations });
  if (!row) throw notFound('Listing not found', 'LISTING_NOT_FOUND');
  return row;
}

export async function activeListingsByIds(dbx: DbOrTx, tenantId: string, ids: string[]) {
  if (ids.length === 0) return [];
  return dbx.query.listings.findMany({ where: and(eq(listings.tenantId, tenantId), inArray(listings.id, ids), eq(listings.status, 'active')), with: withRelations });
}
