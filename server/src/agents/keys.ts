/**
 * Per-user data for the other AI providers: API keys (stored AES-GCM encrypted, only handed
 * to that user's own agent processes, each agent only gets the keys it needs) and
 * preferences (default AI for new chats, default model per AI).
 *
 * Sign-ins made in an agent's own login flow (ChatGPT, Google, OpenCode's provider logins)
 * are kept by that agent in the user's sandbox home — the Studio does not store them.
 */
import { exec, q, q1 } from '../db.js';
import { decryptSecret, encryptSecret, hintFor } from '../lib/crypto.js';
import { baseUserEnv, type SysUser } from '../lib/system.js';
import { getConnection } from '../claude/creds.js';
import { API_KEYS, type AgentDef, type LaunchOpts } from './registry.js';

export interface AgentPrefs {
  /** default AI for new chats ('claude' or an agent id) */
  defaultProvider?: string;
  /** default model per AI */
  models?: Record<string, string>;
}

/**
 * The model an AI gets in a project: the project's model setting belongs to the project's own AI
 * (its setting, else the user's default AI); on the Chat page it is the Claude model picker.
 * `null` = no project model for this AI (use the AI's own default).
 */
export function projectModelFor(aiId: string, settings: { provider?: string; model?: string }, prefs: AgentPrefs, casual: boolean): string | null {
  if (!settings.model) return null;
  const projectAi = casual ? 'claude' : settings.provider || prefs.defaultProvider || 'claude';
  return projectAi === aiId ? settings.model : null;
}

export async function getPrefs(userId: number): Promise<AgentPrefs> {
  const row = await q1<{ prefs: AgentPrefs | null }>('SELECT prefs FROM agent_prefs WHERE user_id = ?', [userId]);
  return row?.prefs ?? {};
}

export async function setPrefs(userId: number, patch: AgentPrefs): Promise<AgentPrefs> {
  const cur = await getPrefs(userId);
  const next: AgentPrefs = {
    ...cur,
    ...(patch.defaultProvider !== undefined ? { defaultProvider: patch.defaultProvider || undefined } : {}),
    models: { ...(cur.models ?? {}), ...(patch.models ?? {}) },
  };
  for (const [k, v] of Object.entries(next.models ?? {})) if (!v) delete next.models![k];
  await exec('INSERT INTO agent_prefs (user_id, prefs) VALUES (?, ?) ON DUPLICATE KEY UPDATE prefs = VALUES(prefs)', [userId, JSON.stringify(next)]);
  return next;
}

export interface StoredKey {
  id: string;
  hint: string | null;
  updatedAt: Date;
}

export async function listKeys(userId: number): Promise<StoredKey[]> {
  const rows = await q<{ key_id: string; secret_hint: string | null; updated_at: Date }>(
    'SELECT key_id, secret_hint, updated_at FROM agent_keys WHERE user_id = ? ORDER BY key_id',
    [userId],
  );
  return rows.map((r) => ({ id: r.key_id, hint: r.secret_hint, updatedAt: r.updated_at }));
}

export async function saveKey(userId: number, keyId: string, secret: string): Promise<void> {
  await exec(
    `INSERT INTO agent_keys (user_id, key_id, secret_enc, secret_hint) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE secret_enc = VALUES(secret_enc), secret_hint = VALUES(secret_hint)`,
    [userId, keyId, encryptSecret(secret), hintFor(secret)],
  );
}

export async function deleteKey(userId: number, keyId: string): Promise<void> {
  await exec('DELETE FROM agent_keys WHERE user_id = ? AND key_id = ?', [userId, keyId]);
}

/** The user's keys (decrypted) — 'anthropic' is the Claude connection's own API key, if any. */
async function decryptedKeys(userId: number): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const rows = await q<{ key_id: string; secret_enc: string }>('SELECT key_id, secret_enc FROM agent_keys WHERE user_id = ?', [userId]);
  for (const r of rows) {
    try {
      out[r.key_id] = decryptSecret(r.secret_enc);
    } catch {
      console.warn(`[agents] cannot decrypt the ${r.key_id} key of user ${userId} (APP_SECRET changed?)`);
    }
  }
  const claude = await getConnection(userId);
  if (claude?.method === 'api_key' && claude.secret_enc) {
    try {
      out.anthropic = decryptSecret(claude.secret_enc);
    } catch {
      /* unreadable */
    }
  }
  return out;
}

/** Which of the agent's keys this user has stored. */
export async function keysFor(userId: number, agent: AgentDef): Promise<string[]> {
  const have = await decryptedKeys(userId);
  return agent.keys.filter((k) => !!have[k]);
}

/** Environment of an agent process: the user's base env + only this agent's keys + its own env. */
export async function agentEnv(
  userId: number,
  su: SysUser,
  agent: AgentDef,
  opts: LaunchOpts,
  extra: Record<string, string | undefined> = {},
): Promise<NodeJS.ProcessEnv> {
  const env = baseUserEnv(su, extra);
  // never inherit a key from the Studio's own environment
  for (const k of API_KEYS) for (const v of k.env) delete env[v];
  delete env.ANTHROPIC_API_KEY;
  const keys = await decryptedKeys(userId);
  for (const id of agent.keys) {
    const value = keys[id];
    if (!value) continue;
    if (id === 'anthropic') env.ANTHROPIC_API_KEY = value;
    for (const v of API_KEYS.find((k) => k.id === id)?.env ?? []) env[v] = value;
    if (id === 'openai' && agent.id === 'codex') env.CODEX_API_KEY = value;
  }
  Object.assign(env, agent.env?.(opts) ?? {});
  return env;
}
