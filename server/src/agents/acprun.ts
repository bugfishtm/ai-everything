/**
 * Chat runs with ACP agents — every AI except Claude Code (which keeps claude/runner.ts).
 *
 * One agent process per chat, started as the project owner in the project folder; it stays
 * up between messages (AGENT_IDLE_MINUTES) and later chats resume with `session/load`.
 * The agent's `session/update` stream is translated into the same chat events Claude
 * produces (text, thinking, tool_use + tool_result, plans as TodoWrite …), so the website
 * shows every AI the same way. Permission requests follow the project's permission mode:
 * answered by the Studio (autonomous, plan, casual chat) or asked in the browser.
 */
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { askUserPermission, cancelPermissions, issueAgentToken, revokeAgentToken } from '../agent.js';
import { buildAgentContext, buildCasualContext, studioMcpServers } from '../claude/prompt.js';
import { config, type PermissionMode } from '../config.js';
import { exec, q } from '../db.js';
import { checkpoint } from '../git.js';
import { hooks } from '../hooks.js';
import { HttpError } from '../lib/http.js';
import { ensureSysUser, killTree, spawnAs, type SysUser } from '../lib/system.js';
import { packsPathFor } from '../packs.js';
import { authorOf, notifyProjectChanged, projectDir, projectSettings, type ProjectRow } from '../projects.js';
import { recordRun } from '../usage.js';
import type { AuthUser } from '../users.js';
import { publish } from '../ws.js';
import { ACP_PROTOCOL_VERSION, AcpClient, type PermissionOutcome } from './acpclient.js';
import { agentBinPath, agentReady, installState } from './install.js';
import { agentEnv, getPrefs, keysFor, projectModelFor } from './keys.js';
import { type AgentDef, enabledAgentIds, getAgent, type LaunchOpts } from './registry.js';

interface ChatLike {
  id: number;
  project_id: number;
  provider: string;
  agent_session_id: string | null;
  started: number;
}

interface ToolState {
  id: string;
  kind: string;
  title: string;
  status: string;
  rawInput: Record<string, unknown>;
  locations: { path: string }[];
  content: Record<string, unknown>[];
  rawOutput: unknown;
  emitted: boolean;
  finished: boolean;
}

interface AgentRun {
  chatId: number;
  projectId: number;
  userId: number;
  user: AuthUser;
  su: SysUser;
  dir: string;
  prompt: string;
  agent: AgentDef;
  opts: LaunchOpts;
  model: string | null;
  startedAt: number;
  stopped: boolean;
  timer: NodeJS.Timeout | null;
  text: string;
  thought: string;
  lastText: string;
  tools: Map<string, ToolState>;
  touched: boolean;
  usage: { input?: number; output?: number; cacheRead?: number } | null;
  cost: number | null;
  lastActivityAt: number;
  /** last session/update — for the watchdog */
  lastUpdateAt: number;
  /** an error the agent only reported in its log (stderr), e.g. a provider's usage limit */
  agentError: string | null;
  /** set by the watchdog: the run ended because of agentError */
  failure: string | null;
  queue: Promise<void>;
  planSeq: number;
}

interface AgentProc {
  chatId: number;
  projectId: number;
  key: string;
  agent: AgentDef;
  client: AcpClient;
  child: ChildProcess;
  su: SysUser;
  token: string;
  sessionId: string;
  /** made by session/new in this process — the Studio context goes into the first prompt */
  fresh: boolean;
  contextSent: boolean;
  /** earlier conversation of this chat, when the agent could not resume its session */
  recap: string | null;
  replaying: boolean;
  agentInfo: { name?: string; title?: string; version?: string } | null;
  model: string | null;
  idleTimer: NodeJS.Timeout | null;
  run: AgentRun | null;
}

const runs = new Map<number, AgentRun>();
const procs = new Map<number, AgentProc>();
/** models an agent reported for a user (its "model" session option) */
const modelCache = new Map<string, { value: string; name: string }[]>();

export function cachedModels(userId: number, agentId: string): { value: string; name: string }[] {
  return modelCache.get(`${userId}:${agentId}`) ?? [];
}
export function agentRunActive(chatId: number): boolean {
  return runs.has(chatId);
}
export function agentProjectRunning(projectId: number): boolean {
  for (const r of runs.values()) if (r.projectId === projectId) return true;
  return false;
}
export function agentRunCount(userId?: number): number {
  return userId === undefined ? runs.size : [...runs.values()].filter((r) => r.userId === userId).length;
}

// ---------------------------------------------------------------------------
// Chat events (same format as claude/runner.ts)
// ---------------------------------------------------------------------------
async function addEvent(chatId: number, kind: string, payload: unknown): Promise<number> {
  const { insertId } = await exec('INSERT INTO chat_events (chat_id, kind, payload) VALUES (?, ?, ?)', [chatId, kind, JSON.stringify(payload)]);
  publish(`chat:${chatId}`, { t: 'chat.event', chatId, event: { id: insertId, kind, payload, createdAt: new Date().toISOString() } });
  return insertId;
}

function publishStatus(run: { chatId: number; projectId: number }, running: boolean): void {
  const msg = { t: 'chat.status', chatId: run.chatId, projectId: run.projectId, running };
  publish(`chat:${run.chatId}`, msg);
  publish(`project:${run.projectId}`, msg);
}

