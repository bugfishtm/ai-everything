import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { config } from './config.js';
import { exec, q1 } from './db.js';
import { hashPassword, randomToken, sha256, verifyPassword } from './lib/crypto.js';
import { HttpError, isPrivateAddress, parse } from './lib/http.js';
import { registrationOpen } from './settings.js';
import { closeUserSockets } from './ws.js';
import {
  type AuthUser,
  type UserRow,
  countUsers,
  createUser,
  emailSchema,
  findUserForLogin,
  getUser,
  passwordSchema,
  publicUser,
  usernameSchema,
} from './users.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export const SESSION_COOKIE = 'studio_session';

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function isSecure(req: Request): boolean {
  if (config.cookieSecure === 'true') return true;
  if (config.cookieSecure === 'false') return false;
  return req.secure;
}

function setSessionCookie(req: Request, res: Response, token: string, maxAgeSec: number): void {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  if (isSecure(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

async function createSession(req: Request, res: Response, userId: number): Promise<void> {
  const token = randomToken(32);
  const days = config.limits.sessionDays;
  await exec(
    'INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? DAY), ?, ?)',
    [sha256(token), userId, days, (req.ip ?? '').slice(0, 64), (req.get('user-agent') ?? '').slice(0, 255)],
  );
  await exec('UPDATE users SET last_login_at = UTC_TIMESTAMP(3) WHERE id = ?', [userId]);
  setSessionCookie(req, res, token, days * 86400);
}

/** Every value of the session cookie in a Cookie header (normally one). */
function sessionTokens(header: string | undefined): string[] {
  if (!header) return [];
  const out = new Set<string>();
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0 || part.slice(0, i).trim() !== SESSION_COOKIE) continue;
    let v = part.slice(i + 1).trim();
    try {
      v = decodeURIComponent(v);
    } catch {
      /* keep raw */
    }
    if (v) out.add(v);
  }
  return [...out];
}

/** Resolve the logged-in user from a raw request (also used for WebSocket upgrades). */
export async function userFromRequest(req: IncomingMessage): Promise<AuthUser | null> {
  const tokens = sessionTokens(req.headers.cookie);
  if (tokens.length <= 1) return tokens[0] ? userFromToken(tokens[0]) : null;
  // Several session cookies: one can be planted from a sibling domain (a website published on
  // example.com while the Studio runs on studio.example.com). Only accept them when they all
  // belong to the same account — never log someone into a planted session.
  const users = (await Promise.all(tokens.slice(0, 4).map(userFromToken))).filter((u): u is AuthUser => !!u);
  if (!users.length) return null;
  return users.every((u) => u.id === users[0].id) ? users[0] : null;
}

async function userFromToken(token: string): Promise<AuthUser | null> {
  if (!token || token.length > 200) return null;
  const row = await q1<AuthUser & { session_id: string; last_seen_at: Date }>(
    `SELECT u.id, u.email, u.username, u.display_name, u.role, u.status, u.created_at, u.last_login_at,
            s.id AS session_id, s.last_seen_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > UTC_TIMESTAMP(3)`,
    [sha256(token)],
  );
  if (!row || row.status !== 'active') return null;
  if (Date.now() - new Date(row.last_seen_at).getTime() > 10 * 60_000) {
    exec('UPDATE sessions SET last_seen_at = UTC_TIMESTAMP(3) WHERE id = ?', [row.session_id]).catch(() => {});
  }
  const { session_id: _s, last_seen_at: _l, ...user } = row;
  return user;
}

export async function attachUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  req.user = (await userFromRequest(req)) ?? undefined;
  next();
}

export function requireUser(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(new HttpError(401, 'Please log in'));
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(new HttpError(401, 'Please log in'));
  if (req.user.role !== 'admin') return next(new HttpError(403, 'Admins only'));
  next();
}

/** The request must come from our own pages (blocks cross-site form posts). */
export function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  try {
    const o = new URL(origin);
    if (host && o.host === host) return true;
    if (config.publicUrl && new URL(config.publicUrl).host === o.host) return true;
  } catch {
    return false;
  }
  return false;
}

