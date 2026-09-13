import { and, count, desc, eq, ilike, inArray, or, sql, sum, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { bookings, defaultPlatformSettings, listings, platformSettings, tenantMembers, tenants, users, type PlatformSettings } from '../../db/schema/index.js';
import { audit } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';
import { hashPassword } from '../../lib/password.js';
import { clientIp } from '../../lib/rate-limit.js';
import { revalidateDirectory, revalidateTenant } from '../../lib/revalidate.js';
import { createRouter } from '../../lib/route.js';
import { idParams, isoDate, isoDateNullable, OK, okResponse, paginated, paginationQuery, passwordSchema } from '../../lib/schemas.js';
import { requireAuth, requireSuperadmin, requireTrustedOrigin } from '../../middleware/auth.js';
import { authOf } from '../../middleware/tenant.js';
import { revokeAllSessions } from '../auth/service.js';
import { toBookingDto } from '../bookings/service.js';
import { bookingSchema, listBookingsQuery } from '../bookings/schemas.js';
import { tenantSchema } from '../tenants/schemas.js';
import { toTenantDto } from '../tenants/router.js';

const { router, route } = createRouter('/v1/platform', {
  tag: 'Platform',
  auth: 'cookie',
  middlewares: [requireTrustedOrigin, requireAuth, requireSuperadmin],
});

const platformTenantSchema = tenantSchema.extend({
  ownerEmail: z.string(),
  ownerName: z.string(),
  listingCount: z.number().int(),
  bookingCount: z.number().int(),
});

const listTenantsQuery = paginationQuery.extend({
  status: z.enum(['pending', 'active', 'suspended', 'archived']).optional(),
  q: z.string().trim().max(80).optional(),
});

route({ method: 'get', path: '/tenants', operationId: 'platformListTenants', summary: 'All tenants', query: listTenantsQuery, response: paginated(platformTenantSchema) }, async (req) => {
  const q = req.valid.query;
  const filters: SQL[] = [];
  if (q.status) filters.push(eq(tenants.status, q.status));
  if (q.q) filters.push(or(ilike(tenants.name, `%${q.q}%`), ilike(tenants.slug, `%${q.q}%`), ilike(users.email, `%${q.q}%`))!);
  const where = filters.length ? and(...filters) : undefined;
  const base = db
    .select({
      tenant: tenants,
      ownerEmail: users.email,
      ownerName: users.name,
      listingCount: sql<number>`(select count(*) from ${listings} l where l.tenant_id = ${tenants.id})`.mapWith(Number),
      bookingCount: sql<number>`(select count(*) from ${bookings} b where b.tenant_id = ${tenants.id})`.mapWith(Number),
    })
    .from(tenants)
    .innerJoin(users, eq(users.id, tenants.ownerUserId))
    .where(where)
    .orderBy(desc(tenants.createdAt))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  const [rows, [{ total = 0 } = {}]] = await Promise.all([base, db.select({ total: count() }).from(tenants).innerJoin(users, eq(users.id, tenants.ownerUserId)).where(where)]);
  return { items: rows.map((r) => ({ ...toTenantDto(r.tenant), ownerEmail: r.ownerEmail, ownerName: r.ownerName, listingCount: r.listingCount, bookingCount: r.bookingCount })), total, page: q.page, pageSize: q.pageSize };
});

route({ method: 'get', path: '/tenants/:id', operationId: 'platformGetTenant', summary: 'Tenant detail', params: idParams, response: platformTenantSchema }, async (req) => {
  const row = await db.query.tenants.findFirst({ where: eq(tenants.id, req.valid.params.id), with: { owner: true } });
  if (!row) throw notFound('Tenant not found');
  const [[l], [b]] = await Promise.all([db.select({ n: count() }).from(listings).where(eq(listings.tenantId, row.id)), db.select({ n: count() }).from(bookings).where(eq(bookings.tenantId, row.id))]);
  return { ...toTenantDto(row), ownerEmail: row.owner.email, ownerName: row.owner.name, listingCount: l?.n ?? 0, bookingCount: b?.n ?? 0 };
});

for (const [action, status] of [
  ['activate', 'active'],
  ['suspend', 'suspended'],
  ['archive', 'archived'],
] as const) {
  route(
    {
      method: 'post',
      path: `/tenants/:id/${action}`,
      operationId: `platformTenant${action[0]!.toUpperCase()}${action.slice(1)}`,
      summary: `Set tenant status to ${status}`,
      params: idParams,
      body: z.object({ reason: z.string().trim().max(500).optional() }),
      response: tenantSchema,
    },
    async (req) => {
      const auth = authOf(req);
      const [row] = await db
        .update(tenants)
        .set({ status, suspendedReason: status === 'suspended' ? (req.valid.body.reason ?? null) : null })
        .where(eq(tenants.id, req.valid.params.id))
        .returning();
      if (!row) throw notFound('Tenant not found');
      await audit(db, { tenantId: row.id, actorUserId: auth.userId, action: `tenant.${action}`, entityType: 'tenant', entityId: row.id, diff: { reason: req.valid.body.reason }, ip: clientIp(req) });
      revalidateTenant(row.slug);
      return toTenantDto(row);
    },
  );
}

// ---------- users ----------

const platformUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  name: z.string(),
  role: z.enum(['superadmin', 'owner', 'staff']),
  status: z.enum(['active', 'disabled']),
  lastLoginAt: isoDateNullable,
  createdAt: isoDate,
  tenants: z.array(z.object({ id: z.string().uuid(), slug: z.string(), name: z.string(), role: z.enum(['owner', 'staff']) })),
});

