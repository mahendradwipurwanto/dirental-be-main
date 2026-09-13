import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { defaultPlatformSettings, platformSettings } from '../../db/schema/index.js';
import { createRouter } from '../../lib/route.js';
import { BLOCK_META, BLOCK_TYPES, FONT_FAMILIES, ICONS, RADIUS_OPTIONS, RESERVED_SLUGS, siteConfigSchema, SITE_SCHEMA_VERSION, SLUG_REGEX } from '../site-config/site-schema.js';

const { router, route } = createRouter('/v1/meta', { tag: 'Meta', auth: 'none' });

route(
  {
    method: 'get',
    path: '/site-schema',
    operationId: 'metaSiteSchema',
    summary: 'Storefront schema facts: reserved slugs, block types, fonts, icons, and the JSON Schema of the site config',
    response: z.object({
      schemaVersion: z.number().int(),
      reservedSlugs: z.array(z.string()),
      slugPattern: z.string(),
      blockTypes: z.array(z.string()),
      blockMeta: z.record(z.string(), z.object({ label: z.string(), description: z.string(), category: z.string() })),
      fontFamilies: z.array(z.string()),
      radiusOptions: z.array(z.string()),
      icons: z.array(z.string()),
      jsonSchema: z.record(z.string(), z.unknown()),
    }),
  },
  async (_req, res) => {
    res.setHeader('Cache-Control', 'public, s-maxage=3600');
    return {
      schemaVersion: SITE_SCHEMA_VERSION,
      reservedSlugs: [...RESERVED_SLUGS],
      slugPattern: SLUG_REGEX.source,
      blockTypes: [...BLOCK_TYPES],
      blockMeta: BLOCK_META,
      fontFamilies: [...FONT_FAMILIES],
      radiusOptions: [...RADIUS_OPTIONS],
      icons: [...ICONS],
      jsonSchema: z.toJSONSchema(siteConfigSchema, { unrepresentable: 'any' }) as Record<string, unknown>,
    };
  },
);

route(
  {
    method: 'get',
    path: '/landing',
    operationId: 'metaLanding',
    summary: 'Landing page copy managed by the platform admin',
    response: z.object({ headline: z.string(), subheadline: z.string(), ctaLabel: z.string(), featuredTenantSlugs: z.array(z.string()) }),
  },
  async (_req, res) => {
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
    const row = await db.query.platformSettings.findFirst({ where: eq(platformSettings.id, 1) });
    return { ...defaultPlatformSettings.landing, ...(row?.data?.landing ?? {}) };
  },
);

export const metaRouter = router;
