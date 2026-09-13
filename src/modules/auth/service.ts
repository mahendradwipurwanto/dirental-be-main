import { and, eq, gt, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, type DbOrTx } from '../../db/client.js';
import {
  defaultPlatformSettings,
  invitations,
  passwordResets,
  platformSettings,
  refreshTokens,
  siteConfigs,
  tenantMembers,
  tenants,
  users,
  type User,
} from '../../db/schema/index.js';
import { env } from '../../config/env.js';
import { audit } from '../../lib/audit.js';
import { AppError, conflict, notFound, unauthorized, unprocessable } from '../../lib/errors.js';
import { signAccessToken, type Membership } from '../../lib/jwt.js';
import { layout, sendEmail } from '../../lib/mailer.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import { hashToken, randomToken } from '../../lib/tokens.js';
import { REFRESH_TTL_SECONDS } from '../../lib/cookies.js';
import { defaultSiteConfig, isSlugValid, RESERVED_SLUGS, SLUG_REGEX } from '../site-config/site-schema.js';
import type { z } from 'zod';
import type { registerOwnerBody } from './schemas.js';

export type SessionMembership = Membership & { status: 'pending' | 'active' | 'suspended' | 'archived' };

export async function loadMemberships(dbx: DbOrTx, userId: string): Promise<SessionMembership[]> {
  const rows = await dbx
    .select({
      tenantId: tenantMembers.tenantId,
      role: tenantMembers.role,
      slug: tenants.slug,
      name: tenants.name,
      status: tenants.status,
    })
    .from(tenantMembers)
    .innerJoin(tenants, eq(tenants.id, tenantMembers.tenantId))
    .where(eq(tenantMembers.userId, userId))
    .orderBy(tenantMembers.createdAt);
  return rows.filter((r) => r.status !== 'archived');
}

export function toSessionUser(u: User) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, locale: u.locale, lastLoginAt: u.lastLoginAt };
}

export async function buildSession(user: User, activeTenantId?: string | null) {
  const memberships = await loadMemberships(db, user.id);
  const active =
    activeTenantId && (user.role === 'superadmin' || memberships.some((m) => m.tenantId === activeTenantId))
      ? activeTenantId
      : (memberships[0]?.tenantId ?? null);
  return { user: toSessionUser(user), memberships, activeTenantId: active };
}

/** Issues a fresh access token + a refresh token in a new family. */
export async function issueTokens(dbx: DbOrTx, user: User, meta: { userAgent?: string; ip?: string }, familyId: string = randomUUID()) {
  const memberships = await loadMemberships(dbx, user.id);
  const access = await signAccessToken({
    sub: user.id,
    role: user.role,
    name: user.name,
    email: user.email,
    memberships: memberships.map(({ tenantId, slug, name, role }) => ({ tenantId, slug, name, role })),
  });
  const refresh = randomToken();
  await dbx.insert(refreshTokens).values({
    userId: user.id,
    tokenHash: hashToken(refresh),
    familyId,
    expiresAt: new Date(Date.now() + REFRESH_TTL_SECONDS * 1000),
    userAgent: meta.userAgent?.slice(0, 255),
    ip: meta.ip,
  });
  return { access, refresh, memberships };
}

export async function checkSlug(slug: string): Promise<{ available: boolean; reason: 'invalid' | 'reserved' | 'taken' | null }> {
  if (!SLUG_REGEX.test(slug)) return { available: false, reason: 'invalid' };
  if ((RESERVED_SLUGS as readonly string[]).includes(slug)) return { available: false, reason: 'reserved' };
  const existing = await db.query.tenants.findFirst({ where: eq(tenants.slug, slug), columns: { id: true } });
  return existing ? { available: false, reason: 'taken' } : { available: true, reason: null };
}

async function requireApproval(dbx: DbOrTx): Promise<boolean> {
  const row = await dbx.query.platformSettings.findFirst({ where: eq(platformSettings.id, 1) });
  return (row?.data ?? defaultPlatformSettings).requireApproval;
}

