import type { RequestHandler } from 'express';
import { COOKIE } from '../lib/cookies.js';
import { verifyAccessToken, type AccessClaims } from '../lib/jwt.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { env } from '../config/env.js';
import { safeEqual } from '../lib/tokens.js';
import type { UserRole } from '../db/schema/index.js';

export type AuthContext = AccessClaims & { userId: string };

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

function extractToken(req: Parameters<RequestHandler>[0]): string | undefined {
  const cookie = req.cookies?.[COOKIE.access] as string | undefined;
  if (cookie) return cookie;
  const header = req.header('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return undefined;
}

/** Populates req.auth when a valid access token is present; never fails. */
export const optionalAuth: RequestHandler = async (req, _res, next) => {
  const token = extractToken(req);
  if (token) {
    const claims = await verifyAccessToken(token);
    if (claims) req.auth = { ...claims, userId: claims.sub };
  }
  next();
};

export const requireAuth: RequestHandler = async (req, _res, next) => {
  const token = extractToken(req);
  const claims = token ? await verifyAccessToken(token) : null;
  if (!claims) {
    next(unauthorized('Session expired or missing', 'TOKEN_INVALID'));
    return;
  }
  req.auth = { ...claims, userId: claims.sub };
  next();
};

export const requireRole =
  (...roles: UserRole[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.auth) return next(unauthorized());
    if (!roles.includes(req.auth.role)) return next(forbidden('Insufficient role'));
    next();
  };

export const requireSuperadmin = requireRole('superadmin');

/** Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. */
export const requireCronSecret: RequestHandler = (req, _res, next) => {
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !safeEqual(token, env.CRON_SECRET)) return next(unauthorized('Invalid cron secret'));
  next();
};

/** rental-web's server-side calls carry a shared key so we trust its forwarded client IP. */
export const requireWebKey: RequestHandler = (req, _res, next) => {
  const key = req.header('x-web-key') ?? '';
  if (!key || !safeEqual(key, env.WEB_API_KEY)) return next(unauthorized('Invalid web key'));
  next();
};

/** Mutations from browsers must come from one of our own origins (defence in depth beyond SameSite=Lax). */
export const requireTrustedOrigin: RequestHandler = (req, _res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.header('origin');
  if (!origin) return next(); // server-to-server or same-origin fetches without Origin
  const allowed = [env.ADMIN_URL, env.WEB_URL].map((u) => new URL(u).origin);
  if (env.VERCEL_URL) allowed.push(`https://${env.VERCEL_URL}`);
  if (!allowed.includes(origin)) return next(forbidden('Untrusted origin', 'BAD_ORIGIN'));
  next();
};