route(
  { method: 'get', path: '/users', operationId: 'platformListUsers', summary: 'All users', query: paginationQuery.extend({ q: z.string().trim().max(80).optional(), role: z.enum(['superadmin', 'owner', 'staff']).optional() }), response: paginated(platformUserSchema) },
  async (req) => {
    const q = req.valid.query;
    const filters: SQL[] = [];
    if (q.q) filters.push(or(ilike(users.email, `%${q.q}%`), ilike(users.name, `%${q.q}%`))!);
    if (q.role) filters.push(eq(users.role, q.role));
    const where = filters.length ? and(...filters) : undefined;
    const [rows, [{ total = 0 } = {}]] = await Promise.all([
      db.query.users.findMany({ where, orderBy: [desc(users.createdAt)], limit: q.pageSize, offset: (q.page - 1) * q.pageSize, with: { memberships: { with: { tenant: { columns: { id: true, slug: true, name: true } } } } } }),
      db.select({ total: count() }).from(users).where(where),
    ]);
    return {
      items: rows.map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt, tenants: u.memberships.map((m) => ({ ...m.tenant, role: m.role })) })),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  },
);

route(
  { method: 'patch', path: '/users/:id', operationId: 'platformUpdateUser', summary: 'Enable/disable a user or change role', params: idParams, body: z.object({ status: z.enum(['active', 'disabled']).optional(), role: z.enum(['superadmin', 'owner', 'staff']).optional() }), response: okResponse },
  async (req) => {
    const auth = authOf(req);
    if (req.valid.params.id === auth.userId && req.valid.body.status === 'disabled') throw notFound('You cannot disable yourself');
    const [row] = await db.update(users).set(req.valid.body).where(eq(users.id, req.valid.params.id)).returning({ id: users.id });
    if (!row) throw notFound('User not found');
    if (req.valid.body.status === 'disabled') await revokeAllSessions(db, row.id);
    await audit(db, { actorUserId: auth.userId, action: 'user.update', entityType: 'user', entityId: row.id, diff: req.valid.body, ip: clientIp(req) });
    return OK;
  },
);

route(
  { method: 'post', path: '/users/:id/reset-password', operationId: 'platformResetUserPassword', summary: 'Set a new password for a user and revoke their sessions', params: idParams, body: z.object({ password: passwordSchema }), response: okResponse },
  async (req) => {
    const auth = authOf(req);
    const [row] = await db.update(users).set({ passwordHash: await hashPassword(req.valid.body.password) }).where(eq(users.id, req.valid.params.id)).returning({ id: users.id });
    if (!row) throw notFound('User not found');
    await revokeAllSessions(db, row.id);
    await audit(db, { actorUserId: auth.userId, action: 'user.reset_password', entityType: 'user', entityId: row.id, ip: clientIp(req) });
    return OK;
  },
);

// ---------- bookings / stats ----------

