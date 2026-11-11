/**
 * Web terminals (xterm.js in the browser ↔ node-pty here), running as the
 * user. Kinds:
 *   claude — the project's AI interactively: Claude Code, or another agent's own UI
 *            (codex, gemini, opencode …) when the project uses another AI
 *   shell  — bash in a project
 *   login  — the sign-in of Claude Code (`claude auth login`) or of another agent
 * Sessions survive page reloads: output is buffered and replayed on attach;
 * a session without viewers is closed after TERMINAL_IDLE_MINUTES.
 */
import type { IPty } from 'node-pty';
import { issueAgentToken, revokeAgentToken } from '../agent.js';
import { cliNotReadyMessage, cliReady } from '../claudecli.js';
import { config } from '../config.js';
import { q1 } from '../db.js';
import { checkpoint } from '../git.js';
import { baseUserEnv, ensureSysUser, type SysUser, userCommand } from '../lib/system.js';
import { userRemove } from '../lib/userfs.js';
import { packsPathFor } from '../packs.js';
import { authorOf, getProjectRow, notifyProjectChanged, projectDir, projectSettings, type ProjectRow } from '../projects.js';
import type { AuthUser } from '../users.js';
import { onWs, onWsClose, send, type WsClient } from '../ws.js';
import { agentBinPath, agentReady } from '../agents/install.js';
import { agentEnv, getPrefs, projectModelFor } from '../agents/keys.js';
import { CLAUDE_ID, enabledAgentIds, getAgent } from '../agents/registry.js';
import { sendToUser } from '../ws.js';
import { accountExtrasEnv, claudeEnv, getConnection, invalidateStatus } from './creds.js';
import { buildProjectPrompt, permissionArgs, writeMcpConfig } from './prompt.js';

type Kind = 'claude' | 'shell' | 'login';
const BUFFER_MAX = 400_000;

interface TermSession {
  key: string;
  kind: Kind;
  user: AuthUser;
  su: SysUser;
  project: ProjectRow | null;
  pty: IPty;
  buffer: string;
  clients: Map<WsClient, string>;
  idleTimer?: NodeJS.Timeout;
  token?: string;
  mcpFile?: string;
  exited: boolean;
  title: string;
  /** 'claude' or the agent id of another AI */
  provider: string;
}

const sessions = new Map<string, TermSession>();

let ptyModule: typeof import('node-pty') | null = null;
async function loadPty(): Promise<typeof import('node-pty')> {
  if (!ptyModule) {
    try {
      const mod = await import('node-pty');
      ptyModule = ((mod as unknown as { default?: typeof import('node-pty') }).default ?? mod) as typeof import('node-pty');
    } catch (err) {
      throw new Error(`Terminals are unavailable (node-pty failed to load: ${(err as Error).message})`);
    }
  }
  return ptyModule;
}

export function isProjectTerminalOpen(projectId: number): boolean {
  for (const s of sessions.values()) if (s.project?.id === projectId && s.kind === 'claude' && !s.exited) return true;
  return false;
}
export function terminalCount(): number {
  return sessions.size;
}

function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') out[k] = v;
  return out;
}

