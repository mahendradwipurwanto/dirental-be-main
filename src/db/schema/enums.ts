import { pgEnum } from 'drizzle-orm/pg-core';

export const userRole = pgEnum('user_role', ['superadmin', 'owner', 'staff']);
export const userStatus = pgEnum('user_status', ['active', 'disabled']);
export const tenantStatus = pgEnum('tenant_status', ['pending', 'active', 'suspended', 'archived']);
export const memberRole = pgEnum('member_role', ['owner', 'staff']);
export const listingStatus = pgEnum('listing_status', ['draft', 'active', 'archived']);
export const bookingStatus = pgEnum('booking_status', [
  'pending_payment',
  'awaiting_verification',
  'confirmed',
  'active',
  'completed',
  'cancelled',
  'expired',
  'rejected',
]);
export const fulfillment = pgEnum('fulfillment', ['pickup', 'delivery']);
export const pricingMode = pgEnum('pricing_mode', ['hour', 'day']);
export const bookingActor = pgEnum('booking_actor', ['customer', 'owner', 'staff', 'system', 'superadmin']);
export const proofStatus = pgEnum('proof_status', ['submitted', 'accepted', 'rejected']);
export const pageStatus = pgEnum('page_status', ['draft', 'published']);
export const notificationType = pgEnum('notification_type', [
  'booking_created',
  'proof_submitted',
  'booking_confirmed',
  'booking_rejected',
  'booking_expired',
  'booking_cancelled',
  'booking_completed',
  'invitation',
  'password_reset',
]);

export type UserRole = (typeof userRole.enumValues)[number];
export type TenantStatus = (typeof tenantStatus.enumValues)[number];
export type MemberRole = (typeof memberRole.enumValues)[number];
export type ListingStatus = (typeof listingStatus.enumValues)[number];
export type BookingStatus = (typeof bookingStatus.enumValues)[number];
export type Fulfillment = (typeof fulfillment.enumValues)[number];
export type PricingMode = (typeof pricingMode.enumValues)[number];
export type BookingActor = (typeof bookingActor.enumValues)[number];
export type ProofStatus = (typeof proofStatus.enumValues)[number];
export type PageStatus = (typeof pageStatus.enumValues)[number];
export type NotificationType = (typeof notificationType.enumValues)[number];