export async function registerOwner(input: z.infer<typeof registerOwnerBody>, meta: { userAgent?: string; ip?: string }) {
  if (!isSlugValid(input.slug)) throw unprocessable('Slug is invalid or reserved', [{ path: 'body.slug', message: 'Invalid or reserved slug' }]);

  const [existingUser, existingTenant] = await Promise.all([
    db.query.users.findFirst({ where: eq(users.email, input.email), columns: { id: true } }),
    db.query.tenants.findFirst({ where: eq(tenants.slug, input.slug), columns: { id: true } }),
  ]);
  if (existingUser) throw conflict('An account with this email already exists', 'EMAIL_TAKEN');
  if (existingTenant) throw conflict('This slug is already taken', 'SLUG_TAKEN');

  const passwordHash = await hashPassword(input.password);

  return db.transaction(async (tx) => {
    const needsApproval = await requireApproval(tx);
    const [user] = await tx
      .insert(users)
      .values({ email: input.email, passwordHash, name: input.name, role: 'owner', locale: input.locale, lastLoginAt: new Date() })
      .returning();
    if (!user) throw new Error('Failed to create user');

    const [tenant] = await tx
      .insert(tenants)
      .values({
        slug: input.slug,
        name: input.tenantName,
        ownerUserId: user.id,
        status: needsApproval ? 'pending' : 'active',
        locale: input.locale,
        contact: { whatsapp: input.whatsapp, phone: input.whatsapp, email: input.email },
      })
      .returning();
    if (!tenant) throw new Error('Failed to create tenant');

    await tx.insert(tenantMembers).values({ tenantId: tenant.id, userId: user.id, role: 'owner' });
    await tx.insert(siteConfigs).values({ tenantId: tenant.id, draft: defaultSiteConfig({ tenantName: tenant.name }) });
    await audit(tx, { tenantId: tenant.id, actorUserId: user.id, action: 'tenant.register', entityType: 'tenant', entityId: tenant.id, ip: meta.ip });

    const tokens = await issueTokens(tx, user, meta);
    return { user, tenant, tokens };
  });
}

export async function login(email: string, password: string, meta: { userAgent?: string; ip?: string }) {
  const user = await db.query.users.findFirst({ where: eq(users.email, email) });
  // Always run the hash check so timing does not reveal whether the email exists.
  const ok = user ? await verifyPassword(user.passwordHash, password) : await verifyPassword(DUMMY_HASH, password).then(() => false);
  if (!user || !ok) throw unauthorized('Email or password is incorrect', 'INVALID_CREDENTIALS');
  if (user.status !== 'active') throw new AppError(403, 'ACCOUNT_DISABLED', 'This account has been disabled');

  const tokens = await issueTokens(db, user, meta);
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  return { user, tokens };
}

const DUMMY_HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$Q3qJ8y5f8QhZbqkGqk3o0f0g5N8t8N8t8N8t8N8t8N8';

/**
 * Rotates a refresh token. If a token that was already rotated is presented again, the whole
 * family is revoked: someone is replaying a stolen token.
 */
export async function refreshSession(refreshToken: string, meta: { userAgent?: string; ip?: string }) {
  const tokenHash = hashToken(refreshToken);
  const row = await db.query.refreshTokens.findFirst({ where: eq(refreshTokens.tokenHash, tokenHash) });
  if (!row) throw unauthorized('Invalid refresh token', 'REFRESH_INVALID');

  if (row.revokedAt) {
    await db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)));
    throw unauthorized('Refresh token reuse detected', 'REFRESH_REUSED');
  }
  if (row.expiresAt.getTime() < Date.now()) throw unauthorized('Refresh token expired', 'REFRESH_EXPIRED');

  const user = await db.query.users.findFirst({ where: eq(users.id, row.userId) });
  if (!user || user.status !== 'active') throw unauthorized('Account unavailable', 'ACCOUNT_DISABLED');

  return db.transaction(async (tx) => {
    const tokens = await issueTokens(tx, user, meta, row.familyId);
    await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, row.id));
    return { user, tokens };
  });
}

export async function revokeRefreshToken(refreshToken: string | undefined) {
  if (!refreshToken) return;
  await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.tokenHash, hashToken(refreshToken)));
}

