import { customType, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Case-insensitive text (requires the `citext` extension, created in migration 0000). */
export const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'citext';
  },
});

export const id = () => uuid().primaryKey().defaultRandom();

export const timestamps = {
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp({ withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
};
