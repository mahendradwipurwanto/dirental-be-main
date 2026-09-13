import { eq } from 'drizzle-orm';
import { waitUntil } from '@vercel/functions';
import { db } from '../../db/client.js';
import { notificationLogs, type Booking, type BookingItem, type NotificationType, type Tenant, type User } from '../../db/schema/index.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { layout, sendEmail } from '../../lib/mailer.js';
import { users } from '../../db/schema/index.js';
import { formatIDR, formatRange } from './format.js';

type Ctx = { booking: Booking; items: BookingItem[]; tenant: Tenant; accessToken?: string; reason?: string };

const bookingUrl = (tenant: Tenant, booking: Booking, token?: string) =>
  `${env.WEB_URL}/${tenant.slug}/booking/${booking.code}${token ? `?token=${token}` : ''}`;
const adminUrl = (booking: Booking) => `${env.ADMIN_URL}/bookings/${booking.id}`;

function t(locale: string, id: string, en: string) {
  return locale === 'en' ? en : id;
}

function itemsRows(items: BookingItem[], locale: string): [string, string][] {
  return items.map((i) => [
    i.listingSnapshot.name,
    `${i.quantity} × ${i.units} ${i.pricingMode === 'hour' ? t(locale, 'jam', 'hr') : t(locale, 'hari', 'day')} — ${formatIDR(i.lineTotal)}`,
  ]);
}

function customerEmailFor(type: NotificationType, ctx: Ctx) {
  const { booking, items, tenant } = ctx;
  const locale = tenant.locale;
  const url = bookingUrl(tenant, booking, ctx.accessToken);
  const range = formatRange(booking.startAt, booking.endAt, tenant.timezone, locale);
  const base: [string, string][] = [
    [t(locale, 'Kode booking', 'Booking code'), booking.code],
    [t(locale, 'Jadwal', 'Schedule'), range],
    ...itemsRows(items, locale),
    [t(locale, 'Total', 'Total'), formatIDR(booking.total)],
  ];
  switch (type) {
    case 'booking_created':
      return layout({
        title: t(locale, `Booking diterima — ${booking.code}`, `Booking received — ${booking.code}`),
        intro: t(
          locale,
          `Terima kasih ${booking.customerName}! Selesaikan pembayaran via transfer bank ${booking.expiresAt ? 'sebelum ' + formatRange(booking.expiresAt, null, tenant.timezone, locale) : 'segera'}, lalu unggah bukti transfer di tautan berikut.`,
          `Thanks ${booking.customerName}! Complete payment by bank transfer ${booking.expiresAt ? 'before ' + formatRange(booking.expiresAt, null, tenant.timezone, locale) : 'soon'}, then upload the transfer receipt via the link below.`,
        ),
        rows: base,
        cta: { label: t(locale, 'Lihat instruksi pembayaran', 'View payment instructions'), url },
        footer: tenant.name,
      });
    case 'booking_confirmed':
      return layout({
        title: t(locale, `Booking dikonfirmasi — ${booking.code}`, `Booking confirmed — ${booking.code}`),
        intro: t(locale, `Pembayaranmu sudah diverifikasi oleh ${tenant.name}. Sampai jumpa!`, `Your payment has been verified by ${tenant.name}. See you soon!`),
        rows: base,
        cta: { label: t(locale, 'Lihat booking', 'View booking'), url },
        footer: tenant.name,
      });
    case 'booking_rejected':
      return layout({
        title: t(locale, `Bukti pembayaran ditolak — ${booking.code}`, `Payment proof rejected — ${booking.code}`),
        intro: t(
          locale,
          `${tenant.name} tidak dapat memverifikasi bukti transfermu${ctx.reason ? `: ${ctx.reason}` : ''}. Silakan unggah ulang bukti yang benar.`,
          `${tenant.name} could not verify your transfer${ctx.reason ? `: ${ctx.reason}` : ''}. Please upload a correct receipt.`,
        ),
        rows: base,
        cta: { label: t(locale, 'Unggah ulang bukti', 'Re-upload receipt'), url },
        footer: tenant.name,
      });
    case 'booking_expired':
      return layout({
        title: t(locale, `Booking kedaluwarsa — ${booking.code}`, `Booking expired — ${booking.code}`),
        intro: t(locale, 'Batas waktu pembayaran terlewati, jadi booking ini dibatalkan otomatis. Kamu bisa membuat booking baru kapan saja.', 'The payment window passed, so this booking was cancelled automatically. You can book again any time.'),
        rows: base,
        footer: tenant.name,
      });
    case 'booking_cancelled':
      return layout({
        title: t(locale, `Booking dibatalkan — ${booking.code}`, `Booking cancelled — ${booking.code}`),
        intro: ctx.reason ? t(locale, `Alasan: ${ctx.reason}`, `Reason: ${ctx.reason}`) : undefined,
        rows: base,
        footer: tenant.name,
      });
    case 'booking_completed':
      return layout({
        title: t(locale, `Terima kasih — ${booking.code}`, `Thank you — ${booking.code}`),
        intro: t(locale, `Sewa selesai. Terima kasih sudah menyewa di ${tenant.name}!`, `Rental completed. Thanks for renting with ${tenant.name}!`),
        rows: base,
        footer: tenant.name,
      });
    default:
      return null;
  }
}

