import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { pages, siteConfigVersions, siteConfigs } from '../../db/schema/index.js';
import { audit } from '../../lib/audit.js';
import { conflict, notFound } from '../../lib/errors.js';
import { signScopedToken } from '../../lib/jwt.js';
import { clientIp } from '../../lib/rate-limit.js';
import { revalidateTenant } from '../../lib/revalidate.js';
import { createRouter } from '../../lib/route.js';
import { isoDate, isoDateNullable } from '../../lib/schemas.js';
import { requireAuth, requireTrustedOrigin } from '../../middleware/auth.js';
import { authOf, resolveTenant, tenantOf } from '../../middleware/tenant.js';
import {
  BLOCK_META,
  BLOCK_TYPES,
  defaultSiteConfig,
  migrateSiteConfig,
  normalizeSiteConfig,
  parseSiteConfigLenient,
  SITE_SCHEMA_VERSION,
  siteConfigSchema,
  type SiteConfig,
} from './site-schema.js';

const { router, route } = createRouter('/v1/admin', {
  tag: 'Admin',
  auth: 'cookie',
  middlewares: [requireTrustedOrigin, requireAuth, resolveTenant],
});

export const siteConfigStateSchema = z.object({
  draft: siteConfigSchema,
  published: siteConfigSchema.nullable(),
  draftVersion: z.number().int(),
  publishedVersion: z.number().int().nullable(),
  publishedAt: isoDateNullable,
  draftUpdatedAt: isoDate,
  hasUnpublishedChanges: z.boolean(),
});

/**
 * Loads the tenant's config, creating a default one if missing. Version-1 drafts (home-page
 * sections + rich-text pages stored in the `pages` table) are migrated to version 2 in place.
 */
async function loadOrInit(tenantId: string, tenantName: string) {
  let row = await db.query.siteConfigs.findFirst({ where: eq(siteConfigs.tenantId, tenantId) });
  if (!row) {
    [row] = await db.insert(siteConfigs).values({ tenantId, draft: defaultSiteConfig({ tenantName }) }).returning();
  }
  const draftVersion = (row!.draft as { schemaVersion?: number } | null)?.schemaVersion;
  if (draftVersion !== SITE_SCHEMA_VERSION) {
    const legacy = await db.query.pages.findMany({ where: eq(pages.tenantId, tenantId), orderBy: [asc(pages.sortOrder), asc(pages.createdAt)] });
    const extra = legacy.map((p) => ({ slug: p.slug, title: p.title, content: p.content, seo: p.seo }));
    const draft = parseSiteConfigLenient(migrateSiteConfig(row!.draft, extra));
    const published = row!.published ? parseSiteConfigLenient(migrateSiteConfig(row!.published, extra.filter((e) => legacy.find((l) => l.slug === e.slug)?.status === 'published'))) : null;
    [row] = await db.update(siteConfigs).set({ draft, published, draftVersion: row!.draftVersion + 1 }).where(eq(siteConfigs.id, row!.id)).returning();
  }
  return row!;
}

const toState = (row: typeof siteConfigs.$inferSelect) => ({
  draft: parseSiteConfigLenient(row.draft),
  published: row.published ? parseSiteConfigLenient(row.published) : null,
  draftVersion: row.draftVersion,
  publishedVersion: row.publishedVersion,
  publishedAt: row.publishedAt,
  draftUpdatedAt: row.draftUpdatedAt,
  hasUnpublishedChanges: !row.publishedAt || row.draftUpdatedAt.getTime() > row.publishedAt.getTime(),
});

route({ method: 'get', path: '/site-config', operationId: 'adminGetSiteConfig', summary: 'Draft and published storefront config', response: siteConfigStateSchema }, async (req) => {
  const tenant = tenantOf(req);
  return toState(await loadOrInit(tenant.id, tenant.name));
});

route(
  {
    method: 'put',
    path: '/site-config/draft',
    operationId: 'adminSaveSiteConfigDraft',
    summary: 'Replace the draft (autosaved by the builder)',
    body: z.object({ draft: siteConfigSchema, baseVersion: z.number().int().optional() }),
    response: siteConfigStateSchema,
  },
  async (req) => {
    const tenant = tenantOf(req);
    const row = await loadOrInit(tenant.id, tenant.name);
    if (req.valid.body.baseVersion !== undefined && req.valid.body.baseVersion !== row.draftVersion) {
      throw conflict('The draft was changed elsewhere; reload to continue editing', 'DRAFT_STALE');
    }
    const draft: SiteConfig = normalizeSiteConfig(req.valid.body.draft);
    const slugs = draft.pages.map((p) => p.slug);
    if (new Set(slugs).size !== slugs.length) throw conflict('Two pages share the same slug', 'PAGE_SLUG_DUPLICATE');
    const [updated] = await db
      .update(siteConfigs)
      .set({ draft, draftVersion: row.draftVersion + 1, draftUpdatedAt: new Date() })
      .where(eq(siteConfigs.id, row.id))
      .returning();
    return toState(updated!);
  },
);