export function csrfGuard(req: Request, _res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-studio') !== '1') return next(new HttpError(403, 'missing x-studio header'));
  if (!originAllowed(req.get('origin'), req.get('host'))) return next(new HttpError(403, 'cross-origin request blocked'));
  next();
}

// ---- tiny in-memory rate limiter for login/register --------------------------
const attempts = new Map<string, { n: number; reset: number }>();
function rateLimit(key: string, max: number, windowMs: number): void {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || a.reset < now) {
    // (bounded: a flood of made-up names must not grow this without end)
    if (attempts.size > 100_000) {
      for (const [k, v] of attempts) if (v.reset < now) attempts.delete(k);
      if (attempts.size > 100_000) throw new HttpError(429, 'Too many attempts — try again in a few minutes');
    }
    attempts.set(key, { n: 1, reset: now + windowMs });
    return;
  }
  a.n++;
  if (a.n > max) throw new HttpError(429, 'Too many attempts — try again in a few minutes');
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attempts) if (v.reset < now) attempts.delete(k);
}, 60_000).unref();

/** a valid hash of a random password — compared against when the account does not exist */
const DUMMY_HASH = 'scrypt$16384$8$1$c3R1ZGlvLWR1bW15LXNhbHQ=$' + Buffer.alloc(64, 7).toString('base64');

export const authRouter = Router();

// ---- the first account ------------------------------------------------------------------------
// Whoever creates the first account becomes the admin. On this computer or in the private network
// that is the owner; on a server that is reachable from the internet it could be anybody who
// finds it first — from there the setup code is needed (it is in the server log and in the data
// volume: home/.studio/setup-code).
let setupCode = '';
const setupCodeFile = () => path.join(config.stateDir, 'setup-code');

function loadSetupCode(): string {
  if (setupCode) return setupCode;
  try {
    setupCode = fs.readFileSync(setupCodeFile(), 'utf8').trim();
  } catch {
    /* created below */
  }
  if (!/^[A-Z0-9]{4}(-[A-Z0-9]{4}){2}$/.test(setupCode)) {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const part = () => Array.from(crypto.randomBytes(4), (b) => abc[b % abc.length]).join('');
    setupCode = `${part()}-${part()}-${part()}`;
    fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(setupCodeFile(), `${setupCode}\n`, { mode: 0o600 });
  }
  return setupCode;
}

function setupCodeNeeded(req: Request): boolean {
  return !isPrivateAddress(req.ip ?? req.socket.remoteAddress);
}

/** At start, while no account exists: say how the first one is made. */
export async function announceSetup(): Promise<void> {
  if ((await countUsers()) > 0) {
    fs.rmSync(setupCodeFile(), { force: true });
    return;
  }
  const code = loadSetupCode();
  console.log('[studio] ------------------------------------------------------------------');
  console.log('[studio] No account exists yet. Open the website: the first account you create is the admin.');
  console.log(`[studio] From another network (a public server) the form asks for this setup code:  ${code}`);
  console.log('[studio] ------------------------------------------------------------------');
}

let firstAccount: Promise<unknown> | null = null;

authRouter.get('/meta', async (req, res) => {
  const hasUsers = (await countUsers()) > 0;
  res.json({
    appName: config.appName,
    version: config.version,
    hasUsers,
    registrationOpen: await registrationOpen(),
    /** the first account is created from outside the private network: the setup code is asked for */
    setupCode: !hasUsers && setupCodeNeeded(req),
  });
});

