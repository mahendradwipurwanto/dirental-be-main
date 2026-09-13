export function formatIDR(amount: number): string {
  return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(amount);
}

const fmt = (d: Date, timeZone: string, locale: string) =>
  new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'id-ID', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);

export function formatRange(start: Date, end: Date | null, timeZone: string, locale: string): string {
  if (!end) return fmt(start, timeZone, locale);
  return `${fmt(start, timeZone, locale)} → ${fmt(end, timeZone, locale)}`;
}