function activity(run: AgentRun, text: string, extra: { detail?: string } = {}, force = false): void {
  const now = Date.now();
  if (!force && now - run.lastActivityAt < 300) return;
  run.lastActivityAt = now;
  publish(`chat:${run.chatId}`, { t: 'chat.activity', chatId: run.chatId, activity: text, ...extra });
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}\n… [${s.length - max} more characters]` : s);
const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function clipInput(input: Record<string, unknown>): Record<string, unknown> {
  if (JSON.stringify(input).length <= 30_000) return input;
  return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, typeof v === 'string' ? clip(v, 6000) : v]));
}

// ---------------------------------------------------------------------------
// ACP tool calls → the Studio's tool names (Bash, Write, Edit, Read …)
// ---------------------------------------------------------------------------
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function commandOf(ri: Record<string, unknown>): string | undefined {
  const c = ri.command ?? ri.cmd;
  if (Array.isArray(c)) {
    const parts = c.map(String);
    // ["bash", "-lc", "npm test"] → "npm test"
    if (parts.length >= 3 && /(^|\/)(ba|z)?sh$/.test(parts[0]) && /^-l?c$/.test(parts[1])) return parts.slice(2).join(' ');
    return parts.join(' ');
  }
  return str(c);
}

function mapTool(t: ToolState): { name: string; input: Record<string, unknown> } {
  const ri = t.rawInput;
  const file = str(ri.file_path) ?? str(ri.filePath) ?? str(ri.absolute_path) ?? str(ri.path) ?? t.locations[0]?.path;
  const diff = t.content.find((c) => c.type === 'diff') as { path?: string; oldText?: string | null; newText?: string } | undefined;
  switch (t.kind) {
    case 'execute':
      return { name: 'Bash', input: { command: commandOf(ri) ?? t.title, ...(str(ri.description) ? { description: ri.description } : {}) } };
    case 'edit': {
      const oldS = ri.old_string ?? ri.oldString;
      const newS = ri.new_string ?? ri.newString;
      if (typeof oldS === 'string' && typeof newS === 'string') return { name: 'Edit', input: { file_path: file ?? t.title, old_string: oldS, new_string: newS } };
      if (typeof ri.content === 'string') return { name: 'Write', input: { file_path: file ?? t.title, content: ri.content } };
      if (diff?.path) {
        return diff.oldText
          ? { name: 'Edit', input: { file_path: diff.path, old_string: diff.oldText, new_string: diff.newText ?? '' } }
          : { name: 'Write', input: { file_path: diff.path, content: diff.newText ?? '' } };
      }
      return { name: 'Change file', input: { file: file ?? t.title } };
    }
    case 'read':
      return { name: 'Read', input: { file_path: file ?? t.title } };
    case 'search':
      return { name: 'Grep', input: { pattern: str(ri.pattern) ?? str(ri.query) ?? t.title, ...(str(ri.path) ? { path: ri.path } : {}) } };
    case 'fetch':
      return str(ri.url) ? { name: 'WebFetch', input: { url: ri.url } } : { name: 'WebSearch', input: { query: str(ri.query) ?? t.title } };
    case 'delete':
      return { name: 'Delete', input: { file: file ?? t.title } };
    case 'move':
      return { name: 'Move', input: { from: str(ri.from) ?? str(ri.source) ?? file ?? t.title, to: str(ri.to) ?? str(ri.destination) ?? '' } };
    case 'think':
      return { name: 'Think', input: { note: t.title } };
    default: {
      // MCP tools: "studio__library_search", "mcp__studio__library_search", "library_search (studio MCP Server)" …
      const m = /^(?:mcp__)?([\w-]+)__([\w-]+)$/.exec(t.title) ?? /^([\w-]+) \(([\w-]+) MCP Server\)$/.exec(t.title);
      if (m) {
        const [server, tool] = t.title.includes(' (') ? [m[2], m[1]] : [m[1], m[2]];
        return { name: `mcp__${server}__${tool}`, input: ri };
      }
      return { name: t.title || 'Tool', input: ri };
    }
  }
}

function resultText(t: ToolState): string {
  const parts: string[] = [];
  for (const c of t.content) {
    if (c.type === 'content') {
      const inner = c.content as { type?: string; text?: string } | undefined;
      if (inner?.type === 'text' && inner.text) parts.push(inner.text);
      else if (inner?.type === 'image') parts.push('[image]');
    } else if (c.type === 'diff') {
      const d = c as { path?: string; oldText?: string | null };
      parts.push(`${d.oldText ? 'Edited' : 'Wrote'} ${d.path ?? 'a file'}`);
    } else if (c.type === 'terminal') parts.push('[terminal output]');
  }
  if (parts.length) return parts.join('\n');
  const ro = t.rawOutput as { output?: unknown; error?: unknown } | string | undefined;
  if (typeof ro === 'string') return ro;
  if (ro && typeof ro === 'object') {
    if (typeof ro.output === 'string') return ro.output;
    if (typeof ro.error === 'string') return ro.error;
    return JSON.stringify(ro).slice(0, 20_000);
  }
  return t.status === 'failed' ? 'failed' : '';
}

function describe(t: ToolState, dir: string): string {
  const rel = (p: string | undefined) => (p && p.startsWith(dir + '/') ? p.slice(dir.length + 1) : p);
  const { input } = mapTool(t);
  const file = rel(str(input.file_path) ?? str(input.file));
  switch (t.kind) {
    case 'execute':
      return `Running ${clip(String(input.command ?? t.title).replace(/\s+/g, ' '), 120)}`;
    case 'edit':
      return `Editing ${file ?? 'a file'}`;
    case 'read':
      return `Reading ${file ?? 'a file'}`;
    case 'search':
      return `Searching ${t.title}`;
    case 'fetch':
      return `Opening ${t.title}`;
    case 'think':
      return 'Thinking…';
    default:
      return `Using ${t.title || 'a tool'}`;
  }
}

// ---------------------------------------------------------------------------
// session/update → chat events
// ---------------------------------------------------------------------------
async function flushThought(run: AgentRun): Promise<void> {
  if (!run.thought.trim()) {
    run.thought = '';
    return;
  }
  const text = run.thought;
  run.thought = '';
  await addEvent(run.chatId, 'assistant', { blocks: [{ type: 'thinking', text: clip(text, 20_000) }], parent: null });
}

async function flushText(run: AgentRun): Promise<void> {
  if (!run.text.trim()) {
    run.text = '';
    return;
  }
  const text = run.text;
  run.text = '';
  run.lastText = text;
  await addEvent(run.chatId, 'assistant', { blocks: [{ type: 'text', text: clip(text, 100_000) }], parent: null });
}

async function flushAll(run: AgentRun): Promise<void> {
  await flushThought(run);
  await flushText(run);
}

function mergeTool(run: AgentRun, u: Record<string, unknown>): ToolState {
  const id = String(u.toolCallId ?? '');
  let t = run.tools.get(id);
  if (!t) {
    t = { id, kind: 'other', title: '', status: 'pending', rawInput: {}, locations: [], content: [], rawOutput: undefined, emitted: false, finished: false };
    run.tools.set(id, t);
  }
  if (typeof u.kind === 'string') t.kind = u.kind;
  if (typeof u.title === 'string' && u.title) t.title = u.title;
  if (typeof u.status === 'string') t.status = u.status;
  if (u.rawInput && typeof u.rawInput === 'object' && Object.keys(u.rawInput).length) t.rawInput = u.rawInput as Record<string, unknown>;
  if (Array.isArray(u.locations) && u.locations.length) t.locations = u.locations as { path: string }[];
  if (Array.isArray(u.content)) t.content = u.content as Record<string, unknown>[];
  if (u.rawOutput !== undefined) t.rawOutput = u.rawOutput;
  return t;
}

/** Agents announce a tool call before its input is known (e.g. only the cwd of a command) — show it once it says what it does. */
function hasUsefulInput(t: ToolState): boolean {
  const ri = t.rawInput;
  switch (t.kind) {
    case 'execute':
      return !!commandOf(ri);
    case 'edit':
      return typeof ri.content === 'string' || typeof (ri.old_string ?? ri.oldString) === 'string' || t.content.some((c) => c.type === 'diff');
    case 'read':
      return !!(str(ri.file_path) ?? str(ri.filePath) ?? str(ri.path) ?? str(ri.absolute_path) ?? t.locations[0]?.path);
    default:
      return Object.keys(ri).some((k) => k !== 'cwd' && k !== 'workdir');
  }
}

async function emitTool(run: AgentRun, t: ToolState, force = false): Promise<void> {
  const done = t.status === 'completed' || t.status === 'failed';
  if (!t.emitted && (force || hasUsefulInput(t) || done)) {
    t.emitted = true;
    const { name, input } = mapTool(t);
    await addEvent(run.chatId, 'assistant', { blocks: [{ type: 'tool_use', id: t.id, name, input: clipInput(input) }], parent: null });
    if (['edit', 'delete', 'move', 'execute'].includes(t.kind)) run.touched = true;
  }
  if (t.emitted && done && !t.finished) {
    t.finished = true;
    await addEvent(run.chatId, 'tool_result', {
      results: [{ toolUseId: t.id, isError: t.status === 'failed', text: clip(resultText(t), 20_000) }],
      parent: null,
    });
    if (run.touched) {
      run.touched = false;
      notifyProjectChanged(run.projectId);
    }
  }
}

function textOf(content: unknown): string {
  const c = content as { type?: string; text?: string; uri?: string; name?: string } | undefined;
  if (c?.type === 'text') return c.text ?? '';
  if (c?.type === 'resource_link' && c.uri) return `[${c.name ?? c.uri}](${c.uri})`;
  return '';
}

async function handleUpdate(run: AgentRun, u: Record<string, unknown>): Promise<void> {
  run.lastUpdateAt = Date.now();
  run.agentError = null;
  switch (u.sessionUpdate) {
    case 'agent_message_chunk': {
      const t = textOf(u.content);
      if (!t) return;
      if (run.thought) await flushThought(run);
      if (!run.text) activity(run, 'Writing…', {}, true);
      run.text += t;
      publish(`chat:${run.chatId}`, { t: 'chat.delta', chatId: run.chatId, text: t });
      return;
    }
    case 'agent_thought_chunk': {
      const t = textOf(u.content);
      if (!t) return;
      if (run.text) await flushText(run);
      run.thought += t;
      activity(run, run.thought.length > 400 ? `Thinking… (${fmtBytes(run.thought.length)} of notes)` : 'Thinking…');
      return;
    }
    case 'tool_call':
    case 'tool_call_update': {
      await flushAll(run);
      const t = mergeTool(run, u);
      if (t.status === 'in_progress' || t.status === 'pending') {
        const out = t.kind === 'execute' ? resultText(t) : '';
        activity(run, describe(t, run.dir), out ? { detail: out.split('\n').slice(-10).join('\n').slice(-1500) } : {}, u.sessionUpdate === 'tool_call');
      }
      await emitTool(run, t);
      return;
    }
    case 'plan': {
      await flushAll(run);
      const entries = Array.isArray(u.entries) ? (u.entries as { content?: string; status?: string }[]) : [];
      const id = `plan-${run.chatId}-${Date.now()}-${run.planSeq++}`;
      const todos = entries.map((e) => ({ content: String(e.content ?? ''), status: e.status === 'completed' ? 'completed' : e.status === 'in_progress' ? 'in_progress' : 'pending' }));
      await addEvent(run.chatId, 'assistant', { blocks: [{ type: 'tool_use', id, name: 'TodoWrite', input: { todos } }], parent: null });
      await addEvent(run.chatId, 'tool_result', { results: [{ toolUseId: id, isError: false, text: 'plan updated' }], parent: null });
      activity(run, 'Planning…', {}, true);
      return;
    }
    case 'usage_update': {
      const cost = u.cost as { amount?: number; currency?: string } | null | undefined;
      if (cost && typeof cost.amount === 'number' && (!cost.currency || cost.currency === 'USD')) run.cost = cost.amount;
      return;
    }
    case 'notice': {
      const text = str(u.message) ?? str(u.text) ?? textOf(u.content);
      if (text) await addEvent(run.chatId, 'system', { subtype: 'notice', text: clip(text, 2000), level: str(u.level) ?? 'info' });
      return;
    }
    case 'compaction_update':
      activity(run, 'Compacting the conversation to save context…', {}, true);
      if (u.status === 'completed' || u.status === 'done') await addEvent(run.chatId, 'system', { subtype: 'compact' });
      return;
    default:
      return;
  }
}

/**
 * Errors some agents only write to their log (stderr), not to the protocol — e.g. OpenCode's
 * "usage limit reached": show them, and let the watchdog end the run if the agent goes quiet.
 */
function noteAgentLog(run: AgentRun, line: string): void {
  if (!/level=ERROR|\bERROR\b|\berror:/i.test(line)) return;
  const msg = (/error(?:\.error)?="([^"]+)"/.exec(line)?.[1] ?? line.replace(/^.*?level=ERROR\s*/i, '')).replace(/\s+/g, ' ').trim().slice(0, 600);
  if (!msg) return;
  activity(run, `${run.agent.name} reports an error: ${msg.slice(0, 220)}`, {}, true);
  // only errors that end the turn arm the watchdog (a provider refusing the call), not e.g. an MCP server warning
  if (FATAL_LOG.test(line)) run.agentError = msg;
}

const FATAL_LOG = /stream error|APICallError|limit|quota|rate|unauthori|forbidden|\b40[13]\b|\b429\b|api key|authenticat|billing|credit|subscri/i;

function logError(line: string): string | null {
  if (!/level=ERROR|\bERROR\b|\berror:/i.test(line) || !FATAL_LOG.test(line)) return null;
  return (/error(?:\.error)?="([^"]+)"/.exec(line)?.[1] ?? line.replace(/^.*?level=ERROR\s*/i, '')).replace(/\s+/g, ' ').trim().slice(0, 600) || null;
}

/** Provider errors often arrive as JSON inside JSON (Gemini …) — the innermost human sentence, plus its status. */
export function readableError(raw: string): string {
  let s = raw;
  for (let i = 0; i < 5 && s.includes('\\'); i++) s = s.replace(/\\(["\\])/g, '$1').replace(/\\n/g, ' ');
  const msgs = [...s.matchAll(/"message"\s*:\s*"([^"{}]{3,})"/g)].map((m) => m[1].replace(/\s+/g, ' ').trim());
  const best = msgs[msgs.length - 1];
  if (!best) return raw;
  const status = /"status"\s*:\s*"([A-Z_]{3,})"/.exec(s)?.[1];
  return status ? `${best} (${status})` : best;
}

function agentErrorHint(agent: AgentDef, text: string): string | undefined {
  if (/limit|quota|rate.?limit|too many requests|429|subscribe/i.test(text)) {
    return `The provider's usage limit is reached — wait, or connect your own account or API key for ${agent.name} (Account → AI connections).`;
  }
  return agentAuthHint(agent, text);
}

