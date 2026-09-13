import type { CookieOptions, Response } from 'express';
import { env } from '../config/env.js';
import { ACCESS_TTL_SECONDS } from './jwt.js';

/**
 * Cookie names are prefixed so they never collide with the Next.js apps' own cookies.
 * All cookies are host-only (no Domain), Path=/ so the admin's proxy.ts can see them on page routes.
 * The admin app reaches this API through a same-origin rewrite, so SameSite=Lax is sufficient.
 */
export const COOKIE = {
  access: 'rt_access',
  refresh: 'rt_refresh',
  tenant: 'rt_tenant',
} as const;

export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

const base: CookieOptions = {
  httpOnly: true,
  secure: env.cookieSecure,
  sameSite: 'lax',
  path: '/',
};

export function setAuthCookies(res: Response, tokens: { access: string; refresh: string; tenantId?: string | null }) {
  res.cookie(COOKIE.access, tokens.access, { ...base, maxAge: ACCESS_TTL_SECONDS * 1000 });
  res.cookie(COOKIE.refresh, tokens.refresh, { ...base, maxAge: REFRESH_TTL_SECONDS * 1000 });
  if (tokens.tenantId !== undefined) setTenantCookie(res, tokens.tenantId);
}

export function setTenantCookie(res: Response, tenantId: string | null) {
  if (tenantId) {
    res.cookie(COOKIE.tenant, tenantId, { ...base, httpOnly: false, maxAge: REFRESH_TTL_SECONDS * 1000 });
  } else {
    res.clearCookie(COOKIE.tenant, { ...base, httpOnly: false });
  }
}

export function clearAuthCookies(res: Response) {
  res.clearCookie(COOKIE.access, base);
  res.clearCookie(COOKIE.refresh, base);
  res.clearCookie(COOKIE.tenant, { ...base, httpOnly: false });
}
