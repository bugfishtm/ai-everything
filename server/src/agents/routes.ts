/**
 * Website routes for the other AI providers: each user's connections (sign-in status, API
 * keys, default AI and models, a connection test) and the admin's switches (enable +
 * install, update, remove, custom ACP agents).
 */
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse } from '../lib/http.js';
import { ensureSysUser, runAs, type SysUser } from '../lib/system.js';
import { userReadFile, userRemove, userStat } from '../lib/userfs.js';
import { setSetting, getSetting } from '../settings.js';
import { sendToUser } from '../ws.js';
import { cachedModels, probeAgent, stopAgentEverywhere } from './acprun.js';
import { agentBinPath, installAgent, installState, removeAgentFiles } from './install.js';
import { agentEnv, deleteKey, getPrefs, keysFor, listKeys, saveKey, setPrefs } from './keys.js';
import {
  API_KEYS,
  type AgentDef,
  allAgents,
  BUILTIN_AGENTS,
  CLAUDE_ID,
  type CustomAgent,
  enabledAgentIds,
  getAgent,
  invalidateCustomAgents,
} from './registry.js';

export interface AgentStatus {
  /** null = unknown (custom agents) */
  connected: boolean | null;
  /** how: "ChatGPT sign-in", "OpenAI API key", "free models" … */
  methods: string[];
  checkedAt: number;
}

const statusCache = new Map<string, AgentStatus>();

async function loginStatus(agent: AgentDef, su: SysUser, userId: number): Promise<AgentStatus> {
  const key = `${userId}:${agent.id}`;
  const cached = statusCache.get(key);
  if (cached && Date.now() - cached.checkedAt < 30_000) return cached;
  const methods: string[] = [];
  for (const k of await keysFor(userId, agent)) {
    methods.push(`${k === 'anthropic' ? 'Anthropic' : (API_KEYS.find((x) => x.id === k)?.label ?? k)} API key`);
  }
  let connected: boolean | null = null;
  if (agent.id === 'codex') {
    const r = await runAs(su, agentBinPath('codex', 'codex'), ['login', 'status'], {
      env: await agentEnv(userId, su, agent, { model: null, mode: 'plan', casual: true }),
      cwd: su.home,
      timeoutMs: 20_000,
    }).catch(() => null);
    const out = `${r?.stdout ?? ''}${r?.stderr ?? ''}`;
    if (/logged in using chatgpt/i.test(out)) methods.unshift('ChatGPT sign-in');
    else if (/logged in using an api key/i.test(out) && !methods.some((m) => m.startsWith('OpenAI'))) methods.unshift('OpenAI API key (Codex login)');
    connected = methods.length > 0;
  } else if (agent.id === 'gemini') {
    if (fs.existsSync(path.join(su.home, '.gemini', 'oauth_creds.json'))) methods.unshift('Google sign-in');
    connected = methods.length > 0;
  } else if (agent.id === 'opencode') {
    try {
      // only the provider names — the credentials themselves are not read
      // read as the user (never as the Studio: the path is theirs — it could be a link or a pipe)
      const file = path.join(su.home, '.local', 'share', 'opencode', 'auth.json');
      const st = await userStat(su, file);
      const auth = st?.isFile && st.size < 256 * 1024 ? (JSON.parse((await userReadFile(su, file, 256 * 1024)).data.toString('utf8')) as Record<string, unknown>) : {};
      const names = Object.keys(auth);
      if (names.length) methods.unshift(`OpenCode sign-ins: ${names.join(', ')}`);
    } catch {
      /* no logins */
    }
    // free models need no account, but OpenCode limits them — not counted as "connected"
    connected = methods.length > 0;
    methods.push('free models (limited)');
  }
  const status: AgentStatus = { connected, methods, checkedAt: Date.now() };
  statusCache.set(key, status);
  return status;
}

function invalidate(userId: number, agentId?: string): void {
  for (const k of [...statusCache.keys()]) if (k.startsWith(`${userId}:`) && (!agentId || k.endsWith(`:${agentId}`))) statusCache.delete(k);
  sendToUser(userId, { t: 'agents.changed' });
}

function publicAgent(agent: AgentDef, enabled: boolean) {
  const inst = installState(agent.id);
  return {
    id: agent.id,
    name: agent.name,
    vendor: agent.vendor,
    description: agent.description,
    builtin: agent.builtin,
    enabled,
    install: { state: inst.state, versions: inst.versions, error: inst.error, updating: inst.updating, installedAt: inst.installedAt },
    login: agent.login ? { title: agent.login.title, steps: agent.login.steps } : null,
    keys: agent.keys,
    tui: !!agent.tuiBin,
    freeTier: agent.freeTier ?? null,
    license: agent.license,
    homepage: agent.homepage,
    terms: agent.terms ?? null,
    notes: agent.notes ?? [],
  };
}

