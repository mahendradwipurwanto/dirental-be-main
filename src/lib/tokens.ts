import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** URL-safe random token. 32 bytes → 43 chars base64url. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Tokens are stored hashed so a DB leak cannot be replayed. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Human-friendly booking code like `RB-7K3M9QX2` (no I, L, O, U). ~40 bits of entropy. */
export function bookingCode(): string {
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += CROCKFORD[bytes[i]! % 32];
  return `RB-${out}`;
}