async function createSession(c: WsClient, key: string, kind: Kind, msg: Record<string, unknown>, cols: number, rows: number): Promise<TermSession> {
  const user = c.user;
  const su = await ensureSysUser(user.id);
  let project: ProjectRow | null = null;
  let cwd = su.home;
  let cmd: string;
  let args: string[] = [];
  let token: string | undefined;
  let mcpFile: string | undefined;
  let title: string;
  let env: NodeJS.ProcessEnv;

  // another AI than Claude Code: its own sign-in / interactive UI
  let provider = CLAUDE_ID;
  if (kind === 'login') provider = typeof msg.provider === 'string' && msg.provider ? msg.provider : CLAUDE_ID;
  else if (kind === 'claude') {
    const p = await getProjectRow(Number(msg.projectId));
    if (p && p.owner_id === user.id) {
      provider = (typeof msg.provider === 'string' && msg.provider) || projectSettings(p).provider || (await getPrefs(user.id)).defaultProvider || CLAUDE_ID;
    }
  }
  if (provider !== CLAUDE_ID) {
    const agent = await getAgent(provider);
    if (!agent || !(await enabledAgentIds()).includes(agent.id)) throw new Error(`The AI "${provider}" is not switched on on this Studio.`);
    if (!agentReady(agent.id)) throw new Error(`${agent.name} is not installed on this server yet — an admin installs it (Admin → AI providers).`);
    if (kind === 'login') {
      if (!agent.login) throw new Error(`${agent.name} has no sign-in flow — use an API key.`);
      const opts = { model: null, mode: 'bypass' as const, casual: false };
      cmd = agentBinPath(agent.id, agent.login.bin);
      args = agent.login.args;
      title = agent.login.title;
      env = await agentEnv(user.id, su, agent, opts, { BROWSER: 'none', ...(agent.login.env ?? {}) });
    } else {
      const projectId = Number(msg.projectId);
      project = await getProjectRow(projectId);
      if (!project || project.owner_id !== user.id) throw new Error('Project not found');
      if (!agent.tuiBin) throw new Error(`${agent.name} has no interactive terminal — use the chat.`);
      cwd = projectDir(project);
      token = issueAgentToken({ userId: user.id, projectId: project.id, kind: 'terminal' });
      const settings = projectSettings(project);
      const prefs = await getPrefs(user.id);
      const opts = {
        model: projectModelFor(agent.id, settings, prefs, false) || prefs.models?.[agent.id] || null,
        mode: settings.permissionMode,
        casual: false,
      };
      cmd = agentBinPath(agent.id, agent.tuiBin);
      args = agent.tuiArgs?.(opts) ?? [];
      title = agent.tuiBin;
      env = await agentEnv(user.id, su, agent, opts, {
        STUDIO_TOKEN: token,
        STUDIO_PROJECT_DIR: cwd,
        STUDIO_PROJECT_ID: String(project.id),
        STUDIO_PACKS_PATH: packsPathFor(su, cwd),
      });
    }
    const pty = await loadPty();
    const [file, fargs] = userCommand(su, cmd, args);
    const p = pty.spawn(file, fargs, { name: 'xterm-256color', cols, rows, cwd, env: cleanEnv(env) });
    const s: TermSession = { key, kind, user, su, project, pty: p, buffer: '', clients: new Map(), token, exited: false, title, provider };
    sessions.set(key, s);
    wire(s);
    return s;
  }

  if ((kind === 'login' || kind === 'claude') && !cliReady()) throw new Error(cliNotReadyMessage());
  if (kind === 'login') {
    // Claude Code's own sign-in: the flow completes at Anthropic, the login is kept by
    // Claude Code in the user's sandbox home — the Studio never stores Claude credentials.
    const console_ = msg.mode === 'console';
    cmd = config.claudeBin;
    args = ['auth', 'login', console_ ? '--console' : '--claudeai'];
    title = 'claude auth login';
    env = baseUserEnv(su, { BROWSER: 'none' });
  } else {
    const projectId = Number(msg.projectId);
    project = await getProjectRow(projectId);
    if (!project || project.owner_id !== user.id) throw new Error('Project not found');
    cwd = projectDir(project);
    token = issueAgentToken({ userId: user.id, projectId: project.id, kind: 'terminal' });
    const extra = {
      STUDIO_TOKEN: token,
      STUDIO_PROJECT_DIR: cwd,
      STUDIO_PROJECT_ID: String(project.id),
      STUDIO_PACKS_PATH: packsPathFor(su, cwd),
    };
    if (kind === 'shell') {
      cmd = '/bin/bash';
      args = ['-l'];
      title = 'bash';
      env = await claudeEnv(user.id, su, extra);
    } else {
      const settings = projectSettings(project);
      const conn = await getConnection(user.id);
      const model = projectModelFor(CLAUDE_ID, settings, await getPrefs(user.id), false) || conn?.default_model || config.defaultModel;
      mcpFile = await writeMcpConfig(su, `term-${project.id}-${Date.now()}`, token, cwd);
      cmd = config.claudeBin;
      args = ['--mcp-config', mcpFile, '--append-system-prompt', await buildProjectPrompt(project, cwd), ...permissionArgs(settings.permissionMode, 'tui')];
      // like chat runs: only the Studio MCP servers unless the user enabled the account's own extras
      // (slash commands stay available in the interactive terminal)
      if (!conn?.account_extras) args.push('--strict-mcp-config');
      if (model) args.push('--model', model);
      if (settings.effort) args.push('--effort', settings.effort);
      const resumeChatId = Number(msg.resumeChatId);
      if (resumeChatId) {
        const chat = await q1<{ claude_session_id: string; started: number; project_id: number }>(
          'SELECT claude_session_id, started, project_id FROM chats WHERE id = ?',
          [resumeChatId],
        );
        if (chat && chat.project_id === project.id && chat.started) args.push('--resume', chat.claude_session_id);
      }
      title = 'claude';
      env = await claudeEnv(user.id, su, { ...extra, ...accountExtrasEnv(!!conn?.account_extras) });
    }
  }

  const pty = await loadPty();
  const [file, fargs] = userCommand(su, cmd, args);
  const p = pty.spawn(file, fargs, { name: 'xterm-256color', cols, rows, cwd, env: cleanEnv(env) });
  const s: TermSession = { key, kind, user, su, project, pty: p, buffer: '', clients: new Map(), token, mcpFile, exited: false, title, provider: CLAUDE_ID };
  sessions.set(key, s);
  wire(s);
  return s;
}

