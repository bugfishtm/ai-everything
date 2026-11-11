/**
 * Runtime installs of the agent CLIs: the official npm packages are downloaded into the
 * data volume (/data/sdk/agents/<id>) once an admin switches an agent on — like Claude
 * Code (claudecli.ts), nothing of it is baked into a published image.
 *
 * Installs run one at a time: the packages are large (several 100 MB), and small Docker
 * VMs (Docker Desktop's default ~4 GB) run out of memory with parallel npm installs.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { run, which } from '../lib/system.js';
import { broadcast, sendToAdmins } from '../ws.js';
import { type AgentDef, allAgents, enabledAgentIds } from './registry.js';

export interface AgentInstall {
  state: 'ready' | 'queued' | 'installing' | 'missing' | 'error';
  /** package → installed version */
  versions: Record<string, string>;
  installedAt: string | null;
  error: string | null;
  /** an update is running while the installed version keeps working */
  updating: boolean;
  log: string[];
}

const states = new Map<string, AgentInstall>();
let queue: Promise<void> = Promise.resolve();
const queued = new Set<string>();

export const agentsDir = () => path.join(config.sdkDir, 'agents');
export const agentPrefix = (id: string) => path.join(agentsDir(), id);
const metaFile = (id: string) => path.join(agentPrefix(id), 'studio-agent.json');

function blank(): AgentInstall {
  return { state: 'missing', versions: {}, installedAt: null, error: null, updating: false, log: [] };
}

export function installState(id: string): AgentInstall {
  return states.get(id) ?? blank();
}

function set(id: string, patch: Partial<AgentInstall>): void {
  states.set(id, { ...installState(id), ...patch });
  broadcast({ t: 'agents.changed' });
}

function log(id: string, line: string): void {
  const clean = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trimEnd();
  if (!clean) return;
  const s = installState(id);
  states.set(id, { ...s, log: [...s.log, clean].slice(-200) });
  console.log(`[agents:${id}] ${clean}`);
  sendToAdmins({ t: 'agents.log', id, line: clean });
}

/** Absolute path of an agent program: the runtime install, else the image's PATH (custom agents). */
export function agentBinPath(id: string, bin: string): string {
  if (bin.includes('/')) return bin;
  const p = path.join(agentPrefix(id), 'bin', bin);
  return fs.existsSync(p) ? p : bin;
}

export function agentReady(id: string): boolean {
  return installState(id).state === 'ready';
}

/** bin folders of installed agents — on the PATH of user processes (shell, terminals). */
let binDirsCache: { at: number; dirs: string[] } = { at: 0, dirs: [] };
export function agentBinDirs(): string[] {
  if (Date.now() - binDirsCache.at < 30_000) return binDirsCache.dirs;
  let dirs: string[] = [];
  try {
    dirs = fs
      .readdirSync(agentsDir())
      .map((d) => path.join(agentsDir(), d, 'bin'))
      .filter((d) => fs.existsSync(d));
  } catch {
    /* none yet */
  }
  binDirsCache = { at: Date.now(), dirs };
  return dirs;
}

async function installedVersions(agent: AgentDef): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const pkg of agent.packages) {
    try {
      const j = JSON.parse(await fsp.readFile(path.join(agentPrefix(agent.id), 'lib', 'node_modules', pkg, 'package.json'), 'utf8')) as { version?: string };
      if (j.version) out[pkg] = j.version;
    } catch {
      /* not installed */
    }
  }
  return out;
}

