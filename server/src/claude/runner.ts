/**
 * Chat runs: every message starts `claude -p --output-format stream-json`
 * as the project owner, in the project folder. The JSON stream is stored as
 * chat events (MySQL) and pushed live to the browser. Conversations continue
 * with --resume <session id>. After each run a git checkpoint is made.
 */
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { Router } from 'express';
import { z } from 'zod';
import { cancelPermissions, issueAgentToken, pendingForChat, replyPermission, revokeAgentToken } from '../agent.js';
import { config } from '../config.js';
import { exec, q, q1 } from '../db.js';
import { checkpoint } from '../git.js';
import { hooks } from '../hooks.js';
import { HttpError, intParam, notFound, parse } from '../lib/http.js';
import { ensureSysUser, killTree, spawnAs, type SysUser } from '../lib/system.js';
import { userRemove } from '../lib/userfs.js';
import {
  authorOf,
  getProjectRow,
  loadOwnedProject,
  notifyProjectChanged,
  projectDir,
  projectSettings,
  type ProjectRow,
} from '../projects.js';
import { cliNotReadyMessage, cliReady } from '../claudecli.js';
import {
  agentProjectRunning,
  agentRunActive,
  agentRunCount,
  assertAgentAvailable,
  closeChatAgent,
  startAgentRun,
  stopAgentRun,
  stopAllAgentRuns,
  stopProjectAgentRuns,
} from '../agents/acprun.js';
import { getPrefs, projectModelFor } from '../agents/keys.js';
import { CLAUDE_ID } from '../agents/registry.js';
import { packsPathFor } from '../packs.js';
import { recordRateLimit, recordRun } from '../usage.js';
import type { AuthUser } from '../users.js';
import { publish } from '../ws.js';
import { accountExtrasArgs, accountExtrasEnv, authHint, claudeEnv, getConnection } from './creds.js';
import { expandSkillCommand } from '../skills.js';
import { buildCasualPrompt, buildProjectPrompt, CASUAL_TOOLS, permissionArgs, writeMcpConfig } from './prompt.js';