export async function revokeAllSessions(dbx: DbOrTx, userId: string) {
  await dbx.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}

export async function requestPasswordReset(email: string) {
  const user = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (!user) return; // do not reveal existence
  const token = randomToken();
  await db.insert(passwordResets).values({ userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 60 * 60 * 1000) });
  const url = `${env.ADMIN_URL}/reset-password?token=${token}`;
  const { html, text } = layout({
    title: user.locale === 'en' ? 'Reset your password' : 'Atur ulang kata sandi',
    intro:
      user.locale === 'en'
        ? 'We received a request to reset your password. The link is valid for 1 hour.'
        : 'Kami menerima permintaan untuk mengatur ulang kata sandi. Tautan berlaku 1 jam.',
    cta: { label: user.locale === 'en' ? 'Reset password' : 'Atur ulang kata sandi', url },
    footer: user.locale === 'en' ? 'If you did not request this, you can ignore this email.' : 'Abaikan email ini jika kamu tidak memintanya.',
  });
  await sendEmail({ to: user.email, subject: user.locale === 'en' ? 'Reset your password' : 'Atur ulang kata sandi', html, text });
}

export async function resetPassword(token: string, password: string) {
  const row = await db.query.passwordResets.findFirst({
    where: and(eq(passwordResets.tokenHash, hashToken(token)), isNull(passwordResets.usedAt), gt(passwordResets.expiresAt, new Date())),
  });
  if (!row) throw unprocessable('Reset link is invalid or has expired', [{ path: 'body.token', message: 'Invalid or expired' }], 'RESET_INVALID');
  const passwordHash = await hashPassword(password);
  await db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash }).where(eq(users.id, row.userId));
    await tx.update(passwordResets).set({ usedAt: new Date() }).where(eq(passwordResets.id, row.id));
    await revokeAllSessions(tx, row.userId);
  });
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string) {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw notFound('User not found');
  if (!(await verifyPassword(user.passwordHash, currentPassword))) {
    throw unprocessable('Current password is incorrect', [{ path: 'body.currentPassword', message: 'Incorrect password' }]);
  }
  await db.update(users).set({ passwordHash: await hashPassword(newPassword) }).where(eq(users.id, userId));
}

export async function getInvitation(token: string) {
  const inv = await db.query.invitations.findFirst({
    where: and(eq(invitations.tokenHash, hashToken(token)), isNull(invitations.acceptedAt), gt(invitations.expiresAt, new Date())),
  });
  if (!inv) throw notFound('Invitation is invalid or has expired', 'INVITATION_INVALID');
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, inv.tenantId), columns: { id: true, name: true, slug: true } });
  if (!tenant) throw notFound('Tenant not found');
  const existing = await db.query.users.findFirst({ where: eq(users.email, inv.email) });
  return { invitation: inv, tenant, existingUser: existing ?? null };
}

export async function acceptInvitation(token: string, input: { name?: string; password?: string }, meta: { userAgent?: string; ip?: string }) {
  const { invitation, tenant, existingUser } = await getInvitation(token);

  return db.transaction(async (tx) => {
    let user = existingUser;
    if (!user) {
      if (!input.name || !input.password) {
        throw unprocessable('Name and password are required to create your account', [
          { path: 'body.name', message: 'Required' },
          { path: 'body.password', message: 'Required' },
        ]);
      }
      const [created] = await tx
        .insert(users)
        .values({ email: invitation.email, name: input.name, passwordHash: await hashPassword(input.password), role: 'staff' })
        .returning();
      user = created!;
    }
    await tx
      .insert(tenantMembers)
      .values({ tenantId: tenant.id, userId: user.id, role: invitation.role })
      .onConflictDoUpdate({ target: [tenantMembers.tenantId, tenantMembers.userId], set: { role: invitation.role } });
    await tx.update(invitations).set({ acceptedAt: new Date() }).where(eq(invitations.id, invitation.id));
    await audit(tx, { tenantId: tenant.id, actorUserId: user.id, action: 'member.accept_invitation', entityType: 'user', entityId: user.id, ip: meta.ip });
    const tokens = await issueTokens(tx, user, meta);
    return { user, tenant, tokens };
  });
}
