import { z } from 'zod';
import { db } from '../../db/client.js';
import { audit } from '../../lib/audit.js';
import { assertUpload, buildKey, deleteObjectsLater, IMAGE_CONTENT_TYPES, presignUpload, publicUrl } from '../../lib/storage.js';
import { clientIp } from '../../lib/rate-limit.js';
import { revalidateListings } from '../../lib/revalidate.js';
import { createRouter } from '../../lib/route.js';
import { idParams, OK, okResponse } from '../../lib/schemas.js';
import { requireAuth, requireTrustedOrigin } from '../../middleware/auth.js';
import { authOf, resolveTenant, tenantOf } from '../../middleware/tenant.js';
import * as s from './schemas.js';
import * as svc from './service.js';

const { router, route } = createRouter('/v1/admin', {
  tag: 'Admin',
  auth: 'cookie',
  middlewares: [requireTrustedOrigin, requireAuth, resolveTenant],
});

const toCategoryDto = (c: { id: string; slug: string; name: string; sortOrder: number }) => ({ id: c.id, slug: c.slug, name: c.name, sortOrder: c.sortOrder });

// ---------- uploads ----------

route(
  {
    method: 'post',
    path: '/uploads/presign',
    operationId: 'adminPresignUpload',
    summary: 'Presigned PUT URL for a listing image, logo, or site asset (public storage)',
    description: 'Upload the file with `PUT uploadUrl` and the returned headers, then record it (e.g. `POST /listings/{id}/images` with `key`, or set `publicUrl` as the logo/image URL).',
    body: s.presignBody,
    response: s.presignResponse,
  },
  async (req) => {
    const tenant = tenantOf(req);
    const { kind, listingId, contentType, size } = req.valid.body;
    assertUpload(contentType, size, IMAGE_CONTENT_TYPES);
    const parts = kind === 'listing' ? ['tenants', tenant.id, 'listings', listingId ?? 'unassigned'] : kind === 'logo' ? ['tenants', tenant.id, 'logo'] : ['tenants', tenant.id, 'site'];
    const key = buildKey('public', parts, contentType);
    const presigned = await presignUpload(key, contentType);
    return { ...presigned, publicUrl: publicUrl(key) };
  },
);

// ---------- categories ----------

route({ method: 'get', path: '/categories', operationId: 'adminListCategories', summary: 'List categories', response: z.array(s.categorySchema) }, async (req) => {
  const rows = await svc.listCategories(db, tenantOf(req).id);
  return rows.map(toCategoryDto);
});

route(
  { method: 'post', path: '/categories', operationId: 'adminCreateCategory', summary: 'Create a category', body: s.createCategoryBody, response: s.categorySchema, status: 201 },
  async (req) => {
    const tenant = tenantOf(req);
    const row = await svc.createCategory(tenant.id, req.valid.body);
    revalidateListings(tenant.slug);
    return toCategoryDto(row);
  },
);

route(
  { method: 'patch', path: '/categories/:id', operationId: 'adminUpdateCategory', summary: 'Rename a category', params: idParams, body: s.updateCategoryBody, response: s.categorySchema },
  async (req) => {
    const tenant = tenantOf(req);
    const row = await svc.updateCategory(tenant.id, req.valid.params.id, req.valid.body);
    revalidateListings(tenant.slug);
    return toCategoryDto(row);
  },
);

route({ method: 'delete', path: '/categories/:id', operationId: 'adminDeleteCategory', summary: 'Delete a category (listings keep existing, uncategorised)', params: idParams, response: okResponse }, async (req) => {
  const tenant = tenantOf(req);
  await svc.deleteCategory(tenant.id, req.valid.params.id);
  revalidateListings(tenant.slug);
  return OK;
});

route({ method: 'post', path: '/categories/reorder', operationId: 'adminReorderCategories', summary: 'Reorder categories', body: s.reorderBody, response: okResponse }, async (req) => {
  const tenant = tenantOf(req);
  await svc.reorderCategories(tenant.id, req.valid.body.ids);
  revalidateListings(tenant.slug);
  return OK;
});

// ---------- listings ----------

route({ method: 'get', path: '/listings', operationId: 'adminListListings', summary: 'List listings (paginated)', query: s.listListingsQuery, response: s.listListingsResponse }, async (req) =>
  svc.listListings(tenantOf(req).id, req.valid.query),
);

route(
  { method: 'post', path: '/listings', operationId: 'adminCreateListing', summary: 'Create a listing', body: s.createListingBody, response: s.listingSchema, status: 201 },
  async (req) => {
    const tenant = tenantOf(req);
    const auth = authOf(req);
    const row = await svc.createListing(tenant.id, req.valid.body);
    await audit(db, { tenantId: tenant.id, actorUserId: auth.userId, action: 'listing.create', entityType: 'listing', entityId: row.id, ip: clientIp(req) });
    revalidateListings(tenant.slug, row.slug);
    return svc.toListingDto(row);
  },
);

