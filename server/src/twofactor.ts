/**
 * Optional two-step sign-in: a time-based one-time code from an authenticator app (TOTP) after
 * the password, with single-use recovery codes for a lost phone. Every user decides for their
 * own account (Account & AI → Two-step sign-in); an admin can switch it off for someone who lost
 * both (Admin → Users → Reset 2FA).
 *
 * The shared secret is stored encrypted (AES-256-GCM with the app secret), recovery codes only as
 * keyed hashes. The last accepted 30-second step is stored too, so a code works once.
 */
import crypto from 'node:crypto';
import { config } from './config.js';
import { exec, getPool, q1 } from './db.js';
import { decryptSecret, encryptSecret, randomToken, sha256, signToken, verifyToken } from './lib/crypto.js';
import { generateRecoveryCodes, generateTotpSecret, normalizeRecoveryCode, normalizeTotpCode, otpauthUri, verifyTotp } from './lib/totp.js';
import type { UserRow } from './users.js';

export const RECOVERY_CODE_COUNT = 10;
/**
 * Wrong codes in a row after which codes from the app are no longer accepted — only a recovery
 * code (about 59 random bits, not guessable) or an admin reset gets in. Together with the
 * per-address limit this caps guessing for good instead of "5 every 15 minutes, forever".
 */
export const MAX_CODE_FAILURES = 10;
/** how long the code step of a sign-in may take after the password was right */
const LOGIN_TICKET_SEC = 5 * 60;
/** how long the "scan the QR code" step of the setup may take */
const SETUP_TOKEN_SEC = 15 * 60;

export function twoFactorOn(row: Pick<UserRow, 'totp_secret_enc' | 'totp_enabled_at'>): boolean {
  return !!row.totp_secret_enc && !!row.totp_enabled_at;
}

function recoveryHash(code: string): string {
  // keyed: a copy of the database alone does not allow guessing the codes offline
  return crypto.createHmac('sha256', `studio-recovery:${config.appSecret}`).update(code).digest('hex');
}

/**
 * A ticket's tie to the account's current state: a new password, or 2FA switched off/on again,
 * makes outstanding tickets worthless.
 */
function ticketBinding(row: Pick<UserRow, 'password_hash' | 'totp_secret_enc'>): string {
  return sha256(`${row.password_hash}|${row.totp_secret_enc ?? ''}`).slice(0, 24);
}

// ---- the sign-in ticket: password was right, the code is still to come --------------------------
const usedTickets = new Map<string, number>();
setInterval(() => {
  const now = Date.now() / 1000;
  for (const [k, exp] of usedTickets) if (exp < now) usedTickets.delete(k);
}, 60_000).unref();

export function issueLoginTicket(row: UserRow): string {
  return signToken({ k: '2fa-login', uid: row.id, b: ticketBinding(row), j: randomToken(12) }, LOGIN_TICKET_SEC);
}

export interface LoginTicket {
  uid: number;
  binding: string;
  jti: string;
  exp: number;
}

export function readLoginTicket(ticket: string): LoginTicket | null {
  const t = verifyToken<{ k?: unknown; uid?: unknown; b?: unknown; j?: unknown; exp: number }>(ticket);
  if (!t || t.k !== '2fa-login' || typeof t.uid !== 'number' || typeof t.b !== 'string' || typeof t.j !== 'string') return null;
  if (usedTickets.has(t.j)) return null;
  return { uid: t.uid, binding: t.b, jti: t.j, exp: t.exp };
}

