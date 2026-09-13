import { relations } from 'drizzle-orm';
import { bookingEvents, bookingItems, bookings, notificationLogs, paymentProofs } from './bookings.js';
import { availabilityBlocks, listingCategories, listingImages, listings } from './listings.js';
import { pages, siteConfigs } from './site.js';
import { bankAccounts, invitations, tenantMembers, tenants } from './tenants.js';
import { refreshTokens, users } from './users.js';

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(tenantMembers),
  refreshTokens: many(refreshTokens),
}));

export const tenantsRelations = relations(tenants, ({ one, many }) => ({
  owner: one(users, { fields: [tenants.ownerUserId], references: [users.id] }),
  members: many(tenantMembers),
  invitations: many(invitations),
  bankAccounts: many(bankAccounts),
  categories: many(listingCategories),
  listings: many(listings),
  bookings: many(bookings),
  siteConfig: one(siteConfigs, { fields: [tenants.id], references: [siteConfigs.tenantId] }),
  pages: many(pages),
}));

export const tenantMembersRelations = relations(tenantMembers, ({ one }) => ({
  tenant: one(tenants, { fields: [tenantMembers.tenantId], references: [tenants.id] }),
  user: one(users, { fields: [tenantMembers.userId], references: [users.id] }),
}));

export const invitationsRelations = relations(invitations, ({ one }) => ({
  tenant: one(tenants, { fields: [invitations.tenantId], references: [tenants.id] }),
}));

export const bankAccountsRelations = relations(bankAccounts, ({ one }) => ({
  tenant: one(tenants, { fields: [bankAccounts.tenantId], references: [tenants.id] }),
}));

export const listingCategoriesRelations = relations(listingCategories, ({ one, many }) => ({
  tenant: one(tenants, { fields: [listingCategories.tenantId], references: [tenants.id] }),
  listings: many(listings),
}));

export const listingsRelations = relations(listings, ({ one, many }) => ({
  tenant: one(tenants, { fields: [listings.tenantId], references: [tenants.id] }),
  category: one(listingCategories, { fields: [listings.categoryId], references: [listingCategories.id] }),
  images: many(listingImages),
  availabilityBlocks: many(availabilityBlocks),
  bookingItems: many(bookingItems),
}));

export const listingImagesRelations = relations(listingImages, ({ one }) => ({
  listing: one(listings, { fields: [listingImages.listingId], references: [listings.id] }),
}));

export const availabilityBlocksRelations = relations(availabilityBlocks, ({ one }) => ({
  listing: one(listings, { fields: [availabilityBlocks.listingId], references: [listings.id] }),
}));

export const bookingsRelations = relations(bookings, ({ one, many }) => ({
  tenant: one(tenants, { fields: [bookings.tenantId], references: [tenants.id] }),
  items: many(bookingItems),
  events: many(bookingEvents),
  proofs: many(paymentProofs),
  notifications: many(notificationLogs),
}));

export const bookingItemsRelations = relations(bookingItems, ({ one }) => ({
  booking: one(bookings, { fields: [bookingItems.bookingId], references: [bookings.id] }),
  listing: one(listings, { fields: [bookingItems.listingId], references: [listings.id] }),
}));

export const bookingEventsRelations = relations(bookingEvents, ({ one }) => ({
  booking: one(bookings, { fields: [bookingEvents.bookingId], references: [bookings.id] }),
  actorUser: one(users, { fields: [bookingEvents.actorUserId], references: [users.id] }),
}));

export const paymentProofsRelations = relations(paymentProofs, ({ one }) => ({
  booking: one(bookings, { fields: [paymentProofs.bookingId], references: [bookings.id] }),
  bankAccount: one(bankAccounts, { fields: [paymentProofs.bankAccountId], references: [bankAccounts.id] }),
  reviewer: one(users, { fields: [paymentProofs.reviewedBy], references: [users.id] }),
}));

export const notificationLogsRelations = relations(notificationLogs, ({ one }) => ({
  booking: one(bookings, { fields: [notificationLogs.bookingId], references: [bookings.id] }),
}));

export const siteConfigsRelations = relations(siteConfigs, ({ one }) => ({
  tenant: one(tenants, { fields: [siteConfigs.tenantId], references: [tenants.id] }),
}));

export const pagesRelations = relations(pages, ({ one }) => ({
  tenant: one(tenants, { fields: [pages.tenantId], references: [tenants.id] }),
}));

export const refreshTokensRelations = relations(refreshTokens, ({ one }) => ({
  user: one(users, { fields: [refreshTokens.userId], references: [users.id] }),
}));
