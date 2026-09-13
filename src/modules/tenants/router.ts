import { and, eq, isNull, ne } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { invitations, tenantMembers, tenants, users, type Tenant } from '../../db/schema/index.js';
import { env } from '../../config/env.js';
import { audit } from '../../lib/audit.js';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { layout, sendEmail } from '../../lib/mailer.js';
import { clientIp } from '../../lib/rate-limit.js';
import { revalidateTenant } from '../../lib/revalidate.js';
import { createRouter } from '../../lib/route.js';
import { OK, okResponse } from '../../lib/schemas.js';
import { hashToken, randomToken } from '../../lib/tokens.js';
import { requireAuth, requireTrustedOrigin } from '../../middleware/auth.js';
import { authOf, requireOwner, resolveTenant, tenantOf } from '../../middleware/tenant.js';
import { checkSlug } from '../auth/service.js';
import * as s from './schemas.js';

const { router, route } = createRouter('/v1/admin', {
  tag: 'Admin',
  auth: 'cookie',
  middlewares: [requireTrustedOrigin, requireAuth, resolveTenant],
});

export const toTenantDto = (t: Tenant) => ({
  id: t.id,
  slug: t.slug,
  name: t.name,
  tagline: t.tagline,
  status: t.status,
  ownerUserId: t.ownerUserId,
  timezone: t.timezone,
  currency: t.currency,
  locale: t.locale,
  customDomain: t.customDomain,
  logoUrl: t.logoUrl,
  contact: t.contact,
  bookingSettings: t.bookingSettings,
  suspendedReason: t.suspendedReason,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
});

route(
  { method: 'get', path: '/tenant', operationId: 'adminGetTenant', summary: 'Active tenant profile', response: s.tenantSchema },
  async (req) => toTenantDto(tenantOf(req)),
);

route(
  { method: 'patch', path: '/tenant', operationId: 'adminUpdateTenant', summary: 'Update tenant profile', body: s.updateTenantBody, response: s.tenantSchema },
  async (req) => {
    const tenant = tenantOf(req);
    const auth = authOf(req);
    const body = req.valid.body;
    const [updated] = await db
      .update(tenants)
      .set({ ...body, contact: body.contact ? { ...tenant.contact, ...body.contact } : undefined })
      .where(eq(tenants.id, tenant.id))
      .returning();
    if (!updated) throw notFound('Tenant not found');
    await audit(db, { tenantId: tenant.id, actorUserId: auth.userId, action: 'tenant.update', entityType: 'tenant', entityId: tenant.id, diff: body, ip: clientIp(req) });
    revalidateTenant(tenant.slug);
    return toTenantDto(updated);
  },
);

route(
  {
    method: 'patch',
    path: '/tenant/booking-settings',
    operationId: 'adminUpdateBookingSettings',
    summary: 'Update payment window, lead time, delivery and instructions',
    body: s.updateBookingSettingsBody,
    response: s.tenantSchema,
  },
  async (req) => {
    const tenant = tenantOf(req);
    const auth = authOf(req);
    const merged = { ...tenant.bookingSettings, ...req.valid.body };
    const [updated] = await db.update(tenants).set({ bookingSettings: merged }).where(eq(tenants.id, tenant.id)).returning();
    if (!updated) throw notFound('Tenant not found');
    await audit(db, { tenantId: tenant.id, actorUserId: auth.userId, action: 'tenant.booking_settings', entityType: 'tenant', entityId: tenant.id, diff: req.valid.body, ip: clientIp(req) });
    revalidateTenant(tenant.slug);
    return toTenantDto(updated);
  },
);

route(
  {
    method: 'post',
    path: '/tenant/slug',
    operationId: 'adminChangeSlug',
    summary: 'Change the storefront slug (owner only; old links stop working)',
    body: s.changeSlugBody,
    response: s.tenantSchema,
    middlewares: [requireOwner],
  },
  async (req) => {
    const tenant = tenantOf(req);
    const auth = authOf(req);
    const slug = req.valid.body.slug;
    if (slug === tenant.slug) return toTenantDto(tenant);
    const check = await checkSlug(slug);
    if (!check.available) {
      if (check.reason === 'taken') throw conflict('Slug already taken', 'SLUG_TAKEN');
      throw unprocessable('Slug is invalid or reserved', [{ path: 'body.slug', message: check.reason ?? 'invalid' }]);
    }
    const [updated] = await db.update(tenants).set({ slug }).where(eq(tenants.id, tenant.id)).returning();
    if (!updated) throw notFound('Tenant not found');
    await audit(db, { tenantId: tenant.id, actorUserId: auth.userId, action: 'tenant.slug', entityType: 'tenant', entityId: tenant.id, diff: { from: tenant.slug, to: slug }, ip: clientIp(req) });
    revalidateTenant(tenant.slug);
    revalidateTenant(slug);
    return toTenantDto(updated);
  },
);

