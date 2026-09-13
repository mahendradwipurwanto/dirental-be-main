import type { BookingSettings, Listing, PricingMode } from '../../db/schema/index.js';

export type QuoteIssue = { code: string; message: string; listingId?: string };

export type QuoteLine = {
  listingId: string;
  name: string;
  slug: string;
  quantity: number;
  pricingMode: PricingMode;
  units: number;
  unitPrice: number;
  lineTotal: number;
  deposit: number;
  available: number;
};

const HOUR = 3_600_000;

/**
 * Prices one listing for a time range. Hourly mode applies when the listing has an hourly price and the
 * range is under 24h (or it has no daily price); otherwise daily mode, rounding partial days up.
 */
export function priceLine(listing: Listing, startAt: Date, endAt: Date, quantity: number, available: number): { line: QuoteLine | null; issues: QuoteIssue[] } {
  const issues: QuoteIssue[] = [];
  const ms = endAt.getTime() - startAt.getTime();
  if (ms <= 0) {
    return { line: null, issues: [{ code: 'INVALID_RANGE', message: 'End must be after start', listingId: listing.id }] };
  }
  const hours = ms / HOUR;
  const canHour = listing.pricePerHour != null;
  const canDay = listing.pricePerDay != null;
  if (!canHour && !canDay) return { line: null, issues: [{ code: 'NO_PRICE', message: 'Listing has no price', listingId: listing.id }] };

  let pricingMode: PricingMode;
  let units: number;
  let unitPrice: number;

  if (canHour && (!canDay || hours < 24)) {
    pricingMode = 'hour';
    units = Math.max(Math.ceil(hours - 1e-9), listing.minHours);
    unitPrice = listing.pricePerHour!;
    if (Math.ceil(hours - 1e-9) < listing.minHours) {
      issues.push({ code: 'MIN_HOURS', message: `Minimum rental is ${listing.minHours} hour(s); charged as ${listing.minHours}`, listingId: listing.id });
    }
  } else {
    pricingMode = 'day';
    const days = Math.ceil(hours / 24 - 1e-9);
    units = Math.max(days, listing.minDays);
    unitPrice = listing.pricePerDay!;
    if (days < listing.minDays) {
      issues.push({ code: 'MIN_DAYS', message: `Minimum rental is ${listing.minDays} day(s); charged as ${listing.minDays}`, listingId: listing.id });
    }
    if (listing.maxDays != null && units > listing.maxDays) {
      return { line: null, issues: [{ code: 'MAX_DAYS', message: `Maximum rental is ${listing.maxDays} day(s)`, listingId: listing.id }] };
    }
  }

  if (quantity > available) {
    issues.push({ code: 'UNAVAILABLE', message: available <= 0 ? 'Not available for these dates' : `Only ${available} unit(s) available`, listingId: listing.id });
  }

  const line: QuoteLine = {
    listingId: listing.id,
    name: listing.name,
    slug: listing.slug,
    quantity,
    pricingMode,
    units,
    unitPrice,
    lineTotal: units * unitPrice * quantity,
    deposit: listing.depositAmount * quantity,
    available,
  };
  return { line, issues };
}

export function checkLeadTime(startAt: Date, settings: BookingSettings, now = new Date()): QuoteIssue | null {
  const earliest = now.getTime() + settings.minLeadHours * HOUR;
  if (startAt.getTime() < earliest) {
    return {
      code: 'LEAD_TIME',
      message: settings.minLeadHours > 0 ? `Bookings must start at least ${settings.minLeadHours} hour(s) from now` : 'Start time is in the past',
    };
  }
  return null;
}

export function deliveryFeeFor(fulfillment: 'pickup' | 'delivery', settings: BookingSettings, listingsAllowDelivery: boolean): { fee: number; issue: QuoteIssue | null } {
  if (fulfillment === 'pickup') return { fee: 0, issue: null };
  if (!settings.deliveryEnabled || !listingsAllowDelivery) {
    return { fee: 0, issue: { code: 'DELIVERY_UNAVAILABLE', message: 'Delivery is not offered for this booking' } };
  }
  return { fee: settings.deliveryFee, issue: null };
}

export function sumLines(lines: QuoteLine[], deliveryFee: number) {
  const subtotal = lines.reduce((a, l) => a + l.lineTotal, 0);
  const depositAmount = lines.reduce((a, l) => a + l.deposit, 0);
  return { subtotal, depositAmount, deliveryFee, total: subtotal + depositAmount + deliveryFee };
}
