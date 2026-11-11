/**
 * Android SDK — installed at runtime, never baked into the image.
 *
 * The Android SDK license does not allow redistribution, so a published image
 * must not contain it. Instead an admin accepts Google's terms on the website
 * (Admin → Android SDK) — or sets ANDROID_SDK_ACCEPT_LICENSE=yes for unattended
 * setups — and the Studio then downloads the newest command-line tools and
 * installs the newest stable platforms + build-tools with the Android CLI into
 * /data/sdk/android in the data volume (shared, read-only for users).
 *
 * The "plan" (what would be installed) is computed from Google's public
 * repository index, so nothing is downloaded or run before acceptance.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router } from 'express';
import { z } from 'zod';
import { config } from './config.js';
import { HttpError, parse } from './lib/http.js';
import { getSetting, setSetting } from './settings.js';
import { detectToolchains } from './tools.js';
import { sendToAdmins } from './ws.js';

export const ANDROID_TERMS_URL = 'https://developer.android.com/studio/terms';
const REPO_BASE = 'https://dl.google.com/android/repository/';

const androidBin = () => path.join(config.androidHome, 'cmdline-tools', 'latest', 'bin', 'android');

// ---------------------------------------------------------------------------
// Plan: newest stable packages from Google's repository index
// ---------------------------------------------------------------------------
interface RepoPkg {
  path: string;
  channel: number;
  display: string;
  linuxUrl?: string;
}

export interface SdkPlan {
  cmdlineToolsUrl: string;
  packages: string[];
  source: 'auto' | 'ANDROID_SDK_PACKAGES';
  fetchedAt: number;
}

let planCache: SdkPlan | null = null;

function parseRepo(xml: string): RepoPkg[] {
  const out: RepoPkg[] = [];
  for (const block of xml.split('<remotePackage ').slice(1)) {
    const p = /^path="([^"]+)"/.exec(block)?.[1];
    if (!p) continue;
    const channel = Number(/<channelRef ref="channel-(\d)"/.exec(block)?.[1] ?? 0);
    const display = /<display-name>([^<]*)<\/display-name>/.exec(block)?.[1] ?? p;
    let linuxUrl: string | undefined;
    for (const arch of block.split('<archive>').slice(1)) {
      const url = /<url>([^<]+)<\/url>/.exec(arch)?.[1];
      const os = /<host-os>([^<]+)<\/host-os>/.exec(arch)?.[1];
      if (url && (!os || os === 'linux')) {
        linuxUrl = url;
        break;
      }
    }
    out.push({ path: p, channel, display, linuxUrl });
  }
  return out;
}

type Ver = number[];
const cmpVer = (a: Ver, b: Ver) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

/** Pick newest stable platform (+ its .0 base and the previous major) and build-tools. */
export function choosePackages(pkgs: RepoPkg[]): { packages: string[]; cmdlineToolsUrl: string } {
  const stable = pkgs.filter((p) => p.channel === 0);
  const platforms: { v: Ver; name: string }[] = [];
  const buildTools: { v: Ver; name: string }[] = [];
  for (const p of stable) {
    const pm = /^platforms;android-(\d+)(?:\.(\d+))?$/.exec(p.path);
    if (pm) platforms.push({ v: [Number(pm[1]), Number(pm[2] ?? 0)], name: p.path.replace(';', '/') });
    const bm = /^build-tools;(\d+)\.(\d+)\.(\d+)$/.exec(p.path);
    if (bm) buildTools.push({ v: [Number(bm[1]), Number(bm[2]), Number(bm[3])], name: p.path.replace(';', '/') });
  }
  platforms.sort((a, b) => cmpVer(b.v, a.v));
  buildTools.sort((a, b) => cmpVer(b.v, a.v));
  const chosen = new Set<string>(['platform-tools']);
  const newest = platforms[0];
  if (newest) {
    chosen.add(newest.name);
    const base = platforms.find((p) => p.v[0] === newest.v[0] && p.v[1] === 0);
    if (base) chosen.add(base.name);
    const prev = platforms.find((p) => p.v[0] === newest.v[0] - 1 && p.v[1] === 0) ?? platforms.find((p) => p.v[0] === newest.v[0] - 1);
    if (prev) chosen.add(prev.name);
  }
  const bt = buildTools[0];
  if (bt) {
    chosen.add(bt.name);
    const btPrev = buildTools.find((b) => b.v[0] === bt.v[0] - 1);
    if (btPrev) chosen.add(btPrev.name);
  }
  const cmdline = stable.find((p) => p.path === 'cmdline-tools;latest')?.linuxUrl;
  if (!cmdline) throw new Error('cmdline-tools;latest not found in the repository index');
  return { packages: [...chosen], cmdlineToolsUrl: REPO_BASE + cmdline };
}

