/**
 * Claude Code CLI — installed at runtime, not shipped in the image.
 *
 * Claude Code is Anthropic's proprietary software ("All rights reserved"), so a
 * published ai-everything image must not contain it. Instead the Studio downloads
 * the official, unmodified npm package `@anthropic-ai/claude-code` on first start
 * into the data volume (/data/sdk/claude-code) and keeps it current
 * (CLAUDE_CODE_VERSION=latest) or pinned (CLAUDE_CODE_VERSION=x.y.z).
 *
 * Where the binary comes from, in this order:
 *   1. CLAUDE_BIN (explicit path, e.g. tests)
 *   2. the runtime install in the data volume
 *   3. a copy baked into a self-built image (build arg INSTALL_CLAUDE_CODE=true —
 *      fine for private use, such an image must not be published)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { config } from './config.js';
import { parse } from './lib/http.js';
import { run, which } from './lib/system.js';
import { detectToolchains } from './tools.js';
import { broadcast, sendToAdmins } from './ws.js';

export const CLAUDE_CODE_PACKAGE = '@anthropic-ai/claude-code';
export const CLAUDE_CODE_TERMS_URL = 'https://code.claude.com/docs/en/legal-and-compliance';

export const claudeCodePrefix = () => path.join(config.sdkDir, 'claude-code');
const runtimeBin = () => path.join(claudeCodePrefix(), 'bin', 'claude');
const metaFile = () => path.join(claudeCodePrefix(), 'studio-claude-code.json');

export interface CliStatus {
  state: 'ready' | 'installing' | 'missing' | 'error';
  source: 'custom' | 'runtime' | 'image' | null;
  version: string | null;
  path: string | null;
  installedAt: string | null;
  /** CLAUDE_CODE_VERSION */
  wanted: string;
  autoInstall: boolean;
  autoUpdate: boolean;
  /** an update is being installed while the current version keeps working */
  updating: boolean;
  error: string | null;
  log: string[];
}

let status: CliStatus = {
  state: 'missing',
  source: null,
  version: null,
  path: null,
  installedAt: null,
  wanted: config.claudeCode.version,
  autoInstall: config.claudeCode.autoInstall,
  autoUpdate: config.claudeCode.autoUpdate,
  updating: false,
  error: null,
  log: [],
};
let job: Promise<void> | null = null;

export function cliStatus(): CliStatus {
  return status;
}
export function cliReady(): boolean {
  return status.state === 'ready';
}
/** Message for users when Claude Code cannot run yet. */
export function cliNotReadyMessage(): string {
  if (status.state === 'installing') return 'Claude Code is being installed on this server (first start) — try again in a minute.';
  if (status.state === 'error') return `Claude Code could not be installed: ${status.error ?? 'unknown error'} — an admin can retry on the Admin page.`;
  return 'Claude Code is not installed on this server yet — an admin can install it on the Admin page.';
}

function log(line: string): void {
  const clean = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trimEnd();
  if (!clean) return;
  status.log = [...status.log, clean].slice(-200);
  console.log(`[claude-code] ${clean}`);
  sendToAdmins({ t: 'claude.cli.log', line: clean });
}

function changed(): void {
  broadcast({ t: 'claude.cli' });
}

async function versionOf(bin: string): Promise<string | null> {
  const r = await run(bin, ['--version'], {
    timeoutMs: 30_000,
    env: { PATH: process.env.PATH, HOME: '/tmp', DISABLE_AUTOUPDATER: '1' },
  }).catch(() => null);
  return r && r.code === 0 ? (/\d+\.\d+\.\d+[\w.-]*/.exec(r.stdout)?.[0] ?? (r.stdout.trim() || null)) : null;
}

