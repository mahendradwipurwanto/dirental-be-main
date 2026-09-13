import { SignJWT, jwtVerify } from 'jose';
import { env } from '../config/env.js';
import type { MemberRole, UserRole } from '../db/schema/index.js';

export type Membership = { tenantId: string; slug: string; name: string; role: MemberRole };

export type AccessClaims = {
  sub: string;
  role: UserRole;
  name: string;
  email: string;
  memberships: Membership[];
};

const secret = new TextEncoder().encode(env.JWT_SECRET);
const ISSUER = 'rental-api';
export const ACCESS_TTL_SECONDS = 15 * 60;

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  const { sub, ...rest } = claims;
  return new SignJWT(rest)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
    .sign(secret);
}

export async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: ISSUER });
    if (!payload.sub) return null;
    return {
      sub: payload.sub,
      role: payload.role as UserRole,
      name: String(payload.name ?? ''),
      email: String(payload.email ?? ''),
      memberships: (payload.memberships as Membership[] | undefined) ?? [],
    };
  } catch {
    return null;
  }
}

/** Short-lived, purpose-bound tokens (storefront draft preview, signed proof URLs). */
export async function signScopedToken(purpose: string, data: Record<string, unknown>, ttlSeconds: number): Promise<string> {
  return new SignJWT({ ...data, purpose })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secret);
}

export async function verifyScopedToken<T extends Record<string, unknown>>(purpose: string, token: string): Promise<T | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: ISSUER });
    if (payload.purpose !== purpose) return null;
    return payload as unknown as T;
  } catch {
    return null;
  }
}
