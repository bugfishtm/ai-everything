/**
 * Per-user isolation.
 *
 * Every website user gets an own Linux account inside the container
 * (uid = UID_BASE + user id). Claude Code, terminals, git and every file
 * operation on user data run as that account via `setpriv`, so the kernel
 * keeps users apart: one user's Claude cannot read another user's projects
 * or Claude credentials. The server itself runs as root only to manage this.
 *
 * ISOLATION=none (or running as non-root) disables this for local development.
 */
import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';

export interface SysUser {
  userId: number;
  uid: number;
  gid: number;
  name: string;
  home: string;
  projectsRoot: string;
}

let isolationOn: boolean | null = null;

export function isolation(): boolean {
  if (isolationOn === null) {
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    if (config.isolation === 'uid') {
      if (!isRoot) throw new Error('ISOLATION=uid requires the server to run as root');
      isolationOn = true;
    } else if (config.isolation === 'none') {
      isolationOn = false;
    } else {
      isolationOn = isRoot && process.platform === 'linux';
    }
  }
  return isolationOn;
}

export function sysUserFor(userId: number): SysUser {
  const iso = isolation();
  return {
    userId,
    uid: iso ? config.uidBase + userId : (process.getuid?.() ?? 0),
    gid: iso ? config.uidBase + userId : (process.getgid?.() ?? 0),
    name: iso ? `u${userId}` : os.userInfo().username,
    home: path.join(config.homesDir, String(userId)),
    projectsRoot: path.join(config.projectsDir, String(userId)),
  };
}

// ---------------------------------------------------------------------------
// Environment for user processes: an allowlist — server secrets never leak.
// ---------------------------------------------------------------------------
const PASSTHROUGH = [
  'PATH', 'LANG', 'LC_ALL', 'TZ',
  'JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'GRADLE_HOME',
  'DOTNET_ROOT', 'DOTNET_CLI_TELEMETRY_OPTOUT', 'DOTNET_NOLOGO', 'DOTNET_SKIP_FIRST_TIME_EXPERIENCE',
  'PLAYWRIGHT_BROWSERS_PATH', 'CHROMIUM_PATH', 'NODE_PATH', 'VIRTUAL_ENV',
  'PYTHONUNBUFFERED', 'PIP_DISABLE_PIP_VERSION_CHECK', 'SOUNDFONT', 'DISABLE_AUTOUPDATER',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
];

/** bin folders of the agent CLIs installed at runtime (/data/sdk/agents/<id>/bin). */
let agentDirs: { at: number; dirs: string[] } = { at: 0, dirs: [] };
function agentBinDirs(): string[] {
  if (Date.now() - agentDirs.at < 30_000) return agentDirs.dirs;
  const root = path.join(config.sdkDir, 'agents');
  let dirs: string[] = [];
  try {
    dirs = fs
      .readdirSync(root)
      .map((d) => path.join(root, d, 'bin'))
      .filter((d) => fs.existsSync(d));
  } catch {
    /* none installed */
  }
  agentDirs = { at: Date.now(), dirs };
  return dirs;
}

export function baseUserEnv(su: SysUser, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of [...PASSTHROUGH, ...config.userEnvAllow]) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  const basePath = env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  Object.assign(env, {
    HOME: su.home,
    USER: su.name,
    LOGNAME: su.name,
    SHELL: '/bin/bash',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    LANG: env.LANG || 'C.UTF-8',
    // user-level installs land in the home directory, not in the shared image
    NPM_CONFIG_PREFIX: path.join(su.home, '.npm-global'),
    PATH: [
      path.join(su.home, '.local/bin'),
      path.join(su.home, '.npm-global/bin'),
      path.join(su.home, '.dotnet/tools'),
      // Claude Code downloaded at runtime (claudecli.ts) — `claude` in the user's shell
      path.join(config.sdkDir, 'claude-code', 'bin'),
      // other AI agents installed at runtime (codex, gemini, opencode …)
      ...agentBinDirs(),
      basePath,
    ].join(':'),
    DISABLE_AUTOUPDATER: '1',
    IS_SANDBOX: '1',
    STUDIO_API_URL: config.internalUrl,
    STUDIO_TOOLS_DIR: config.toolsDir,
  });
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------
/**
 * Programs the server starts are found with the SERVER's own PATH, resolved to an absolute path.
 * The environment of a user process starts with ~/.local/bin — and Node looks a bare command
 * name up with the PATH of the child's environment. Without this, a file named `setpriv` (or
 * `tar`, `git` …) in a user's home would run as root, before any privilege was dropped.
 */
