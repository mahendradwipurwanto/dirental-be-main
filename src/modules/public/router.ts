import { and, count, desc, eq, ilike, or, sql } from 'drizzle-orm';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { listingImages, listings, siteConfigs, tenants, type Tenant } from '../../db/schema/index.js';
import { notFound } from '../../lib/errors.js';
import { createRouter } from '../../lib/route.js';
import { isoDateNullable } from '../../lib/schemas.js';
import { listBankAccounts, publicBankAccountSchema, toBankAccountDto } from '../bank-accounts/router.js';
import * as ls from '../listings/schemas.js';
import * as lsvc from '../listings/service.js';
import { parseSiteConfigLenient, siteConfigSchema } from '../site-config/site-schema.js';
import * as ts from '../tenants/schemas.js';

declare global {
  namespace Express {
    interface Request {
      publicTenant?: Tenant;
    }
  }
}

/** Loads an ACTIVE tenant by slug for storefront routes; anything else is a 404. */
const loadPublicTenant: RequestHandler = async (req, _res, next) => {
  const slug = String(req.params.slug ?? '').toLowerCase();
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, slug) });
  if (!tenant || tenant.status !== 'active') return next(notFound('Storefront not found', 'TENANT_NOT_FOUND'));
  req.publicTenant = tenant;
  next();
};

const cacheable: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
  next();
};

export const toPublicTenant = (t: Tenant) => ({
  id: t.id,
  slug: t.slug,
  name: t.name,
  tagline: t.tagline,
  logoUrl: t.logoUrl,
  timezone: t.timezone,
  currency: t.currency,
  locale: t.locale,
  contact: t.contact,
  bookingSettings: t.bookingSettings,
});

const slugParams = z.object({ slug: z.string().min(1).max(60) });
const listingSlugParams = slugParams.extend({ listingSlug: z.string().min(1).max(80) });

export const publicSiteResponse = z.object({
  tenant: ts.publicTenantSchema,
  config: siteConfigSchema.nullable(),
  publishedAt: isoDateNullable,
  bankAccounts: z.array(publicBankAccountSchema),
});

const { router, route } = createRouter('/v1/public', { tag: 'Public', auth: 'none' });

route(
  {
    method: 'get',
    path: '/tenants',
    operationId: 'publicDirectory',
    summary: 'Directory of active storefronts for the platform landing page',
    query: ts.directoryQuery,
    response: z.object({ items: z.array(ts.directoryTenantSchema) }),
    middlewares: [cacheable],
  },
  async (req) => {
    const { q, limit } = req.valid.query;
    const rows = await db
      .select({
        slug: tenants.slug,
        name: tenants.name,
        tagline: tenants.tagline,
        logoUrl: tenants.logoUrl,
        city: sql<string | null>`${tenants.contact} ->> 'city'`,
        listingCount: count(listings.id),
        coverImageUrl: sql<string | null>`(
          select li.url from ${listingImages} li
          join ${listings} l2 on l2.id = li.listing_id
          where l2.tenant_id = ${tenants.id} and l2.status = 'active'
          order by l2.is_featured desc, l2.sort_order asc, li.sort_order asc limit 1
        )`,
      })
      .from(tenants)
      .leftJoin(listings, and(eq(listings.tenantId, tenants.id), eq(listings.status, 'active')))
      .where(and(eq(tenants.status, 'active'), q ? or(ilike(tenants.name, `%${q}%`), ilike(tenants.tagline, `%${q}%`), sql`${tenants.contact} ->> 'city' ilike ${'%' + q + '%'}`) : undefined))
      .groupBy(tenants.id)
      .orderBy(desc(count(listings.id)), desc(tenants.createdAt))
      .limit(limit);
    return { items: rows };
  },
);

route(
  {
    method: 'get',
    path: '/tenants/:slug/site',
    operationId: 'publicSite',
    summary: 'Storefront bundle: tenant profile, published site config, bank accounts',
    params: slugParams,
    response: publicSiteResponse,
    middlewares: [loadPublicTenant, cacheable],
  },
  async (req) => {
    const tenant = req.publicTenant!;
    const [cfg, accounts] = await Promise.all([db.query.siteConfigs.findFirst({ where: eq(siteConfigs.tenantId, tenant.id) }), listBankAccounts(tenant.id, true)]);
    return {
      tenant: toPublicTenant(tenant),
      config: cfg?.published ? parseSiteConfigLenient(cfg.published) : null,
      publishedAt: cfg?.publishedAt ?? null,
      bankAccounts: accounts.map((a) => {
        const { isActive: _a, sortOrder: _s, createdAt: _c, ...pub } = toBankAccountDto(a);
        return pub;
      }),
    };
  },
);

route(
  {
    method: 'get',
    path: '/tenants/:slug/listings',
    operationId: 'publicListings',
    summary: 'Active listings for a storefront',
    params: slugParams,
    query: ls.publicListingsQuery,
    response: ls.publicListingsResponse,
    middlewares: [loadPublicTenant, cacheable],
  },
  async (req) => {
    const result = await lsvc.publicListings(req.publicTenant!.id, req.valid.query);
    return { items: result.items, categories: result.categories.map((c) => ({ id: c.id, slug: c.slug, name: c.name })) };
  },
);

route(
  {
    method: 'get',
    path: '/tenants/:slug/listings/:listingSlug',
    operationId: 'publicListing',
    summary: 'One active listing',
    params: listingSlugParams,
    response: ls.publicListingSchema,
    middlewares: [loadPublicTenant, cacheable],
  },
  async (req) => lsvc.toPublicListingDto(await lsvc.publicListing(req.publicTenant!.id, req.valid.params.listingSlug)),
);

export const publicRouter = router;
export { loadPublicTenant };