export interface ChatRow {
  id: number;
  project_id: number;
  title: string;
  claude_session_id: string;
  started: number;
  total_cost_usd: string | number;
  /** 'claude' (this module) or an ACP agent id (agents/acprun.ts) */
  provider: string;
  agent_session_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/** A content block that is still streaming (tool input being generated, thinking …). */
interface StreamBlock {
  type: string;
  name?: string;
  /** first characters of the tool input JSON (file path, command …) */
  head: string;
  /** last characters (what is being written right now) */
  tail: string;
  bytes: number;
}

interface ActiveRun {
  chatId: number;
  projectId: number;
  userId: number;
  user: AuthUser;
  su: SysUser;
  dir: string;
  prompt: string;
  child: ChildProcess;
  token: string;
  mcpFile: string | null;
  kind: 'chat' | 'casual';
  model: string | null;
  startedAt: number;
  gotResult: boolean;
  stderr: string;
  stopped: boolean;
  attempt: number;
  timer: NodeJS.Timeout;
  queue: Promise<void>;
  touchedFiles: boolean;
  blocks: Map<number, StreamBlock>;
  lastActivityAt: number;
}

const runs = new Map<number, ActiveRun>();
/** chats whose run is being prepared (between the request and the process start) */
const starting = new Set<number>();

export function isProjectRunning(projectId: number): boolean {
  for (const r of runs.values()) if (r.projectId === projectId) return true;
  return agentProjectRunning(projectId);
}
export function activeRunCount(): number {
  return runs.size + agentRunCount();
}

function publicChat(c: ChatRow) {
  return {
    id: c.id,
    projectId: c.project_id,
    title: c.title,
    sessionId: c.claude_session_id,
    provider: c.provider || CLAUDE_ID,
    started: !!c.started,
    totalCostUsd: Number(c.total_cost_usd),
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    running: runs.has(c.id) || agentRunActive(c.id),
  };
}

async function loadOwnedChat(user: AuthUser, chatId: number): Promise<{ chat: ChatRow; project: ProjectRow }> {
  const chat = await q1<ChatRow>('SELECT * FROM chats WHERE id = ?', [chatId]);
  if (!chat) throw notFound('Chat not found');
  const project = await getProjectRow(chat.project_id);
  if (!project || project.owner_id !== user.id) throw notFound('Chat not found');
  return { chat, project };
}

export async function canAccessChat(user: AuthUser, chatId: number): Promise<boolean> {
  try {
    await loadOwnedChat(user, chatId);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
async function addEvent(chatId: number, kind: string, payload: unknown): Promise<number> {
  const { insertId } = await exec('INSERT INTO chat_events (chat_id, kind, payload) VALUES (?, ?, ?)', [chatId, kind, JSON.stringify(payload)]);
  publish(`chat:${chatId}`, {
    t: 'chat.event',
    chatId,
    event: { id: insertId, kind, payload, createdAt: new Date().toISOString() },
  });
  return insertId;
}

// ---------------------------------------------------------------------------
// Live activity: what Claude is doing right now (shown above the composer)
// ---------------------------------------------------------------------------
function activity(run: ActiveRun, text: string, extra: { detail?: string } = {}, force = false): void {
  const now = Date.now();
  if (!force && now - run.lastActivityAt < 300) return;
  run.lastActivityAt = now;
  publish(`chat:${run.chatId}`, { t: 'chat.activity', chatId: run.chatId, activity: text, ...extra });
}

function fmtBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Decodes a (possibly cut-off) JSON string body. */
function unescapeJson(s: string): string {
  return s
    .replace(/\\$/, '')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\(["\\/bfnrt])/g, (_, c: string) => ({ b: '\b', f: '\f', n: '\n', r: '', t: '\t' })[c] ?? c);
}

function jsonField(src: string, key: string): string | null {
  const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(src);
  return m ? unescapeJson(m[1]) : null;
}

const VERBS: Record<string, string> = {
  Write: 'Writing',
  Edit: 'Editing',
  MultiEdit: 'Editing',
  NotebookEdit: 'Editing',
  Read: 'Reading',
  Bash: 'Preparing a command',
  WebFetch: 'Opening a web page',
  WebSearch: 'Searching the web',
  Glob: 'Looking for files',
  Grep: 'Searching files',
  TodoWrite: 'Planning',
  Task: 'Starting a helper agent',
};

function toolProgress(run: ActiveRun, b: StreamBlock): { text: string; detail?: string } {
  const name = b.name ?? 'a tool';
  const rel = (p: string | null) => (p && p.startsWith(run.dir + '/') ? p.slice(run.dir.length + 1) : p);
  const file = rel(jsonField(b.head, 'file_path') ?? jsonField(b.head, 'notebook_path'));
  const size = b.bytes > 600 ? ` · ${fmtBytes(b.bytes)}` : '';
  const lastLines = (field: string) => {
    // the tail is inside the field that is being generated (content / new_string / command …)
    const at = b.tail.lastIndexOf(`"${field}"`);
    const raw = (at >= 0 ? (/^"[^"]*"\s*:\s*"([\s\S]*)$/.exec(b.tail.slice(at))?.[1] ?? '') : b.tail).replace(/"\s*}\s*$/, '');
    const lines = unescapeJson(raw).split('\n');
    return lines
      .slice(-10)
      .map((l) => (l.length > 160 ? `${l.slice(0, 160)}…` : l))
      .join('\n');
  };
  if (name === 'Write') return { text: `Writing ${file ?? 'a file'}${size}`, detail: b.bytes > 200 ? lastLines('content') : undefined };
  if (name === 'Edit' || name === 'MultiEdit') return { text: `Editing ${file ?? 'a file'}${size}`, detail: b.bytes > 200 ? lastLines('new_string') : undefined };
  if (name === 'Bash') {
    const cmd = jsonField(b.head, 'command');
    return { text: `Preparing a command${size}`, detail: cmd ? cmd.slice(0, 600) : undefined };
  }
  if (name.startsWith('mcp__')) return { text: `Using ${name.replace(/^mcp__/, '').replace(/__/g, ' → ')}${size}` };
  return { text: `${VERBS[name] ?? `Using ${name}`}${file ? ` ${file}` : ''}${size}` };
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n… [${s.length - max} more characters]` : s;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function clipInput(input: any): unknown {
  if (!input || typeof input !== 'object') return input;
  const json = JSON.stringify(input);
  if (json.length <= 30_000) return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) out[k] = typeof v === 'string' ? clip(v, 6000) : v;
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toolResultText(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content
    .map((b) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : JSON.stringify(b)))
    .join('\n');
}

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleLine(run: ActiveRun, obj: any): Promise<void> {
  const chatId = run.chatId;
  switch (obj?.type) {
    case 'system': {
      if (obj.subtype === 'init') {
        run.model = typeof obj.model === 'string' ? obj.model : null;
        await exec('UPDATE chats SET started = 1 WHERE id = ? AND started = 0', [chatId]);
        await addEvent(chatId, 'system', {
          subtype: 'init',
          model: obj.model,
          permissionMode: obj.permissionMode,
          tools: Array.isArray(obj.tools) ? obj.tools.length : undefined,
          mcpServers: obj.mcp_servers,
          version: obj.claude_code_version,
          casual: run.kind === 'casual' || undefined,
        });
        activity(run, 'Waiting for Claude…', {}, true);
      } else if (obj.subtype === 'compact_boundary') {
        await addEvent(chatId, 'system', { subtype: 'compact' });
      } else if (obj.subtype === 'status' && typeof obj.status === 'string') {
        if (obj.status === 'compacting') activity(run, 'Compacting the conversation to save context…', {}, true);
      } else if (obj.subtype === 'thinking_tokens' && typeof obj.estimated_tokens === 'number') {
        activity(run, `Thinking… (~${Math.round(obj.estimated_tokens).toLocaleString('en')} tokens)`);
      } else if (obj.subtype === 'api_retry') {
        const secs = Math.max(1, Math.round((obj.retry_delay_ms ?? 0) / 1000));
        const why = obj.error_status === 429 || obj.error === 'rate_limit' ? 'rate limited' : obj.error_status ? `error ${obj.error_status}` : 'no answer';
        activity(run, `Anthropic's API is busy (${why}) — retrying in ${secs}s (attempt ${obj.attempt ?? '?'}/${obj.max_retries ?? '?'})`, {}, true);
      } else if ((obj.subtype === 'model_fallback' || obj.subtype === 'notification') && (obj.content || obj.text)) {
        await addEvent(chatId, 'system', { subtype: 'notice', text: clip(String(obj.content ?? obj.text), 2000), level: obj.level ?? obj.color ?? 'info' });
      }
      return;
    }
    case 'rate_limit_event': {
      const info = obj.rate_limit_info;
      await recordRateLimit(run.userId, info).catch((err) => console.warn('[usage] rate limit', (err as Error).message));
      if (info?.status === 'allowed_warning' || info?.status === 'rejected') {
        await addEvent(chatId, 'system', { subtype: 'limit', info });
      }
      return;
    }
    case 'stream_event': {
      if (obj.parent_tool_use_id) {
        activity(run, 'A helper agent is working…');
        return;
      }
      const ev = obj.event;
      if (ev?.type === 'content_block_start') {
        const b = ev.content_block;
        run.blocks.set(ev.index, { type: b?.type ?? '?', name: b?.name, head: '', tail: '', bytes: 0 });
        if (b?.type === 'tool_use') activity(run, toolProgress(run, run.blocks.get(ev.index)!).text, {}, true);
        else if (b?.type === 'thinking' || b?.type === 'redacted_thinking') activity(run, 'Thinking…', {}, true);
        else if (b?.type === 'text') activity(run, 'Writing…', {}, true);
      } else if (ev?.type === 'content_block_delta') {
        const d = ev.delta;
        if (d?.type === 'text_delta') {
          publish(`chat:${chatId}`, { t: 'chat.delta', chatId, text: d.text });
        } else if (d?.type === 'input_json_delta' && typeof d.partial_json === 'string') {
          const b = run.blocks.get(ev.index);
          if (!b) return;
          b.bytes += d.partial_json.length;
          if (b.head.length < 4000) b.head += d.partial_json.slice(0, 4000 - b.head.length);
          b.tail = (b.tail + d.partial_json).slice(-3000);
          const p = toolProgress(run, b);
          activity(run, p.text, { detail: p.detail });
        } else if (d?.type === 'thinking_delta') {
          const b = run.blocks.get(ev.index);
          if (b) b.bytes += String(d.thinking ?? '').length;
          activity(run, b && b.bytes > 400 ? `Thinking… (${fmtBytes(b.bytes)} of notes)` : 'Thinking…');
        }
      } else if (ev?.type === 'content_block_stop') {
        run.blocks.delete(ev.index);
      } else if (ev?.type === 'message_start') {
        run.blocks.clear();
      }
      return;
    }
    case 'assistant': {
      const content = Array.isArray(obj.message?.content) ? obj.message.content : [];
      const blocks = [];
      for (const b of content) {
        if (b?.type === 'text' && b.text) blocks.push({ type: 'text', text: clip(b.text, 100_000) });
        else if (b?.type === 'tool_use') {
          blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: clipInput(b.input) });
          if (FILE_TOOLS.has(b.name) || String(b.name).startsWith('mcp__studio__library_get')) run.touchedFiles = true;
        } else if (b?.type === 'thinking' && b.thinking) blocks.push({ type: 'thinking', text: clip(b.thinking, 20_000) });
      }
      if (blocks.length) await addEvent(chatId, 'assistant', { blocks, parent: obj.parent_tool_use_id ?? null });
      return;
    }
    case 'user': {
      const content = obj.message?.content;
      if (!Array.isArray(content)) return;
      const results = content
        .filter((b: { type?: string }) => b?.type === 'tool_result')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((b: any) => ({ toolUseId: b.tool_use_id, isError: !!b.is_error, text: clip(toolResultText(b.content), 20_000) }));
      if (results.length) await addEvent(chatId, 'tool_result', { results, parent: obj.parent_tool_use_id ?? null });
      if (run.touchedFiles) {
        run.touchedFiles = false;
        notifyProjectChanged(run.projectId);
      }
      return;
    }
    case 'result': {
      run.gotResult = true;
      run.blocks.clear();
      const text = typeof obj.result === 'string' ? obj.result : '';
      const eventId = await addEvent(chatId, 'result', {
        subtype: obj.subtype,
        isError: !!obj.is_error,
        text: clip(text, 20_000),
        hint: obj.is_error ? authHint(text) : undefined,
        durationMs: obj.duration_ms,
        turns: obj.num_turns,
        costUsd: obj.total_cost_usd,
        usage: obj.usage
          ? {
              input: obj.usage.input_tokens,
              output: obj.usage.output_tokens,
              cacheRead: obj.usage.cache_read_input_tokens,
              cacheWrite: obj.usage.cache_creation_input_tokens,
            }
          : undefined,
        errors: Array.isArray(obj.errors) ? obj.errors.slice(0, 5) : undefined,
      });
      if (typeof obj.total_cost_usd === 'number') {
        await exec('UPDATE chats SET total_cost_usd = total_cost_usd + ? WHERE id = ?', [obj.total_cost_usd, chatId]);
      }
      await recordRun({
        userId: run.userId,
        projectId: run.projectId,
        chatId,
        kind: run.kind,
        model: run.model ?? (obj.modelUsage && typeof obj.modelUsage === 'object' ? (Object.keys(obj.modelUsage)[0] ?? null) : null),
        isError: !!obj.is_error,
        turns: obj.num_turns,
        durationMs: obj.duration_ms,
        costUsd: obj.total_cost_usd,
        usage: obj.usage,
        sourceEventId: eventId,
      }).catch((err) => console.warn('[usage] record', (err as Error).message));
      return;
    }
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------
function publishStatus(run: { chatId: number; projectId: number }, running: boolean): void {
  const msg = { t: 'chat.status', chatId: run.chatId, projectId: run.projectId, running };
  publish(`chat:${run.chatId}`, msg);
  publish(`project:${run.projectId}`, msg);
}

async function spawnRun(user: AuthUser, chat: ChatRow, project: ProjectRow, prompt: string, attempt = 1): Promise<void> {
  const su = await ensureSysUser(user.id);
  const dir = projectDir(project);
  const settings = projectSettings(project);
  const conn = await getConnection(user.id);
  const casual = project.area === 'chat';
  // the project's model belongs to the project's AI (a Codex project's model is not for Claude chats)
  const model = projectModelFor(CLAUDE_ID, settings, await getPrefs(user.id), casual) || conn?.default_model || config.defaultModel;
  const extras = !!conn?.account_extras;
  const token = issueAgentToken({ userId: user.id, projectId: project.id, chatId: chat.id, kind: 'run' });
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  let mcpFile: string | null = null;
  if (casual) {
    // plain conversation: own system prompt, read-only tools, no MCP servers → starts fast
    args.push(
      '--system-prompt', await buildCasualPrompt(user),
      '--tools', CASUAL_TOOLS,
      '--allowedTools', CASUAL_TOOLS,
      '--strict-mcp-config',
      '--disable-slash-commands',
    );
  } else {
    mcpFile = await writeMcpConfig(su, `chat-${chat.id}`, token, dir);
    args.push(
      '--mcp-config', mcpFile,
      '--append-system-prompt', await buildProjectPrompt(project, dir),
      ...permissionArgs(settings.permissionMode, 'print'),
      ...accountExtrasArgs(extras),
    );
  }
  if (model) args.push('--model', model);
  if (settings.effort) args.push('--effort', settings.effort);
  args.push(...(chat.started ? ['--resume', chat.claude_session_id] : ['--session-id', chat.claude_session_id]));

  const env = await claudeEnv(user.id, su, {
    STUDIO_TOKEN: token,
    STUDIO_PROJECT_DIR: dir,
    STUDIO_PROJECT_ID: String(project.id),
    STUDIO_PACKS_PATH: packsPathFor(su, dir),
    ...accountExtrasEnv(extras && !casual),
  });
  const child = spawnAs(su, config.claudeBin, args, { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });

  const run: ActiveRun = {
    chatId: chat.id,
    projectId: project.id,
    userId: user.id,
    user,
    su,
    dir,
    prompt,
    child,
    token,
    mcpFile,
    kind: casual ? 'casual' : 'chat',
    model: null,
    startedAt: Date.now(),
    gotResult: false,
    stderr: '',
    stopped: false,
    attempt,
    queue: Promise.resolve(),
    touchedFiles: false,
    blocks: new Map(),
    lastActivityAt: 0,
    timer: setTimeout(() => {
      void addEvent(chat.id, 'error', { message: `Stopped after ${config.limits.runTimeoutMin} minutes (RUN_TIMEOUT_MINUTES).` });
      stopRun(chat.id);
    }, config.limits.runTimeoutMin * 60_000),
  };
  runs.set(chat.id, run);
  publishStatus(run, true);

  child.stdin!.on('error', () => {});
  child.stdin!.end(prompt);
  child.stderr!.on('data', (d: Buffer) => {
    run.stderr = (run.stderr + d.toString()).slice(-8000);
  });
  const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      run.stderr = (run.stderr + line + '\n').slice(-8000);
      return;
    }
    run.queue = run.queue.then(() => handleLine(run, obj)).catch((err) => console.error('[runner] event', err));
  });
  child.on('error', (err) => {
    run.stderr += `\n${err.message}`;
  });
  child.on('close', (code, signal) => {
    rl.close();
    run.queue = run.queue.then(() => finishRun(run, code, signal)).catch((err) => console.error('[runner] finish', err));
  });
}

