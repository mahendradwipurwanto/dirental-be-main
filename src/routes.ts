import { Router } from 'express';
import { sql } from 'drizzle-orm';
import { db } from './db/client.js';
import { authRouter } from './modules/auth/router.js';
import { adminBankAccountsRouter } from './modules/bank-accounts/router.js';
import { adminBookingsRouter } from './modules/bookings/admin-router.js';
import { publicBookingsRouter } from './modules/bookings/public-router.js';
import { cronRouter } from './modules/cron/router.js';
import { adminListingsRouter } from './modules/listings/router.js';
import { metaRouter } from './modules/meta/router.js';
import { platformRouter } from './modules/platform/router.js';
import { publicRouter } from './modules/public/router.js';
import { publicSiteRouter } from './modules/site-config/public-router.js';
import { adminSiteRouter } from './modules/site-config/router.js';
import { adminTenantRouter } from './modules/tenants/router.js';

export const routes = Router();

routes.get('/healthz', async (_req, res, next) => {
  try {
    await db.execute(sql`select 1`);
    res.json({ ok: true, db: 'up', ts: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

routes.use('/auth', authRouter);
routes.use('/public', publicRouter);
routes.use('/public', publicBookingsRouter);
routes.use('/public', publicSiteRouter);
routes.use('/admin', adminTenantRouter);
routes.use('/admin', adminListingsRouter);
routes.use('/admin', adminBankAccountsRouter);
routes.use('/admin', adminBookingsRouter);
routes.use('/admin', adminSiteRouter);
routes.use('/platform', platformRouter);
routes.use('/internal', cronRouter);
routes.use('/meta', metaRouter);
