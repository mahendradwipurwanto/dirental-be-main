import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { attachDatabasePool } from '@vercel/functions';
import { env } from '../config/env.js';
import * as schema from './schema/index.js';

/**
 * One small pool per function instance. Fluid Compute reuses instances across requests, and
 * attachDatabasePool releases idle clients before the instance is suspended, so connections
 * do not leak against a self-hosted Postgres with a small max_connections.
 */
export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 3,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
  allowExitOnIdle: true,
});

if (env.VERCEL_ENV) {
  attachDatabasePool(pool);
}

export const db = drizzle({ client: pool, schema, casing: 'snake_case' });

export type Db = typeof db;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;
