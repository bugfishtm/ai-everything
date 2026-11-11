/**
 * Connecting a user's Claude account — within Anthropic's rules for platforms that
 * host Claude Code (https://code.claude.com/docs/en/legal-and-compliance):
 *   login    — the user signs in to the unmodified Claude Code (`claude auth login`
 *              in a web terminal). The sign-in completes at Anthropic; Claude Code
 *              keeps the login in the user's own sandbox home. The Studio never
 *              collects, stores or uses Claude subscription credentials or tokens.
 *   api_key  — the user's own Anthropic API key (billed to them), stored AES-GCM
 *              encrypted and only handed to that user's Claude processes.
 * (Earlier versions also stored pasted `claude setup-token` tokens; migration 3
 * deletes those — subscription tokens must not be stored by third-party software.)
 */
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { exec, q1 } from '../db.js';
import { decryptSecret, encryptSecret, hintFor } from '../lib/crypto.js';
import { HttpError, parse } from '../lib/http.js';
import { type SysUser, baseUserEnv, ensureSysUser, run, runAs } from '../lib/system.js';
import { cliNotReadyMessage, cliReady } from '../claudecli.js';
import { sendToUser } from '../ws.js';

export type ConnMethod = 'login' | 'api_key';

export interface ConnectionRow {
  user_id: number;
  method: ConnMethod;
  secret_enc: string | null;
  secret_hint: string | null;
  default_model: string | null;
  last_status: unknown;
  verified_at: Date | null;
  updated_at: Date;
  account_extras: number;
}

export async function getConnection(userId: number): Promise<ConnectionRow | null> {
  return q1<ConnectionRow>('SELECT * FROM claude_connections WHERE user_id = ?', [userId]);
}

/**
 * A Claude account can bring its own plugins, claude.ai connectors (Gmail, Slack …)
 * and MCP servers. Loaded into every Studio run they add dozens of tools, slow the
 * start and fill the context — so by default Studio runs use only the Studio tools.
 * Users can switch them on (Account → "Use my account's plugins and connectors").
 */
export function accountExtrasArgs(enabled: boolean): string[] {
  return enabled ? [] : ['--strict-mcp-config', '--disable-slash-commands'];
}
export function accountExtrasEnv(enabled: boolean): Record<string, string> {
  return enabled ? {} : { ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS: '1' };
}

/** Environment for a Claude process of this user, including the stored credential. */
export async function claudeEnv(userId: number, su: SysUser, extra: Record<string, string | undefined> = {}): Promise<NodeJS.ProcessEnv> {
  const env = baseUserEnv(su, extra);
  const conn = await getConnection(userId);
  if (conn?.secret_enc && conn.method === 'api_key') {
    try {
      env.ANTHROPIC_API_KEY = decryptSecret(conn.secret_enc);
    } catch {
      console.warn(`[claude] cannot decrypt stored credential of user ${userId} (APP_SECRET changed?)`);
    }
  }
  return env;
}

export interface ClaudeStatus {
  loggedIn: boolean;
  authMethod: string;
  method: ConnMethod;
  hint: string | null;
  loginExpiresAt: string | null;
  defaultModel: string | null;
  verifiedAt: Date | null;
  /** load the account's plugins / connectors / MCP servers in Studio runs */
  accountExtras: boolean;
  /** subscription type of a `claude auth login` (pro, max, team …) */
  plan: string | null;
  error?: string;
  checkedAt: number;
}

const statusCache = new Map<number, ClaudeStatus>();

export function invalidateStatus(userId: number): void {
  statusCache.delete(userId);
  sendToUser(userId, { t: 'claude.changed' });
}

export async function claudeStatus(userId: number, refresh = false): Promise<ClaudeStatus> {
  const cached = statusCache.get(userId);
  if (cached && !refresh && Date.now() - cached.checkedAt < 30_000) return cached;
  const su = await ensureSysUser(userId);
  const conn = await getConnection(userId);
  const env = await claudeEnv(userId, su);
  let parsed: { loggedIn?: boolean; authMethod?: string; loginExpiresAt?: string | null; subscriptionType?: string | null } | null = null;
  let error: string | undefined;
  if (!cliReady()) {
    error = cliNotReadyMessage();
  } else {
    try {
      const r = await runAs(su, config.claudeBin, ['auth', 'status', '--json'], { env, cwd: su.home, timeoutMs: 30_000 });
      try {
        parsed = JSON.parse(r.stdout);
      } catch {
        error = (r.stderr || r.stdout).trim().slice(0, 500) || `claude exited with ${r.code}`;
      }
    } catch (err) {
      error = `Claude Code CLI not available: ${(err as Error).message}`;
    }
  }
  const status: ClaudeStatus = {
    loggedIn: !!parsed?.loggedIn,
    authMethod: parsed?.authMethod ?? 'none',
    method: conn?.method ?? 'login',
    hint: conn?.method !== 'login' ? (conn?.secret_hint ?? null) : null,
    loginExpiresAt: parsed?.loginExpiresAt ?? null,
    defaultModel: conn?.default_model ?? null,
    verifiedAt: conn?.verified_at ?? null,
    accountExtras: !!conn?.account_extras,
    plan: parsed?.subscriptionType ?? null,
    error,
    checkedAt: Date.now(),
  };
  statusCache.set(userId, status);
  return status;
}