async function finishRun(run: ActiveRun, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
  clearTimeout(run.timer);
  revokeAgentToken(run.token);
  cancelPermissions(run.chatId);
  if (run.mcpFile) userRemove(run.su, run.mcpFile).catch(() => {});

  if (!run.gotResult && !run.stopped) {
    const err = run.stderr.trim();
    // session bookkeeping got out of sync → fix it and retry once
    if (run.attempt === 1 && /already in use/i.test(err)) {
      runs.delete(run.chatId);
      await exec('UPDATE chats SET started = 1 WHERE id = ?', [run.chatId]);
      return retry(run);
    }
    if (run.attempt === 1 && /no conversation found/i.test(err)) {
      runs.delete(run.chatId);
      await exec('UPDATE chats SET started = 0 WHERE id = ?', [run.chatId]);
      return retry(run);
    }
    await addEvent(run.chatId, 'error', {
      message: err ? clip(err, 4000) : `Claude exited unexpectedly (code ${code ?? '-'}${signal ? `, ${signal}` : ''}).`,
      hint: authHint(err),
    });
  } else if (run.stopped) {
    await addEvent(run.chatId, 'error', { message: 'Stopped.', stopped: true });
  }

  if (run.kind !== 'casual') {
    try {
      const summary = run.prompt.replace(/\s+/g, ' ').trim().slice(0, 72);
      const cp = await checkpoint(run.su, run.dir, `Claude: ${summary}`, authorOf(run.user));
      hooks.turnFinished(run.projectId);
      if (cp) await addEvent(run.chatId, 'checkpoint', { sha: cp.sha, files: cp.files, message: `Claude: ${summary}` });
    } catch (err) {
      console.warn('[runner] checkpoint failed', (err as Error).message);
    }
  }
  // (a failed write must not leave the chat "running" forever)
  await exec('UPDATE chats SET updated_at = UTC_TIMESTAMP(3) WHERE id = ?', [run.chatId]).catch(() => {});
  // the chat counts as busy until its checkpoint is written
  if (runs.get(run.chatId) === run) runs.delete(run.chatId);
  publishStatus(run, false);
  notifyProjectChanged(run.projectId);
}