function wire(s: TermSession): void {
  const p = s.pty;
  p.onData((d) => {
    s.buffer += d;
    if (s.buffer.length > BUFFER_MAX) s.buffer = s.buffer.slice(-BUFFER_MAX);
    for (const [client, id] of s.clients) send(client, { t: 'term.out', id, data: d });
  });
  p.onExit(({ exitCode }) => {
    s.exited = true;
    for (const [client, id] of s.clients) send(client, { t: 'term.exit', id, code: exitCode });
    void cleanup(s);
  });
}

async function cleanup(s: TermSession): Promise<void> {
  if (sessions.get(s.key) === s) sessions.delete(s.key);
  if (s.idleTimer) clearTimeout(s.idleTimer);
  revokeAgentToken(s.token);
  if (s.mcpFile) userRemove(s.su, s.mcpFile).catch(() => {});
  if (s.kind === 'login') {
    if (s.provider === CLAUDE_ID) invalidateStatus(s.user.id);
    else sendToUser(s.user.id, { t: 'agents.changed' });
  }
  if (s.project) {
    if (s.kind === 'claude') {
      await checkpoint(s.su, projectDir(s.project), 'Terminal session', authorOf(s.user)).catch(() => null);
    }
    notifyProjectChanged(s.project.id);
  }
}

