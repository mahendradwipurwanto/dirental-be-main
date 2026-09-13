import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { users } from '../../db/schema/index.js';
import { clearAuthCookies, COOKIE, setAuthCookies, setTenantCookie } from '../../lib/cookies.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { clientIp, rateLimit } from '../../lib/rate-limit.js';
import { createRouter } from '../../lib/route.js';
import { OK, okResponse } from '../../lib/schemas.js';
import { requireAuth, requireTrustedOrigin } from '../../middleware/auth.js';
import { authOf } from '../../middleware/tenant.js';
import * as s from './schemas.js';
import * as svc from './service.js';

const { router, route } = createRouter('/v1/auth', { tag: 'Auth', auth: 'none', middlewares: [requireTrustedOrigin] });

const meta = (req: { header: (n: string) => string | undefined; ip?: string }) => ({ userAgent: req.header('user-agent'), ip: clientIp(req) });

route(
  {
    method: 'get',
    path: '/slug-available',
    operationId: 'authSlugAvailable',
    summary: 'Check whether a storefront slug can be registered',
    query: s.slugAvailableQuery,
    response: s.slugAvailableResponse,
  },
  async (req) => {
    const { slug } = req.valid.query;
    const result = await svc.checkSlug(slug);
    return { slug, ...result };
  },
);

route(
  {
    method: 'post',
    path: '/register-owner',
    operationId: 'authRegisterOwner',
    summary: 'Create an owner account and its tenant, then sign in',
    body: s.registerOwnerBody,
    response: s.sessionSchema,
    status: 201,
    middlewares: [rateLimit('register', 5, 3600)],
  },
  async (req, res) => {
    const { user, tenant, tokens } = await svc.registerOwner(req.valid.body, meta(req));
    setAuthCookies(res, { access: tokens.access, refresh: tokens.refresh, tenantId: tenant.id });
    return svc.buildSession(user, tenant.id);
  },
);

route(
  {
    method: 'post',
    path: '/login',
    operationId: 'authLogin',
    summary: 'Sign in with email and password',
    body: s.loginBody,
    response: s.sessionSchema,
    middlewares: [rateLimit('login', 10, 900, 'email')],
  },
  async (req, res) => {
    const { user, tokens } = await svc.login(req.valid.body.email, req.valid.body.password, meta(req));
    const session = await svc.buildSession(user, req.cookies?.[COOKIE.tenant]);
    setAuthCookies(res, { access: tokens.access, refresh: tokens.refresh, tenantId: session.activeTenantId });
    return session;
  },
);

route(
  {
    method: 'post',
    path: '/refresh',
    operationId: 'authRefresh',
    summary: 'Rotate the refresh token and issue a new access token',
    response: s.sessionSchema,
  },
  async (req, res) => {
    const refresh = req.cookies?.[COOKIE.refresh] as string | undefined;
    if (!refresh) {
      clearAuthCookies(res);
      throw forbidden('No refresh token', 'REFRESH_MISSING');
    }
    try {
      const { user, tokens } = await svc.refreshSession(refresh, meta(req));
      const session = await svc.buildSession(user, req.cookies?.[COOKIE.tenant]);
      setAuthCookies(res, { access: tokens.access, refresh: tokens.refresh, tenantId: session.activeTenantId });
      return session;
    } catch (err) {
      clearAuthCookies(res);
      throw err;
    }
  },
);

route(
  { method: 'post', path: '/logout', operationId: 'authLogout', summary: 'Revoke the refresh token and clear cookies', response: okResponse },
  async (req, res) => {
    await svc.revokeRefreshToken(req.cookies?.[COOKIE.refresh]);
    clearAuthCookies(res);
    return OK;
  },
);

route(
  { method: 'get', path: '/me', operationId: 'authMe', summary: 'Current session', auth: 'cookie', response: s.sessionSchema, middlewares: [requireAuth] },
  async (req) => {
    const auth = authOf(req);
    const user = await db.query.users.findFirst({ where: eq(users.id, auth.userId) });
    if (!user || user.status !== 'active') throw notFound('User not found');
    return svc.buildSession(user, (req.header('x-tenant-id') as string | undefined) ?? req.cookies?.[COOKIE.tenant]);
  },
);

