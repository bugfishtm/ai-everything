/**
 * Servers — Node.js backends that projects deploy (multiplayer, storage,
 * leaderboards, accounts, APIs …) for their Android apps, Windows programs,
 * games and web apps. Claude writes them in the chat; the Studio detects,
 * deploys, runs and exposes them; people control them on the website.
 *
 * A server is a Node.js package inside the project (default folder `server/`)
 * that listens on process.env.PORT. "Deploy" snapshots it into a release,
 * installs its npm dependencies and (re)starts it as the project owner's
 * sandbox user. Outside the project:
 *   /data/services/<user>/<id>/releases/<n>/   code + node_modules (last 3 kept)
 *   /data/services/<user>/<id>/data/            DATA_DIR — survives redeploys
 *   /data/services/.logs/<id>.log               written by the Studio (root only)
 * Everything is reachable through the Studio's own port — no extra ports:
 *   HTTP + WebSocket   /srv/<slug>/…   →   127.0.0.1:<PORT>/…   (prefix stripped)
 * Responses are sandboxed like previews (CSP sandbox → opaque origin), the
 * Studio's session cookie is never forwarded, and server cookies are scoped
 * to /srv/<slug>/.
 */
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http, { type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import type { Duplex, Readable } from 'node:stream';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { agentContext } from './agent.js';
import { getArea } from './areas.js';
import { SESSION_COOKIE } from './auth.js';
import { config } from './config.js';
import { exec, q, q1 } from './db.js';
import { hooks } from './hooks.js';
import { decryptSecret, encryptSecret } from './lib/crypto.js';
import { HttpError, intParam, notFound, parse } from './lib/http.js';
import { baseUserEnv, closeAfterExit, ensureSysUser, isolation, killTree, runAs, spawnAs, type SysUser } from './lib/system.js';
import { relOf, resolveIn, userCopyTree, userMkdir, userReadFile, userRemove, userStat, userWriteFile, userZip } from './lib/userfs.js';
import { getProjectRow, loadOwnedProject, projectDir, type ProjectRow } from './projects.js';
import { getSetting, setSetting } from './settings.js';
import type { AuthUser } from './users.js';
import { addUpgradeRoute, broadcast, publish, sendToUser } from './ws.js';

// ---------------------------------------------------------------------------
// Types and state
// ---------------------------------------------------------------------------
export interface ServiceSettings {
  /** add permissive CORS headers when the server sends none (default on) */
  cors?: boolean;
  memoryMb?: number;
  /** overrides package.json scripts.start */
  start?: string;
}

export interface ServiceRow {
  id: number;
  owner_id: number;
  project_id: number;
  name: string;
  slug: string;
  root: string;
  desired: 'running' | 'stopped';
  release_no: number;
  settings: ServiceSettings | null;
  env_enc: string | null;
  created_at: Date;
  updated_at: Date;
  deployed_at: Date | null;
}

type State = 'stopped' | 'starting' | 'running' | 'crashed' | 'error';

interface Runtime {
  state: State;
  deploying: boolean;
  child: ChildProcess | null;
  port: number | null;
  startedAt: number | null;
  listening: boolean;
  stopping: boolean;
  crashes: number[];
  restartTimer: NodeJS.Timeout | null;
  lastExit: { code: number | null; signal: string | null; at: number } | null;
  message: string | null;
  log: string[];
  logLines: number;
  busy: Promise<void> | null;
  readyWaiters: (() => void)[];
}

const rows = new Map<number, ServiceRow>();
const runtimes = new Map<number, Runtime>();
const slugIndex = new Map<string, number>();
const usedPorts = new Set<number>();

const LOG_LINES = 2000;
const LOG_FILE_MAX = 5 * 1024 * 1024;
const RESERVED_ENV = new Set(['PORT', 'HOST', 'DATA_DIR', 'BASE_PATH', 'PUBLIC_URL', 'SERVICE_NAME', 'NODE_ENV', 'NODE_OPTIONS', 'HOME', 'USER', 'PATH']);
const TEMPLATES = ['basic', 'multiplayer', 'storage'] as const;

function runtime(id: number): Runtime {
  let rt = runtimes.get(id);
  if (!rt) {
    rt = {
      state: 'stopped',
      deploying: false,
      child: null,
      port: null,
      startedAt: null,
      listening: false,
      stopping: false,
      crashes: [],
      restartTimer: null,
      lastExit: null,
      message: null,
      log: [],
      logLines: 0,
      busy: null,
      readyWaiters: [],
    };
    runtimes.set(id, rt);
  }
  return rt;
}

// ---------------------------------------------------------------------------
// Paths, URLs
// ---------------------------------------------------------------------------
const userServicesDir = (ownerId: number) => path.join(config.servicesDir, String(ownerId));
const serviceDir = (row: ServiceRow) => path.join(userServicesDir(row.owner_id), String(row.id));
const releaseDir = (row: ServiceRow, n: number) => path.join(serviceDir(row), 'releases', String(n));
const dataDir = (row: ServiceRow) => path.join(serviceDir(row), 'data');
const logFile = (id: number) => path.join(config.servicesDir, '.logs', `${id}.log`);

/**
 * Origin people use to reach this Studio — PUBLIC_URL, else what logged-in browsers used last
 * (kept in the settings table, so servers started at boot get the right PUBLIC_URL too).
 */
let seenOrigin: string | null = null;
let saveOriginTimer: NodeJS.Timeout | null = null;
export function rememberOrigin(req: Request, _res: Response, next: NextFunction): void {
  const host = req.get('host');
  // (an admin's browser: any user could send a made-up Host header and change the address shown to everyone)
  if (req.user?.role === 'admin' && host && /^[a-z0-9.-]+(:\d+)?$|^\[[0-9a-f:]+\](:\d+)?$/i.test(host) && !seenOrigin?.endsWith(`//${host}`)) {
    seenOrigin = `${req.protocol}://${host}`;
    if (!saveOriginTimer) {
      saveOriginTimer = setTimeout(() => {
        saveOriginTimer = null;
        setSetting('services.origin', seenOrigin).catch(() => {});
      }, 5000);
      saveOriginTimer.unref();
    }
  }
  next();
}
function publicBase(): string {
  return (config.publicUrl || seenOrigin || `http://localhost:${config.port}`).replace(/\/+$/, '');
}
export function publicUrl(slug: string): string {
  return `${publicBase()}/srv/${slug}`;
}

/** Host names the Studio's own website is reached at — never usable as a website domain. */
export function studioHostnames(): string[] {
  const out = new Set<string>();
  for (const u of [config.publicUrl, seenOrigin]) {
    if (!u) continue;
    try {
      out.add(new URL(u).hostname.toLowerCase());
    } catch {
      /* not a URL */
    }
  }
  return [...out];
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'server'
  );
}