route({ method: 'get', path: '/listings/:id', operationId: 'adminGetListing', summary: 'Get a listing', params: idParams, response: s.listingSchema }, async (req) =>
  svc.toListingDto(await svc.getListing(tenantOf(req).id, req.valid.params.id)),
);

route(
  { method: 'patch', path: '/listings/:id', operationId: 'adminUpdateListing', summary: 'Update a listing', params: idParams, body: s.updateListingBody, response: s.listingSchema },
  async (req) => {
    const tenant = tenantOf(req);
    const auth = authOf(req);
    const before = await svc.getListing(tenant.id, req.valid.params.id);
    const row = await svc.updateListing(tenant.id, req.valid.params.id, req.valid.body);
    await audit(db, { tenantId: tenant.id, actorUserId: auth.userId, action: 'listing.update', entityType: 'listing', entityId: row.id, diff: req.valid.body, ip: clientIp(req) });
    revalidateListings(tenant.slug, row.slug);
    if (before.slug !== row.slug) revalidateListings(tenant.slug, before.slug);
    return svc.toListingDto(row);
  },
);

for (const [action, status] of [
  ['publish', 'active'],
  ['unpublish', 'draft'],
  ['archive', 'archived'],
] as const) {
  route(
    { method: 'post', path: `/listings/:id/${action}`, operationId: `adminListing${action[0]!.toUpperCase()}${action.slice(1)}`, summary: `Set listing status to ${status}`, params: idParams, response: s.listingSchema },
    async (req) => {
      const tenant = tenantOf(req);
      const auth = authOf(req);
      const row = await svc.setListingStatus(tenant.id, req.valid.params.id, status);
      await audit(db, { tenantId: tenant.id, actorUserId: auth.userId, action: `listing.${action}`, entityType: 'listing', entityId: row.id, ip: clientIp(req) });
      revalidateListings(tenant.slug, row.slug);
      return svc.toListingDto(row);
    },
  );
}

route(
  {
    method: 'delete',
    path: '/listings/:id',
    operationId: 'adminDeleteListing',
    summary: 'Delete a listing; listings with bookings are archived instead',
    params: idParams,
    response: z.object({ deleted: z.boolean() }),
  },
  async (req) => {
    const tenant = tenantOf(req);
    const auth = authOf(req);
    const before = await svc.getListing(tenant.id, req.valid.params.id);
    const result = await svc.deleteListing(tenant.id, req.valid.params.id);
    if (result.images.length) deleteObjectsLater(result.images);
    await audit(db, { tenantId: tenant.id, actorUserId: auth.userId, action: result.deleted ? 'listing.delete' : 'listing.archive', entityType: 'listing', entityId: before.id, ip: clientIp(req) });
    revalidateListings(tenant.slug, before.slug);
    return { deleted: result.deleted };
  },
);

route({ method: 'post', path: '/listings/reorder', operationId: 'adminReorderListings', summary: 'Reorder listings', body: s.reorderBody, response: okResponse }, async (req) => {
  const tenant = tenantOf(req);
  await svc.reorderListings(tenant.id, req.valid.body.ids);
  revalidateListings(tenant.slug);
  return OK;
});

// ---------- images ----------

route(
  { method: 'post', path: '/listings/:id/images', operationId: 'adminAddListingImage', summary: 'Record an uploaded image', params: idParams, body: s.addImageBody, response: s.listingImageSchema, status: 201 },
  async (req) => {
    const tenant = tenantOf(req);
    const img = await svc.addImage(tenant.id, req.valid.params.id, req.valid.body);
    const listing = await svc.getListing(tenant.id, req.valid.params.id);
    revalidateListings(tenant.slug, listing.slug);
    return svc.toImageDto(img);
  },
);

route({ method: 'delete', path: '/listings/:id/images/:imageId', operationId: 'adminRemoveListingImage', summary: 'Remove an image', params: s.imageParams, response: okResponse }, async (req) => {
  const tenant = tenantOf(req);
  const img = await svc.removeImage(tenant.id, req.valid.params.id, req.valid.params.imageId);
  deleteObjectsLater([img.pathname]);
  const listing = await svc.getListing(tenant.id, req.valid.params.id);
  revalidateListings(tenant.slug, listing.slug);
  return OK;
});

route({ method: 'post', path: '/listings/:id/images/reorder', operationId: 'adminReorderListingImages', summary: 'Reorder images', params: idParams, body: s.reorderImagesBody, response: okResponse }, async (req) => {
  const tenant = tenantOf(req);
  await svc.reorderImages(tenant.id, req.valid.params.id, req.valid.body.imageIds);
  const listing = await svc.getListing(tenant.id, req.valid.params.id);
  revalidateListings(tenant.slug, listing.slug);
  return OK;
});

export const adminListingsRouter = router;