export async function claudeVersion(): Promise<string | null> {
  const r = await run(config.claudeBin, ['--version'], {
    timeoutMs: 15_000,
    env: { PATH: process.env.PATH, HOME: '/tmp', DISABLE_AUTOUPDATER: '1' },
  }).catch(() => null);
  return r?.stdout.trim() || null;
}

const AUTH_ERROR = /invalid api key|please run \/login|not logged in|authentication|oauth token|401|credit balance|unauthorized/i;

export function authHint(text: string): string | undefined {
  return AUTH_ERROR.test(text)
    ? 'Your Claude account does not seem to be connected (or the key/token is invalid). Open Account → Claude connection.'
    : undefined;
}

// ---------------------------------------------------------------------------
export const claudeRouter = Router();

claudeRouter.get('/claude/status', async (req, res) => {
  res.json({ status: await claudeStatus(req.user!.id, req.query.refresh === '1') });
});

claudeRouter.put('/claude/credentials', async (req, res) => {
  const body = parse(
    z.object({
      method: z.literal('api_key', { message: 'Only your own Anthropic API key can be stored here — for a Claude subscription, sign in to Claude Code instead' }),
      secret: z.string().trim().min(20, 'that does not look like an API key').max(1000),
    }),
    req.body,
  );
  if (/\s/.test(body.secret)) throw new HttpError(400, 'The key must not contain spaces or line breaks');
  // subscription (OAuth) tokens must not be collected or stored by third-party software
  if (/^sk-ant-oat/i.test(body.secret)) {
    throw new HttpError(400, 'This is a Claude subscription token. The Studio does not store those — use “Sign in to Claude Code” instead.');
  }
  await exec(
    `INSERT INTO claude_connections (user_id, method, secret_enc, secret_hint, verified_at)
     VALUES (?, ?, ?, ?, NULL)
     ON DUPLICATE KEY UPDATE method = VALUES(method), secret_enc = VALUES(secret_enc), secret_hint = VALUES(secret_hint), verified_at = NULL`,
    [req.user!.id, body.method, encryptSecret(body.secret), hintFor(body.secret)],
  );
  invalidateStatus(req.user!.id);
  res.json({ status: await claudeStatus(req.user!.id, true) });
});

claudeRouter.delete('/claude/credentials', async (req, res) => {
  await exec(
    `INSERT INTO claude_connections (user_id, method) VALUES (?, 'login')
     ON DUPLICATE KEY UPDATE method = 'login', secret_enc = NULL, secret_hint = NULL, verified_at = NULL`,
    [req.user!.id],
  );
  invalidateStatus(req.user!.id);
  res.json({ status: await claudeStatus(req.user!.id, true) });
});

claudeRouter.post('/claude/logout', async (req, res) => {
  const su = await ensureSysUser(req.user!.id);
  await runAs(su, config.claudeBin, ['auth', 'logout'], { env: baseUserEnv(su), cwd: su.home, timeoutMs: 30_000 });
  await exec('UPDATE claude_connections SET verified_at = NULL WHERE user_id = ?', [req.user!.id]);
  invalidateStatus(req.user!.id);
  res.json({ status: await claudeStatus(req.user!.id, true) });
});

claudeRouter.patch('/claude/settings', async (req, res) => {
  const body = parse(z.object({ defaultModel: z.string().trim().max(64).optional(), accountExtras: z.boolean().optional() }), req.body);
  if (body.defaultModel !== undefined) {
    await exec(
      `INSERT INTO claude_connections (user_id, default_model) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE default_model = VALUES(default_model)`,
      [req.user!.id, body.defaultModel || null],
    );
  }
  if (body.accountExtras !== undefined) {
    await exec(
      `INSERT INTO claude_connections (user_id, account_extras) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE account_extras = VALUES(account_extras)`,
      [req.user!.id, body.accountExtras ? 1 : 0],
    );
  }
  invalidateStatus(req.user!.id);
  res.json({ status: await claudeStatus(req.user!.id, true) });
});

/** Sends one tiny prompt to prove the connection works end to end. */
claudeRouter.post('/claude/test', async (req, res) => {
  const userId = req.user!.id;
  if (!cliReady()) throw new HttpError(503, cliNotReadyMessage());
  const su = await ensureSysUser(userId);
  const env = await claudeEnv(userId, su, accountExtrasEnv(false));
  const started = Date.now();
  const r = await runAs(
    su,
    config.claudeBin,
    ['-p', '--output-format', 'json', '--max-turns', '1', '--model', 'haiku', '--tools', '', '--no-session-persistence', '--strict-mcp-config'],
    { env, cwd: su.home, input: 'Reply with exactly one word: CONNECTED', timeoutMs: 120_000 },
  );
  let result: { is_error?: boolean; result?: string; total_cost_usd?: number } | null = null;
  try {
    result = JSON.parse(r.stdout.trim().split('\n').pop() ?? '');
  } catch {
    /* not json */
  }
  const ok = !!result && !result.is_error && r.code === 0;
  const message = ok ? (result?.result ?? '').trim() : (result?.result || r.stderr || r.stdout || `exit ${r.code}`).trim().slice(0, 1000);
  if (ok) await exec('INSERT INTO claude_connections (user_id, verified_at) VALUES (?, UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE verified_at = UTC_TIMESTAMP(3)', [userId]);
  invalidateStatus(userId);
  res.json({ ok, message, hint: ok ? undefined : authHint(message), ms: Date.now() - started, costUsd: result?.total_cost_usd });
});