// ---------------------------------------------------------------------------
// Logs and status
// ---------------------------------------------------------------------------
function log(id: number, line: string, kind: 'out' | 'err' | 'sys' = 'sys'): void {
  const rt = runtime(id);
  const stamp = new Date().toISOString().slice(11, 19);
  const text = `${stamp} ${kind === 'sys' ? '▸ ' : kind === 'err' ? '! ' : '  '}${line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')}`.slice(0, 4000);
  rt.log.push(text);
  if (rt.log.length > LOG_LINES) rt.log.splice(0, rt.log.length - LOG_LINES);
  publish(`service:${id}`, { t: 'service.log', id, line: text });
  const file = logFile(id);
  fs.appendFile(file, text + '\n', () => {});
  if (++rt.logLines % 500 === 0) {
    fsp
      .stat(file)
      .then((st) => (st.size > LOG_FILE_MAX ? fsp.rename(file, `${file}.1`) : undefined))
      .catch(() => {});
  }
}

function pipeLines(stream: Readable | null, fn: (line: string) => void): void {
  if (!stream) return;
  let buf = '';
  stream.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      fn(buf.slice(0, i).replace(/\r$/, ''));
      buf = buf.slice(i + 1);
    }
    if (buf.length > 8000) {
      fn(buf);
      buf = '';
    }
  });
  stream.on('end', () => {
    if (buf) fn(buf);
  });
}

function rssMb(pid: number | undefined): number | null {
  if (!pid) return null;
  try {
    const kb = /VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1];
    return kb ? Math.round(Number(kb) / 102.4) / 10 : null;
  } catch {
    return null;
  }
}

export function publicService(row: ServiceRow) {
  const rt = runtime(row.id);
  const recent = rt.crashes.filter((t) => Date.now() - t < 3600_000).length;
  return {
    id: row.id,
    projectId: row.project_id,
    ownerId: row.owner_id,
    name: row.name,
    slug: row.slug,
    root: row.root,
    desired: row.desired,
    state: rt.state,
    deploying: rt.deploying,
    listening: rt.listening,
    port: rt.child ? rt.port : null,
    release: row.release_no,
    deployedAt: row.deployed_at,
    startedAt: rt.child && rt.startedAt ? new Date(rt.startedAt).toISOString() : null,
    restartsLastHour: recent,
    lastExit: rt.lastExit ? { ...rt.lastExit, at: new Date(rt.lastExit.at).toISOString() } : null,
    message: rt.message,
    memoryMb: rssMb(rt.child?.pid),
    url: publicUrl(row.slug),
    path: `/srv/${row.slug}/`,
    internalUrl: `${config.internalUrl}/srv/${row.slug}`,
    settings: { cors: row.settings?.cors !== false, memoryMb: row.settings?.memoryMb ?? config.services.memoryMb, start: row.settings?.start ?? '' },
  };
}
export type PublicService = ReturnType<typeof publicService>;

function changed(id: number): void {
  const row = rows.get(id);
  if (!row) return;
  const svc = publicService(row);
  publish(`service:${id}`, { t: 'service.status', service: svc });
  sendToUser(row.owner_id, { t: 'services.changed', projectId: row.project_id });
}

function setState(id: number, state: State, message: string | null = null): void {
  const rt = runtime(id);
  rt.state = state;
  rt.message = message;
  if (state !== 'starting') {
    for (const w of rt.readyWaiters.splice(0)) w();
  }
  changed(id);
}

