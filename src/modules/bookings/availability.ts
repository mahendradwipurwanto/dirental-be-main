import { sql } from 'drizzle-orm';
import { TZDate } from '@date-fns/tz';
import type { DbOrTx } from '../../db/client.js';

/** Statuses that hold stock. `rejected` still holds it until its retry window expires. */
export const HOLDING_STATUSES = ['pending_payment', 'awaiting_verification', 'rejected', 'confirmed', 'active'] as const;

const holding = sql.join(
  HOLDING_STATUSES.map((s) => sql`${s}`),
  sql`, `,
);

/**
 * Units of a listing free over [start, end). Existing bookings are widened by the listing's
 * buffer on both sides; blocks with a null quantity block every unit. Conservative: any overlap
 * counts fully for the whole range.
 */
export async function availableUnits(dbx: DbOrTx, listingId: string, start: Date, end: Date): Promise<number> {
  const range = sql`tstzrange(${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz, '[)')`;
  const result = await dbx.execute(sql`
    select l.stock_quantity
      - coalesce((
          select sum(bi.quantity) from booking_items bi
          join bookings b on b.id = bi.booking_id
          where bi.listing_id = l.id
            and b.status in (${holding})
            and tstzrange(b.start_at - make_interval(mins => l.buffer_minutes), b.end_at + make_interval(mins => l.buffer_minutes), '[)') && ${range}
        ), 0)
      - coalesce((
          select sum(coalesce(ab.quantity, l.stock_quantity)) from availability_blocks ab
          where ab.listing_id = l.id and tstzrange(ab.start_at, ab.end_at, '[)') && ${range}
        ), 0) as available
    from listings l
    where l.id = ${listingId}
  `);
  const row = result.rows[0] as { available: string | number | null } | undefined;
  if (!row) return 0;
  return Math.max(0, Number(row.available ?? 0));
}

/** Per-day availability for a calendar month in the tenant timezone. */
export async function dailyAvailability(dbx: DbOrTx, listingId: string, month: string, timezone: string) {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const from = new TZDate(y, m - 1, 1, timezone);
  const to = new TZDate(y, m, 1, timezone);
  const result = await dbx.execute(sql`
    select to_char(d at time zone ${timezone}, 'YYYY-MM-DD') as date,
      l.stock_quantity as stock,
      l.stock_quantity
      - coalesce((
          select sum(bi.quantity) from booking_items bi
          join bookings b on b.id = bi.booking_id
          where bi.listing_id = l.id
            and b.status in (${holding})
            and tstzrange(b.start_at - make_interval(mins => l.buffer_minutes), b.end_at + make_interval(mins => l.buffer_minutes), '[)')
                && tstzrange(d, d + interval '1 day', '[)')
        ), 0)
      - coalesce((
          select sum(coalesce(ab.quantity, l.stock_quantity)) from availability_blocks ab
          where ab.listing_id = l.id and tstzrange(ab.start_at, ab.end_at, '[)') && tstzrange(d, d + interval '1 day', '[)')
        ), 0) as available
    from listings l
    cross join generate_series(${from.toISOString()}::timestamptz, ${to.toISOString()}::timestamptz - interval '1 day', interval '1 day') d
    where l.id = ${listingId}
    order by d
  `);
  const rows = result.rows as { date: string; stock: number; available: string | number }[];
  return {
    month,
    stock: rows[0]?.stock ?? 0,
    days: rows.map((r) => ({ date: r.date, available: Math.max(0, Number(r.available)) })),
  };
}