/** the ticket still fits the account (same password, same 2FA secret, still active) */
export function ticketMatches(t: LoginTicket, row: UserRow): boolean {
  if (row.id !== t.uid || row.status !== 'active' || !twoFactorOn(row)) return false;
  const a = Buffer.from(ticketBinding(row));
  const b = Buffer.from(t.binding);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** a ticket that led to a session is not accepted again */
export function spendLoginTicket(t: LoginTicket): void {
  if (usedTickets.size > 50_000) usedTickets.clear(); // (bounded; tickets expire within minutes anyway)
  usedTickets.set(t.jti, t.exp);
}

// ---- checking a code ------------------------------------------------------------------------------

export type SecondFactorResult =
  | { ok: true; how: 'totp' | 'recovery'; /** wrong codes entered since the last good one (tell the owner) */ failedBefore: number }
  | { ok: false; reason: 'wrong' | 'locked' };

/**
 * Checks a code from the authenticator app — or, with `allowRecovery`, a recovery code (which is
 * used up by this). Every wrong code is counted in the database and logged; after
 * MAX_CODE_FAILURES in a row only a recovery code is accepted. `from`: the client address (log).
 */
export async function verifySecondFactor(row: UserRow, code: string, allowRecovery: boolean, from = ''): Promise<SecondFactorResult> {
  if (!twoFactorOn(row)) return { ok: false, reason: 'wrong' };
  const failed = Number(row.totp_failed_count ?? 0);
  let how: 'totp' | 'recovery' | null = null;
  if (normalizeTotpCode(code)) {
    if (failed >= MAX_CODE_FAILURES) {
      console.warn(`[2fa] code from the app refused for ${row.username} (#${row.id})${from ? ` from ${from}` : ''}: locked after ${failed} wrong codes in a row`);
      return { ok: false, reason: 'locked' };
    }
    let secret: string | null = null;
    try {
      secret = decryptSecret(row.totp_secret_enc!);
    } catch {
      console.warn(`[2fa] the secret of user #${row.id} cannot be decrypted (was APP_SECRET changed?)`);
    }
    const step = secret === null ? null : verifyTotp(secret, code, { afterStep: row.totp_last_step === null ? null : Number(row.totp_last_step) });
    if (step !== null) {
      // atomic: of two requests with the same code at the same moment only one gets through
      const r = await exec('UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)', [step, row.id, step]);
      if (r.affectedRows === 1) how = 'totp';
    }
  } else if (allowRecovery && normalizeRecoveryCode(code)) {
    const r = await exec('UPDATE user_recovery_codes SET used_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND code_hash = ? AND used_at IS NULL', [
      row.id,
      recoveryHash(normalizeRecoveryCode(code)!),
    ]);
    if (r.affectedRows === 1) how = 'recovery';
  } else {
    return { ok: false, reason: 'wrong' }; // not even the shape of a code: a typo, not a guess
  }
  if (!how) {
    await exec('UPDATE users SET totp_failed_count = totp_failed_count + 1, totp_failed_at = UTC_TIMESTAMP(3) WHERE id = ?', [row.id]);
    console.warn(`[2fa] wrong code for ${row.username} (#${row.id})${from ? ` from ${from}` : ''} — ${failed + 1} in a row`);
    return { ok: false, reason: failed + 1 >= MAX_CODE_FAILURES ? 'locked' : 'wrong' };
  }
  if (failed) await exec('UPDATE users SET totp_failed_count = 0 WHERE id = ?', [row.id]);
  return { ok: true, how, failedBefore: failed };
}

// ---- setting it up ------------------------------------------------------------------------------

/** Step 1: a new secret for the app (not stored yet — it travels in a signed, encrypted token). */
export function startSetup(row: UserRow, issuer: string): { secret: string; uri: string; setupToken: string } {
  const secret = generateTotpSecret();
  return {
    secret,
    uri: otpauthUri({ secret, account: row.username, issuer }),
    setupToken: signToken({ k: '2fa-setup', uid: row.id, s: encryptSecret(secret) }, SETUP_TOKEN_SEC),
  };
}

/**
 * Step 2: the first code from the app proves it was set up right. Stores the secret, makes new
 * recovery codes and returns them (the only time they are shown). Null: the code was wrong.
 */
function setupSecret(userId: number, setupToken: string): string | null {
  const t = verifyToken<{ k?: unknown; uid?: unknown; s?: unknown }>(setupToken);
  if (!t || t.k !== '2fa-setup' || t.uid !== userId || typeof t.s !== 'string') return null;
  try {
    return decryptSecret(t.s);
  } catch {
    return null;
  }
}

/** the setup token is genuine, this user's, and not expired (checked before any attempt is counted) */
export function setupTokenValid(userId: number, setupToken: string): boolean {
  return setupSecret(userId, setupToken) !== null;
}

export async function finishSetup(userId: number, setupToken: string, code: string): Promise<string[] | null | 'expired' | 'already'> {
  const secret = setupSecret(userId, setupToken);
  if (!secret) return 'expired';
  const step = verifyTotp(secret, code);
  if (step === null) return null;
  const r = await exec(
    'UPDATE users SET totp_secret_enc = ?, totp_enabled_at = UTC_TIMESTAMP(3), totp_last_step = ?, totp_failed_count = 0, totp_failed_at = NULL WHERE id = ? AND totp_enabled_at IS NULL',
    [encryptSecret(secret), step, userId],
  );
  if (r.affectedRows !== 1) return 'already';
  return replaceRecoveryCodes(userId);
}

/** New recovery codes; the old ones stop working. */
export async function replaceRecoveryCodes(userId: number): Promise<string[]> {
  const codes = generateRecoveryCodes(RECOVERY_CODE_COUNT);
  const rows = codes.map((c) => [userId, recoveryHash(normalizeRecoveryCode(c)!)]);
  // one transaction: two requests at once must not leave both sets valid
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM user_recovery_codes WHERE user_id = ?', [userId]);
    await conn.query('INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ?', [rows]);
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
  return codes;
}

/** Switches two-step sign-in off for an account (by the user, or an admin for them). */
export async function disableTwoFactor(userId: number): Promise<void> {
  await exec('UPDATE users SET totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL, totp_failed_count = 0, totp_failed_at = NULL WHERE id = ?', [
    userId,
  ]);
  await exec('DELETE FROM user_recovery_codes WHERE user_id = ?', [userId]);
}

export async function twoFactorStatus(userId: number): Promise<{
  enabled: boolean;
  enabledAt: Date | null;
  recoveryCodesLeft: number;
  /** wrong codes in a row since the last good one, and when the last one came */
  failedAttempts: number;
  lastFailedAt: Date | null;
  /** that many wrong codes: codes from the app are refused until a recovery code is used */
  locked: boolean;
}> {
  const row = await q1<{ totp_secret_enc: string | null; totp_enabled_at: Date | null; totp_failed_count: number; totp_failed_at: Date | null }>(
    'SELECT totp_secret_enc, totp_enabled_at, totp_failed_count, totp_failed_at FROM users WHERE id = ?',
    [userId],
  );
  const enabled = !!row && twoFactorOn(row);
  const left = enabled
    ? Number((await q1<{ n: number }>('SELECT COUNT(*) AS n FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL', [userId]))?.n ?? 0)
    : 0;
  const failed = enabled ? Number(row!.totp_failed_count ?? 0) : 0;
  return {
    enabled,
    enabledAt: enabled ? row!.totp_enabled_at : null,
    recoveryCodesLeft: left,
    failedAttempts: failed,
    lastFailedAt: failed ? row!.totp_failed_at : null,
    locked: failed >= MAX_CODE_FAILURES,
  };
}