async function latestVersion(pkg: string): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg.replace('/', '%2f')}/latest`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    return ((await res.json()) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

function spawnLogged(id: string, cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onData = (d: Buffer) => d.toString().split(/\r?\n/).forEach((l) => log(id, l));
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      log(id, err.message);
      resolve(127);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** Queue an install / update of an agent's npm packages. */
export function installAgent(agent: AgentDef, reason: string): Promise<void> {
  if (!agent.packages.length) {
    void refreshState(agent);
    return Promise.resolve();
  }
  if (queued.has(agent.id)) return queue;
  queued.add(agent.id);
  const keepWorking = installState(agent.id).state === 'ready';
  set(agent.id, keepWorking ? { updating: true, error: null } : { state: 'queued', error: null });
  queue = queue
    .then(async () => {
      set(agent.id, keepWorking ? { updating: true } : { state: 'installing' });
      log(agent.id, `Downloading ${agent.packages.join(' + ')} from npm (${reason}) …`);
      await fsp.mkdir(agentPrefix(agent.id), { recursive: true });
      const code = await spawnLogged(agent.id, 'npm', [
        'install', '--global', '--prefix', agentPrefix(agent.id), '--no-audit', '--no-fund', '--loglevel=error',
        ...agent.packages.map((p) => (p.includes('@', 1) ? p : `${p}@latest`)),
      ]);
      if (code !== 0) throw new Error(`npm install failed (exit ${code}) — is the npm registry reachable?`);
      await run('chmod', ['-R', 'a+rX', agentPrefix(agent.id)]);
      const versions = await installedVersions(agent);
      const installedAt = new Date().toISOString();
      await fsp.writeFile(metaFile(agent.id), JSON.stringify({ packages: agent.packages, versions, installedAt, reason }, null, 2));
      binDirsCache.at = 0;
      set(agent.id, { state: 'ready', versions, installedAt, updating: false, error: null });
      log(agent.id, `${agent.name} is ready (${Object.entries(versions).map(([p, v]) => `${p} ${v}`).join(', ')}).`);
    })
    .catch((err: Error) => {
      log(agent.id, `Failed: ${err.message}`);
      set(agent.id, keepWorking ? { updating: false, error: err.message } : { state: 'error', updating: false, error: err.message });
    })
    .finally(() => {
      queued.delete(agent.id);
    });
  return queue;
}

/** Look at what is on disk (startup, custom agents without packages). */
async function refreshState(agent: AgentDef): Promise<void> {
  if (!agent.packages.length) {
    const found = agent.acpBin.includes('/') ? fs.existsSync(agent.acpBin) : !!(await which(agent.acpBin));
    set(agent.id, found ? { state: 'ready', error: null } : { state: 'error', error: `${agent.acpBin} was not found on this server` });
    return;
  }
  const versions = await installedVersions(agent);
  if (Object.keys(versions).length === agent.packages.length) {
    const meta = await fsp
      .readFile(metaFile(agent.id), 'utf8')
      .then((t) => JSON.parse(t) as { installedAt?: string })
      .catch(() => ({}) as { installedAt?: string });
    set(agent.id, { state: 'ready', versions, installedAt: meta.installedAt ?? null, error: null });
  } else if (installState(agent.id).state === 'ready') {
    set(agent.id, { state: 'missing' });
  }
}

async function updateIfNewer(agent: AgentDef, reason: string): Promise<void> {
  if (!agent.packages.length || installState(agent.id).state !== 'ready') return;
  const current = installState(agent.id).versions;
  for (const pkg of agent.packages) {
    const newest = await latestVersion(pkg);
    if (newest && current[pkg] && newest !== current[pkg]) {
      await installAgent(agent, reason);
      return;
    }
  }
}

/** Startup: what is installed; install switched-on agents that are missing; daily updates. */
export async function initAgents(): Promise<void> {
  const enabled = new Set(await enabledAgentIds());
  for (const agent of await allAgents()) {
    await refreshState(agent);
    if (!enabled.has(agent.id)) continue;
    if (installState(agent.id).state !== 'ready') void installAgent(agent, 'switched on');
    else if (config.agents.autoUpdate) void updateIfNewer(agent, 'update at start');
  }
  if (config.agents.autoUpdate) {
    setInterval(async () => {
      const on = new Set(await enabledAgentIds());
      for (const agent of await allAgents()) if (on.has(agent.id)) await updateIfNewer(agent, 'daily update').catch(() => {});
    }, 24 * 3600_000).unref();
  }
}

export async function removeAgentFiles(id: string): Promise<void> {
  await fsp.rm(agentPrefix(id), { recursive: true, force: true });
  binDirsCache.at = 0;
  states.delete(id);
  broadcast({ t: 'agents.changed' });
}