async function ownAgent(id: string): Promise<AgentDef> {
  const agent = await getAgent(id);
  if (!agent || !(await enabledAgentIds()).includes(agent.id)) throw new HttpError(404, 'This AI is not switched on on this Studio');
  return agent;
}

// ---------------------------------------------------------------------------
export const agentsRouter = Router();

/** The AIs a user can use: Claude Code + every switched-on agent, with this user's status. */
agentsRouter.get('/agents', async (req, res) => {
  const user = req.user!;
  const su = await ensureSysUser(user.id);
  const enabled = new Set(await enabledAgentIds());
  const prefs = await getPrefs(user.id);
  const stored = await listKeys(user.id);
  const agents = [];
  for (const agent of await allAgents()) {
    if (!enabled.has(agent.id)) continue;
    const ready = installState(agent.id).state === 'ready';
    const models = cachedModels(user.id, agent.id);
    agents.push({
      ...publicAgent(agent, true),
      status: ready ? await loginStatus(agent, su, user.id) : null,
      models: models.length ? models : agent.models.map((m) => ({ value: m, name: m })),
      defaultModel: prefs.models?.[agent.id] ?? null,
    });
  }
  res.json({
    agents,
    keys: API_KEYS.map((k) => ({ id: k.id, label: k.label, url: k.url, placeholder: k.placeholder, hint: stored.find((s) => s.id === k.id)?.hint ?? null })),
    prefs: { defaultProvider: prefs.defaultProvider ?? CLAUDE_ID, models: prefs.models ?? {} },
  });
});

agentsRouter.put('/agents/keys/:keyId', async (req, res) => {
  const def = API_KEYS.find((k) => k.id === req.params.keyId);
  if (!def) throw new HttpError(404, 'Unknown key');
  const body = parse(z.object({ secret: z.string().trim().min(10, 'that does not look like an API key').max(2000) }), req.body);
  if (/\s/.test(body.secret)) throw new HttpError(400, 'The key must not contain spaces or line breaks');
  await saveKey(req.user!.id, def.id, body.secret);
  invalidate(req.user!.id);
  res.json({ ok: true });
});

agentsRouter.delete('/agents/keys/:keyId', async (req, res) => {
  await deleteKey(req.user!.id, String(req.params.keyId));
  invalidate(req.user!.id);
  res.json({ ok: true });
});

agentsRouter.patch('/agents/prefs', async (req, res) => {
  const body = parse(
    z.object({
      defaultProvider: z.string().trim().max(48).optional(),
      models: z.record(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/), z.string().trim().max(128)).optional(),
    }),
    req.body,
  );
  if (body.defaultProvider && body.defaultProvider !== CLAUDE_ID) await ownAgent(body.defaultProvider);
  const prefs = await setPrefs(req.user!.id, body);
  invalidate(req.user!.id);
  res.json({ prefs: { defaultProvider: prefs.defaultProvider ?? CLAUDE_ID, models: prefs.models ?? {} } });
});

/** One tiny prompt through the agent — proves sign-in / key / model work end to end. */
agentsRouter.post('/agents/:id/test', async (req, res) => {
  const agent = await ownAgent(String(req.params.id));
  if (installState(agent.id).state !== 'ready') throw new HttpError(503, `${agent.name} is not installed yet`);
  const r = await probeAgent(req.user!, agent);
  invalidate(req.user!.id, agent.id);
  res.json(r);
});