authRouter.post('/auth/register', async (req, res) => {
  rateLimit(`reg:${req.ip}`, 10, 60 * 60_000);
  const body = parse(
    z.object({
      email: emailSchema,
      username: usernameSchema,
      displayName: z.string().trim().max(128).optional(),
      password: passwordSchema,
      setupCode: z.string().trim().max(40).optional(),
    }),
    req.body,
  );
  // (one at a time: two "first" registrations at the same moment must not both become admin)
  while (firstAccount) await firstAccount.catch(() => {});
  const first = (await countUsers()) === 0;
  if (!first && !(await registrationOpen())) throw new HttpError(403, 'Registration is closed — ask an admin for an account');
  if (first && setupCodeNeeded(req)) {
    const given = Buffer.from((body.setupCode ?? '').toUpperCase().replace(/[^A-Z0-9]/g, ''));
    const want = Buffer.from(loadSetupCode().replace(/-/g, ''));
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      throw new HttpError(403, 'The setup code is missing or wrong. It is in the server log (docker compose logs studio) — look for "setup code".');
    }
  }
  const { setupCode: _code, ...account } = body;
  const job = createUser({ ...account, role: first ? 'admin' : 'user' });
  if (first) firstAccount = job.finally(() => (firstAccount = null));
  const user = await job;
  if (first) fs.rmSync(setupCodeFile(), { force: true });
  await createSession(req, res, user.id);
  res.json({ user: publicUser(user) });
});

authRouter.post('/auth/login', async (req, res) => {
  const body = parse(z.object({ login: z.string().min(1).max(255), password: z.string().min(1).max(200) }), req.body);
  // per address (trying many accounts) and per address + name (trying many passwords)
  rateLimit(`login-ip:${req.ip}`, 60, 15 * 60_000);
  rateLimit(`login:${req.ip}:${body.login.toLowerCase().slice(0, 80)}`, 10, 15 * 60_000);
  const row: UserRow | null = await findUserForLogin(body.login);
  // unknown names take as long as wrong passwords (no telling which accounts exist)
  const ok = await verifyPassword(body.password, row?.password_hash ?? DUMMY_HASH);
  if (!row || !ok) throw new HttpError(401, 'Wrong username/email or password');
  if (row.status !== 'active') throw new HttpError(403, 'This account is disabled');
  await createSession(req, res, row.id);
  res.json({ user: publicUser(row) });
});

authRouter.post('/auth/logout', async (req, res) => {
  for (const token of sessionTokens(req.headers.cookie).slice(0, 4)) await exec('DELETE FROM sessions WHERE id = ?', [sha256(token)]);
  // open connections (terminals, live updates) end with the login; other browsers of the user reconnect
  if (req.user) closeUserSockets(req.user.id);
  setSessionCookie(req, res, '', 0);
  res.json({ ok: true });
});

authRouter.get('/auth/me', (req, res) => {
  if (!req.user) throw new HttpError(401, 'Please log in');
  res.json({ user: publicUser(req.user) });
});

export const accountRouter = Router();

accountRouter.patch('/account', async (req, res) => {
  const body = parse(z.object({ displayName: z.string().trim().min(1).max(128) }), req.body);
  await exec('UPDATE users SET display_name = ? WHERE id = ?', [body.displayName, req.user!.id]);
  res.json({ user: publicUser((await getUser(req.user!.id))!) });
});

accountRouter.post('/account/password', async (req, res) => {
  const body = parse(z.object({ current: z.string().min(1), next: passwordSchema }), req.body);
  const row = await q1<UserRow>('SELECT * FROM users WHERE id = ?', [req.user!.id]);
  if (!row || !(await verifyPassword(body.current, row.password_hash))) throw new HttpError(400, 'Current password is wrong');
  await exec('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(body.next), row.id]);
  // log out other sessions
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  await exec('DELETE FROM sessions WHERE user_id = ? AND id <> ?', [row.id, sha256(token ?? '')]);
  // a connection opened with one of those sessions must not live on (this page reconnects by itself)
  closeUserSockets(row.id);
  res.json({ ok: true });
});

export async function bootstrapAdmin(): Promise<void> {
  if (!config.admin.email || !config.admin.password) return;
  if ((await countUsers()) > 0) return;
  await createUser({
    email: config.admin.email,
    username: config.admin.username || 'admin',
    password: config.admin.password,
    displayName: 'Administrator',
    role: 'admin',
  });
  console.log(`[auth] created admin account ${config.admin.email}`);
}
