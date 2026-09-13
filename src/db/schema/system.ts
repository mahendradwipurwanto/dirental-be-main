import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { id } from './_common.js';
import { tenants } from './tenants.js';
import { users } from './users.js';

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    tenantId: uuid().references(() => tenants.id, { onDelete: 'cascade' }),
    actorUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
    action: text().notNull(),
    entityType: text().notNull(),
    entityId: text(),
    diff: jsonb().$type<Record<string, unknown>>(),
    ip: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('audit_logs_tenant_created_idx').on(t.tenantId, t.createdAt), index('audit_logs_actor_idx').on(t.actorUserId)],
);

/**
 * Fixed-window counters keyed by `${scope}:${subject}:${windowStart}`. Vercel instances are ephemeral,
 * so in-memory limiters cannot be the source of truth; a tiny table is enough at this scale.
 */
export const rateLimits = pgTable(
  'rate_limits',
  {
    key: text().primaryKey(),
    count: integer().notNull().default(0),
    windowStart: timestamp({ withTimezone: true }).notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [index('rate_limits_expires_idx').on(t.expiresAt)],
);

export type AuditLog = typeof auditLogs.$inferSelect;