export async function sdkPlan(force = false): Promise<SdkPlan> {
  if (planCache && !force && Date.now() - planCache.fetchedAt < 3600_000) return planCache;
  const res = await fetch(REPO_BASE + 'repository2-3.xml');
  if (!res.ok) throw new Error(`repository index: HTTP ${res.status}`);
  const auto = choosePackages(parseRepo(await res.text()));
  const override = config.android.packages.split(/[\s,]+/).filter(Boolean);
  planCache = {
    cmdlineToolsUrl: config.android.toolsUrl || auto.cmdlineToolsUrl,
    packages: override.length ? override : auto.packages,
    source: override.length ? 'ANDROID_SDK_PACKAGES' : 'auto',
    fetchedAt: Date.now(),
  };
  return planCache;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------
async function listDir(dir: string): Promise<string[]> {
  return (await fsp.readdir(dir).catch(() => [] as string[])).filter((n) => !n.startsWith('.')).sort();
}

export interface SdkStatus {
  installed: boolean;
  androidHome: string;
  platforms: string[];
  buildTools: string[];
  platformTools: boolean;
  installedAt: string | null;
  license: { acceptedBy: string; acceptedAt: string } | null;
  termsUrl: string;
  job: { state: string; startedAt: number; finishedAt?: number; packages: string[]; log: string[] } | null;
}

let summaryCache = '';

export async function sdkStatus(): Promise<SdkStatus> {
  const meta = await fsp
    .readFile(path.join(config.androidHome, 'studio-sdk.json'), 'utf8')
    .then((t) => JSON.parse(t) as { installedAt?: string })
    .catch(() => null);
  const s: SdkStatus = {
    installed: fs.existsSync(androidBin()),
    androidHome: config.androidHome,
    platforms: await listDir(path.join(config.androidHome, 'platforms')),
    buildTools: await listDir(path.join(config.androidHome, 'build-tools')),
    platformTools: fs.existsSync(path.join(config.androidHome, 'platform-tools')),
    installedAt: meta?.installedAt ?? null,
    license: await getSetting<SdkStatus['license']>('android_sdk_license', null),
    termsUrl: ANDROID_TERMS_URL,
    job: job ? { state: job.state, startedAt: job.startedAt, finishedAt: job.finishedAt, packages: job.packages, log: job.log.slice(-500) } : null,
  };
  summaryCache = s.installed && s.platforms.length ? `platforms ${s.platforms.join(', ')}; build-tools ${s.buildTools.join(', ')}` : '';
  return s;
}

/** One line for Claude's system prompt ('' when not installed). */
export function androidSdkSummary(): string {
  return summaryCache;
}

// ---------------------------------------------------------------------------
// Install job
// ---------------------------------------------------------------------------
interface Job {
  state: 'running' | 'done' | 'failed';
  startedAt: number;
  finishedAt?: number;
  packages: string[];
  log: string[];
}
let job: Job | null = null;

function log(line: string): void {
  if (!job) return;
  const clean = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trimEnd();
  if (!clean) return;
  job.log.push(clean);
  if (job.log.length > 3000) job.log.splice(0, job.log.length - 3000);
  sendToAdmins({ t: 'sdk.log', line: clean });
}

function runLogged(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const onData = (d: Buffer) => {
      buf += d.toString().replace(/\r/g, '\n');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        log(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', (code) => {
      if (buf) log(buf);
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(cmd)} ${args.slice(0, 4).join(' ')} exited with ${code}`));
    });
  });
}

async function install(): Promise<void> {
  const plan = await sdkPlan(true);
  job!.packages = plan.packages;
  const home = config.androidHome;
  const tmp = path.join(config.sdkDir, '.tmp');
  await fsp.rm(tmp, { recursive: true, force: true });
  await fsp.mkdir(tmp, { recursive: true });
  await fsp.mkdir(path.join(home, 'cmdline-tools'), { recursive: true });

  log(`Downloading command-line tools: ${plan.cmdlineToolsUrl}`);
  const res = await fetch(plan.cmdlineToolsUrl);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const zip = path.join(tmp, 'cmdline-tools.zip');
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), fs.createWriteStream(zip));
  await runLogged('unzip', ['-q', zip, '-d', path.join(tmp, 'ct')], process.env);
  const unpacked = path.join(tmp, 'ct', 'cmdline-tools');
  if (!fs.existsSync(unpacked)) throw new Error('unexpected archive layout (no cmdline-tools/ folder)');
  await fsp.rm(path.join(home, 'cmdline-tools', 'latest'), { recursive: true, force: true });
  await fsp.rename(unpacked, path.join(home, 'cmdline-tools', 'latest'));
  log('Command-line tools installed.');

  const env = { ...process.env, ANDROID_HOME: home, ANDROID_SDK_ROOT: home };
  for (const pkg of plan.packages) {
    log(`Installing ${pkg} …`);
    await runLogged(androidBin(), ['--no-metrics', 'sdk', 'install', pkg], env);
  }
  await runLogged('chmod', ['-R', 'a+rX', home], process.env);
  await fsp.writeFile(
    path.join(home, 'studio-sdk.json'),
    JSON.stringify({ installedAt: new Date().toISOString(), packages: plan.packages, cmdlineTools: plan.cmdlineToolsUrl }, null, 2),
  );
  await fsp.rm(tmp, { recursive: true, force: true });
}

export async function startSdkInstall(acceptedBy: string): Promise<void> {
  if (job?.state === 'running') throw new HttpError(409, 'An installation is already running');
  await setSetting('android_sdk_license', { acceptedBy, acceptedAt: new Date().toISOString(), termsUrl: ANDROID_TERMS_URL });
  job = { state: 'running', startedAt: Date.now(), packages: [], log: [] };
  log(`Android SDK license accepted by ${acceptedBy} (${ANDROID_TERMS_URL}).`);
  install()
    .then(() => {
      job!.state = 'done';
      log('Android SDK ready.');
    })
    .catch((err: Error) => {
      job!.state = 'failed';
      log(`FAILED: ${err.message}`);
    })
    .finally(async () => {
      job!.finishedAt = Date.now();
      await detectToolchains().catch(() => {});
      await sdkStatus().catch(() => {});
      sendToAdmins({ t: 'sdk.status' });
    });
}

/** Unattended setups: ANDROID_SDK_ACCEPT_LICENSE=yes + ANDROID_SDK_AUTO_INSTALL=true */
export async function maybeAutoInstallSdk(): Promise<void> {
  const st = await sdkStatus();
  if (st.installed || !config.android.autoInstall) return;
  if (!config.android.acceptLicense) {
    console.warn('[sdk] ANDROID_SDK_AUTO_INSTALL is set, but ANDROID_SDK_ACCEPT_LICENSE is not "yes" — skipping');
    return;
  }
  console.log('[sdk] installing the Android SDK (license accepted via ANDROID_SDK_ACCEPT_LICENSE)');
  await startSdkInstall('environment (ANDROID_SDK_ACCEPT_LICENSE)');
}

// ---------------------------------------------------------------------------
// Admin routes
// ---------------------------------------------------------------------------
export const sdkRouter = Router();

sdkRouter.get('/admin/sdk/android', async (req, res) => {
  const status = await sdkStatus();
  let plan: SdkPlan | null = null;
  let planError: string | undefined;
  try {
    plan = await sdkPlan(req.query.refresh === '1');
  } catch (err) {
    planError = (err as Error).message;
  }
  res.json({ status, plan, planError });
});

sdkRouter.post('/admin/sdk/android/install', async (req, res) => {
  const body = parse(z.object({ accept: z.boolean() }), req.body);
  if (!body.accept) throw new HttpError(400, 'You must accept the Android SDK License Agreement to install the SDK');
  await startSdkInstall(`${req.user!.display_name} (@${req.user!.username})`);
  res.json({ ok: true });
});