// ---------------------------------------------------------------------------
// Permissions: the project's mode decides; "ask" modes ask the user in the browser
// ---------------------------------------------------------------------------
const SAFE_KINDS = new Set(['read', 'search', 'think', 'switch_mode']);

function policy(mode: PermissionMode, casual: boolean, kind: string): 'allow' | 'deny' | 'ask' {
  if (casual) return SAFE_KINDS.has(kind) || kind === 'fetch' ? 'allow' : 'deny';
  switch (mode) {
    case 'bypass':
      return 'allow';
    case 'plan':
      return SAFE_KINDS.has(kind) || kind === 'fetch' ? 'allow' : 'deny';
    case 'acceptEdits':
      return SAFE_KINDS.has(kind) || kind === 'edit' || kind === 'fetch' ? 'allow' : 'ask';
    default:
      return SAFE_KINDS.has(kind) ? 'allow' : 'ask';
  }
}

async function onPermission(
  proc: AgentProc,
  params: { sessionId: string; toolCall: Record<string, unknown>; options: { optionId: string; name: string; kind: string }[] },
): Promise<PermissionOutcome> {
  const run = proc.run;
  const pick = (kinds: string[]) => params.options.find((o) => kinds.includes(o.kind))?.optionId;
  if (!run || run.stopped) return { outcome: 'cancelled' };
  let allow: boolean;
  let remember = false;
  // the tool call shows up in the chat before the question (like Claude's runs)
  const t = await new Promise<ToolState>((resolve) => {
    run.queue = run.queue
      .then(async () => {
        await flushAll(run);
        const st = mergeTool(run, params.toolCall);
        await emitTool(run, st, true);
        resolve(st);
      })
      .catch(() => resolve(mergeTool(run, params.toolCall)));
  });
  const p = policy(run.opts.mode, run.opts.casual, t.kind);
  if (p === 'ask') {
    const { name, input } = mapTool(t);
    activity(run, `Waiting for your answer: ${describe(t, run.dir)}`, {}, true);
    const d = await askUserPermission(run.chatId, run.userId, name, input);
    allow = d.behavior === 'allow';
    remember = !!d.remembered;
  } else allow = p === 'allow';
  const optionId = allow ? (remember ? pick(['allow_always', 'allow_once']) : pick(['allow_once', 'allow_always'])) : pick(['reject_once', 'reject_always']);
  return optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' };
}

