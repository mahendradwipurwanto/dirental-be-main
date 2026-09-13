import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps } from './_common.js';
import { pageStatus } from './enums.js';
import type { RichText } from './listings.js';
import { tenants } from './tenants.js';
import { users } from './users.js';
import type { SiteConfig } from '../../modules/site-config/site-schema.js';

export const siteConfigs = pgTable(
  'site_configs',
  {
    id: id(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' })
      .unique(),
    draft: jsonb().$type<SiteConfig>().notNull(),
    published: jsonb().$type<SiteConfig>(),
    draftVersion: integer().notNull().default(1),
    publishedVersion: integer(),
    publishedAt: timestamp({ withTimezone: true }),
    draftUpdatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    ...timestamps,
  },
);

export const siteConfigVersions = pgTable(
  'site_config_versions',
  {
    id: id(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    version: integer().notNull(),
    snapshot: jsonb().$type<SiteConfig>().notNull(),
    publishedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('site_config_versions_tenant_version_uq').on(t.tenantId, t.version)],
);

export type PageSeo = { title?: string; description?: string; noindex?: boolean };

export const pages = pgTable(
  'pages',
  {
    id: id(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    slug: text().notNull(),
    title: text().notNull(),
    content: jsonb().$type<RichText>().notNull(),
    status: pageStatus().notNull().default('draft'),
    seo: jsonb().$type<PageSeo>().notNull().default({}),
    sortOrder: integer().notNull().default(0),
    publishedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('pages_tenant_slug_uq').on(t.tenantId, t.slug), index('pages_tenant_status_idx').on(t.tenantId, t.status)],
);

export type SiteConfigRow = typeof siteConfigs.$inferSelect;
export type Page = typeof pages.$inferSelect;
export type NewPage = typeof pages.$inferInsert;