const systemBins = new Map<string, string>();
function systemPathDirs(): string[] {
  const own = (process.env.PATH ?? '').split(path.delimiter).filter((d) => d && path.isAbsolute(d));
  const data = [config.homesDir, config.projectsDir].map((d) => path.resolve(d) + path.sep);
  // never a folder inside the users' data
  return [...new Set([...own, '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'])].filter(
    (d) => !data.some((x) => (path.resolve(d) + path.sep).startsWith(x)),
  );
}
export function systemBin(name: string): string | null {
  if (name.includes('/')) return name;
  let hit = systemBins.get(name);
  if (hit === undefined) {
    hit = '';
    for (const dir of systemPathDirs()) {
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).isFile()) {
          fs.accessSync(full, fs.constants.X_OK);
          hit = full;
          break;
        }
      } catch {
        /* next */
      }
    }
    // (a miss is not remembered: agent CLIs are installed at runtime)
    if (hit) systemBins.set(name, hit);
  }
  return hit || null;
}
const setprivBin = () => systemBin('setpriv') ?? '/usr/bin/setpriv';

export function userCommand(su: SysUser, cmd: string, args: string[]): [string, string[]] {
  if (!isolation()) return [cmd, args];
  return [
    setprivBin(),
    // a command the image does not have (an AI CLI installed at runtime, a tool in the user's
    // home) is looked up by setpriv itself — after it dropped to the user
    ['--reuid', String(su.uid), '--regid', String(su.gid), '--clear-groups', '--no-new-privs', '--', systemBin(cmd) ?? cmd, ...args],
  ];
}

export interface SpawnAsOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
  /** own process group, so the whole tree can be signalled with killTree() */
  detached?: boolean;
}

export function spawnAs(su: SysUser, cmd: string, args: string[], opts: SpawnAsOptions = {}): ChildProcess {
  const [file, fargs] = userCommand(su, cmd, args);
  return spawn(file, fargs, {
    cwd: opts.cwd ?? su.home,
    env: opts.env ?? baseUserEnv(su),
    stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe'],
    detached: opts.detached ?? false,
  });
}

/** Run untrusted-input converters (ffmpeg, ImageMagick …) as `nobody`. */
export function nobodyCommand(cmd: string, args: string[]): [string, string[]] {
  if (!isolation()) return [cmd, args];
  return [setprivBin(), ['--reuid=65534', '--regid=65534', '--clear-groups', '--no-new-privs', '--', systemBin(cmd) ?? cmd, ...args]];
}

/**
 * `close` only comes when every holder of the output pipes is gone — a grandchild that left the
 * process group (setsid) keeps them open for ever, and whoever waits for `close` hangs with it.
 * After the process itself exited, its pipes are closed from this side.
 */
export function closeAfterExit(child: ChildProcess, graceMs = 3000): void {
  child.once('exit', () => {
    setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    }, graceMs).unref();
  });
}

/** Signal a detached child and everything it started. */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!child.pid || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* gone */
    }
  }
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  stdoutBuf: Buffer;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
  timeoutMs?: number;
  maxOutput?: number;
}