function ownerEmailFor(type: NotificationType, ctx: Ctx) {
  const { booking, items, tenant } = ctx;
  const locale = tenant.locale;
  const rows: [string, string][] = [
    [t(locale, 'Kode', 'Code'), booking.code],
    [t(locale, 'Pelanggan', 'Customer'), `${booking.customerName} · ${booking.customerPhone}`],
    [t(locale, 'Jadwal', 'Schedule'), formatRange(booking.startAt, booking.endAt, tenant.timezone, locale)],
    ...itemsRows(items, locale),
    [t(locale, 'Total', 'Total'), formatIDR(booking.total)],
  ];
  switch (type) {
    case 'booking_created':
      return layout({ title: t(locale, `Booking baru ${booking.code}`, `New booking ${booking.code}`), rows, cta: { label: t(locale, 'Buka dashboard', 'Open dashboard'), url: adminUrl(booking) } });
    case 'proof_submitted':
      return layout({
        title: t(locale, `Bukti transfer masuk — ${booking.code}`, `Transfer receipt received — ${booking.code}`),
        intro: t(locale, 'Pelanggan mengunggah bukti transfer. Verifikasi sekarang.', 'The customer uploaded a receipt. Verify it now.'),
        rows,
        cta: { label: t(locale, 'Verifikasi', 'Verify'), url: adminUrl(booking) },
      });
    case 'booking_cancelled':
      return layout({ title: t(locale, `Booking dibatalkan — ${booking.code}`, `Booking cancelled — ${booking.code}`), intro: ctx.reason, rows });
    default:
      return null;
  }
}

async function recipients(ctx: Ctx): Promise<{ customer: string; owner: string | null }> {
  const owner: User | undefined = await db.query.users.findFirst({ where: eq(users.id, ctx.tenant.ownerUserId) });
  return { customer: ctx.booking.customerEmail, owner: ctx.tenant.contact.email ?? owner?.email ?? null };
}

/**
 * Sends the emails for a booking event to customer and owner, exactly once per dedupe key.
 * Runs after the response via waitUntil.
 */
export function notify(type: NotificationType, ctx: Ctx, dedupeSuffix = ''): void {
  waitUntil(
    (async () => {
      const to = await recipients(ctx);
      const jobs: { recipient: string; email: ReturnType<typeof layout> | null; subjectFrom: 'customer' | 'owner' }[] = [
        { recipient: to.customer, email: customerEmailFor(type, ctx), subjectFrom: 'customer' },
        ...(to.owner ? [{ recipient: to.owner, email: ownerEmailFor(type, ctx), subjectFrom: 'owner' as const }] : []),
      ];
      for (const job of jobs) {
        if (!job.email) continue;
        const dedupeKey = `${ctx.booking.id}:${type}:${job.subjectFrom}${dedupeSuffix ? ':' + dedupeSuffix : ''}`;
        const inserted = await db
          .insert(notificationLogs)
          .values({ bookingId: ctx.booking.id, type, recipient: job.recipient, dedupeKey, status: 'pending' })
          .onConflictDoNothing()
          .returning({ id: notificationLogs.id });
        const logId = inserted[0]?.id;
        if (!logId) continue;
        try {
          const subject = job.email.text.split('\n')[0] ?? type;
          const result = await sendEmail({ to: job.recipient, subject, html: job.email.html, text: job.email.text });
          await db.update(notificationLogs).set({ status: 'sent', providerId: result.id }).where(eq(notificationLogs.id, logId));
        } catch (err) {
          logger.error({ err, type, bookingId: ctx.booking.id }, 'notification failed');
          await db.update(notificationLogs).set({ status: 'failed', error: String(err) }).where(eq(notificationLogs.id, logId));
        }
      }
    })(),
  );
}
