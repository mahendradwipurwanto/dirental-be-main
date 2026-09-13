import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from './logger.js';

export type Email = {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
};

export type SendResult = { id: string | null; provider: 'smtp' | 'console' };

let transporter: Transporter | null = null;

function smtp(): Transporter | null {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
      connectionTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }
  return transporter;
}

/**
 * Sends through SMTP when configured; otherwise logs the email so local development and preview
 * deployments work without a mail provider.
 */
export async function sendEmail(email: Email): Promise<SendResult> {
  const t = smtp();
  if (!t) {
    logger.info({ to: email.to, subject: email.subject, preview: email.text?.slice(0, 200) }, '[mail:console]');
    return { id: null, provider: 'console' };
  }
  const info = await t.sendMail({ from: env.EMAIL_FROM, to: email.to, subject: email.subject, html: email.html, text: email.text, replyTo: email.replyTo });
  return { id: info.messageId ?? null, provider: 'smtp' };
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Minimal, inline-styled layout that renders well in every client. */
export function layout(opts: { title: string; intro?: string; rows?: [string, string][]; cta?: { label: string; url: string }; footer?: string }) {
  const rows = (opts.rows ?? [])
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 12px 6px 0;color:#64748b;font-size:14px;white-space:nowrap">${escapeHtml(k)}</td><td style="padding:6px 0;font-size:14px;color:#0f172a"><strong>${escapeHtml(v)}</strong></td></tr>`,
    )
    .join('');
  const cta = opts.cta
    ? `<p style="margin:24px 0"><a href="${opts.cta.url}" style="display:inline-block;background:#0f766e;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">${escapeHtml(opts.cta.label)}</a></p><p style="font-size:12px;color:#64748b">${opts.cta.url}</p>`
    : '';
  const html = `<!doctype html><html><body style="margin:0;background:#f8fafc;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:32px 20px"><div style="background:#fff;border-radius:12px;padding:28px;border:1px solid #e2e8f0">
<h1 style="margin:0 0 12px;font-size:20px;color:#0f172a">${escapeHtml(opts.title)}</h1>
${opts.intro ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.5;color:#334155">${escapeHtml(opts.intro)}</p>` : ''}
${rows ? `<table style="border-collapse:collapse">${rows}</table>` : ''}
${cta}
${opts.footer ? `<p style="margin:24px 0 0;font-size:12px;color:#94a3b8">${escapeHtml(opts.footer)}</p>` : ''}
</div></div></body></html>`;
  const text = [opts.title, opts.intro, ...(opts.rows ?? []).map(([k, v]) => `${k}: ${v}`), opts.cta ? `${opts.cta.label}: ${opts.cta.url}` : '', opts.footer]
    .filter(Boolean)
    .join('\n');
  return { html, text };
}