async function retry(run: ActiveRun): Promise<void> {
  const chat = await q1<ChatRow>('SELECT * FROM chats WHERE id = ?', [run.chatId]);
  const project = await getProjectRow(run.projectId);
  if (!chat || !project) return;
  await spawnRun(run.user, chat, project, run.prompt, run.attempt + 1);
}

export function stopRun(chatId: number): boolean {
  const run = runs.get(chatId);
  if (!run) return stopAgentRun(chatId);
  run.stopped = true;
  killTree(run.child, 'SIGINT');
  setTimeout(() => killTree(run.child, 'SIGTERM'), 5000).unref();
  setTimeout(() => killTree(run.child, 'SIGKILL'), 12_000).unref();
  return true;
}

export async function stopProjectRuns(projectId: number): Promise<void> {
  for (const r of [...runs.values()]) if (r.projectId === projectId) stopRun(r.chatId);
  await stopProjectAgentRuns(projectId);
}

export function stopAllRuns(): void {
  for (const r of runs.values()) killTree(r.child, 'SIGTERM');
  stopAllAgentRuns();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export const chatRouter = Router();

chatRouter.get('/projects/:id/chats', async (req, res) => {
  const { project } = await loadOwnedProject(req.user!, intParam(req.params.id));
  const chats = await q<ChatRow>('SELECT * FROM chats WHERE project_id = ? ORDER BY updated_at DESC', [project.id]);
  res.json({ chats: chats.map(publicChat) });
});

chatRouter.post('/projects/:id/chats', async (req, res) => {
  const { project } = await loadOwnedProject(req.user!, intParam(req.params.id));
  const body = parse(
    z.object({ title: z.string().trim().max(255).optional(), provider: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/).optional() }),
    req.body ?? {},
  );
  // which AI answers in this chat: chosen now, else the project's, else the user's default
  let provider = body.provider || projectSettings(project).provider || (await getPrefs(req.user!.id)).defaultProvider || CLAUDE_ID;
  if (provider !== CLAUDE_ID) {
    try {
      await assertAgentAvailable(provider);
    } catch (err) {
      // chosen explicitly → say why not; a default that was switched off meanwhile → Claude
      if (body.provider) throw err;
      provider = CLAUDE_ID;
    }
  }
  const { insertId } = await exec('INSERT INTO chats (project_id, title, claude_session_id, provider) VALUES (?, ?, ?, ?)', [
    project.id,
    body.title || 'New chat',
    randomUUID(),
    provider,
  ]);
  const chat = (await q1<ChatRow>('SELECT * FROM chats WHERE id = ?', [insertId]))!;
  res.status(201).json({ chat: publicChat(chat) });
});