// ---------------------------------------------------------------------------
// Agent processes
// ---------------------------------------------------------------------------
function hasLogin(agent: AgentDef, su: SysUser): boolean {
  if (agent.id === 'codex') return fs.existsSync(path.join(su.home, '.codex', 'auth.json'));
  if (agent.id === 'gemini') return fs.existsSync(path.join(su.home, '.gemini', 'oauth_creds.json'));
  return false;
}

const AUTH_ERROR = /auth|api key|log ?in|sign ?in|credential|unauthori[sz]ed|401|403|forbidden|quota|billing/i;

export function agentAuthHint(agent: AgentDef, text: string): string | undefined {
  return AUTH_ERROR.test(text) ? `${agent.name} does not seem to be connected (or the key is invalid). Open Account → AI connections.` : undefined;
}

/** Request; on "authentication required" select the user's key / login method and try once more. */
async function withAuth<T>(client: AcpClient, agent: AgentDef, su: SysUser, userId: number, authMethods: { id: string }[], fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const e = err as Error & { code?: number };
    if (!(e.code === -32000 || AUTH_ERROR.test(e.message))) throw err;
    const ids = authMethods.map((m) => m.id);
    let method: string | null = null;
    for (const k of await keysFor(userId, agent)) {
      const m = agent.keyAuthMethods?.[k];
      if (m && ids.includes(m)) {
        method = m;
        break;
      }
    }
    if (!method && agent.loginAuthMethod && ids.includes(agent.loginAuthMethod) && hasLogin(agent, su)) method = agent.loginAuthMethod;
    if (!method) throw err;
    await client.request('authenticate', { methodId: method }, 60_000);
    return fn();
  }
}

