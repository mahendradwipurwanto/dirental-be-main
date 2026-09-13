import { z } from 'zod';
import { emailSchema, isoDate, isoDateNullable, passwordSchema, phoneSchema } from '../../lib/schemas.js';
import { SLUG_REGEX } from '../site-config/site-schema.js';

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(SLUG_REGEX, 'Use 2–50 lowercase letters, numbers or hyphens; must start and end with a letter or number');

export const membershipSchema = z.object({
  tenantId: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  role: z.enum(['owner', 'staff']),
  status: z.enum(['pending', 'active', 'suspended', 'archived']),
});

export const sessionUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  name: z.string(),
  role: z.enum(['superadmin', 'owner', 'staff']),
  locale: z.string(),
  lastLoginAt: isoDateNullable,
});

export const sessionSchema = z.object({
  user: sessionUserSchema,
  memberships: z.array(membershipSchema),
  activeTenantId: z.string().uuid().nullable(),
});

export const registerOwnerBody = z.object({
  name: z.string().trim().min(2).max(80),
  email: emailSchema,
  password: passwordSchema,
  tenantName: z.string().trim().min(2).max(80),
  slug: slugSchema,
  whatsapp: phoneSchema,
  locale: z.enum(['id', 'en']).default('id'),
});

export const loginBody = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});

export const switchTenantBody = z.object({ tenantId: z.string().uuid() });

export const forgotPasswordBody = z.object({ email: emailSchema });

export const resetPasswordBody = z.object({
  token: z.string().min(10),
  password: passwordSchema,
});

export const changePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});

export const updateProfileBody = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  locale: z.enum(['id', 'en']).optional(),
});

export const slugAvailableQuery = z.object({ slug: z.string().trim().toLowerCase().min(1).max(60) });
export const slugAvailableResponse = z.object({
  slug: z.string(),
  available: z.boolean(),
  reason: z.enum(['invalid', 'reserved', 'taken']).nullable(),
});

export const invitationParams = z.object({ token: z.string().min(10) });
export const invitationInfoResponse = z.object({
  email: z.string(),
  tenantName: z.string(),
  role: z.enum(['owner', 'staff']),
  userExists: z.boolean(),
  expiresAt: isoDate,
});
export const acceptInvitationBody = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  password: passwordSchema.optional(),
});