chatRouter.patch('/chats/:chatId', async (req, res) => {
  const { chat } = await loadOwnedChat(req.user!, intParam(req.params.chatId));
  const body = parse(z.object({ title: z.string().trim().min(1).max(255) }), req.body);
  await exec('UPDATE chats SET title = ? WHERE id = ?', [body.title, chat.id]);
  res.json({ chat: publicChat((await q1<ChatRow>('SELECT * FROM chats WHERE id = ?', [chat.id]))!) });
});

chatRouter.delete('/chats/:chatId', async (req, res) => {
  const { chat } = await loadOwnedChat(req.user!, intParam(req.params.chatId));
  stopRun(chat.id);
  closeChatAgent(chat.id);
  await exec('DELETE FROM chats WHERE id = ?', [chat.id]);
  res.json({ ok: true });
});

chatRouter.get('/chats/:chatId/events', async (req, res) => {
  const { chat } = await loadOwnedChat(req.user!, intParam(req.params.chatId));
  const after = Number(req.query.after) || 0;
  const rows = await q<{ id: number; kind: string; payload: unknown; created_at: Date }>(
    `SELECT * FROM (SELECT id, kind, payload, created_at FROM chat_events WHERE chat_id = ? AND id > ? ORDER BY id DESC LIMIT 1500) t ORDER BY id`,
    [chat.id, after],
  );
  res.json({
    chat: publicChat(chat),
    events: rows.map((r) => ({
      id: Number(r.id),
      kind: r.kind,
      payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
      createdAt: r.created_at,
    })),
    pending: pendingForChat(chat.id),
  });
});