/** Remove the agent's own sign-in from the user's sandbox home (API keys stay until removed). */
agentsRouter.post('/agents/:id/logout', async (req, res) => {
  const agent = await ownAgent(String(req.params.id));
  const su = await ensureSysUser(req.user!.id);
  if (agent.id === 'codex') {
    await runAs(su, agentBinPath('codex', 'codex'), ['logout'], { env: await agentEnv(req.user!.id, su, agent, { model: null, mode: 'plan', casual: true }), cwd: su.home, timeoutMs: 20_000 });
  } else if (agent.id === 'gemini') {
    await userRemove(su, path.join(su.home, '.gemini', 'oauth_creds.json')).catch(() => {});
  } else if (agent.id === 'opencode') {
    await userRemove(su, path.join(su.home, '.local', 'share', 'opencode', 'auth.json')).catch(() => {});
  } else throw new HttpError(400, `Sign out of ${agent.name} in its own terminal`);
  invalidate(req.user!.id, agent.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Admin (mounted behind requireAdmin for /admin/*)
// ---------------------------------------------------------------------------
agentsRouter.get('/admin/agents', async (_req, res) => {
  const enabled = new Set(await enabledAgentIds());
  const custom = await getSetting<CustomAgent[]>('agents.custom', []);
  res.json({
    agents: (await allAgents()).map((a) => ({ ...publicAgent(a, enabled.has(a.id)), packages: a.packages, log: installState(a.id).log.slice(-120) })),
    custom: Array.isArray(custom) ? custom : [],
  });
});

async function setEnabled(id: string, on: boolean): Promise<void> {
  const list = new Set(await enabledAgentIds());
  if (on) list.add(id);
  else list.delete(id);
  await setSetting('agents.enabled', [...list]);
}

agentsRouter.post('/admin/agents/:id/enable', async (req, res) => {
  const agent = await getAgent(String(req.params.id));
  if (!agent) throw new HttpError(404, 'Unknown AI');
  await setEnabled(agent.id, true);
  if (installState(agent.id).state !== 'ready') void installAgent(agent, `switched on by ${req.user!.username}`);
  res.json({ ok: true });
});

agentsRouter.post('/admin/agents/:id/disable', async (req, res) => {
  const agent = await getAgent(String(req.params.id));
  if (!agent) throw new HttpError(404, 'Unknown AI');
  await setEnabled(agent.id, false);
  stopAgentEverywhere(agent.id);
  res.json({ ok: true });
});

agentsRouter.post('/admin/agents/:id/install', async (req, res) => {
  const agent = await getAgent(String(req.params.id));
  if (!agent) throw new HttpError(404, 'Unknown AI');
  void installAgent(agent, `requested by ${req.user!.username}`);
  res.json({ ok: true });
});

agentsRouter.delete('/admin/agents/:id/files', async (req, res) => {
  const agent = await getAgent(String(req.params.id));
  if (!agent) throw new HttpError(404, 'Unknown AI');
  if ((await enabledAgentIds()).includes(agent.id)) throw new HttpError(409, 'Switch it off first');
  await removeAgentFiles(agent.id);
  res.json({ ok: true });
});

const customSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,31}$/, 'id: 2–32 characters a-z, 0-9, - and _'),
  name: z.string().trim().min(1).max(64),
  vendor: z.string().trim().max(64).optional(),
  description: z.string().trim().max(400).optional(),
  packages: z.array(z.string().trim().regex(/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~<>=*-]+)?$/i, 'npm package names only')).max(5).optional(),
  command: z.string().trim().min(1).max(200),
  args: z.array(z.string().max(500)).max(30).optional(),
  tui: z.string().trim().max(200).optional(),
  tuiArgs: z.array(z.string().max(500)).max(30).optional(),
  login: z.string().trim().max(300).optional(),
  keys: z.array(z.string()).max(12).optional(),
  homepage: z.string().trim().max(300).optional(),
  license: z.string().trim().max(64).optional(),
});

agentsRouter.put('/admin/agents/custom', async (req, res) => {
  const body = parse(customSchema, req.body);
  if (body.id === CLAUDE_ID || BUILTIN_AGENTS.some((a) => a.id === body.id)) throw new HttpError(400, 'This id belongs to a built-in AI');
  const valid = new Set([...API_KEYS.map((k) => k.id), 'anthropic']);
  body.keys = (body.keys ?? []).filter((k) => valid.has(k));
  const list = (await getSetting<CustomAgent[]>('agents.custom', [])).filter((c) => c.id !== body.id);
  list.push(body);
  await setSetting('agents.custom', list);
  invalidateCustomAgents();
  res.json({ ok: true });
});

agentsRouter.delete('/admin/agents/custom/:id', async (req, res) => {
  const id = String(req.params.id);
  // the id becomes a folder name that is removed
  if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(id)) throw new HttpError(400, 'invalid id');
  await setEnabled(id, false);
  stopAgentEverywhere(id);
  await setSetting('agents.custom', (await getSetting<CustomAgent[]>('agents.custom', [])).filter((c) => c.id !== id));
  invalidateCustomAgents();
  await removeAgentFiles(id).catch(() => {});
  res.json({ ok: true });
});