function killProc(proc: AgentProc): void {
  if (procs.get(proc.chatId) === proc) procs.delete(proc.chatId);
  if (proc.idleTimer) clearTimeout(proc.idleTimer);
  revokeAgentToken(proc.token);
  proc.client.close();
  killTree(proc.child, 'SIGTERM');
  setTimeout(() => killTree(proc.child, 'SIGKILL'), 5000).unref();
}

function scheduleIdle(proc: AgentProc): void {
  if (proc.idleTimer) clearTimeout(proc.idleTimer);
  proc.idleTimer = setTimeout(() => killProc(proc), config.agents.idleMinutes * 60_000);
  proc.idleTimer.unref();
}

/** The chat's earlier conversation, for a fresh session of an agent that could not resume. */
async function recapOf(chatId: number, current: string): Promise<string | null> {
  const rows = await q<{ kind: string; payload: unknown }>(
    `SELECT kind, payload FROM (SELECT id, kind, payload FROM chat_events WHERE chat_id = ? AND kind IN ('user','assistant') ORDER BY id DESC LIMIT 80) t ORDER BY id`,
    [chatId],
  );
  const lines: string[] = [];
  for (const r of rows) {
    const p = (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as { text?: string; blocks?: { type: string; text?: string }[] };
    if (r.kind === 'user' && p.text) lines.push(`User: ${p.text}`);
    if (r.kind === 'assistant') for (const b of p.blocks ?? []) if (b.type === 'text' && b.text) lines.push(`Assistant: ${b.text}`);
  }
  if (lines.length && lines[lines.length - 1] === `User: ${current}`) lines.pop();
  if (!lines.length) return null;
  let text = lines.join('\n\n');
  if (text.length > 16_000) text = `…\n${text.slice(-16_000)}`;
  return text;
}

async function ensureProc(run: AgentRun, chat: ChatLike, project: ProjectRow): Promise<AgentProc> {
  const { agent, opts, su, dir } = run;
  const key = `${agent.id}|${opts.model ?? ''}|${opts.mode}|${opts.casual}`;
  let proc = procs.get(chat.id);
  if (proc && (proc.key !== key || !proc.client.alive)) {
    killProc(proc);
    proc = undefined;
  }
  if (proc) {
    if (proc.idleTimer) clearTimeout(proc.idleTimer);
    proc.idleTimer = null;
    return proc;
  }

  activity(run, `Starting ${agent.name}…`, {}, true);
  const token = issueAgentToken({ userId: run.userId, projectId: project.id, chatId: chat.id, kind: 'run' });
  const env = await agentEnv(run.userId, su, agent, opts, {
    STUDIO_TOKEN: token,
    STUDIO_PROJECT_DIR: dir,
    STUDIO_PROJECT_ID: String(project.id),
    STUDIO_PACKS_PATH: packsPathFor(su, dir),
  });
  const child = spawnAs(su, agentBinPath(agent.id, agent.acpBin), agent.acpArgs(opts), { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  // eslint-disable-next-line prefer-const
  let created: AgentProc;
  const client = new AcpClient(child, {
    onUpdate: (p) => {
      if (created.replaying || !created.run || p.sessionId !== created.sessionId) return;
      const r = created.run;
      r.queue = r.queue.then(() => handleUpdate(r, p.update)).catch((err) => console.error('[agents] update', err));
    },
    onPermission: (p) => onPermission(created, p),
    onLog: (line) => {
      if (created.run) noteAgentLog(created.run, line);
    },
  });
  created = {
    chatId: chat.id,
    projectId: project.id,
    key,
    agent,
    client,
    child,
    su,
    token,
    sessionId: '',
    fresh: true,
    contextSent: false,
    recap: null,
    replaying: false,
    agentInfo: null,
    model: opts.model,
    idleTimer: null,
    run: null,
  };
  procs.set(chat.id, created);
  try {
    const init = await client.request<{
      agentInfo?: { name?: string; title?: string; version?: string };
      authMethods?: { id: string }[];
      agentCapabilities?: { loadSession?: boolean };
    }>(
      'initialize',
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'ai-everything', title: 'Everything Studio', version: config.version },
      },
      120_000,
    );
    created.agentInfo = init.agentInfo ?? null;
    const authMethods = init.authMethods ?? [];
    // the Studio's tools (library, packs, headless browser) as MCP servers — not in casual chats
    const mcpServers = opts.casual
      ? []
      : Object.entries(studioMcpServers(su, token, dir)).map(([name, s]) => ({
          name,
          command: s.command,
          args: s.args,
          env: Object.entries({ ...s.env, STUDIO_MCP_PERMISSION_TOOL: '0' }).map(([n, value]) => ({ name: n, value: String(value) })),
        }));
    type SessionResp = { sessionId?: string; configOptions?: ConfigOption[] | null; modes?: { currentModeId?: string; availableModes?: { id: string; name?: string }[] } | null };
    let session: SessionResp | null = null;
    if (chat.agent_session_id && chat.started && init.agentCapabilities?.loadSession) {
      activity(run, `Resuming the conversation with ${agent.name}…`, {}, true);
      created.replaying = true;
      try {
        session = await withAuth(client, agent, su, run.userId, authMethods, () =>
          client.request<SessionResp>('session/load', { sessionId: chat.agent_session_id, cwd: dir, mcpServers }, 180_000),
        );
        created.sessionId = chat.agent_session_id;
        created.fresh = false;
      } catch (err) {
        if (!client.alive) throw err;
        session = null;
      } finally {
        created.replaying = false;
      }
    }
    if (!session) {
      session = await withAuth(client, agent, su, run.userId, authMethods, () =>
        client.request<SessionResp>('session/new', { cwd: dir, mcpServers }, 180_000),
      );
      created.sessionId = String(session.sessionId ?? '');
      if (!created.sessionId) throw new Error(`${agent.name} did not open a session`);
      created.fresh = true;
      if (chat.started) created.recap = await recapOf(chat.id, run.prompt);
      await exec('UPDATE chats SET agent_session_id = ?, started = 1 WHERE id = ?', [created.sessionId, chat.id]);
    }
    await applySessionOptions(created, run, session.configOptions ?? null, session.modes ?? null);
    await addEvent(chat.id, 'system', {
      subtype: 'init',
      provider: agent.id,
      agent: created.agentInfo?.title || created.agentInfo?.name || agent.name,
      version: created.agentInfo?.version,
      model: created.model,
      mcpServers: mcpServers.map((s) => ({ name: s.name, status: 'connected' })),
      resumed: !created.fresh || undefined,
      casual: opts.casual || undefined,
    });
    return created;
  } catch (err) {
    killProc(created);
    throw err;
  }
}

interface ConfigOption {
  id: string;
  name?: string;
  category?: string | null;
  type?: string;
  currentValue?: unknown;
  options?: { value: string; name?: string }[] | { group?: string; options: { value: string; name?: string }[] }[];
}

function flatOptions(o: ConfigOption): { value: string; name: string }[] {
  const out: { value: string; name: string }[] = [];
  for (const x of (o.options ?? []) as Record<string, unknown>[]) {
    if (Array.isArray(x.options)) for (const y of x.options as { value: string; name?: string }[]) out.push({ value: y.value, name: y.name ?? y.value });
    else if (typeof x.value === 'string') out.push({ value: x.value, name: (x.name as string) ?? x.value });
  }
  return out;
}

/** Model and plan mode through the session's config options (agents with `modelVia: 'session'`). */
async function applySessionOptions(proc: AgentProc, run: AgentRun, options: ConfigOption[] | null, modes: { currentModeId?: string; availableModes?: { id: string }[] } | null): Promise<void> {
  const { agent, opts } = run;
  const modelOpt = options?.find((o) => o.category === 'model' || o.id === 'model');
  if (modelOpt) {
    const list = flatOptions(modelOpt);
    if (list.length) modelCache.set(`${run.userId}:${agent.id}`, list);
    const current = typeof modelOpt.currentValue === 'string' ? modelOpt.currentValue : null;
    let applied = !!opts.model && current === opts.model;
    if (agent.modelVia === 'session' && opts.model && !applied) {
      try {
        await proc.client.request('session/set_config_option', { sessionId: proc.sessionId, configId: modelOpt.id, value: opts.model }, 30_000);
        applied = true;
      } catch (err) {
        await addEvent(run.chatId, 'system', {
          subtype: 'notice',
          level: 'warning',
          text: `The model "${opts.model}" is not available to ${agent.name} here (${(err as Error).message.split('\n')[0]}) — it uses ${current ?? 'its default'}.`,
        });
      }
    }
    // the model really in use: the chosen one if it took effect (or went in as a launch flag), else the agent's
    proc.model = applied || (agent.modelVia === 'launch' && opts.model) ? opts.model : current;
  }
  // plan mode in the agent's own session: on for "plan only" / the Chat page, off again otherwise
  // (agents keep the mode in a resumed session)
  const wantPlan = opts.casual || opts.mode === 'plan';
  const isPlan = (v: unknown) => typeof v === 'string' && /plan|read/i.test(v);
  const modeOpt = options?.find((o) => o.category === 'mode');
  if (modeOpt) {
    const values = flatOptions(modeOpt).map((v) => v.value);
    const target = wantPlan ? values.find(isPlan) : isPlan(modeOpt.currentValue) ? values.find((v) => !isPlan(v)) : undefined;
    if (target && target !== modeOpt.currentValue) {
      await proc.client.request('session/set_config_option', { sessionId: proc.sessionId, configId: modeOpt.id, value: target }, 30_000).catch(() => {});
    }
  } else if (modes?.availableModes?.length) {
    const ids = modes.availableModes.map((x) => x.id);
    const target = wantPlan ? ids.find(isPlan) : isPlan(modes.currentModeId) ? ids.find((v) => !isPlan(v)) : undefined;
    if (target && target !== modes.currentModeId) {
      await proc.client.request('session/set_mode', { sessionId: proc.sessionId, modeId: target }, 30_000).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------
export function agentNotReadyMessage(agent: AgentDef): string {
  const s = installState(agent.id);
  if (s.state === 'queued' || s.state === 'installing') return `${agent.name} is being installed on this server — try again in a minute.`;
  if (s.state === 'error') return `${agent.name} could not be installed: ${s.error ?? 'unknown error'} — an admin can retry (Admin → AI providers).`;
  return `${agent.name} is not installed on this server — an admin can install it (Admin → AI providers).`;
}

/** The chat's AI must exist, be switched on and installed — checked before a message is stored. */
export async function assertAgentAvailable(id: string): Promise<AgentDef> {
  const agent = await getAgent(id);
  if (!agent) throw new HttpError(400, `The AI "${id}" is not available on this Studio any more — start a new chat with another AI.`);
  if (!(await enabledAgentIds()).includes(agent.id)) throw new HttpError(503, `${agent.name} is switched off on this Studio — an admin can switch it on (Admin → AI providers).`);
  if (!agentReady(agent.id)) throw new HttpError(503, agentNotReadyMessage(agent));
  return agent;
}

/** Start answering a chat message with the chat's ACP agent (returns once the run started). */
export async function startAgentRun(user: AuthUser, chat: ChatLike, project: ProjectRow, prompt: string): Promise<void> {
  const agent = await assertAgentAvailable(chat.provider);
  const su = await ensureSysUser(user.id);
  const dir = projectDir(project);
  const settings = projectSettings(project);
  const casual = project.area === 'chat';
  const prefs = await getPrefs(user.id);
  const model = projectModelFor(agent.id, settings, prefs, casual) || prefs.models?.[agent.id] || null;
  const opts: LaunchOpts = { model, mode: settings.permissionMode, casual };
  const run: AgentRun = {
    chatId: chat.id,
    projectId: project.id,
    userId: user.id,
    user,
    su,
    dir,
    prompt,
    agent,
    opts,
    model,
    startedAt: Date.now(),
    stopped: false,
    timer: null,
    text: '',
    thought: '',
    lastText: '',
    tools: new Map(),
    touched: false,
    usage: null,
    cost: null,
    lastActivityAt: 0,
    lastUpdateAt: Date.now(),
    agentError: null,
    failure: null,
    queue: Promise.resolve(),
    planSeq: 0,
  };
  runs.set(chat.id, run);
  publishStatus(run, true);
  run.timer = setTimeout(() => {
    void addEvent(chat.id, 'error', { message: `Stopped after ${config.limits.runTimeoutMin} minutes (RUN_TIMEOUT_MINUTES).` });
    stopAgentRun(chat.id);
  }, config.limits.runTimeoutMin * 60_000);
  void execute(run, chat, project)
    .catch((err) => console.error('[agents] run', err))
    .finally(() => {
      // normally done by execute(); here when it failed half-way (e.g. the database was unreachable)
      if (runs.get(run.chatId) === run) {
        const p = procs.get(run.chatId);
        if (p?.run === run) p.run = null;
        void finishRun(run).catch((err) => console.error('[agents] finish', err));
      }
    });
}

async function execute(run: AgentRun, chat: ChatLike, project: ProjectRow): Promise<void> {
  let proc: AgentProc | null = null;
  let stopReason: string | null = null;
  let usage: { inputTokens?: number; outputTokens?: number; cachedReadTokens?: number; totalTokens?: number } | undefined;
  try {
    proc = await ensureProc(run, chat, project);
    if (run.stopped) throw Object.assign(new Error('stopped'), { stopped: true });
    proc.run = run;
    run.model = proc.model;
    let text = run.prompt;
    if (proc.fresh && !proc.contextSent) {
      const context = run.opts.casual ? await buildCasualContext(run.user, run.agent.name) : await buildAgentContext(project, run.dir, run.agent.name);
      text = [
        '<studio-instructions>',
        'Instructions from Everything Studio for this whole conversation (the user does not see this block):',
        '',
        context,
        '</studio-instructions>',
        proc.recap ? `\n<conversation-so-far>\n${proc.recap}\n</conversation-so-far>` : '',
        '',
        run.prompt,
      ].join('\n');
      proc.contextSent = true;
    }
    activity(run, `Waiting for ${run.agent.name}…`, {}, true);
    run.lastUpdateAt = Date.now();
    run.agentError = null;
    const p = proc;
    // an error in the agent's log and then silence: end the run with that error (instead of waiting an hour)
    const watchdog = setInterval(() => {
      if (!run.agentError || run.stopped || Date.now() - run.lastUpdateAt < 30_000) return;
      clearInterval(watchdog);
      run.failure = run.agentError;
      run.stopped = true;
      p.client.notify('session/cancel', { sessionId: p.sessionId });
      setTimeout(() => {
        if (runs.get(run.chatId) === run) killProc(p);
      }, 8000).unref();
    }, 5000);
    try {
      const res = await p.client.request<{ stopReason?: string; usage?: typeof usage }>('session/prompt', { sessionId: p.sessionId, prompt: [{ type: 'text', text }] }, 0);
      stopReason = res?.stopReason ?? 'end_turn';
      usage = res?.usage;
    } finally {
      clearInterval(watchdog);
    }
  } catch (err) {
    await run.queue.catch(() => {});
    await flushAll(run).catch(() => {});
    const e = err as Error & { stopped?: boolean };
    if (run.failure) {
      await addEvent(run.chatId, 'error', { message: run.failure, hint: agentErrorHint(run.agent, run.failure), provider: run.agent.id });
    } else if (run.stopped || e.stopped) {
      await addEvent(run.chatId, 'error', { message: 'Stopped.', stopped: true });
    } else {
      const raw = e.message || String(err);
      const message = clip(readableError(raw), 4000);
      await addEvent(run.chatId, 'error', { message, hint: agentErrorHint(run.agent, raw), provider: run.agent.id });
      if (proc && !proc.client.alive) killProc(proc);
    }
  }
  if (stopReason) {
    await run.queue.catch(() => {});
    await flushAll(run);
    // tool calls that never reported completion
    for (const t of run.tools.values()) {
      if (t.emitted && !t.finished) {
        t.status = t.status === 'failed' ? 'failed' : 'completed';
        await emitTool(run, t);
      }
    }
    if (run.failure) {
      await addEvent(run.chatId, 'error', { message: run.failure, hint: agentErrorHint(run.agent, run.failure), provider: run.agent.id });
    } else if (stopReason === 'cancelled' || run.stopped) {
      await addEvent(run.chatId, 'error', { message: 'Stopped.', stopped: true });
    } else {
      const isError = stopReason === 'refusal';
      const durationMs = Date.now() - run.startedAt;
      const eventId = await addEvent(run.chatId, 'result', {
        subtype: stopReason === 'end_turn' ? 'success' : stopReason,
        isError,
        text: isError ? `${run.agent.name} refused to continue.` : clip(run.lastText, 20_000),
        durationMs,
        costUsd: run.cost ?? undefined,
        provider: run.agent.id,
        usage: usage ? { input: usage.inputTokens, output: usage.outputTokens, cacheRead: usage.cachedReadTokens } : undefined,
      });
      if (stopReason === 'max_tokens' || stopReason === 'max_turn_requests') {
        await addEvent(run.chatId, 'system', {
          subtype: 'notice',
          level: 'warning',
          text: stopReason === 'max_tokens' ? 'The answer reached the model’s output limit — ask to continue.' : 'The agent reached its limit of steps for one message — ask to continue.',
        });
      }
      if (typeof run.cost === 'number' && run.cost > 0) await exec('UPDATE chats SET total_cost_usd = total_cost_usd + ? WHERE id = ?', [run.cost, run.chatId]);
      await recordRun({
        userId: run.userId,
        projectId: run.projectId,
        chatId: run.chatId,
        kind: run.opts.casual ? 'casual' : 'chat',
        provider: run.agent.id,
        model: run.model,
        isError,
        durationMs,
        costUsd: run.cost ?? undefined,
        usage: usage ? { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, cache_read_input_tokens: usage.cachedReadTokens } : null,
        sourceEventId: eventId,
      }).catch((err) => console.warn('[usage] record', (err as Error).message));
    }
  }
  if (proc) {
    proc.run = null;
    if (proc.client.alive) scheduleIdle(proc);
  }
  await finishRun(run);
}

async function finishRun(run: AgentRun): Promise<void> {
  if (run.timer) clearTimeout(run.timer);
  cancelPermissions(run.chatId);
  if (!run.opts.casual) {
    try {
      const summary = run.prompt.replace(/\s+/g, ' ').trim().slice(0, 72);
      const cp = await checkpoint(run.su, run.dir, `${run.agent.name}: ${summary}`, authorOf(run.user));
      hooks.turnFinished(run.projectId);
      if (cp) await addEvent(run.chatId, 'checkpoint', { sha: cp.sha, files: cp.files, message: `${run.agent.name}: ${summary}` });
    } catch (err) {
      console.warn('[agents] checkpoint failed', (err as Error).message);
    }
  }
  // (a failed write must not leave the chat "running" forever)
  await exec('UPDATE chats SET updated_at = UTC_TIMESTAMP(3) WHERE id = ?', [run.chatId]).catch(() => {});
  if (runs.get(run.chatId) === run) runs.delete(run.chatId);
  publishStatus(run, false);
  notifyProjectChanged(run.projectId);
}

export function stopAgentRun(chatId: number): boolean {
  const run = runs.get(chatId);
  if (!run) return false;
  run.stopped = true;
  cancelPermissions(chatId);
  const proc = procs.get(chatId);
  if (proc?.sessionId) proc.client.notify('session/cancel', { sessionId: proc.sessionId });
  // agents that ignore the cancel request
  setTimeout(() => {
    if (runs.get(chatId) === run && proc) killProc(proc);
  }, 10_000).unref();
  return true;
}

/** A chat was deleted or its AI changed: end its agent process. */
export function closeChatAgent(chatId: number): void {
  stopAgentRun(chatId);
  const proc = procs.get(chatId);
  if (proc) killProc(proc);
}

export async function stopProjectAgentRuns(projectId: number): Promise<void> {
  for (const r of [...runs.values()]) if (r.projectId === projectId) stopAgentRun(r.chatId);
  // idle agent processes too (they stay up between messages) — the project folder is going away
  for (const p of [...procs.values()]) if (p.projectId === projectId) killProc(p);
}

export function stopAllAgentRuns(): void {
  for (const r of runs.values()) r.failure = r.failure ?? 'The Studio was restarted while the AI was working — this answer was interrupted. Send your message again.';
  for (const p of [...procs.values()]) killProc(p);
}

/** An agent was switched off: stop its runs and processes. */
export function stopAgentEverywhere(agentId: string): void {
  for (const r of [...runs.values()]) if (r.agent.id === agentId) stopAgentRun(r.chatId);
  for (const p of [...procs.values()]) if (p.agent.id === agentId) killProc(p);
}

/** Connection test: one tiny prompt in a throw-away session in the user's home. */
export async function probeAgent(user: AuthUser, agent: AgentDef): Promise<{ ok: boolean; message: string; ms: number; version?: string; model?: string | null }> {
  const started = Date.now();
  const su = await ensureSysUser(user.id);
  const prefs = await getPrefs(user.id);
  const opts: LaunchOpts = { model: prefs.models?.[agent.id] || null, mode: 'plan', casual: true };
  const env = await agentEnv(user.id, su, agent, opts);
  const child = spawnAs(su, agentBinPath(agent.id, agent.acpBin), agent.acpArgs(opts), { cwd: su.home, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  let text = '';
  let sessionId = '';
  let logged: string | null = null;
  let lastNews = Date.now();
  const client = new AcpClient(child, {
    onUpdate: (p) => {
      lastNews = Date.now();
      if (p.sessionId === sessionId && p.update.sessionUpdate === 'agent_message_chunk') text += textOf(p.update.content);
    },
    onPermission: async () => ({ outcome: 'cancelled' }),
    onLog: (line) => {
      logged = logError(line) ?? logged;
    },
  });
  const timer = setTimeout(() => killTree(child, 'SIGKILL'), 150_000);
  // a provider error the agent only logged, then silence → stop waiting
  const watchdog = setInterval(() => {
    if (logged && !text && Date.now() - lastNews > 15_000) killTree(child, 'SIGKILL');
  }, 2000);
  try {
    const init = await client.request<{ agentInfo?: { version?: string }; authMethods?: { id: string }[] }>(
      'initialize',
      { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'ai-everything', version: config.version } },
      120_000,
    );
    const s = await withAuth(client, agent, su, user.id, init.authMethods ?? [], () =>
      client.request<{ sessionId: string; configOptions?: ConfigOption[] }>('session/new', { cwd: su.home, mcpServers: [] }, 120_000),
    );
    sessionId = s.sessionId;
    const modelOpt = s.configOptions?.find((o) => o.category === 'model' || o.id === 'model');
    if (modelOpt) {
      const list = flatOptions(modelOpt);
      if (list.length) modelCache.set(`${user.id}:${agent.id}`, list);
      if (agent.modelVia === 'session' && opts.model) {
        await client.request('session/set_config_option', { sessionId, configId: modelOpt.id, value: opts.model }, 30_000).catch(() => {});
      }
    }
    await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Reply with exactly one word: CONNECTED' }] }, 120_000);
    const answer = text.trim();
    return {
      ok: answer.length > 0,
      message: answer || '(no answer)',
      ms: Date.now() - started,
      version: init.agentInfo?.version,
      model: opts.model ?? (typeof modelOpt?.currentValue === 'string' ? modelOpt.currentValue : null),
    };
  } catch (err) {
    return { ok: false, message: clip(readableError(logged ?? (err as Error).message), 1500), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
    clearInterval(watchdog);
    client.close();
    killTree(child, 'SIGTERM');
  }
}
