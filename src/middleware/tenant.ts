import type { RequestHandler } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tenants, type MemberRole, type Tenant } from '../db/schema/index.js';
import { COOKIE } from '../lib/cookies.js';
import { forbidden, notFound, unauthorized } from '../lib/errors.js';

export type TenantContext = Tenant & { memberRole: MemberRole | 'superadmin' };

declare global {
  namespace Express {
    interface Request {
      tenant?: TenantContext;
    }
  }
}

/**
 * Resolves the active tenant for admin routes. Precedence: `X-Tenant-Id` header, `rt_tenant` cookie,
 * first membership. Superadmins may act on any tenant; everyone else must be a member.
 */
export const resolveTenant: RequestHandler = async (req, _res, next) => {
  const auth = req.auth;
  if (!auth) return next(unauthorized());

  const requested =
    (req.header('x-tenant-id') as string | undefined) ??
    (req.cookies?.[COOKIE.tenant] as string | undefined) ??
    auth.memberships[0]?.tenantId;

  if (!requested) return next(forbidden('No tenant selected', 'NO_TENANT'));

  const membership = auth.memberships.find((m) => m.tenantId === requested);
  if (!membership && auth.role !== 'superadmin') {
    return next(forbidden('You are not a member of this tenant', 'NOT_A_MEMBER'));
  }

  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, requested) });
  if (!tenant || tenant.status === 'archived') return next(notFound('Tenant not found', 'TENANT_NOT_FOUND'));

  req.tenant = { ...tenant, memberRole: membership?.role ?? 'superadmin' };
  next();
};

/** Owner-only actions (billing details, members, danger zone). */
export const requireOwner: RequestHandler = (req, _res, next) => {
  const role = req.tenant?.memberRole;
  if (role !== 'owner' && role !== 'superadmin') return next(forbidden('Owner role required', 'OWNER_REQUIRED'));
  next();
};

export function tenantOf(req: { tenant?: TenantContext }): TenantContext {
  if (!req.tenant) throw unauthorized();
  return req.tenant;
}

export function authOf(req: { auth?: Express.Request['auth'] }): NonNullable<Express.Request['auth']> {
  if (!req.auth) throw unauthorized();
  return req.auth;
}
