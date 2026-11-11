import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.js';

const scrypt = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** Short random id with a prefix, e.g. ast_k3m9x2qp7v */
export function shortId(prefix: string, len = 10): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return `${prefix}_${out}`;
}

function encKey(): Buffer {
  return crypto.createHash('sha256').update('studio-enc:' + config.appSecret).digest();
}
function macKey(): Buffer {
  return crypto.createHash('sha256').update('studio-mac:' + config.appSecret).digest();
}

/** AES-256-GCM encryption for stored Claude credentials. */
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'v1:' + Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptSecret(enc: string): string {
  if (!enc.startsWith('v1:')) throw new Error('unknown secret format');
  const buf = Buffer.from(enc.slice(3), 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** Compact signed token: base64url(json).base64url(hmac). */
export function signToken(payload: Record<string, unknown>, ttlSeconds: number): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString(
    'base64url',
  );
  const sig = crypto.createHmac('sha256', macKey()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken<T extends Record<string, unknown>>(token: string): T | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(crypto.createHmac('sha256', macKey()).update(body).digest('base64url'));
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & { exp: number };
    if (typeof data.exp !== 'number' || data.exp < Date.now() / 1000) return null;
    return data;
  } catch {
    return null;
  }
}

export function hintFor(secret: string): string {
  const s = secret.trim();
  if (s.length <= 12) return '••••';
  return `${s.slice(0, 10)}…${s.slice(-4)}`;
}