chatRouter.post('/chats/:chatId/messages', async (req, res) => {
  const user = req.user!;
  const { chat, project } = await loadOwnedChat(user, intParam(req.params.chatId));
  const body = parse(z.object({ text: z.string().trim().min(1).max(100_000) }), req.body);
  const claude = (chat.provider || CLAUDE_ID) === CLAUDE_ID;
  if (claude && !cliReady()) throw new HttpError(503, cliNotReadyMessage());
  if (!claude) await assertAgentAvailable(chat.provider);
  if (runs.has(chat.id) || agentRunActive(chat.id) || starting.has(chat.id)) throw new HttpError(409, 'The AI is still working in this chat — wait or press Stop');
  const mine = [...runs.values()].filter((r) => r.userId === user.id).length + agentRunCount(user.id);
  if (mine >= config.limits.runsPerUser) {
    throw new HttpError(429, `You already have ${mine} AI run(s) working (limit ${config.limits.runsPerUser}). Wait or stop one.`);
  }
  // a second click while this one is still being prepared must not start a second run
  starting.add(chat.id);
  try {
    if (chat.title === 'New chat') {
      const title = body.text.replace(/\s+/g, ' ').slice(0, 60);
      await exec('UPDATE chats SET title = ? WHERE id = ?', [title, chat.id]);
    }
    // "/name …" calls one of the user's skills: the AI gets its instructions with the request
    const called = await expandSkillCommand(user.id, body.text).catch(() => null);
    await addEvent(chat.id, 'user', called ? { text: body.text, skill: called.skill.slug } : { text: body.text });
    const prompt = called?.prompt ?? body.text;
    if (claude) await spawnRun(user, chat, project, prompt);
    else await startAgentRun(user, chat, project, prompt);
  } finally {
    starting.delete(chat.id);
  }
  res.json({ ok: true });
});

chatRouter.post('/chats/:chatId/stop', async (req, res) => {
  const { chat } = await loadOwnedChat(req.user!, intParam(req.params.chatId));
  res.json({ stopped: stopRun(chat.id) });
});

chatRouter.post('/chats/:chatId/permissions/:permId', async (req, res) => {
  await loadOwnedChat(req.user!, intParam(req.params.chatId));
  const body = parse(z.object({ allow: z.boolean(), remember: z.boolean().optional(), message: z.string().max(2000).optional() }), req.body);
  res.json({ ok: replyPermission(req.user!.id, String(req.params.permId), body.allow, body.remember, body.message) });
});