// ---------- members ----------

route(
  { method: 'get', path: '/members', operationId: 'adminListMembers', summary: 'Members and pending invitations', response: s.membersResponse },
  async (req) => {
    const tenant = tenantOf(req);
    const [members, pending] = await Promise.all([
      db
        .select({ userId: users.id, email: users.email, name: users.name, role: tenantMembers.role, joinedAt: tenantMembers.createdAt, lastLoginAt: users.lastLoginAt })
        .from(tenantMembers)
        .innerJoin(users, eq(users.id, tenantMembers.userId))
        .where(eq(tenantMembers.tenantId, tenant.id))
        .orderBy(tenantMembers.createdAt),
      db.query.invitations.findMany({
        where: and(eq(invitations.tenantId, tenant.id), isNull(invitations.acceptedAt)),
        columns: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
        orderBy: (t, { desc }) => desc(t.createdAt),
      }),
    ]);
    return { members, invitations: pending.filter((i) => i.expiresAt.getTime() > Date.now()) };
  },
);

route(
  {
    method: 'post',
    path: '/members/invite',
    operationId: 'adminInviteMember',
    summary: 'Invite a staff member or co-owner by email',
    body: s.inviteMemberBody,
    response: s.invitationSchema,
    status: 201,
    middlewares: [requireOwner],
  },
  async (req) => {
    const tenant = tenantOf(req);
    const auth = authOf(req);
    const { email, role } = req.valid.body;

    const existingMember = await db
      .select({ userId: tenantMembers.userId })
      .from(tenantMembers)
      .innerJoin(users, eq(users.id, tenantMembers.userId))
      .where(and(eq(tenantMembers.tenantId, tenant.id), eq(users.email, email)))
      .limit(1);
    if (existingMember.length) throw conflict('Already a member', 'ALREADY_MEMBER');

    const token = randomToken();
    const [inv] = await db
      .insert(invitations)
      .values({ tenantId: tenant.id, email, role, tokenHash: hashToken(token), invitedBy: auth.userId, expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000) })
      .returning();
    if (!inv) throw new Error('Failed to create invitation');

    const url = `${env.ADMIN_URL}/accept-invite?token=${token}`;
    const { html, text } = layout({
      title: `Undangan bergabung ke ${tenant.name}`,
      intro: `${auth.name} mengundangmu sebagai ${role === 'owner' ? 'pemilik' : 'staf'} di ${tenant.name}. Undangan berlaku 7 hari.`,
      cta: { label: 'Terima undangan', url },
    });
    await sendEmail({ to: email, subject: `Undangan bergabung ke ${tenant.name}`, html, text });
    await audit(db, { tenantId: tenant.id, actorUserId: auth.userId, action: 'member.invite', entityType: 'invitation', entityId: inv.id, diff: { email, role }, ip: clientIp(req) });
    return { id: inv.id, email: inv.email, role: inv.role, expiresAt: inv.expiresAt, createdAt: inv.createdAt };
  },
);

route(
  {
    method: 'delete',
    path: '/members/invitations/:id',
    operationId: 'adminRevokeInvitation',
    summary: 'Revoke a pending invitation',
    params: s.invitationIdParams,
    response: okResponse,
    middlewares: [requireOwner],
  },
  async (req) => {
    const tenant = tenantOf(req);
    await db.delete(invitations).where(and(eq(invitations.id, req.valid.params.id), eq(invitations.tenantId, tenant.id)));
    return OK;
  },
);

route(
  {
    method: 'delete',
    path: '/members/:userId',
    operationId: 'adminRemoveMember',
    summary: 'Remove a member (cannot remove the tenant owner)',
    params: s.memberParams,
    response: okResponse,
    middlewares: [requireOwner],
  },
  async (req) => {
    const tenant = tenantOf(req);
    const auth = authOf(req);
    const { userId } = req.valid.params;
    if (userId === tenant.ownerUserId) throw forbidden('The tenant owner cannot be removed', 'OWNER_PROTECTED');
    await db.delete(tenantMembers).where(and(eq(tenantMembers.tenantId, tenant.id), eq(tenantMembers.userId, userId), ne(tenantMembers.userId, tenant.ownerUserId)));
    await audit(db, { tenantId: tenant.id, actorUserId: auth.userId, action: 'member.remove', entityType: 'user', entityId: userId, ip: clientIp(req) });
    return OK;
  },
);

export const adminTenantRouter = router;