const cmpVer = (a: string, b: string) => {
  const pa = a.split(/[.-]/).map((x) => Number(x) || 0);
  const pb = b.split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

async function latestVersion(): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${CLAUDE_CODE_PACKAGE}/latest`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    return ((await res.json()) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

function spawnLogged(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onData = (d: Buffer) => d.toString().split(/\r?\n/).forEach(log);
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      log(err.message);
      resolve(127);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** Download (or update) the official npm package into the data volume. */
export function installClaudeCode(version: string, reason: string): Promise<void> {
  if (job) return job;
  const keepWorking = status.state === 'ready';
  status = { ...status, state: keepWorking ? 'ready' : 'installing', updating: keepWorking, error: null };
  changed();
  job = (async () => {
    log(`Downloading ${CLAUDE_CODE_PACKAGE}@${version} from npm (${reason}) …`);
    await fsp.mkdir(claudeCodePrefix(), { recursive: true });
    const code = await spawnLogged('npm', ['install', '--global', '--prefix', claudeCodePrefix(), '--no-audit', '--no-fund', '--loglevel=error', `${CLAUDE_CODE_PACKAGE}@${version}`]);
    if (code !== 0) throw new Error(`npm install failed (exit ${code}) — is the npm registry reachable?`);
    await run('chmod', ['-R', 'a+rX', claudeCodePrefix()]);
    const v = await versionOf(runtimeBin());
    if (!v) throw new Error('the package was installed but `claude --version` does not run');
    const installedAt = new Date().toISOString();
    await fsp.writeFile(metaFile(), JSON.stringify({ package: CLAUDE_CODE_PACKAGE, version: v, installedAt, reason }, null, 2));
    config.claudeBin = runtimeBin();
    status = { ...status, state: 'ready', source: 'runtime', version: v, path: runtimeBin(), installedAt, updating: false, error: null };
    log(`Claude Code ${v} is ready.`);
    await detectToolchains().catch(() => {});
  })()
    .catch((err: Error) => {
      log(`Failed: ${err.message}`);
      status = { ...status, state: keepWorking ? 'ready' : 'error', updating: false, error: err.message };
      console.error('[claude-code] install failed:', err.message);
    })
    .finally(() => {
      job = null;
      changed();
    });
  return job;
}

/** With CLAUDE_CODE_VERSION=latest: newest release; with a pinned version: exactly that one. */
async function maybeUpdate(reason: string): Promise<void> {
  if (status.source !== 'runtime' || !status.version) return;
  const wanted = config.claudeCode.version;
  if (wanted !== 'latest') {
    if (cmpVer(wanted, status.version) !== 0) await installClaudeCode(wanted, `pinned to ${wanted}`);
    return;
  }
  if (!config.claudeCode.autoUpdate) return;
  const newest = await latestVersion();
  if (newest && cmpVer(newest, status.version) > 0) await installClaudeCode(newest, reason);
}

/** Startup: find Claude Code, or install it in the background. */
export async function initClaudeCli(): Promise<void> {
  const custom = process.env.CLAUDE_BIN;
  if (custom) {
    config.claudeBin = custom;
    status = { ...status, state: 'ready', source: 'custom', path: custom, version: await versionOf(custom) };
    return;
  }
  if (fs.existsSync(runtimeBin())) {
    const meta = await fsp
      .readFile(metaFile(), 'utf8')
      .then((t) => JSON.parse(t) as { installedAt?: string })
      .catch(() => ({}) as { installedAt?: string });
    const v = await versionOf(runtimeBin());
    if (v) {
      config.claudeBin = runtimeBin();
      status = { ...status, state: 'ready', source: 'runtime', path: runtimeBin(), version: v, installedAt: meta.installedAt ?? null };
    }
  }
  if (status.state !== 'ready') {
    const image = await which('claude');
    const v = image ? await versionOf(image) : null;
    if (image && v) {
      config.claudeBin = image;
      status = { ...status, state: 'ready', source: 'image', path: image, version: v };
    }
  }
  if (status.state === 'ready') {
    console.log(`[claude-code] ${status.version} (${status.source === 'image' ? 'in the image' : 'data volume'})`);
    maybeUpdate('update at start').catch(() => {});
    return;
  }
  if (!config.claudeCode.autoInstall) {
    console.log('[claude-code] not installed — CLAUDE_CODE_AUTO_INSTALL=false; an admin can install it on the Admin page');
    return;
  }
  console.log(`[claude-code] not installed yet — downloading ${CLAUDE_CODE_PACKAGE}@${config.claudeCode.version} from npm`);
  void installClaudeCode(config.claudeCode.version, 'first start');
}

/** Daily update check (CLAUDE_CODE_VERSION=latest, runtime installs only). */
export function scheduleClaudeUpdates(): void {
  setInterval(() => maybeUpdate('daily update').catch(() => {}), 24 * 3600_000).unref();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export const claudeCliRouter = Router();

claudeCliRouter.get('/claude/cli', (req, res) => {
  const s = cliStatus();
  res.json({ cli: req.user?.role === 'admin' ? s : { ...s, log: [] }, terms: CLAUDE_CODE_TERMS_URL });
});

/** Admin: install / update / pin (mounted behind requireAdmin). */
claudeCliRouter.post('/admin/claude-cli/install', async (req, res) => {
  const body = parse(z.object({ version: z.string().trim().regex(/^(latest|stable|\d+\.\d+\.\d+[\w.-]*)$/, 'a version like 2.1.319, or latest').optional() }), req.body ?? {});
  let version = body.version || config.claudeCode.version;
  if (version === 'latest') version = (await latestVersion()) ?? 'latest';
  void installClaudeCode(version, `requested by ${req.user!.username}`);
  res.json({ cli: cliStatus() });
});
