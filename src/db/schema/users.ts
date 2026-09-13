import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { citext, id, timestamps } from './_common.js';
import { userRole, userStatus } from './enums.js';

export const users = pgTable(
  'users',
  {
    id: id(),
    email: citext().notNull().unique(),
    passwordHash: text().notNull(),
    name: text().notNull(),
    role: userRole().notNull().default('owner'),
    status: userStatus().notNull().default('active'),
    locale: text().notNull().default('id'),
    lastLoginAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text().notNull().unique(),
    familyId: uuid().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
    replacedBy: uuid(),
    userAgent: text(),
    ip: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('refresh_tokens_user_idx').on(t.userId), index('refresh_tokens_family_idx').on(t.familyId)],
);

export const passwordResets = pgTable(
  'password_resets',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text().notNull().unique(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    usedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('password_resets_user_idx').on(t.userId)],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type RefreshToken = typeof refreshTokens.$inferSelect;
