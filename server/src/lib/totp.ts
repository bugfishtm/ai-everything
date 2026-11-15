/**
 * Time-based one-time passwords (RFC 6238 TOTP over RFC 4226 HOTP) — what authenticator apps
 * (Google Authenticator, Aegis, 1Password, Authy …) show: 6 digits, a new one every 30 seconds,
 * HMAC-SHA1. Also the recovery codes that stand in for the app when the phone is gone.
 */
import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_PERIOD = 30;
export const TOTP_DIGITS = 6;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Accepts lower case, spaces, dashes and `=` padding (as people copy secrets around). */
export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error('invalid base32');
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new shared secret: 160 random bits (RFC 4226's recommended length), base32. */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function hotp(key: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export function totpStep(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD);
}

/** "123 456", "123-456" → "123456"; anything that is not 6 digits then → null */
export function normalizeTotpCode(code: string): string | null {
  const c = code.replace(/[\s-]/g, '');
  return new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(c) ? c : null;
}

/**
 * Checks a code against the secret. Accepts the current 30-second step and `window` steps either
 * side (clocks of phones drift). Steps up to and including `afterStep` are refused: a code that
 * was used once must not work a second time. Returns the matched step, or null.
 */
export function verifyTotp(secretB32: string, code: string, opts: { window?: number; nowMs?: number; afterStep?: number | null } = {}): number | null {
  const c = normalizeTotpCode(code);
  if (!c) return null;
  let key: Buffer;
  try {
    key = base32Decode(secretB32);
  } catch {
    return null;
  }
  if (!key.length) return null;
  const window = opts.window ?? 1;
  const now = totpStep(opts.nowMs);
  const given = Buffer.from(c);
  let match: number | null = null;
  // (every candidate is computed and compared — no early exit that would tell which step matched)
  for (let step = now - window; step <= now + window; step++) {
    if (step < 0) continue;
    const ok = crypto.timingSafeEqual(given, Buffer.from(hotp(key, step)));
    if (ok && (opts.afterStep == null || step > opts.afterStep) && match === null) match = step;
  }
  return match;
}

/** The otpauth:// link authenticator apps read from the QR code. */
export function otpauthUri(opts: { secret: string; account: string; issuer: string }): string {
  // (a colon separates issuer and account in the label — neither part may contain one)
  const issuer = opts.issuer.replace(/:/g, ' ').trim() || 'Everything Studio';
  const account = opts.account.replace(/:/g, ' ').trim();
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  // (percent-encoding, not URLSearchParams: some apps show a "+" from form encoding literally)
  const params: [string, string][] = [
    ['secret', opts.secret],
    ['issuer', issuer],
    ['algorithm', 'SHA1'],
    ['digits', String(TOTP_DIGITS)],
    ['period', String(TOTP_PERIOD)],
  ];
  return `otpauth://totp/${label}?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}

// ---- recovery codes ------------------------------------------------------------------------------
// 12 characters from a 31-letter alphabet without look-alikes (0/o, 1/l/i): ~59 random bits each,
// shown as "abcd-efgh-jkmn". Stored only as a keyed hash.
const RC_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const RC_LEN = 12;

export function generateRecoveryCodes(n = 10): string[] {
  const out = new Set<string>();
  while (out.size < n) {
    const bytes = crypto.randomBytes(RC_LEN * 2);
    let s = '';
    // rejection sampling: no modulo bias
    for (const b of bytes) {
      if (b >= 256 - (256 % RC_ALPHABET.length)) continue;
      s += RC_ALPHABET[b % RC_ALPHABET.length];
      if (s.length === RC_LEN) break;
    }
    if (s.length === RC_LEN) out.add(`${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`);
  }
  return [...out];
}

/** What a typed recovery code is compared as: lower case, letters and digits only. */
export function normalizeRecoveryCode(code: string): string | null {
  const c = code.toLowerCase().replace(/[^a-z0-9]/g, '');
  return c.length === RC_LEN ? c : null;
}