route(
  {
    method: 'post',
    path: '/switch-tenant',
    operationId: 'authSwitchTenant',
    summary: 'Set the active tenant for subsequent admin requests',
    auth: 'cookie',
    body: s.switchTenantBody,
    response: s.sessionSchema,
    middlewares: [requireAuth],
  },
  async (req, res) => {
    const auth = authOf(req);
    const user = await db.query.users.findFirst({ where: eq(users.id, auth.userId) });
    if (!user) throw notFound('User not found');
    const session = await svc.buildSession(user, req.valid.body.tenantId);
    if (session.activeTenantId !== req.valid.body.tenantId) throw forbidden('Not a member of that tenant', 'NOT_A_MEMBER');
    setTenantCookie(res, session.activeTenantId);
    return session;
  },
);

route(
  {
    method: 'patch',
    path: '/me',
    operationId: 'authUpdateProfile',
    summary: 'Update name or locale',
    auth: 'cookie',
    body: s.updateProfileBody,
    response: s.sessionUserSchema,
    middlewares: [requireAuth],
  },
  async (req) => {
    const auth = authOf(req);
    const [user] = await db.update(users).set(req.valid.body).where(eq(users.id, auth.userId)).returning();
    if (!user) throw notFound('User not found');
    return svc.toSessionUser(user);
  },
);

route(
  {
    method: 'post',
    path: '/change-password',
    operationId: 'authChangePassword',
    summary: 'Change password (keeps current session)',
    auth: 'cookie',
    body: s.changePasswordBody,
    response: okResponse,
    middlewares: [requireAuth, rateLimit('change-password', 5, 900)],
  },
  async (req) => {
    const auth = authOf(req);
    await svc.changePassword(auth.userId, req.valid.body.currentPassword, req.valid.body.newPassword);
    return OK;
  },
);

route(
  {
    method: 'post',
    path: '/forgot-password',
    operationId: 'authForgotPassword',
    summary: 'Send a password reset email (always succeeds)',
    body: s.forgotPasswordBody,
    response: okResponse,
    middlewares: [rateLimit('forgot', 5, 900, 'email')],
  },
  async (req) => {
    await svc.requestPasswordReset(req.valid.body.email);
    return OK;
  },
);

route(
  {
    method: 'post',
    path: '/reset-password',
    operationId: 'authResetPassword',
    summary: 'Set a new password using a reset token',
    body: s.resetPasswordBody,
    response: okResponse,
    middlewares: [rateLimit('reset', 10, 900)],
  },
  async (req) => {
    await svc.resetPassword(req.valid.body.token, req.valid.body.password);
    return OK;
  },
);

route(
  {
    method: 'get',
    path: '/invitations/:token',
    operationId: 'authGetInvitation',
    summary: 'Inspect an invitation before accepting it',
    params: s.invitationParams,
    response: s.invitationInfoResponse,
  },
  async (req) => {
    const { invitation, tenant, existingUser } = await svc.getInvitation(req.valid.params.token);
    return { email: invitation.email, tenantName: tenant.name, role: invitation.role, userExists: Boolean(existingUser), expiresAt: invitation.expiresAt };
  },
);

route(
  {
    method: 'post',
    path: '/invitations/:token/accept',
    operationId: 'authAcceptInvitation',
    summary: 'Accept an invitation (creates the account if needed) and sign in',
    params: s.invitationParams,
    body: s.acceptInvitationBody,
    response: s.sessionSchema,
    middlewares: [rateLimit('invite-accept', 10, 900)],
  },
  async (req, res) => {
    const { user, tenant, tokens } = await svc.acceptInvitation(req.valid.params.token, req.valid.body, meta(req));
    setAuthCookies(res, { access: tokens.access, refresh: tokens.refresh, tenantId: tenant.id });
    return svc.buildSession(user, tenant.id);
  },
);

export const authRouter = router;
export { z };
