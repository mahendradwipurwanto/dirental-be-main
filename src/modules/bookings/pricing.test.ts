import { describe, expect, it } from 'vitest';
import type { BookingSettings, Listing } from '../../db/schema/index.js';
import { checkLeadTime, deliveryFeeFor, priceLine, sumLines } from './pricing.js';

const base: Listing = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  categoryId: null,
  slug: 'vario',
  name: 'Vario',
  summary: null,
  description: null,
  status: 'active',
  stockQuantity: 5,
  pricePerHour: 25_000,
  pricePerDay: 90_000,
  minHours: 3,
  minDays: 1,
  maxDays: null,
  depositAmount: 300_000,
  pickupEnabled: true,
  deliveryEnabled: false,
  bufferMinutes: 0,
  isFeatured: false,
  sortOrder: 0,
  attributes: {},
  createdAt: new Date(),
  updatedAt: new Date(),
};

const at = (h: number) => new Date(Date.UTC(2026, 8, 10, h));

describe('priceLine', () => {
  it('uses hourly mode under 24h and enforces minHours', () => {
    const { line, issues } = priceLine(base, at(2), at(4), 1, 5);
    expect(line?.pricingMode).toBe('hour');
    expect(line?.units).toBe(3);
    expect(line?.lineTotal).toBe(75_000);
    expect(issues.map((i) => i.code)).toContain('MIN_HOURS');
  });

  it('switches to daily mode at 24h and rounds partial days up', () => {
    const { line } = priceLine(base, at(2), new Date(at(2).getTime() + 30 * 3_600_000), 2, 5);
    expect(line?.pricingMode).toBe('day');
    expect(line?.units).toBe(2);
    expect(line?.lineTotal).toBe(2 * 90_000 * 2);
    expect(line?.deposit).toBe(600_000);
  });

  it('uses hourly for long ranges when there is no daily price', () => {
    const { line } = priceLine({ ...base, pricePerDay: null }, at(0), new Date(at(0).getTime() + 30 * 3_600_000), 1, 5);
    expect(line?.pricingMode).toBe('hour');
    expect(line?.units).toBe(30);
  });

  it('flags unavailability and invalid ranges', () => {
    expect(priceLine(base, at(2), at(4), 3, 2).issues.some((i) => i.code === 'UNAVAILABLE')).toBe(true);
    expect(priceLine(base, at(4), at(2), 1, 5).line).toBeNull();
  });

  it('rejects ranges beyond maxDays', () => {
    const r = priceLine({ ...base, maxDays: 2 }, at(0), new Date(at(0).getTime() + 72 * 3_600_000), 1, 5);
    expect(r.line).toBeNull();
    expect(r.issues[0]?.code).toBe('MAX_DAYS');
  });
});

const settings: BookingSettings = { paymentWindowMinutes: 120, minLeadHours: 2, pickupEnabled: true, deliveryEnabled: true, deliveryFee: 50_000, instructions: '', cancellationHours: 24 };

describe('lead time and delivery', () => {
  it('requires start after the lead time', () => {
    const now = new Date();
    expect(checkLeadTime(new Date(now.getTime() + 3_600_000), settings, now)?.code).toBe('LEAD_TIME');
    expect(checkLeadTime(new Date(now.getTime() + 3 * 3_600_000), settings, now)).toBeNull();
  });

  it('charges delivery only when both tenant and listings allow it', () => {
    expect(deliveryFeeFor('pickup', settings, false).fee).toBe(0);
    expect(deliveryFeeFor('delivery', settings, true).fee).toBe(50_000);
    expect(deliveryFeeFor('delivery', settings, false).issue?.code).toBe('DELIVERY_UNAVAILABLE');
    expect(deliveryFeeFor('delivery', { ...settings, deliveryEnabled: false }, true).issue?.code).toBe('DELIVERY_UNAVAILABLE');
  });

  it('sums lines, deposits and delivery', () => {
    const l = priceLine(base, at(2), at(6), 2, 5).line!;
    expect(sumLines([l], 50_000)).toEqual({ subtotal: 200_000, depositAmount: 600_000, deliveryFee: 50_000, total: 850_000 });
  });
});