route({ method: 'post', path: '/site-config/publish', operationId: 'adminPublishSiteConfig', summary: 'Publish the current draft and revalidate the storefront', response: siteConfigStateSchema }, async (req) => {
  const tenant = tenantOf(req);
  const auth = authOf(req);
  const row = await loadOrInit(tenant.id, tenant.name);
  const draft = parseSiteConfigLenient(row.draft);
  const version = (row.publishedVersion ?? 0) + 1;
  const updated = await db.transaction(async (tx) => {
    const [u] = await tx.update(siteConfigs).set({ published: draft, publishedVersion: version, publishedAt: new Date() }).where(eq(siteConfigs.id, row.id)).returning();
    await tx.insert(siteConfigVersions).values({ tenantId: tenant.id, version, snapshot: draft, publishedBy: auth.userId });
    return u!;
  });
  await audit(db, { tenantId: tenant.id, actorUserId: auth.userId, action: 'site.publish', entityType: 'site_config', entityId: row.id, diff: { version }, ip: clientIp(req) });
  revalidateTenant(tenant.slug);
  return toState(updated);
});

route({ method: 'post', path: '/site-config/unpublish', operationId: 'adminUnpublishSiteConfig', summary: 'Take the storefront offline (shows a coming-soon page)', response: siteConfigStateSchema }, async (req) => {
  const tenant = tenantOf(req);
  const auth = authOf(req);
  const row = await loadOrInit(tenant.id, tenant.name);
  const [updated] = await db.update(siteConfigs).set({ published: null, publishedAt: null }).where(eq(siteConfigs.id, row.id)).returning();
  await audit(db, { tenantId: tenant.id, actorUserId: auth.userId, action: 'site.unpublish', entityType: 'site_config', entityId: row.id, ip: clientIp(req) });
  revalidateTenant(tenant.slug);
  return toState(updated!);
});

route(
  {
    method: 'get',
    path: '/site-config/versions',
    operationId: 'adminListSiteConfigVersions',
    summary: 'Published version history',
    response: z.array(z.object({ version: z.number().int(), createdAt: isoDate, publishedBy: z.string().uuid().nullable() })),
  },
  async (req) => {
    const tenant = tenantOf(req);
    return db.query.siteConfigVersions.findMany({ where: eq(siteConfigVersions.tenantId, tenant.id), orderBy: [desc(siteConfigVersions.version)], columns: { version: true, createdAt: true, publishedBy: true }, limit: 50 });
  },
);

route(
  {
    method: 'post',
    path: '/site-config/versions/:version/restore',
    operationId: 'adminRestoreSiteConfigVersion',
    summary: 'Copy a published version into the draft (does not publish)',
    params: z.object({ version: z.coerce.number().int().min(1) }),
    response: siteConfigStateSchema,
  },
  async (req) => {
    const tenant = tenantOf(req);
    const v = await db.query.siteConfigVersions.findFirst({ where: and(eq(siteConfigVersions.tenantId, tenant.id), eq(siteConfigVersions.version, req.valid.params.version)) });
    if (!v) throw notFound('Version not found');
    const row = await loadOrInit(tenant.id, tenant.name);
    const [updated] = await db.update(siteConfigs).set({ draft: parseSiteConfigLenient(v.snapshot), draftVersion: row.draftVersion + 1, draftUpdatedAt: new Date() }).where(eq(siteConfigs.id, row.id)).returning();
    return toState(updated!);
  },
);

route(
  {
    method: 'post',
    path: '/site-config/preview-token',
    operationId: 'adminPreviewToken',
    summary: 'Short-lived token that lets the storefront render the draft in the builder preview iframe',
    response: z.object({ token: z.string(), expiresInSeconds: z.number().int() }),
  },
  async (req) => {
    const tenant = tenantOf(req);
    const ttl = 2 * 3600;
    return { token: await signScopedToken('preview', { tenantId: tenant.id, slug: tenant.slug }, ttl), expiresInSeconds: ttl };
  },
);

route(
  {
    method: 'get',
    path: '/site-config/blocks',
    operationId: 'adminBlockCatalog',
    summary: 'Block types available in the builder, with labels and categories',
    response: z.array(z.object({ type: z.string(), label: z.string(), description: z.string(), category: z.enum(['layout', 'content', 'store', 'marketing']) })),
  },
  async () => BLOCK_TYPES.map((type) => ({ type, ...BLOCK_META[type] })),
);

export const adminSiteRouter = router;
export type { SiteConfig };