function kill(s: TermSession): void {
  if (s.exited) return;
  try {
    s.pty.kill('SIGHUP');
  } catch {
    /* gone */
  }
  setTimeout(() => {
    if (!s.exited) {
      try {
        s.pty.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }
  }, 4000).unref();
}

function attach(s: TermSession, c: WsClient, id: string): void {
  s.clients.set(c, id);
  if (s.idleTimer) {
    clearTimeout(s.idleTimer);
    s.idleTimer = undefined;
  }
  send(c, { t: 'term.attached', id, title: s.title, kind: s.kind });
  if (s.buffer) send(c, { t: 'term.out', id, data: s.buffer });
}

function detach(s: TermSession, c: WsClient): void {
  s.clients.delete(c);
  if (s.clients.size || s.exited) return;
  const idleMs = s.kind === 'login' ? 2 * 60_000 : config.limits.terminalIdleMin * 60_000;
  s.idleTimer = setTimeout(() => kill(s), idleMs);
}

function findByClient(c: WsClient, id: string): TermSession | undefined {
  for (const s of sessions.values()) if (s.clients.get(c) === id) return s;
  return undefined;
}

function clamp(v: unknown, lo: number, hi: number, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : def;
}

const opening = new Map<number, Promise<void>>();

export function initTerminals(): void {
  onWs('term.open', async (c, msg) => {
    const id = String(msg.id ?? '');
    const kind: Kind = msg.kind === 'shell' ? 'shell' : msg.kind === 'login' ? 'login' : 'claude';
    const cols = clamp(msg.cols, 20, 500, 100);
    const rows = clamp(msg.rows, 5, 200, 30);
    if (kind === 'claude' && !msg.provider) {
      // the project's AI (a project can switch from Claude Code to another agent)
      const p = await getProjectRow(Number(msg.projectId)).catch(() => null);
      if (p && p.owner_id === c.user.id) msg.provider = projectSettings(p).provider || (await getPrefs(c.user.id)).defaultProvider || CLAUDE_ID;
    }
    const provider = typeof msg.provider === 'string' && /^[a-z0-9][a-z0-9_-]{0,47}$/.test(msg.provider) && msg.provider !== CLAUDE_ID ? msg.provider : '';
    const key =
      kind === 'login'
        ? `${c.user.id}:login:${provider || msg.mode || 'claudeai'}`
        : `${c.user.id}:${Number(msg.projectId)}:${kind}${msg.resumeChatId ? `:${Number(msg.resumeChatId)}` : ''}${provider && kind === 'claude' ? `:${provider}` : ''}`;
    // one at a time per user: two opens of the same terminal (a page that mounts while the socket
    // connects sends them) must not start two processes, nor slip past the limit together
    const before = opening.get(c.user.id) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const chain = before.then(() => mine);
    opening.set(c.user.id, chain);
    await before;
    try {
      let s = sessions.get(key);
      if (s && (s.exited || msg.restart)) {
        if (!s.exited) kill(s);
        sessions.delete(key);
        s = undefined;
      }
      if (!s) {
        const mine = [...sessions.values()].filter((x) => x.user.id === c.user.id && !x.exited).length;
        if (mine >= config.limits.terminalsPerUser) {
          throw new Error(`You have ${mine} terminals open (limit ${config.limits.terminalsPerUser}). Close one first.`);
        }
        s = await createSession(c, key, kind, msg, cols, rows);
      } else {
        try {
          s.pty.resize(cols, rows);
        } catch {
          /* ignore */
        }
      }
      attach(s, c, id);
    } catch (err) {
      send(c, { t: 'term.error', id, error: (err as Error).message });
    } finally {
      release();
      if (opening.get(c.user.id) === chain) opening.delete(c.user.id);
    }
  });

  onWs('term.in', (c, msg) => {
    const s = findByClient(c, String(msg.id));
    if (s && !s.exited && typeof msg.data === 'string') s.pty.write(msg.data);
  });

  onWs('term.resize', (c, msg) => {
    const s = findByClient(c, String(msg.id));
    if (s && !s.exited) {
      try {
        s.pty.resize(clamp(msg.cols, 20, 500, 100), clamp(msg.rows, 5, 200, 30));
      } catch {
        /* ignore */
      }
    }
  });

  onWs('term.close', (c, msg) => {
    const s = findByClient(c, String(msg.id));
    if (!s) return;
    if (msg.kill) kill(s);
    else detach(s, c);
  });

  onWsClose((c) => {
    for (const s of [...sessions.values()]) if (s.clients.has(c)) detach(s, c);
  });
}

export function stopProjectTerminals(projectId: number): void {
  for (const s of sessions.values()) if (s.project?.id === projectId) kill(s);
}

export function stopAllTerminals(): void {
  for (const s of sessions.values()) kill(s);
}
