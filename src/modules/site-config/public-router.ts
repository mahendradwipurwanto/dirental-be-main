import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { siteConfigs } from '../../db/schema/index.js';
import { notFound, unauthorized } from '../../lib/errors.js';
import { verifyScopedToken } from '../../lib/jwt.js';
import { createRouter } from '../../lib/route.js';
import { loadPublicTenant, publicSiteResponse, toPublicTenant } from '../public/router.js';
import { listBankAccounts, toBankAccountDto } from '../bank-accounts/router.js';
import { HOME_SLUG, pageSchema, parseSiteConfigLenient } from './site-schema.js';

const { router, route } = createRouter('/v1/public', { tag: 'Public', auth: 'none', middlewares: [loadPublicTenant] });

async function publishedConfig(tenantId: string) {
  const cfg = await db.query.siteConfigs.findFirst({ where: eq(siteConfigs.tenantId, tenantId) });
  return cfg?.published ? parseSiteConfigLenient(cfg.published) : null;
}

route(
  {
    method: 'get',
    path: '/tenants/:slug/pages/:pageSlug',
    operationId: 'publicPage',
    summary: 'A published custom page (blocks)',
    params: z.object({ slug: z.string(), pageSlug: z.string().min(1).max(80) }),
    response: pageSchema,
  },
  async (req, res) => {
    const cfg = await publishedConfig(req.publicTenant!.id);
    const page = cfg?.pages.find((p) => p.slug === req.valid.params.pageSlug && p.slug !== HOME_SLUG);
    if (!page) throw notFound('Page not found', 'PAGE_NOT_FOUND');
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    return page;
  },
);

route(
  {
    method: 'get',
    path: '/tenants/:slug/pages',
    operationId: 'publicPages',
    summary: 'Published page list (for navigation and sitemaps)',
    params: z.object({ slug: z.string() }),
    response: z.array(z.object({ slug: z.string(), title: z.string() })),
  },
  async (req, res) => {
    const cfg = await publishedConfig(req.publicTenant!.id);
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    return (cfg?.pages ?? []).filter((p) => p.slug !== HOME_SLUG && !p.seo.noindex).map((p) => ({ slug: p.slug, title: p.title }));
  },
);

route(
  {
    method: 'get',
    path: '/tenants/:slug/draft-site',
    operationId: 'publicDraftSite',
    summary: 'Draft storefront bundle for the builder preview (requires a preview token)',
    params: z.object({ slug: z.string() }),
    query: z.object({ token: z.string().min(10) }),
    response: publicSiteResponse,
  },
  async (req, res) => {
    const tenant = req.publicTenant!;
    const claims = await verifyScopedToken<{ tenantId: string }>('preview', req.valid.query.token);
    if (!claims || claims.tenantId !== tenant.id) throw unauthorized('Invalid preview token', 'PREVIEW_TOKEN_INVALID');
    res.setHeader('Cache-Control', 'no-store');
    const [cfg, accounts] = await Promise.all([db.query.siteConfigs.findFirst({ where: eq(siteConfigs.tenantId, tenant.id) }), listBankAccounts(tenant.id, true)]);
    return {
      tenant: toPublicTenant(tenant),
      config: cfg ? parseSiteConfigLenient(cfg.draft) : null,
      publishedAt: cfg?.publishedAt ?? null,
      bankAccounts: accounts.map((a) => {
        const { isActive: _a, sortOrder: _s, createdAt: _c, ...pub } = toBankAccountDto(a);
        return pub;
      }),
    };
  },
);

export const publicSiteRouter = router;