function collect(child: ChildProcess, opts: RunOptions): Promise<RunResult> {
  const max = opts.maxOutput ?? 16 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let timer: NodeJS.Timeout | undefined;
    child.stdout?.on('data', (d: Buffer) => {
      if (outLen < max) out.push(d);
      outLen += d.length;
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (errLen < 256 * 1024) err.push(d);
      errLen += d.length;
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      const stdoutBuf = Buffer.concat(out);
      resolve({
        code: code ?? (signal ? 128 : 1),
        stdout: stdoutBuf.toString('utf8'),
        stdoutBuf,
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
    if (opts.timeoutMs) {
      timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
    }
    if (child.stdin) {
      child.stdin.on('error', () => {
        /* process exited early */
      });
      if (opts.input !== undefined) child.stdin.end(opts.input);
      else child.stdin.end();
    }
  });
}

/** Run a command as the given user and collect its output. */
export function runAs(su: SysUser, cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const child = spawnAs(su, cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return collect(child, opts);
}

/** Run a command as the server user. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return collect(child, opts);
}

export async function runAsChecked(su: SysUser, cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const r = await runAs(su, cmd, args, opts);
  if (r.code !== 0) {
    throw new Error(`${cmd} failed (${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
  }
  return r;
}

// ---------------------------------------------------------------------------
// Account management
// ---------------------------------------------------------------------------
const ensuring = new Map<number, Promise<SysUser>>();

async function mkdirOwned(dir: string, su: SysUser, mode: number): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  if (isolation()) await fsp.chown(dir, su.uid, su.gid);
  await fsp.chmod(dir, mode);
}

export function ensureSysUser(userId: number): Promise<SysUser> {
  let p = ensuring.get(userId);
  if (!p) {
    p = (async () => {
      const su = sysUserFor(userId);
      if (isolation()) {
        const g = await run('getent', ['group', su.name]);
        if (g.code !== 0) {
          const r = await run('groupadd', ['-g', String(su.gid), su.name]);
          if (r.code !== 0 && !/already exists/.test(r.stderr)) throw new Error(`groupadd: ${r.stderr}`);
        }
        const u = await run('getent', ['passwd', su.name]);
        if (u.code !== 0) {
          const r = await run('useradd', [
            '-u', String(su.uid), '-g', String(su.gid), '-d', su.home, '-M',
            '-s', '/bin/bash', '-c', `studio user ${userId}`, su.name,
          ]);
          if (r.code !== 0 && !/already exists/.test(r.stderr)) throw new Error(`useradd: ${r.stderr}`);
        }
      }
      await mkdirOwned(su.home, su, 0o700);
      await mkdirOwned(su.projectsRoot, su, 0o700);
      // personal packs: written only by the server, readable by the owner (group)
      const packs = path.join(config.packsDir, 'users', String(userId));
      await fsp.mkdir(packs, { recursive: true });
      if (isolation()) {
        await fsp.chown(packs, 0, su.gid);
        await fsp.chmod(packs, 0o750);
      }
      // Android CLI: no usage metrics by default ('wx' never follows an existing path)
      const rc = path.join(su.home, '.androidrc');
      try {
        await fsp.writeFile(rc, '--no-metrics\n', { flag: 'wx', mode: 0o644 });
        if (isolation()) await fsp.lchown(rc, su.uid, su.gid);
      } catch {
        /* exists */
      }
      return su;
    })();
    ensuring.set(userId, p);
    p.catch(() => ensuring.delete(userId));
  }
  return p;
}

/** The website account is deleted: its Linux account goes too (its files are removed by the caller). */
export async function removeSysUser(userId: number): Promise<void> {
  ensuring.delete(userId);
  if (!isolation()) return;
  const name = `u${userId}`;
  await run('pkill', ['-KILL', '-u', name]).catch(() => {});
  await run('userdel', [name]).catch(() => {});
  await run('groupdel', [name]).catch(() => {});
}

/** Top-level data directories: traversable but not listable for users. */
export async function prepareDataDirs(): Promise<void> {
  for (const dir of [config.projectsDir, config.homesDir]) {
    await fsp.mkdir(dir, { recursive: true });
    if (isolation()) {
      await fsp.chown(dir, 0, 0);
      await fsp.chmod(dir, 0o711);
    }
  }
  await fsp.mkdir(path.join(config.libraryDir, 'assets'), { recursive: true });
  await fsp.mkdir(config.stateDir, { recursive: true });
  for (const [dir, mode] of [
    [config.packsDir, 0o755],
    [path.join(config.packsDir, 'global'), 0o755],
    [path.join(config.packsDir, 'users'), 0o711],
    // traversable (random sub folder names) so the media probe can run as `nobody`
    [path.join(config.packsDir, '.staging'), 0o711],
    [config.sdkDir, 0o755],
    // deployed Node.js servers: per-user folders below (0700, owned by the user)
    [config.servicesDir, 0o711],
    // their logs are written by the Studio itself: root-only
    [path.join(config.servicesDir, '.logs'), 0o700],
    // published websites: written and served by the Studio itself (root-only)
    [config.sitesDir, 0o700],
    // WordPress runtimes: <id>/ belongs to root, <id>/run and <id>/tmp to the site's owner
    [config.wordpressDir, 0o711],
  ] as const) {
    await fsp.mkdir(dir, { recursive: true });
    if (isolation()) await fsp.chmod(dir, mode);
  }
  if (isolation()) {
    await fsp.chmod(config.libraryDir, 0o700);
    await fsp.chmod(config.stateDir, 0o700);
  }
}

/** Is a binary on PATH? */
export async function which(bin: string): Promise<string | null> {
  if (bin.includes('/')) {
    try {
      await fsp.access(bin);
      return bin;
    } catch {
      return null;
    }
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, bin);
    try {
      const st = await fsp.stat(full);
      if (st.isFile()) return full;
    } catch {
      /* next */
    }
  }
  return null;
}