route(
  { method: 'get', path: '/bookings', operationId: 'platformListBookings', summary: 'Bookings across all tenants', query: listBookingsQuery.extend({ tenantId: z.string().uuid().optional() }), response: paginated(bookingSchema.extend({ tenant: z.object({ id: z.string().uuid(), slug: z.string(), name: z.string() }) })) },
  async (req) => {
    const q = req.valid.query;
    const filters: SQL[] = [];
    if (q.tenantId) filters.push(eq(bookings.tenantId, q.tenantId));
    if (q.status?.length) filters.push(inArray(bookings.status, q.status));
    if (q.q) filters.push(or(ilike(bookings.code, `%${q.q}%`), ilike(bookings.customerName, `%${q.q}%`), ilike(bookings.customerEmail, `%${q.q}%`))!);
    const where = filters.length ? and(...filters) : undefined;
    const [rows, [{ total = 0 } = {}]] = await Promise.all([
      db.query.bookings.findMany({ where, with: { items: true, proofs: true, tenant: { columns: { id: true, slug: true, name: true } } }, orderBy: [desc(bookings.createdAt)], limit: q.pageSize, offset: (q.page - 1) * q.pageSize }),
      db.select({ total: count() }).from(bookings).where(where),
    ]);
    return { items: rows.map((b) => ({ ...toBookingDto(b), tenant: b.tenant })), total, page: q.page, pageSize: q.pageSize };
  },
);

route(
  {
    method: 'get',
    path: '/stats',
    operationId: 'platformStats',
    summary: 'Platform-wide counters',
    response: z.object({
      tenants: z.record(z.string(), z.number().int()),
      users: z.number().int(),
      listings: z.number().int(),
      bookings: z.number().int(),
      bookingsThisMonth: z.number().int(),
      gmvThisMonth: z.number().int(),
    }),
  },
  async () => {
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1) - 7 * 3_600_000);
    const [tenantRows, [u], [l], [b], [bm], [gmv]] = await Promise.all([
      db.select({ status: tenants.status, n: count() }).from(tenants).groupBy(tenants.status),
      db.select({ n: count() }).from(users),
      db.select({ n: count() }).from(listings).where(eq(listings.status, 'active')),
      db.select({ n: count() }).from(bookings),
      db.select({ n: count() }).from(bookings).where(sql`${bookings.createdAt} >= ${monthStart.toISOString()}`),
      db.select({ n: sum(bookings.subtotal) }).from(bookings).where(and(inArray(bookings.status, ['confirmed', 'active', 'completed']), sql`${bookings.confirmedAt} >= ${monthStart.toISOString()}`)),
    ]);
    return {
      tenants: Object.fromEntries(tenantRows.map((r) => [r.status, r.n])),
      users: u?.n ?? 0,
      listings: l?.n ?? 0,
      bookings: b?.n ?? 0,
      bookingsThisMonth: bm?.n ?? 0,
      gmvThisMonth: Number(gmv?.n ?? 0),
    };
  },
);

// ---------- settings ----------

const landingSchema = z.object({
  headline: z.string().max(120),
  subheadline: z.string().max(300),
  ctaLabel: z.string().max(40),
  featuredTenantSlugs: z.array(z.string()).max(12),
});
const platformSettingsSchema = z.object({ requireApproval: z.boolean(), landing: landingSchema });
const updatePlatformSettingsBody = z.object({ requireApproval: z.boolean().optional(), landing: landingSchema.partial().optional() });

async function loadSettings(): Promise<PlatformSettings> {
  const row = await db.query.platformSettings.findFirst({ where: eq(platformSettings.id, 1) });
  return { ...defaultPlatformSettings, ...(row?.data ?? {}), landing: { ...defaultPlatformSettings.landing, ...(row?.data?.landing ?? {}) } };
}

route({ method: 'get', path: '/settings', operationId: 'platformGetSettings', summary: 'Platform settings and landing content', response: platformSettingsSchema }, async () => loadSettings());

route({ method: 'put', path: '/settings', operationId: 'platformUpdateSettings', summary: 'Update platform settings', body: updatePlatformSettingsBody, response: platformSettingsSchema }, async (req) => {
  const auth = authOf(req);
  const current = await loadSettings();
  const next: PlatformSettings = { ...current, ...req.valid.body, landing: { ...current.landing, ...(req.valid.body.landing ?? {}) } };
  await db.insert(platformSettings).values({ id: 1, data: next }).onConflictDoUpdate({ target: platformSettings.id, set: { data: next } });
  await audit(db, { actorUserId: auth.userId, action: 'platform.settings', entityType: 'platform', diff: req.valid.body, ip: clientIp(req) });
  revalidateDirectory();
  return next;
});

route({ method: 'post', path: '/revalidate', operationId: 'platformRevalidate', summary: 'Manually purge storefront caches', body: z.object({ slug: z.string().optional() }), response: okResponse }, async (req) => {
  if (req.valid.body.slug) revalidateTenant(req.valid.body.slug);
  else revalidateDirectory();
  return OK;
});

export const platformRouter = router;
export { tenantMembers };