/** Resolves once the server listens, crashed, stopped — or after `ms`. */
function waitSettled(id: number, ms: number): Promise<void> {
  const rt = runtime(id);
  if (rt.state !== 'starting' && !rt.deploying) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    rt.readyWaiters.push(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Database cache
// ---------------------------------------------------------------------------
function cache(row: ServiceRow): ServiceRow {
  const old = rows.get(row.id);
  if (old && old.slug !== row.slug) slugIndex.delete(old.slug);
  rows.set(row.id, row);
  slugIndex.set(row.slug, row.id);
  return row;
}

async function reloadRow(id: number): Promise<ServiceRow> {
  const row = await q1<ServiceRow>('SELECT * FROM services WHERE id = ?', [id]);
  if (!row) throw notFound('Server not found');
  return cache(row);
}

export function servicesOfProjectSync(projectId: number): PublicService[] {
  return [...rows.values()].filter((r) => r.project_id === projectId).map(publicService);
}

async function ownedService(user: AuthUser, id: number): Promise<ServiceRow> {
  const row = await reloadRow(id).catch(() => null);
  if (!row || (row.owner_id !== user.id && user.role !== 'admin')) throw notFound('Server not found');
  return row;
}

function userEnv(row: ServiceRow): Record<string, string> {
  if (!row.env_enc) return {};
  try {
    const obj = JSON.parse(decryptSecret(row.env_enc)) as Record<string, string>;
    return Object.fromEntries(Object.entries(obj).filter(([k]) => !RESERVED_ENV.has(k)));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Detecting servers in a project
// ---------------------------------------------------------------------------
type Pkg = { name?: string; description?: string; main?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; studio?: { service?: unknown } };

async function readPkg(su: SysUser, dir: string): Promise<Pkg | null> {
  try {
    const { data } = await userReadFile(su, path.join(dir, 'package.json'), 512 * 1024);
    return JSON.parse(data.toString('utf8')) as Pkg;
  } catch {
    return null;
  }
}

function startCommand(pkg: Pkg | null, settings?: ServiceSettings | null): string {
  if (settings?.start) return settings.start;
  const s = pkg?.scripts?.start;
  if (typeof s === 'string' && s.trim()) return s.trim();
  return `node ${typeof pkg?.main === 'string' && pkg.main ? pkg.main : 'index.js'}`;
}

export interface DetectedServer {
  root: string;
  name: string;
  description: string | null;
  start: string;
  dependencies: string[];
  serviceId: number | null;
}

const CONVENTIONAL = new Set(['server', 'backend', 'api', 'game-server', 'multiplayer', 'services']);

/** Folders in the project that hold a Node.js server (package.json + convention or "studio.service"). */
export async function detectServers(su: SysUser, dir: string, projectId: number): Promise<DetectedServer[]> {
  const out: DetectedServer[] = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const known = [...rows.values()].filter((r) => r.project_id === projectId);
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'exports' || e.name === 'assets') continue;
    const pkg = await readPkg(su, path.join(dir, e.name));
    if (!pkg) continue;
    if (!CONVENTIONAL.has(e.name) && !pkg.studio?.service) continue;
    out.push({
      root: e.name,
      name: String(pkg.name ?? e.name),
      description: pkg.description ? String(pkg.description) : null,
      start: startCommand(pkg),
      dependencies: Object.keys(pkg.dependencies ?? {}),
      serviceId: known.find((r) => r.root === e.name)?.id ?? null,
    });
  }
  // already deployed roots that are not on the list (folder renamed / deleted)
  for (const r of known) {
    if (!out.some((d) => d.root === r.root)) out.push({ root: r.root, name: r.name, description: null, start: '', dependencies: [], serviceId: r.id });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ports, folders
// ---------------------------------------------------------------------------
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

async function allocPort(prefer: number | null): Promise<number> {
  const { portMin, portMax } = config.services;
  const candidates = prefer && prefer >= portMin && prefer <= portMax ? [prefer] : [];
  for (let p = portMin; p <= portMax; p++) candidates.push(p);
  for (const p of candidates) {
    if (usedPorts.has(p)) continue;
    if (await portFree(p)) {
      usedPorts.add(p);
      return p;
    }
  }
  throw new Error('no free port for the server (SERVICE_PORT_MIN … SERVICE_PORT_MAX are all in use)');
}

async function ensureUserDir(su: SysUser): Promise<void> {
  const d = userServicesDir(su.userId);
  const st = await fsp.lstat(d).catch(() => null);
  if (st && !st.isDirectory()) throw new Error(`${d} is not a directory`);
  if (!st) await fsp.mkdir(d, { mode: 0o700 });
  if (isolation()) {
    await fsp.chown(d, su.uid, su.gid);
    await fsp.chmod(d, 0o700);
  }
}

function runLogged(id: number, su: SysUser, cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    const child = spawnAs(su, cmd, args, {
      cwd,
      env: baseUserEnv(su, { npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' }),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    pipeLines(child.stdout, (l) => log(id, l, 'out'));
    pipeLines(child.stderr, (l) => log(id, l, 'err'));
    const timer = setTimeout(() => killTree(child, 'SIGKILL'), timeoutMs);
    child.on('error', (err) => log(id, err.message, 'err'));
    closeAfterExit(child);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------
async function waitListening(id: number, child: ChildProcess, port: number): Promise<void> {
  const rt = runtime(id);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (rt.child !== child) return;
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => {
        s.destroy();
        resolve(true);
      });
      s.once('error', () => resolve(false));
    });
    if (rt.child !== child) return;
    if (ok) {
      rt.listening = true;
      const row = rows.get(id);
      log(id, `Running — ${row ? `${publicUrl(row.slug)}/` : ''}`);
      setState(id, 'running');
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (rt.child === child) {
    log(id, `The process runs but does not listen on port ${port} — the server must listen on process.env.PORT.`);
    setState(id, 'running', 'Not listening on process.env.PORT');
  }
}

function onExit(id: number, child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
  const rt = runtime(id);
  if (rt.child !== child) return;
  rt.child = null;
  rt.listening = false;
  if (rt.port) usedPorts.delete(rt.port);
  rt.lastExit = { code, signal, at: Date.now() };
  if (rt.stopping) {
    rt.stopping = false;
    log(id, 'Stopped.');
    setState(id, 'stopped');
    return;
  }
  log(id, `The server exited (${signal ? `signal ${signal}` : `exit code ${code}`}).`);
  const row = rows.get(id);
  if (!row || row.desired !== 'running' || !config.services.enabled) {
    setState(id, 'stopped');
    return;
  }
  rt.crashes = rt.crashes.filter((t) => Date.now() - t < 5 * 60_000);
  rt.crashes.push(Date.now());
  if (rt.crashes.length >= 5) {
    log(id, 'Crashed 5 times within 5 minutes — not restarting. Fix the error shown above and deploy again.');
    // stays stopped (also after a Studio restart) until someone deploys or starts it again
    exec("UPDATE services SET desired = 'stopped' WHERE id = ?", [id])
      .then(() => reloadRow(id))
      .catch(() => {});
    setState(id, 'crashed', 'Crashed 5 times within 5 minutes — see the log');
    return;
  }
  const delay = [1, 2, 5, 10, 30][rt.crashes.length - 1] * 1000;
  log(id, `Restarting in ${delay / 1000}s …`);
  setState(id, 'starting', `Restarting after a crash (${rt.crashes.length}/5)`);
  rt.restartTimer = setTimeout(() => {
    rt.restartTimer = null;
    const r = rows.get(id);
    if (r && r.desired === 'running' && !rt.child) {
      startProcess(r).catch((err: Error) => {
        log(id, `Could not start: ${err.message}`);
        setState(id, 'error', err.message);
      });
    }
  }, delay);
}

async function startProcess(row: ServiceRow): Promise<void> {
  if (!config.services.enabled) throw new HttpError(503, 'Servers are switched off on this Studio (SERVICES_ENABLED=false)');
  if (!row.release_no) throw new HttpError(400, 'Deploy the server first');
  if (disabledOwners.has(row.owner_id)) throw new HttpError(403, 'The account that owns this server is disabled');
  const rt = runtime(row.id);
  if (rt.child) return;
  const su = await ensureSysUser(row.owner_id);
  const cwd = releaseDir(row, row.release_no);
  const pkg = await readPkg(su, cwd);
  const start = startCommand(pkg, row.settings);
  const port = await allocPort(rt.port);
  rt.port = port;
  const mem = Math.max(64, Math.min(row.settings?.memoryMb ?? config.services.memoryMb, 16384));
  const base = baseUserEnv(su);
  const env = baseUserEnv(su, {
    ...userEnv(row),
    PATH: `${path.join(cwd, 'node_modules', '.bin')}:${base.PATH}`,
    PORT: String(port),
    HOST: '127.0.0.1',
    NODE_ENV: 'production',
    DATA_DIR: dataDir(row),
    BASE_PATH: `/srv/${row.slug}`,
    PUBLIC_URL: publicUrl(row.slug),
    SERVICE_NAME: row.name,
    NODE_OPTIONS: `--max-old-space-size=${mem}`,
    STUDIO_API_URL: undefined,
    STUDIO_TOOLS_DIR: undefined,
  });
  log(row.id, `Starting release #${row.release_no}: ${start}   (PORT=${port}, memory ≤ ${mem} MB)`);
  // `exec` hands signals straight to node; commands with shell operators keep the shell
  // (stop/restart signal the whole process group either way)
  const script = /[;&|<>()$`]/.test(start) ? start : `exec ${start}`;
  const child = spawnAs(su, 'bash', ['-c', script], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  rt.child = child;
  rt.startedAt = Date.now();
  rt.listening = false;
  rt.stopping = false;
  pipeLines(child.stdout, (l) => log(row.id, l, 'out'));
  pipeLines(child.stderr, (l) => log(row.id, l, 'err'));
  child.on('error', (err) => log(row.id, err.message, 'err'));
  closeAfterExit(child);
  child.on('close', (code, signal) => onExit(row.id, child, code, signal));
  setState(row.id, 'starting');
  void waitListening(row.id, child, port);
}

async function stopProcess(id: number, why: string): Promise<void> {
  const rt = runtime(id);
  if (rt.restartTimer) {
    clearTimeout(rt.restartTimer);
    rt.restartTimer = null;
  }
  const child = rt.child;
  if (!child) {
    if (rt.state !== 'stopped') setState(id, 'stopped');
    return;
  }
  rt.stopping = true;
  log(id, `Stopping (${why}) …`);
  killTree(child, 'SIGTERM');
  const killer = setTimeout(() => killTree(child, 'SIGKILL'), 5000);
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    // at most 15 s: whatever happens to the process, the lock of this server is released
    const giveUp = setTimeout(resolve, 15_000);
    child.once('close', () => {
      clearTimeout(giveUp);
      resolve();
    });
  });
  clearTimeout(killer);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------
async function serialize(id: number, fn: () => Promise<void>): Promise<void> {
  const rt = runtime(id);
  while (rt.busy) await rt.busy.catch(() => {});
  const job = fn();
  rt.busy = job;
  try {
    await job;
  } finally {
    if (rt.busy === job) rt.busy = null;
  }
}

export async function createService(user: AuthUser, project: ProjectRow, root: string, name?: string): Promise<ServiceRow> {
  const su = await ensureSysUser(user.id);
  const dir = projectDir(project);
  const rel = relOf(dir, resolveIn(dir, root));
  if (!rel || rel.includes('/')) throw new HttpError(400, 'the server must be a folder directly in the project (e.g. server/)');
  const existing = [...rows.values()].find((r) => r.project_id === project.id && r.root === rel);
  if (existing) return existing;
  const pkg = await readPkg(su, path.join(dir, rel));
  if (!pkg) throw new HttpError(400, `${rel}/package.json is missing — a server is a Node.js package (studio service new creates one)`);
  const mine = (await q1<{ n: number }>('SELECT COUNT(*) AS n FROM services WHERE owner_id = ?', [user.id]))?.n ?? 0;
  if (Number(mine) >= config.services.maxPerUser) {
    throw new HttpError(429, `You already have ${mine} server(s) (limit ${config.services.maxPerUser}). Delete one on the Servers page first.`);
  }
  const base = slugify(rel === 'server' || rel === 'backend' ? project.name : `${project.name}-${rel}`);
  let slug = base;
  for (let i = 2; slugIndex.has(slug) || (await q1('SELECT id FROM services WHERE slug = ?', [slug])); i++) slug = `${base}-${i}`;
  const { insertId } = await exec('INSERT INTO services (owner_id, project_id, name, slug, root, settings) VALUES (?, ?, ?, ?, ?, ?)', [
    user.id,
    project.id,
    (name || String(pkg.name ?? '') || project.name).slice(0, 64),
    slug,
    rel,
    JSON.stringify({}),
  ]);
  const row = await reloadRow(insertId);
  log(row.id, `Created server "${row.name}" for ${project.name}/${rel}/ — URL ${publicUrl(slug)}`);
  sendToUser(user.id, { t: 'services.changed', projectId: project.id });
  return row;
}

/** Copy the project folder into a new release, npm install, switch over. The old release keeps running until then. */
export async function deployService(id: number, by: string): Promise<void> {
  await serialize(id, async () => {
    const row = await reloadRow(id);
    const rt = runtime(id);
    const su = await ensureSysUser(row.owner_id);
    const project = await getProjectRow(row.project_id);
    if (!project) throw new HttpError(404, 'the project no longer exists');
    const src = resolveIn(projectDir(project), row.root);
    if (!(await userStat(su, src))?.isDir) throw new HttpError(400, `${row.root}/ does not exist in the project`);
    const pkg = await readPkg(su, src);
    if (!pkg) throw new HttpError(400, `${row.root}/package.json is missing`);
    rt.deploying = true;
    rt.message = null;
    changed(id);
    const n = row.release_no + 1;
    try {
      log(id, `Deploy #${n} (${by}): copying ${row.root}/ …`);
      await ensureUserDir(su);
      await userMkdir(su, releaseDir(row, n));
      await userMkdir(su, dataDir(row));
      const r = await runAs(su, 'rsync', ['-a', '--delete', '--exclude', 'node_modules', '--exclude', '.git', `${src}/`, `${releaseDir(row, n)}/`], {
        timeoutMs: 300_000,
      });
      if (r.code !== 0) throw new Error(`copy failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
      const deps = Object.keys(pkg.dependencies ?? {});
      if (deps.length) {
        const lock = await userStat(su, path.join(releaseDir(row, n), 'package-lock.json'));
        const args = lock
          ? ['ci', '--omit=dev', '--no-audit', '--no-fund']
          : ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock'];
        log(id, `npm ${args[0]}: ${deps.join(', ')} …`);
        const code = await runLogged(id, su, 'npm', args, releaseDir(row, n), 600_000);
        if (code !== 0) throw new Error(`npm ${args[0]} failed (exit ${code}) — see the log above`);
      }
      await exec('UPDATE services SET release_no = ?, deployed_at = UTC_TIMESTAMP(3), desired = ? WHERE id = ?', [n, 'running', id]);
      const fresh = await reloadRow(id);
      rt.crashes = [];
      await stopProcess(id, `switching to release #${n}`);
      rt.deploying = false;
      await startProcess(fresh);
      // keep the last 3 releases (rollback)
      for (let old = n - 3; old >= 1 && old >= n - 20; old--) {
        if (await fsp.lstat(releaseDir(fresh, old)).catch(() => null)) await userRemove(su, releaseDir(fresh, old)).catch(() => {});
      }
    } catch (err) {
      rt.deploying = false;
      log(id, `Deploy #${n} failed: ${(err as Error).message}`);
      rt.message = `Deploy failed: ${(err as Error).message}`;
      changed(id);
      throw err instanceof HttpError ? err : new HttpError(400, (err as Error).message);
    }
  });
}

export async function startService(id: number): Promise<void> {
  await serialize(id, async () => {
    await exec("UPDATE services SET desired = 'running' WHERE id = ?", [id]);
    const row = await reloadRow(id);
    runtime(id).crashes = [];
    await startProcess(row);
  });
}

export async function stopService(id: number): Promise<void> {
  await serialize(id, async () => {
    await exec("UPDATE services SET desired = 'stopped' WHERE id = ?", [id]);
    await reloadRow(id);
    await stopProcess(id, 'stopped by request');
  });
}

export async function restartService(id: number): Promise<void> {
  await serialize(id, async () => {
    await exec("UPDATE services SET desired = 'running' WHERE id = ?", [id]);
    const row = await reloadRow(id);
    runtime(id).crashes = [];
    await stopProcess(id, 'restart');
    await startProcess(row);
  });
}

async function releasesOf(row: ServiceRow): Promise<number[]> {
  const su = await ensureSysUser(row.owner_id);
  const r = await runAs(su, 'ls', ['-1', '--', path.join(serviceDir(row), 'releases')], { timeoutMs: 10_000 });
  return r.stdout
    .split('\n')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => b - a);
}

async function rollbackService(row: ServiceRow, n: number): Promise<void> {
  if (!(await releasesOf(row)).includes(n)) throw new HttpError(404, `release #${n} is not kept anymore`);
  await serialize(row.id, async () => {
    await exec("UPDATE services SET release_no = ?, desired = 'running' WHERE id = ?", [n, row.id]);
    const fresh = await reloadRow(row.id);
    log(row.id, `Rolling back to release #${n}`);
    await stopProcess(row.id, `rollback to #${n}`);
    await startProcess(fresh);
  });
}

export async function deleteService(id: number): Promise<void> {
  await serialize(id, async () => {
    const row = await reloadRow(id);
    await exec("UPDATE services SET desired = 'stopped' WHERE id = ?", [id]);
    await reloadRow(id);
    await stopProcess(id, 'deleted');
    const su = await ensureSysUser(row.owner_id);
    await userRemove(su, serviceDir(row)).catch(() => {});
    await fsp.rm(logFile(id), { force: true }).catch(() => {});
    await fsp.rm(`${logFile(id)}.1`, { force: true }).catch(() => {});
    await exec('DELETE FROM services WHERE id = ?', [id]);
    rows.delete(id);
    slugIndex.delete(row.slug);
    runtimes.delete(id);
    sendToUser(row.owner_id, { t: 'services.changed', projectId: row.project_id });
  });
}

hooks.onProjectDeleted(async (projectId: number) => {
  for (const r of [...rows.values()].filter((x) => x.project_id === projectId)) await deleteService(r.id).catch(() => {});
});

/** Startup: load all servers, start the ones that should run. */
/** The end of a server's log file (so logs survive Studio restarts). */
function loadLogTail(id: number): string[] {
  try {
    const fd = fs.openSync(logFile(id), 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 128 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf8').split('\n').slice(1).filter(Boolean).slice(-LOG_LINES / 2);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

export async function initServices(): Promise<void> {
  seenOrigin = await getSetting<string | null>('services.origin', null).catch(() => null);
  for (const r of await q<ServiceRow>('SELECT * FROM services')) {
    cache(r);
    runtime(r.id).log = loadLogTail(r.id);
  }
  addUpgradeRoute('/srv/', serviceUpgrade);
  if (!config.services.enabled) {
    console.log('[services] disabled (SERVICES_ENABLED=false)');
    return;
  }
  for (const u of await q<{ id: number }>("SELECT id FROM users WHERE status <> 'active'")) disabledOwners.add(u.id);
  const toStart = [...rows.values()].filter((r) => r.desired === 'running' && r.release_no > 0 && !disabledOwners.has(r.owner_id));
  if (toStart.length) console.log(`[services] starting ${toStart.length} server(s)`);
  for (const r of toStart) {
    log(r.id, 'The Studio started — starting the server again …');
    startProcess(r).catch((err: Error) => {
      log(r.id, `Could not start: ${err.message}`);
      setState(r.id, 'error', err.message);
    });
  }
}

/** Accounts that are disabled: their servers do not run (and are not started at boot). */
const disabledOwners = new Set<number>();

/** An admin disabled or re-enabled an account: its servers stop, or start again. */
export async function setServicesOwnerDisabled(ownerId: number, disabled: boolean): Promise<void> {
  const mine = [...rows.values()].filter((r) => r.owner_id === ownerId);
  if (disabled) {
    disabledOwners.add(ownerId);
    for (const r of mine) {
      log(r.id, 'The account was disabled by an admin — the server is stopped.');
      await stopProcess(r.id, 'account disabled').catch(() => {});
    }
    return;
  }
  if (!disabledOwners.delete(ownerId) || !config.services.enabled) return;
  for (const r of mine) {
    if (r.desired !== 'running' || !r.release_no) continue;
    startProcess(r).catch((err: Error) => {
      log(r.id, `Could not start: ${err.message}`);
      setState(r.id, 'error', err.message);
    });
  }
}

export function stopAllServices(): void {
  for (const [id, rt] of runtimes) {
    if (rt.child) {
      log(id, 'The Studio is shutting down — stopping (it starts again with the Studio) …');
      rt.stopping = true;
      killTree(rt.child, 'SIGTERM');
    }
  }
}

export function serviceCount(): number {
  return [...runtimes.values()].filter((rt) => rt.child).length;
}

// ---------------------------------------------------------------------------
// Reverse proxy: /srv/<slug>/…  (HTTP + WebSocket)
// ---------------------------------------------------------------------------
const SANDBOX_CSP =
  'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock allow-orientation-lock';

function parseSrvPath(url: string | undefined): { slug: string; rest: string } | null {
  const m = /^\/srv\/([a-z0-9][a-z0-9-]{0,63})(\/[^]*|\?[^]*)?$/.exec(url ?? '');
  if (!m) return null;
  const rest = m[2] ? (m[2].startsWith('?') ? `/${m[2]}` : m[2]) : '';
  return { slug: m[1], rest };
}

/** Request headers for the server: no Studio session cookie, X-Forwarded-*. */
function forwardHeaders(req: IncomingMessage, prefix: string): IncomingHttpHeaders {
  const h: IncomingHttpHeaders = { ...req.headers };
  if (h.cookie) {
    const kept = String(h.cookie)
      .split(';')
      .map((c) => c.trim())
      .filter((c) => c && !c.startsWith(`${SESSION_COOKIE}=`));
    if (kept.length) h.cookie = kept.join('; ');
    else delete h.cookie;
  }
  const proto = (req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http';
  const fwdProto = config.trustProxy && typeof h['x-forwarded-proto'] === 'string' ? h['x-forwarded-proto'] : proto;
  const ip = req.socket.remoteAddress ?? '';
  h['x-forwarded-for'] = config.trustProxy && h['x-forwarded-for'] ? `${h['x-forwarded-for']}, ${ip}` : ip;
  h['x-forwarded-proto'] = fwdProto;
  h['x-forwarded-host'] = req.headers.host ?? '';
  if (prefix) h['x-forwarded-prefix'] = prefix;
  else delete h['x-forwarded-prefix'];
  return h;
}

/**
 * How a server is mounted: below `/srv/<slug>` (prefix stripped, cookies confined to it) or as a
 * whole website (prefix ''). `sandbox` = CSP sandbox on every response — always on the Studio's own
 * port, so a server can never act with the Studio's origin.
 */
interface Mount {
  prefix: string;
  sandbox: boolean;
}

/** Response headers to the browser: sandboxed (Studio port), cookies scoped to the server's path. */
function backHeaders(raw: IncomingHttpHeaders, mount: Mount, cors: boolean, origin: string | undefined): IncomingHttpHeaders {
  const h: IncomingHttpHeaders = { ...raw };
  delete h.connection;
  delete h['keep-alive'];
  if (h['set-cookie'] && mount.prefix) {
    h['set-cookie'] = h['set-cookie'].map(
      (c) =>
        c
          .split(';')
          .filter((part) => !/^\s*(path|domain)=/i.test(part))
          .join(';') + `; Path=${mount.prefix}/`,
    );
  }
  if (mount.sandbox) h['content-security-policy'] = SANDBOX_CSP;
  h['x-content-type-options'] = 'nosniff';
  if (cors && !h['access-control-allow-origin']) {
    h['access-control-allow-origin'] = origin && origin !== 'null' ? origin : '*';
    h.vary = h.vary ? `${h.vary}, Origin` : 'Origin';
  }
  return h;
}

function unavailable(res: Response, status: number, message: string, sandbox = true): void {
  res.status(status);
  if (sandbox) res.setHeader('Content-Security-Policy', SANDBOX_CSP);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.json({ error: message });
}

/**
 * `/srv/<slug>/…` → the server. On the Studio's port every server is reachable (sandboxed);
 * on the website port (sites.ts) only the servers of the website's owner (`ownerId`).
 */
export function proxySrv(req: Request, res: Response, opts: { ownerId?: number; sandbox: boolean }): void {
  const p = parseSrvPath(req.originalUrl);
  if (!p) return unavailable(res, 404, 'No server at this address', opts.sandbox);
  const id = slugIndex.get(p.slug);
  const row = id ? rows.get(id) : undefined;
  if (!row || (opts.ownerId !== undefined && row.owner_id !== opts.ownerId)) {
    return unavailable(res, 404, `No server "${p.slug}" here`, opts.sandbox);
  }
  if (!p.rest) {
    res.redirect(308, `/srv/${p.slug}/`);
    return;
  }
  forwardHttp(req, res, row, p.rest, { prefix: `/srv/${p.slug}`, sandbox: opts.sandbox });
}

export function serviceHttpProxy(req: Request, res: Response): void {
  proxySrv(req, res, { sandbox: true });
}

/** A website that is one server of its project as a whole (website port, no prefix). */
export function proxyWholeSite(req: Request, res: Response, serviceId: number, ownerId: number): void {
  const row = rows.get(serviceId);
  if (!row || row.owner_id !== ownerId) return unavailable(res, 404, 'The server of this website no longer exists', false);
  forwardHttp(req, res, row, req.originalUrl, { prefix: '', sandbox: false });
}

function forwardHttp(req: Request, res: Response, row: ServiceRow, upstreamPath: string, mount: Mount): void {
  const rt = runtime(row.id);
  const cors = row.settings?.cors !== false;
  if (cors && req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
    res.status(204);
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin && req.headers.origin !== 'null' ? req.headers.origin : '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', String(req.headers['access-control-request-headers'] ?? '*'));
    res.setHeader('Access-Control-Max-Age', '600');
    res.setHeader('Vary', 'Origin');
    res.end();
    return;
  }
  if (!rt.child || !rt.port || !rt.listening) {
    const why = rt.deploying ? 'is being deployed' : rt.state === 'starting' ? 'is starting' : rt.state === 'crashed' ? 'crashed' : 'is not running';
    return unavailable(res, 503, `The server "${row.name}" ${why}.`, mount.sandbox);
  }
  const upstream = http.request(
    { host: '127.0.0.1', port: rt.port, method: req.method, path: upstreamPath, headers: forwardHeaders(req, mount.prefix) },
    (pres) => {
      res.writeHead(pres.statusCode ?? 502, backHeaders(pres.headers, mount, cors, req.headers.origin));
      pres.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    if (!res.headersSent) unavailable(res, 502, `The server "${row.name}" did not answer (${err.message}).`, mount.sandbox);
    else res.destroy();
  });
  req.on('aborted', () => upstream.destroy());
  // the visitor left in the middle of an answer (event streams, long polls, downloads)
  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.pipe(upstream);
}

function rejectUpgrade(socket: Duplex): void {
  socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  socket.destroy();
}

function serviceUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  srvUpgrade(req, socket, head, {});
}

/** WebSocket to `/srv/<slug>/…` (website port: only servers of `ownerId`). */
export function srvUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, opts: { ownerId?: number }): void {
  const p = parseSrvPath(req.url);
  const id = p ? slugIndex.get(p.slug) : undefined;
  const row = id ? rows.get(id) : undefined;
  if (!p || !p.rest || !row || (opts.ownerId !== undefined && row.owner_id !== opts.ownerId)) return rejectUpgrade(socket);
  forwardUpgrade(req, socket, head, row, p.rest, `/srv/${p.slug}`);
}

/** WebSocket of a website that is one server as a whole. */
export function wholeSiteUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, serviceId: number, ownerId: number): void {
  const row = rows.get(serviceId);
  if (!row || row.owner_id !== ownerId) return rejectUpgrade(socket);
  forwardUpgrade(req, socket, head, row, req.url ?? '/', '');
}

function forwardUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, row: ServiceRow, upstreamPath: string, prefix: string): void {
  const rt = runtime(row.id);
  if (!rt.child || !rt.port) return rejectUpgrade(socket);
  const upstream = net.connect(rt.port, '127.0.0.1', () => {
    const headers = forwardHeaders(req, prefix);
    const lines = [`${req.method} ${upstreamPath} HTTP/1.1`];
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined) continue;
      for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${String(one).replace(/[\r\n]/g, ' ')}`);
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.setNoDelay(true);
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
  upstream.on('close', () => socket.destroy());
}

// ---------------------------------------------------------------------------
// Starter templates (also used by `studio service new`)
// ---------------------------------------------------------------------------
const templateDir = (t: string) => path.join(config.toolsDir, 'studio', 'templates', 'service', t);

async function scaffold(su: SysUser, dir: string, folder: string, template: string, name: string): Promise<string> {
  const rel = relOf(dir, resolveIn(dir, folder));
  if (!rel || rel.includes('/')) throw new HttpError(400, 'choose a folder directly in the project (e.g. server)');
  const dest = path.join(dir, rel);
  if (await userStat(su, path.join(dest, 'package.json'))) throw new HttpError(409, `${rel}/ already contains a server (package.json)`);
  if (!fs.existsSync(templateDir(template))) throw new HttpError(400, `unknown template "${template}" (${TEMPLATES.join(', ')})`);
  await userCopyTree(su, templateDir(template), dest);
  const pkgFile = path.join(dest, 'package.json');
  const { data } = await userReadFile(su, pkgFile, 64 * 1024);
  await userWriteFile(su, pkgFile, data.toString('utf8').replace(/\{\{NAME\}\}/g, slugify(name)));
  return rel;
}

// ---------------------------------------------------------------------------
// Website routes
// ---------------------------------------------------------------------------
export const servicesRouter = Router();

servicesRouter.get('/services', async (req, res) => {
  const user = req.user!;
  const list = await q<ServiceRow & { project_name: string; project_area: string }>(
    `SELECT s.*, p.name AS project_name, p.area AS project_area FROM services s JOIN projects p ON p.id = s.project_id
      WHERE s.owner_id = ? ORDER BY s.created_at DESC`,
    [user.id],
  );
  res.json({
    services: list.map((r) => ({ ...publicService(cache(r)), projectName: r.project_name, projectArea: r.project_area })),
    limits: { maxPerUser: config.services.maxPerUser, enabled: config.services.enabled },
  });
});

servicesRouter.get('/projects/:id/services', async (req, res) => {
  const { project, su, dir } = await loadOwnedProject(req.user!, intParam(req.params.id));
  res.json({
    services: servicesOfProjectSync(project.id),
    detected: await detectServers(su, dir, project.id),
    templates: TEMPLATES,
    enabled: config.services.enabled,
    suggested: !!getArea(project.area)?.services,
  });
});

servicesRouter.post('/projects/:id/services/scaffold', async (req, res) => {
  const { project, su, dir } = await loadOwnedProject(req.user!, intParam(req.params.id));
  const body = parse(z.object({ template: z.enum(TEMPLATES), folder: z.string().trim().max(64).default('server') }), req.body ?? {});
  const root = await scaffold(su, dir, body.folder || 'server', body.template, project.name);
  res.status(201).json({ root, detected: await detectServers(su, dir, project.id) });
});

servicesRouter.post('/projects/:id/services', async (req, res) => {
  const { project } = await loadOwnedProject(req.user!, intParam(req.params.id));
  const body = parse(z.object({ root: z.string().trim().min(1).max(255), name: z.string().trim().max(64).optional(), deploy: z.boolean().optional() }), req.body);
  const row = await createService(req.user!, project, body.root, body.name);
  if (body.deploy) void deployService(row.id, `deployed by ${req.user!.username}`).catch(() => {});
  res.status(201).json({ service: publicService(row) });
});

servicesRouter.get('/services/:id', async (req, res) => {
  const row = await ownedService(req.user!, intParam(req.params.id));
  const project = await getProjectRow(row.project_id);
  res.json({
    service: publicService(row),
    project: project ? { id: project.id, name: project.name, area: project.area } : null,
    env: userEnv(row),
    releases: await releasesOf(row).catch(() => []),
    log: runtime(row.id).log.slice(-400),
  });
});

servicesRouter.get('/services/:id/logs', async (req, res) => {
  const row = await ownedService(req.user!, intParam(req.params.id));
  const tail = Math.min(LOG_LINES, Math.max(1, Number(req.query.tail) || 400));
  res.json({ log: runtime(row.id).log.slice(-tail) });
});

const ACTIONS: [string, (id: number, user: AuthUser) => Promise<void>][] = [
  ['deploy', (id, user) => deployService(id, `deployed by ${user.username}`)],
  ['start', (id) => startService(id)],
  ['stop', (id) => stopService(id)],
  ['restart', (id) => restartService(id)],
];
for (const [action, fn] of ACTIONS) {
  servicesRouter.post(`/services/:id/${action}`, async (req, res) => {
    const row = await ownedService(req.user!, intParam(req.params.id));
    if (action === 'deploy') {
      // npm install can take a while: answer at once, progress arrives over the WebSocket
      void fn(row.id, req.user!).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
    } else {
      await fn(row.id, req.user!);
    }
    res.json({ service: publicService(rows.get(row.id) ?? row) });
  });
}

servicesRouter.post('/services/:id/rollback', async (req, res) => {
  const row = await ownedService(req.user!, intParam(req.params.id));
  const body = parse(z.object({ release: z.number().int().positive() }), req.body);
  await rollbackService(row, body.release);
  res.json({ service: publicService(rows.get(row.id) ?? row) });
});

servicesRouter.put('/services/:id/env', async (req, res) => {
  const row = await ownedService(req.user!, intParam(req.params.id));
  const body = parse(
    z.object({
      env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, 'variable names: letters, digits, _'), z.string().max(8192)),
      restart: z.boolean().optional(),
    }),
    req.body,
  );
  const reserved = Object.keys(body.env).filter((k) => RESERVED_ENV.has(k));
  if (reserved.length) throw new HttpError(400, `${reserved.join(', ')} ${reserved.length === 1 ? 'is' : 'are'} set by the Studio`);
  await exec('UPDATE services SET env_enc = ? WHERE id = ?', [Object.keys(body.env).length ? encryptSecret(JSON.stringify(body.env)) : null, row.id]);
  await reloadRow(row.id);
  log(row.id, `Environment updated (${Object.keys(body.env).length} variable(s))${body.restart ? ' — restarting' : ''}`);
  if (body.restart && runtime(row.id).child) await restartService(row.id);
  res.json({ ok: true });
});

servicesRouter.patch('/services/:id', async (req, res) => {
  const row = await ownedService(req.user!, intParam(req.params.id));
  const body = parse(
    z.object({
      name: z.string().trim().min(1).max(64).optional(),
      slug: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9][a-z0-9-]{1,47}$/, 'address: 2–48 characters, a-z, 0-9 and -')
        .optional(),
      settings: z
        .object({ cors: z.boolean().optional(), memoryMb: z.number().int().min(64).max(16384).optional(), start: z.string().trim().max(500).optional() })
        .optional(),
    }),
    req.body,
  );
  if (body.slug && body.slug !== row.slug && (slugIndex.has(body.slug) || (await q1('SELECT id FROM services WHERE slug = ?', [body.slug])))) {
    throw new HttpError(409, `the address /srv/${body.slug}/ is taken`);
  }
  const settings = { ...(row.settings ?? {}), ...(body.settings ?? {}) };
  if (body.settings?.start === '') delete settings.start;
  await exec('UPDATE services SET name = ?, slug = ?, settings = ? WHERE id = ?', [body.name ?? row.name, body.slug ?? row.slug, JSON.stringify(settings), row.id]);
  const fresh = await reloadRow(row.id);
  if (fresh.slug !== row.slug) log(row.id, `New address: ${publicUrl(fresh.slug)}`);
  changed(row.id);
  res.json({ service: publicService(fresh) });
});

servicesRouter.delete('/services/:id', async (req, res) => {
  const row = await ownedService(req.user!, intParam(req.params.id));
  await deleteService(row.id);
  res.json({ ok: true });
});

/** The server's persistent data (DATA_DIR) as a zip. */
servicesRouter.get('/services/:id/data.zip', async (req, res) => {
  const row = await ownedService(req.user!, intParam(req.params.id));
  const su = await ensureSysUser(row.owner_id);
  if (!(await userStat(su, dataDir(row)))?.isDir) throw new HttpError(404, 'no data yet');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${row.slug}-data.zip"`);
  const child = userZip(su, dataDir(row));
  child.stdout!.pipe(res);
  res.on('close', () => child.kill());
});

/** Admin: every server on this Studio. */
servicesRouter.get('/admin/services', async (_req, res) => {
  const list = await q<ServiceRow & { username: string; project_name: string }>(
    `SELECT s.*, u.username, p.name AS project_name FROM services s
       JOIN users u ON u.id = s.owner_id JOIN projects p ON p.id = s.project_id ORDER BY s.id`,
  );
  res.json({
    services: list.map((r) => ({ ...publicService(cache(r)), owner: r.username, projectName: r.project_name })),
    config: { enabled: config.services.enabled, maxPerUser: config.services.maxPerUser, memoryMb: config.services.memoryMb },
  });
});

servicesRouter.post('/admin/services/:id/stop', async (req, res) => {
  const id = intParam(req.params.id);
  if (!rows.has(id)) await reloadRow(id);
  await stopService(id);
  broadcast({ t: 'services.changed' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Agent routes (bearer STUDIO_TOKEN) — the `studio service` CLI inside Claude sessions
// ---------------------------------------------------------------------------
export const servicesAgentRouter = Router();

async function agentService(req: Request) {
  const a = await agentContext(req);
  const id = intParam(req.params.id);
  const row = await reloadRow(id).catch(() => null);
  if (!row || row.project_id !== a.project.id) throw notFound('server not found in this project');
  return { ...a, row };
}

function report(row: ServiceRow, tail = 40) {
  return { service: publicService(rows.get(row.id) ?? row), log: runtime(row.id).log.slice(-tail) };
}

servicesAgentRouter.get('/agent/services', async (req, res) => {
  const { project, su, dir } = await agentContext(req);
  res.json({ services: servicesOfProjectSync(project.id), detected: await detectServers(su, dir, project.id), enabled: config.services.enabled });
});

/** Create (if needed) + deploy + wait until it listens or fails — Claude gets the result at once. */
servicesAgentRouter.post('/agent/services/deploy', async (req, res) => {
  const { user, project, dir } = await agentContext(req);
  const body = parse(z.object({ path: z.string().trim().max(1024).optional(), name: z.string().trim().max(64).optional() }), req.body ?? {});
  const root = body.path ? relOf(dir, resolveIn(dir, body.path)) : 'server';
  const row = await createService(user, project, root, body.name);
  await deployService(row.id, 'deployed by Claude');
  await waitSettled(row.id, 35_000);
  res.json(report(await reloadRow(row.id)));
});

for (const action of ['start', 'stop', 'restart'] as const) {
  servicesAgentRouter.post(`/agent/services/:id/${action}`, async (req, res) => {
    const { row } = await agentService(req);
    await (action === 'start' ? startService(row.id) : action === 'stop' ? stopService(row.id) : restartService(row.id));
    if (action !== 'stop') await waitSettled(row.id, 35_000);
    res.json(report(row));
  });
}

servicesAgentRouter.get('/agent/services/:id/logs', async (req, res) => {
  const { row } = await agentService(req);
  res.json(report(row, Math.min(LOG_LINES, Math.max(1, Number(req.query.tail) || 100))));
});

servicesAgentRouter.put('/agent/services/:id/env', async (req, res) => {
  const { row } = await agentService(req);
  const body = parse(
    z.object({
      set: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.string().max(8192)).optional(),
      unset: z.array(z.string()).optional(),
    }),
    req.body ?? {},
  );
  const env = { ...userEnv(row), ...(body.set ?? {}) };
  for (const k of body.unset ?? []) delete env[k];
  const reserved = Object.keys(env).filter((k) => RESERVED_ENV.has(k));
  if (reserved.length) throw new HttpError(400, `${reserved.join(', ')} ${reserved.length === 1 ? 'is' : 'are'} set by the Studio`);
  await exec('UPDATE services SET env_enc = ? WHERE id = ?', [Object.keys(env).length ? encryptSecret(JSON.stringify(env)) : null, row.id]);
  await reloadRow(row.id);
  log(row.id, `Environment updated by Claude: ${Object.keys(env).join(', ') || '(empty)'} — restart to apply`);
  res.json({ env: Object.keys(env) });
});
