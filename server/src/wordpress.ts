/**
 * WordPress — projects of the WordPress area are real WordPress sites that people set up,
 * manage and extend (own plugins, themes and blocks) right in the Studio.
 *
 * Layout of such a project:
 *   wordpress/            the WordPress installation (core, wp-config.php, uploads, installed
 *                         plugins/themes) — not in the project's git history
 *   plugins/<slug>/       the user's own plugins   ┐ written by the AI and the user, versioned;
 *   themes/<slug>/        the user's own themes    ┘ linked into wordpress/wp-content/…
 *   exports/              installable zips of the own modules, database dumps
 * Each installation has
 *   - its own database in the built-in MariaDB (an own account that sees nothing else),
 *   - its own PHP-FPM (started on the first request, stopped when idle): the workers run as the
 *     owner's sandbox user and are confined to the project folder (open_basedir, no shell functions),
 *   - a website (sites.ts, mode "wordpress"): <name>.localhost, <name>.<base domain> and the
 *     user's own domains with HTTPS certificates — requests arrive there and are handed to PHP
 *     over FastCGI; static files are sent by the Studio itself.
 * Management (install, plugins, themes, updates, exports) uses WP-CLI as the owner.
 * /data/wordpress/<id>/ holds the runtime files: fpm.conf, the socket and fpm.log (root only),
 * run/ and tmp/ (the owner's: PHP error log, sessions, upload temp).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Router, type Request, type Response } from 'express';
import mysql from 'mysql2/promise';
import { z } from 'zod';
import { agentContext } from './agent.js';
import { SESSION_COOKIE } from './auth.js';
import { config } from './config.js';
import { exec, q, q1 } from './db.js';
import { hooks } from './hooks.js';
import { decryptSecret, encryptSecret, randomToken } from './lib/crypto.js';
import { FcgiError, fcgiRequest } from './lib/fastcgi.js';
import { HttpError, intParam, notFound, parse } from './lib/http.js';
import { mimeFor } from './lib/mime.js';
import { baseUserEnv, ensureSysUser, isolation, killTree, run, runAs, which, type SysUser } from './lib/system.js';
import { userMkdir, userRemove, userStat, userWriteFile } from './lib/userfs.js';
import { getProjectRow, loadOwnedProject, notifyProjectChanged, projectDir, type ProjectRow } from './projects.js';
import { versioningOf } from './releases.js';
import { deleteSiteOfProject, ensureWordPressSite, page, setWordPressBackend, siteHostsOfProject, siteOfProjectSync, siteStateChanged } from './sites.js';
import { publish } from './ws.js';

// ---------------------------------------------------------------------------
// Types and state
// ---------------------------------------------------------------------------
interface WpSettings {
  title?: string;
  locale?: string;
  adminUser?: string;
  adminEmail?: string;
  debug?: boolean;
}

interface WpInfo {
  version?: string;
}

interface WpRow {
  id: number;
  owner_id: number;
  project_id: number;
  state: 'new' | 'installing' | 'ready' | 'error';
  desired: 'running' | 'stopped';
  db_name: string | null;
  db_user: string | null;
  db_pass_enc: string | null;
  login_secret_enc: string | null;
  settings: WpSettings | null;
  info: WpInfo | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  installed_at: Date | null;
}

interface Runtime {
  child: ChildProcess | null;
  listening: boolean;
  starting: Promise<void> | null;
  stopping: boolean;
  startedAt: number | null;
  lastRequestAt: number;
  lastCronAt: number;
  crashes: number[];
  message: string | null;
  /** what PHP-FPM printed (start-up problems) */
  log: string[];
  /** progress of the installation / the last long operation */
  job: string[];
  busy: Promise<unknown> | null;
}

const rows = new Map<number, WpRow>();
const byProject = new Map<number, number>();
const runtimes = new Map<number, Runtime>();

const bins: { fpm: string | null; wp: string | null; php: string | null; phpVersion: string } = { fpm: null, wp: null, php: null, phpVersion: '' };

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/;
/** names of plugins and themes on wordpress.org (and of folders in wp-content) */
const EXT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const LOCALE_RE = /^[a-z]{2,3}(?:_[A-Z]{2})?(?:_[a-z]+)?$/;
const MODULE_KINDS = ['plugin', 'theme'] as const;
type ModuleKind = (typeof MODULE_KINDS)[number];
const TEMPLATES: Record<ModuleKind, { id: string; name: string; description: string }[]> = {
  plugin: [
    { id: 'basic', name: 'Basic plugin', description: 'A clean start: main file, activation hooks, a shortcode' },
    { id: 'settings', name: 'Plugin with a settings page', description: 'Admin menu, Settings API, options, a front-end output' },
    { id: 'block', name: 'Block (Gutenberg)', description: 'An editor block without a build step: block.json, editor script, styles' },
    { id: 'rest', name: 'Custom post type + REST API', description: 'Registers a post type and an own REST endpoint' },
  ],
  theme: [
    { id: 'block', name: 'Block theme', description: 'Full-site editing: theme.json, HTML templates and parts' },
    { id: 'classic', name: 'Classic theme', description: 'PHP templates: header, footer, index, functions.php' },
  ],
};

function runtime(id: number): Runtime {
  let rt = runtimes.get(id);
  if (!rt) {
    rt = { child: null, listening: false, starting: null, stopping: false, startedAt: null, lastRequestAt: 0, lastCronAt: 0, crashes: [], message: null, log: [], job: [], busy: null };
    runtimes.set(id, rt);
  }
  return rt;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const docrootOf = (dir: string) => path.join(dir, 'wordpress');
const runtimeDir = (id: number) => path.join(config.wordpressDir, String(id));
const runDir = (id: number) => path.join(runtimeDir(id), 'run');
const tmpDir = (id: number) => path.join(runtimeDir(id), 'tmp');
const sockPath = (id: number) => path.join(runtimeDir(id), 'fpm.sock');
const confPath = (id: number) => path.join(runtimeDir(id), 'fpm.conf');
const fpmLog = (id: number) => path.join(runtimeDir(id), 'fpm.log');
const phpLog = (id: number) => path.join(runDir(id), 'php-error.log');
const kitDir = () => path.join(config.toolsDir, 'studio', 'templates', 'wordpress');

export function wordpressAvailable(): { ok: boolean; reason: string } {
  if (!config.wordpress.enabled) return { ok: false, reason: 'WordPress is switched off on this Studio (WORDPRESS_ENABLED=false)' };
  if (!config.sites.enabled) return { ok: false, reason: 'WordPress needs the website hosting, which is switched off on this Studio (SITES_ENABLED=false)' };
  if (!bins.fpm || !bins.php) return { ok: false, reason: 'PHP is not part of this image (build it with INSTALL_WORDPRESS=true)' };
  if (!bins.wp) return { ok: false, reason: 'WP-CLI is not part of this image (build it with INSTALL_WORDPRESS=true)' };
  return { ok: true, reason: '' };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------
function cache(row: WpRow): WpRow {
  rows.set(row.id, row);
  byProject.set(row.project_id, row.id);
  return row;
}

function forget(id: number): void {
  const row = rows.get(id);
  if (row && byProject.get(row.project_id) === id) byProject.delete(row.project_id);
  rows.delete(id);
}

async function reloadRow(id: number): Promise<WpRow> {
  const row = await q1<WpRow>('SELECT * FROM wordpress_sites WHERE id = ?', [id]);
  if (!row) {
    forget(id);
    throw notFound('This project has no WordPress');
  }
  return cache(row);
}

async function reloadAll(): Promise<void> {
  const list = await q<WpRow>('SELECT * FROM wordpress_sites');
  const seen = new Set<number>();
  for (const r of list) {
    seen.add(r.id);
    cache(r);
  }
  for (const id of [...rows.keys()]) {
    if (seen.has(id)) continue;
    // deleted by a cascade (project or user removed): stop its PHP and drop what belongs to it
    const gone = rows.get(id)!;
    forget(id);
    void destroyRuntime(gone).catch(() => {});
  }
}

function rowOfProject(projectId: number): WpRow | undefined {
  const id = byProject.get(projectId);
  return id === undefined ? undefined : rows.get(id);
}

function changed(row: WpRow): void {
  publish(`project:${row.project_id}`, { t: 'wordpress.changed', projectId: row.project_id });
}

function job(row: WpRow, line: string): void {
  const rt = runtime(row.id);
  for (const l of line.split('\n')) {
    if (!l.trim()) continue;
    rt.job.push(l.slice(0, 600));
  }
  if (rt.job.length > 400) rt.job.splice(0, rt.job.length - 400);
  changed(row);
}

function publicWordPress(row: WpRow) {
  const rt = runtime(row.id);
  const s = row.settings ?? {};
  return {
    id: row.id,
    projectId: row.project_id,
    state: row.state,
    desired: row.desired,
    /** PHP of the site: it starts with the first request and stops when nobody visits */
    php: rt.listening ? 'running' : rt.starting ? 'starting' : rt.crashes.length >= 5 ? 'crashed' : 'idle',
    message: rt.message,
    error: row.state === 'error' ? row.last_error : null,
    version: row.info?.version ?? null,
    phpVersion: bins.phpVersion,
    title: s.title ?? '',
    locale: s.locale ?? 'en_US',
    adminUser: s.adminUser ?? '',
    adminEmail: s.adminEmail ?? '',
    debug: !!s.debug,
    installedAt: row.installed_at,
    job: rt.job.slice(-120),
    busy: !!rt.busy,
  };
}
export type PublicWordPress = ReturnType<typeof publicWordPress>;

async function serialize<T>(row: WpRow, fn: () => Promise<T>): Promise<T> {
  const rt = runtime(row.id);
  while (rt.busy) await rt.busy.catch(() => {});
  const p = fn();
  rt.busy = p;
  changed(row);
  try {
    return await p;
  } finally {
    if (rt.busy === p) rt.busy = null;
    changed(row);
  }
}

// ---------------------------------------------------------------------------
// Files owned by the user, read by the Studio (root): never through a link, never someone else's
// ---------------------------------------------------------------------------
async function openOwned(su: SysUser, abs: string, noFollow = false): Promise<{ fh: fsp.FileHandle; st: fs.Stats } | null> {
  let fh: fsp.FileHandle;
  try {
    // O_NONBLOCK: a FIFO planted in the folder must not hang the open
    fh = await fsp.open(abs, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (noFollow ? fs.constants.O_NOFOLLOW : 0));
  } catch {
    return null;
  }
  try {
    const st = await fh.stat();
    if (st.isFile() && (!isolation() || st.uid === su.uid)) return { fh, st };
  } catch {
    /* fall through */
  }
  await fh.close().catch(() => {});
  return null;
}

async function readOwnedHead(su: SysUser, abs: string, bytes: number): Promise<string> {
  const o = await openOwned(su, abs);
  if (!o) return '';
  try {
    const buf = Buffer.alloc(Math.min(bytes, o.st.size));
    const { bytesRead } = await o.fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await o.fh.close().catch(() => {});
  }
}

async function readOwnedTail(su: SysUser, abs: string, bytes: number): Promise<string> {
  const o = await openOwned(su, abs, true);
  if (!o) return '';
  try {
    const len = Math.min(bytes, o.st.size);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await o.fh.read(buf, 0, len, o.st.size - len);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await o.fh.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Database of a site
// ---------------------------------------------------------------------------
const builtinDb = () => !config.db.host;

async function dbAdmin(sql: string): Promise<void> {
  if (builtinDb()) {
    // the built-in MariaDB trusts root on its socket (the Studio runs as root in the container)
    const r = await run('mariadb', [`--socket=${config.db.socket}`, '-uroot', '--batch'], { input: sql, timeoutMs: 60_000 });
    if (r.code !== 0) throw new Error(`database: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
    return;
  }
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.wordpress.dbAdminUser || config.db.user,
    password: config.wordpress.dbAdminUser ? config.wordpress.dbAdminPassword : config.db.password,
    multipleStatements: true,
  });
  try {
    await conn.query(sql);
  } catch (err) {
    throw new Error(
      `the database server refused (${(err as Error).message}) — WordPress needs an account that may create databases: set WORDPRESS_DB_ADMIN_USER and WORDPRESS_DB_ADMIN_PASSWORD, or use the built-in database`,
    );
  } finally {
    await conn.end().catch(() => {});
  }
}

const sqlStr = (s: string) => `'${s.replace(/[^A-Za-z0-9_.@%-]/g, '')}'`;
const sqlId = (s: string) => `\`${s.replace(/[^A-Za-z0-9_]/g, '')}\``;

function dbHostForAccount(): string {
  return builtinDb() ? 'localhost' : '%';
}

/** Database + account of a site (idempotent — also re-applied at start, so a restored volume works). */
async function ensureDatabase(row: WpRow): Promise<void> {
  if (!row.db_name || !row.db_user || !row.db_pass_enc) return;
  const pass = decryptSecret(row.db_pass_enc);
  const acct = `${sqlStr(row.db_user)}@${sqlStr(dbHostForAccount())}`;
  await dbAdmin(
    [
      `CREATE DATABASE IF NOT EXISTS ${sqlId(row.db_name)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
      `CREATE USER IF NOT EXISTS ${acct} IDENTIFIED BY ${sqlStr(pass)};`,
      `ALTER USER ${acct} IDENTIFIED BY ${sqlStr(pass)};`,
      `GRANT ALL PRIVILEGES ON ${sqlId(row.db_name)}.* TO ${acct};`,
      'FLUSH PRIVILEGES;',
    ].join('\n'),
  );
}

async function dropDatabase(row: WpRow): Promise<void> {
  if (!row.db_name || !row.db_user) return;
  await dbAdmin(
    [`DROP DATABASE IF EXISTS ${sqlId(row.db_name)};`, `DROP USER IF EXISTS ${sqlStr(row.db_user)}@${sqlStr(dbHostForAccount())};`, 'FLUSH PRIVILEGES;'].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// wp-config.php and the Studio's must-use plugin
// ---------------------------------------------------------------------------
function phpStr(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function wpConfig(row: WpRow): string {
  const dbHost = builtinDb() ? `localhost:${config.db.socket}` : `${config.db.host}:${config.db.port}`;
  const salt = () => crypto.randomBytes(48).toString('base64url');
  const keys = ['AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT'];
  return [
    '<?php',
    '/**',
    ' * WordPress configuration — written by Everything Studio when the site was set up.',
    ' * Your own settings go below the Studio block (or use: wp config set NAME value).',
    ' */',
    `define( 'DB_NAME', ${phpStr(row.db_name!)} );`,
    `define( 'DB_USER', ${phpStr(row.db_user!)} );`,
    `define( 'DB_PASSWORD', ${phpStr(decryptSecret(row.db_pass_enc!))} );`,
    `define( 'DB_HOST', ${phpStr(dbHost)} );`,
    "define( 'DB_CHARSET', 'utf8mb4' );",
    "define( 'DB_COLLATE', '' );",
    '',
    ...keys.map((k) => `define( '${k}', ${phpStr(salt())} );`),
    '',
    "$table_prefix = 'wp_';",
    '',
    '// --- Everything Studio -----------------------------------------------------------',
    '// The site answers on every address the Studio gives it (its own domains, <name>.localhost …):',
    '// links always point to the address the visitor used.',
    "if ( ! empty( $_SERVER['HTTP_HOST'] ) && ! defined( 'WP_HOME' ) ) {",
    "\t$studio_scheme = ( ! empty( $_SERVER['HTTPS'] ) && 'off' !== strtolower( $_SERVER['HTTPS'] ) ) ? 'https' : 'http';",
    "\tdefine( 'WP_HOME', $studio_scheme . '://' . $_SERVER['HTTP_HOST'] );",
    "\tdefine( 'WP_SITEURL', WP_HOME );",
    '}',
    '// one-click sign-in from the Studio (the WordPress tab of the project)',
    `define( 'STUDIO_LOGIN_SECRET', ${phpStr(decryptSecret(row.login_secret_enc!))} );`,
    '// the Studio runs due tasks itself every few minutes',
    "define( 'DISABLE_WP_CRON', true );",
    '// plugins, themes and updates are written directly (PHP runs as the owner of the files)',
    "define( 'FS_METHOD', 'direct' );",
    '// errors go to the PHP error log shown in the Studio — WP_DEBUG adds notices and warnings',
    "define( 'WP_DEBUG', false );",
    "define( 'WP_DEBUG_DISPLAY', false );",
    '// ---------------------------------------------------------------------------------',
    '',
    "/* That's all, stop editing! Happy publishing. */",
    '',
    "if ( ! defined( 'ABSPATH' ) ) {",
    "\tdefine( 'ABSPATH', __DIR__ . '/' );",
    '}',
    "require_once ABSPATH . 'wp-settings.php';",
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// WP-CLI (as the owner)
// ---------------------------------------------------------------------------
interface CliOptions {
  input?: string;
  timeoutMs?: number;
  /** management commands must work even when a plugin of the site is broken */
  safe?: boolean;
}

async function wpCli(row: WpRow, su: SysUser, dir: string, args: string[], opts: CliOptions = {}) {
  const site = siteHostsOfProject(row.project_id);
  const full = [`--path=${docrootOf(dir)}`, '--no-color'];
  if (site) full.push(`--url=${site.primary.replace(/\/+$/, '')}`);
  if (opts.safe !== false) full.push('--skip-plugins', '--skip-themes');
  full.push(...args);
  return runAs(su, bins.wp!, full, {
    cwd: dir,
    env: baseUserEnv(su, {
      WP_CLI_CACHE_DIR: path.join(su.home, '.wp-cli', 'cache'),
      WP_CLI_DISABLE_AUTO_CHECK_UPDATE: '1',
      PAGER: 'cat',
      STUDIO_API_URL: undefined,
      STUDIO_TOOLS_DIR: undefined,
    }),
    input: opts.input,
    timeoutMs: opts.timeoutMs ?? 120_000,
    maxOutput: 8 * 1024 * 1024,
  });
}

function cliError(r: { stdout: string; stderr: string }): string {
  const lines = `${r.stderr}\n${r.stdout}`
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^(Deprecated|Notice|Warning: Undefined|PHP (Deprecated|Notice))/i.test(l));
  const err = lines.filter((l) => /^(Error|Fatal|PHP Fatal)/i.test(l));
  return (err.length ? err : lines).slice(-4).join(' ').replace(/^Error:\s*/i, '').slice(0, 600) || 'WP-CLI failed';
}

async function wpChecked(row: WpRow, su: SysUser, dir: string, args: string[], opts: CliOptions = {}): Promise<string> {
  const r = await wpCli(row, su, dir, args, opts);
  if (r.code !== 0) throw new HttpError(400, cliError(r));
  return r.stdout;
}

async function wpJson<T>(row: WpRow, su: SysUser, dir: string, args: string[], opts: CliOptions = {}): Promise<T> {
  const out = await wpChecked(row, su, dir, [...args, '--format=json'], opts);
  // PHP notices may come before the JSON
  for (const line of out.split('\n').reverse()) {
    const t = line.trim();
    if (!t.startsWith('[') && !t.startsWith('{')) continue;
    try {
      return JSON.parse(t) as T;
    } catch {
      /* next */
    }
  }
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new HttpError(500, 'WP-CLI answered with something unexpected');
  }
}

// ---------------------------------------------------------------------------
// The user's own modules: plugins/<slug>, themes/<slug> — linked into wp-content
// ---------------------------------------------------------------------------
const LINK_SCRIPT = `
cd -- "$1" || exit 1
[ -d wordpress/wp-content ] || exit 0
for kind in plugins themes; do
  mkdir -p "$kind" "wordpress/wp-content/$kind"
  for d in "$kind"/*/; do
    [ -d "$d" ] || continue
    s=$(basename "$d")
    case "$s" in .*) continue ;; esac
    l="wordpress/wp-content/$kind/$s"
    if [ -L "$l" ] || [ ! -e "$l" ]; then ln -sfn "../../../$kind/$s" "$l"; else echo "conflict $kind/$s"; fi
  done
  for l in "wordpress/wp-content/$kind"/*; do
    if [ -L "$l" ] && [ ! -e "$l" ]; then rm -f -- "$l"; fi
  done
done
`;

/** Links every own module into the installation (and removes links whose module is gone). */
async function linkModules(su: SysUser, dir: string): Promise<string[]> {
  const r = await runAs(su, 'sh', ['-c', LINK_SCRIPT, 'sh', dir], { timeoutMs: 30_000 });
  return r.stdout
    .split('\n')
    .filter((l) => l.startsWith('conflict '))
    .map((l) => l.slice(9));
}

function headerOf(text: string, key: string): string {
  const m = new RegExp(`^[ \\t/*#@]*${key}:(.*)$`, 'mi').exec(text);
  return m ? m[1].replace(/\*\/\s*$/, '').trim() : '';
}

interface OwnModule {
  kind: ModuleKind;
  slug: string;
  name: string;
  version: string;
  description: string;
  /** the main file, relative to the project */
  file: string;
  linked: boolean;
}

async function ownModules(su: SysUser, dir: string): Promise<OwnModule[]> {
  const out: OwnModule[] = [];
  for (const kind of MODULE_KINDS) {
    const base = path.join(dir, `${kind}s`);
    const names = await fsp.readdir(base, { withFileTypes: true }).catch(() => []);
    for (const ent of names) {
      if (!ent.isDirectory() || ent.name.startsWith('.') || !EXT_RE.test(ent.name)) continue;
      const slug = ent.name;
      const folder = path.join(base, slug);
      let file = '';
      let head = '';
      if (kind === 'theme') {
        file = 'style.css';
        head = await readOwnedHead(su, path.join(folder, file), 8192);
      } else {
        const php = (await fsp.readdir(folder).catch(() => [] as string[])).filter((f) => f.endsWith('.php')).sort((a, b) => Number(b === `${slug}.php`) - Number(a === `${slug}.php`));
        for (const f of php.slice(0, 20)) {
          const h = await readOwnedHead(su, path.join(folder, f), 8192);
          if (headerOf(h, 'Plugin Name')) {
            file = f;
            head = h;
            break;
          }
        }
      }
      const link = await fsp.lstat(path.join(docrootOf(dir), 'wp-content', `${kind}s`, slug)).catch(() => null);
      out.push({
        kind,
        slug,
        name: headerOf(head, kind === 'theme' ? 'Theme Name' : 'Plugin Name') || slug,
        version: headerOf(head, 'Version') || '',
        description: headerOf(head, 'Description'),
        file: file ? `${kind}s/${slug}/${file}` : `${kind}s/${slug}`,
        linked: !!link?.isSymbolicLink(),
      });
    }
  }
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.slug.localeCompare(b.slug));
}

function toPascal(slug: string): string {
  return slug
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join('');
}

async function walkKit(dirAbs: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const ent of await fsp.readdir(path.join(dirAbs, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...(await walkKit(dirAbs, r)));
    else if (ent.isFile()) out.push(r);
  }
  return out;
}

export interface NewModule {
  kind: ModuleKind;
  slug: string;
  name?: string;
  description?: string;
  author?: string;
  template?: string;
}

/** A new plugin or theme from a starter, in plugins/<slug> or themes/<slug>. */
async function createModule(project: ProjectRow, su: SysUser, dir: string, input: NewModule, authorName: string): Promise<OwnModule> {
  const slug = input.slug.trim().toLowerCase();
  if (!SLUG_RE.test(slug)) throw new HttpError(400, 'The folder name needs 2–50 characters: a–z, 0–9 and - (for example my-plugin)');
  const template = input.template || TEMPLATES[input.kind][0].id;
  if (!TEMPLATES[input.kind].some((t) => t.id === template)) throw new HttpError(400, `unknown starter "${template}" — ${TEMPLATES[input.kind].map((t) => t.id).join(', ')}`);
  const target = path.join(dir, `${input.kind}s`, slug);
  if (await userStat(su, target)) throw new HttpError(409, `${input.kind}s/${slug} already exists`);
  const taken = await fsp.lstat(path.join(docrootOf(dir), 'wp-content', `${input.kind}s`, slug)).catch(() => null);
  if (taken && !taken.isSymbolicLink()) throw new HttpError(409, `WordPress already has a ${input.kind} named "${slug}" — choose another folder name`);
  const src = path.join(kitDir(), `${input.kind}-${template}`);
  const files = await walkKit(src).catch(() => [] as string[]);
  if (!files.length) throw new HttpError(500, `the starter ${input.kind}-${template} is missing in this image`);
  const name = (input.name ?? '').trim() || slug.split('-').map((p) => p[0].toUpperCase() + p.slice(1)).join(' ');
  const v = versioningOf(project);
  const vars: Record<string, string> = {
    NAME: name,
    SLUG: slug,
    DESCRIPTION: (input.description ?? '').trim().replace(/\s+/g, ' ') || `${name} — a WordPress ${input.kind}.`,
    AUTHOR: (input.author ?? '').trim() || authorName,
    PREFIX: slug.replace(/[^a-z0-9]+/g, '_'),
    CONST: slug.replace(/[^a-z0-9]+/g, '_').toUpperCase(),
    CLASS: toPascal(slug),
    VERSION: v.enabled ? v.version : '0.1.0',
    YEAR: String(new Date().getFullYear()),
  };
  const render = (s: string) => s.replace(/\{\{([A-Z]+)\}\}/g, (m, k: string) => vars[k] ?? m);
  for (const rel of files) {
    const data = await fsp.readFile(path.join(src, rel));
    const outRel = rel === 'plugin.php' ? `${slug}.php` : rel;
    const isText = /\.(php|js|json|css|html|txt|md|pot)$/i.test(rel);
    await userWriteFile(su, path.join(target, outRel), isText ? render(data.toString('utf8')) : data);
  }
  await linkModules(su, dir);
  notifyProjectChanged(project.id);
  const made = (await ownModules(su, dir)).find((m) => m.kind === input.kind && m.slug === slug);
  if (!made) throw new HttpError(500, 'the module was written but cannot be read back');
  return made;
}

/** An installable zip of an own module: exports/<slug>-<version>.zip with the folder <slug>/ inside. */
async function exportModule(su: SysUser, dir: string, kind: ModuleKind, slug: string): Promise<{ path: string; size: number; version: string }> {
  if (!EXT_RE.test(slug)) throw new HttpError(400, 'invalid name');
  const mod = (await ownModules(su, dir)).find((m) => m.kind === kind && m.slug === slug);
  if (!mod) throw notFound(`${kind}s/${slug} does not exist`);
  const version = /^[0-9A-Za-z.+-]{1,40}$/.test(mod.version) ? mod.version : '';
  const rel = `exports/${slug}${version ? `-${version}` : ''}.zip`;
  const abs = path.join(dir, rel);
  await userMkdir(su, path.join(dir, 'exports'));
  await userRemove(su, abs).catch(() => {});
  const r = await runAs(
    su,
    'zip',
    ['-q', '-r', '-X', abs, slug, '-x', '*/.git/*', '*/node_modules/*', '*/.DS_Store', '*/.studio/*', '*.log'],
    { cwd: path.join(dir, `${kind}s`), timeoutMs: 120_000 },
  );
  if (r.code !== 0) throw new HttpError(500, `zip failed: ${r.stderr.trim().slice(0, 300)}`);
  const st = await userStat(su, abs);
  return { path: rel, size: st?.size ?? 0, version };
}

// ---------------------------------------------------------------------------
// PHP-FPM of a site
// ---------------------------------------------------------------------------
const DISABLED_FUNCTIONS = [
  'exec', 'passthru', 'shell_exec', 'system', 'proc_open', 'popen', 'pcntl_exec', 'pcntl_fork', 'dl',
  'posix_kill', 'posix_setuid', 'posix_setgid', 'posix_setsid', 'symlink', 'link', 'apache_child_terminate',
];

function fpmConfig(row: WpRow, su: SysUser, dir: string): string {
  const id = row.id;
  const asRoot = process.getuid?.() === 0;
  const up = Math.max(8, config.wordpress.uploadMb);
  const admin: [string, string][] = [
    ['error_log', phpLog(id)],
    ['memory_limit', `${Math.max(64, config.wordpress.memoryMb)}M`],
    ['upload_max_filesize', `${up}M`],
    ['post_max_size', `${up + 8}M`],
    ['max_execution_time', '120'],
    ['max_input_time', '120'],
    ['upload_tmp_dir', tmpDir(id)],
    ['sys_temp_dir', tmpDir(id)],
    ['session.save_path', tmpDir(id)],
    ['cgi.fix_pathinfo', '0'],
  ];
  if (config.wordpress.harden) {
    admin.push(['open_basedir', [`${dir}/`, `${tmpDir(id)}/`, `${runDir(id)}/`, '/usr/share/zoneinfo/'].join(':')]);
    admin.push(['disable_functions', DISABLED_FUNCTIONS.join(',')]);
  }
  return [
    '; written by Everything Studio (wordpress.ts) on every start — changes here are lost',
    '[global]',
    `pid = ${path.join(runtimeDir(id), 'fpm.pid')}`,
    `error_log = ${fpmLog(id)}`,
    'log_level = notice',
    'daemonize = no',
    'emergency_restart_threshold = 0',
    '',
    '[wordpress]',
    ...(asRoot && isolation() ? [`user = ${su.name}`, `group = ${su.name}`] : []),
    `listen = ${sockPath(id)}`,
    'listen.mode = 0600',
    'listen.backlog = 128',
    'pm = ondemand',
    `pm.max_children = ${Math.max(1, Math.min(config.wordpress.maxWorkers, 64))}`,
    'pm.process_idle_timeout = 60s',
    'pm.max_requests = 500',
    'request_terminate_timeout = 300s',
    `chdir = ${docrootOf(dir)}`,
    'catch_workers_output = yes',
    'decorate_workers_output = no',
    'clear_env = yes',
    'security.limit_extensions = .php',
    `env[HOME] = ${su.home}`,
    `env[TMPDIR] = ${tmpDir(id)}`,
    'env[PATH] = /usr/local/bin:/usr/bin:/bin',
    'php_admin_flag[log_errors] = on',
    'php_admin_flag[display_errors] = off',
    'php_admin_flag[allow_url_include] = off',
    ...admin.map(([k, v]) => `php_admin_value[${k}] = ${v}`),
    '',
  ].join('\n');
}

async function prepareRuntime(row: WpRow, su: SysUser, dir: string): Promise<void> {
  const base = runtimeDir(row.id);
  await fsp.mkdir(base, { recursive: true });
  await fsp.chmod(base, 0o755);
  for (const d of [runDir(row.id), tmpDir(row.id)]) {
    const st = await fsp.lstat(d).catch(() => null);
    if (st && !st.isDirectory()) await fsp.rm(d, { force: true });
    await fsp.mkdir(d, { recursive: true });
    if (isolation()) await fsp.chown(d, su.uid, su.gid);
    await fsp.chmod(d, 0o700);
  }
  await fsp.writeFile(confPath(row.id), fpmConfig(row, su, dir), { mode: 0o644 });
  await fsp.rm(sockPath(row.id), { force: true });
}

function fpmLine(row: WpRow, line: string): void {
  const rt = runtime(row.id);
  rt.log.push(line.slice(0, 500));
  if (rt.log.length > 200) rt.log.splice(0, rt.log.length - 200);
}

function socketUp(sock: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(sock);
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
}

async function startFpm(row: WpRow): Promise<void> {
  const avail = wordpressAvailable();
  if (!avail.ok) throw new HttpError(503, avail.reason);
  const rt = runtime(row.id);
  if (rt.child && rt.listening) return;
  const project = await getProjectRow(row.project_id);
  if (!project) throw new HttpError(404, 'the project no longer exists');
  const su = await ensureSysUser(row.owner_id);
  const dir = projectDir(project);
  await prepareRuntime(row, su, dir);
  const asRoot = process.getuid?.() === 0;
  const args = [
    '--nodaemonize',
    '--fpm-config', confPath(row.id),
    '-d', 'expose_php=0',
    // edits of plugins and themes show at once
    '-d', 'opcache.revalidate_freq=0',
    '-d', 'opcache.memory_consumption=96',
  ];
  // without per-user accounts the workers run as the server user — as root only on explicit request
  if (asRoot && !isolation()) args.push('--allow-to-run-as-root');
  const child = spawn(bins.fpm!, args, {
    cwd: runtimeDir(row.id),
    env: { PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', TZ: process.env.TZ ?? 'UTC' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  rt.child = child;
  rt.listening = false;
  rt.stopping = false;
  rt.startedAt = Date.now();
  rt.message = null;
  for (const stream of [child.stdout, child.stderr]) {
    let rest = '';
    stream?.on('data', (d: Buffer) => {
      const parts = (rest + d.toString('utf8')).split('\n');
      rest = parts.pop() ?? '';
      for (const l of parts) if (l.trim()) fpmLine(row, l);
    });
  }
  child.on('error', (err) => fpmLine(row, `could not start PHP: ${err.message}`));
  child.on('close', (code, signal) => {
    if (rt.child !== child) return;
    rt.child = null;
    rt.listening = false;
    if (rt.stopping) {
      rt.stopping = false;
      return;
    }
    fpmLine(row, `PHP stopped unexpectedly (${signal ? `signal ${signal}` : `exit code ${code}`})`);
    rt.crashes = rt.crashes.filter((t) => Date.now() - t < 5 * 60_000);
    rt.crashes.push(Date.now());
    if (rt.crashes.length >= 5) rt.message = 'PHP stopped 5 times within 5 minutes — see the log';
    const cur = rows.get(row.id);
    if (cur) changed(cur);
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (rt.child !== child) throw new HttpError(503, `PHP did not start: ${rt.log.slice(-3).join(' · ') || 'unknown reason'}`);
    if (await socketUp(sockPath(row.id))) {
      rt.listening = true;
      changed(row);
      return;
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  killTree(child, 'SIGKILL');
  throw new HttpError(503, 'PHP did not start in time');
}

/** Starts the PHP of a site when it is not running (one start at a time). */
function ensureStarted(row: WpRow): Promise<void> {
  const rt = runtime(row.id);
  if (rt.child && rt.listening) return Promise.resolve();
  if (!rt.starting) {
    if (rt.crashes.filter((t) => Date.now() - t < 5 * 60_000).length >= 5) {
      return Promise.reject(new HttpError(503, 'PHP keeps stopping — look at the log in the WordPress tab, then press Restart'));
    }
    rt.starting = startFpm(row).finally(() => {
      rt.starting = null;
    });
  }
  return rt.starting;
}

async function stopFpm(id: number): Promise<void> {
  const rt = runtime(id);
  if (rt.starting) await rt.starting.catch(() => {});
  const child = rt.child;
  if (!child) return;
  rt.stopping = true;
  rt.listening = false;
  killTree(child, 'SIGTERM');
  const killer = setTimeout(() => killTree(child, 'SIGKILL'), 5000);
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('close', () => resolve());
  });
  clearTimeout(killer);
  rt.child = null;
}

export function stopAllWordPress(): void {
  for (const rt of runtimes.values()) {
    if (!rt.child) continue;
    rt.stopping = true;
    killTree(rt.child, 'SIGTERM');
  }
}

/** PHP, runtime files and database of a site that no longer exists. */
async function destroyRuntime(row: WpRow): Promise<void> {
  await stopFpm(row.id).catch(() => {});
  runtimes.delete(row.id);
  await dropDatabase(row).catch((err) => console.warn(`[wordpress] database of site ${row.id} not removed: ${(err as Error).message}`));
  await fsp.rm(runtimeDir(row.id), { recursive: true, force: true }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Serving a request
// ---------------------------------------------------------------------------
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authorization', 'proxy-authenticate', 'proxy-connection', 'content-length', 'content-type', 'proxy']);
const MAX_BUFFERED_BODY = 16 * 1024 * 1024;

function denied(p: string): boolean {
  const lower = p.toLowerCase();
  const segs = lower.split('/').filter(Boolean);
  // hidden files and folders (.git, .htaccess, .env …) — except /.well-known/
  if (segs.some((s, i) => s.startsWith('.') && !(i === 0 && s === '.well-known'))) return true;
  if (lower === '/wp-config.php' || lower === '/wp-config-sample.php') return true;
  if (/\.(sql|sql\.gz|log|bak|old|orig|swp|sh|ini|phar|inc)$/.test(lower) || lower.endsWith('~')) return true;
  // uploads and caches hold files visitors and plugins put there: never run them
  if (/^\/wp-content\/(uploads|cache|upgrade|backups?)\//.test(lower) && /\.(php\d?|phtml|pht)(\/|$)/.test(lower)) return true;
  if (/^\/wp-includes\/[^/]+\.php$/.test(lower) && lower !== '/wp-includes/ms-files.php') return true;
  return false;
}

async function sendStatic(req: Request, res: Response, su: SysUser, abs: string, urlPath: string): Promise<boolean> {
  const o = await openOwned(su, abs);
  if (!o) return false;
  const { fh, st } = o;
  const done = () => void fh.close().catch(() => {});
  try {
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    res.setHeader('Content-Type', mimeFor(abs));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', new Date(st.mtimeMs).toUTCString());
    // core files change with WordPress updates only; everything else is checked on each use
    res.setHeader('Cache-Control', /^\/wp-(includes|admin)\//.test(urlPath) ? 'public, max-age=86400' : 'public, no-cache');
    const inm = req.headers['if-none-match'];
    const ims = req.headers['if-modified-since'];
    if ((inm && inm === etag) || (!inm && ims && Date.parse(ims) >= Math.floor(st.mtimeMs / 1000) * 1000)) {
      res.status(304).end();
      done();
      return true;
    }
    let start = 0;
    let end = st.size - 1;
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? '').trim());
    if (m && st.size > 0 && (m[1] || m[2])) {
      if (m[1] === '') {
        start = Math.max(0, st.size - Number(m[2]));
      } else {
        start = Number(m[1]);
        if (m[2] !== '') end = Math.min(Number(m[2]), st.size - 1);
      }
      if (start > end || start >= st.size) {
        res.status(416).setHeader('Content-Range', `bytes */${st.size}`);
        res.end();
        done();
        return true;
      }
      res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
    }
    res.setHeader('Content-Length', String(st.size === 0 ? 0 : end - start + 1));
    if (req.method === 'HEAD' || st.size === 0) {
      res.end();
      done();
      return true;
    }
    const stream = fh.createReadStream({ start, end, autoClose: true });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
    return true;
  } catch {
    done();
    return false;
  }
}

function bufferBody(req: Request, limit: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (d: Buffer) => {
      size += d.length;
      if (size > limit) {
        resolve(null);
        req.destroy();
      } else chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

function fcgiParams(req: Request, root: string, script: string, pathInfo: string): Record<string, string> {
  const url = req.originalUrl || '/';
  const qi = url.indexOf('?');
  const fwdHost = config.trustProxy ? req.headers['x-forwarded-host'] : undefined;
  const host = ((Array.isArray(fwdHost) ? fwdHost[0] : fwdHost)?.split(',')[0] ?? req.headers.host ?? 'localhost').trim();
  const secure = req.secure;
  const portMatch = /:(\d+)$/.exec(host);
  const params: Record<string, string> = {
    GATEWAY_INTERFACE: 'CGI/1.1',
    SERVER_SOFTWARE: 'EverythingStudio',
    SERVER_PROTOCOL: 'HTTP/1.1',
    REQUEST_METHOD: req.method,
    REQUEST_URI: url,
    QUERY_STRING: qi >= 0 ? url.slice(qi + 1) : '',
    SCRIPT_FILENAME: path.join(root, script),
    SCRIPT_NAME: script,
    DOCUMENT_URI: script + pathInfo,
    DOCUMENT_ROOT: root,
    REMOTE_ADDR: (req.ip ?? req.socket.remoteAddress ?? '').replace(/^::ffff:/, ''),
    REMOTE_PORT: String(req.socket.remotePort ?? 0),
    SERVER_ADDR: '127.0.0.1',
    SERVER_NAME: host.replace(/:\d+$/, ''),
    SERVER_PORT: portMatch ? portMatch[1] : secure ? '443' : '80',
    REDIRECT_STATUS: '200',
    HTTP_HOST: host,
  };
  if (pathInfo) params.PATH_INFO = pathInfo;
  if (secure) params.HTTPS = 'on';
  if (req.headers['content-type']) params.CONTENT_TYPE = String(req.headers['content-type']);
  if (req.headers['content-length']) params.CONTENT_LENGTH = String(req.headers['content-length']);
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_HEADERS.has(name) || name === 'host') continue;
    // names with "_" cannot be told apart from "-" afterwards; forwarded-for headers come from us
    if (name.includes('_') || name.startsWith('x-forwarded-') || name === 'x-real-ip' || name === 'forwarded') continue;
    let v = Array.isArray(value) ? value.join(', ') : value;
    if (name === 'cookie') {
      v = v
        .split(';')
        .map((c) => c.trim())
        .filter((c) => c && !c.startsWith(`${SESSION_COOKIE}=`))
        .join('; ');
      if (!v) continue;
    }
    params[`HTTP_${name.toUpperCase().replace(/-/g, '_')}`] = v;
  }
  return params;
}

async function runPhp(req: Request, res: Response, row: WpRow, root: string, script: string, pathInfo: string): Promise<void> {
  const params = fcgiParams(req, root, script, pathInfo);
  let body: Readable | null = null;
  const hasLength = req.headers['content-length'] !== undefined;
  const chunkedBody = !hasLength && req.headers['transfer-encoding'] !== undefined;
  const limit = (Math.max(8, config.wordpress.uploadMb) + 16) * 1024 * 1024;
  if (hasLength) {
    if (Number(req.headers['content-length']) > limit) {
      res.setHeader('Connection', 'close');
      return page(res, 413, 'Too large', `Uploads are limited to ${config.wordpress.uploadMb} MB on this server.`);
    }
    if (Number(req.headers['content-length']) > 0) body = req;
  } else if (chunkedBody) {
    // PHP needs the length up front
    const buf = await bufferBody(req, MAX_BUFFERED_BODY);
    if (!buf) return page(res, 413, 'Too large', 'The request is too large.');
    params.CONTENT_LENGTH = String(buf.length);
    body = Readable.from([buf]);
  }
  let r;
  try {
    r = await fcgiRequest(sockPath(row.id), params, body, { timeoutMs: 310_000, maxBodyBytes: limit });
  } catch (err) {
    const e = err as FcgiError;
    if (res.headersSent) return void res.destroy();
    if (e.code === 'body-too-large') return page(res, 413, 'Too large', `Uploads are limited to ${config.wordpress.uploadMb} MB on this server.`);
    if (e.code === 'timeout') return page(res, 504, 'Timeout', 'The website took too long to answer.');
    if (e.code === 'connect') runtime(row.id).listening = false;
    return page(res, 502, 'Website not available', 'The website could not answer this request. Try again in a moment.');
  }
  res.status(r.status);
  const cookies: string[] = [];
  for (const [name, value] of r.headers) {
    const lower = name.toLowerCase();
    if (lower === 'x-powered-by' || lower === 'connection' || lower === 'keep-alive' || lower === 'transfer-encoding') continue;
    if (/[\r\n]/.test(value)) continue;
    if (lower === 'set-cookie') cookies.push(value);
    else {
      try {
        res.setHeader(name, value);
      } catch {
        /* a header name PHP made up */
      }
    }
  }
  if (cookies.length) res.setHeader('Set-Cookie', cookies);
  r.body.on('error', () => res.destroy());
  res.on('close', () => r.body.destroy());
  if (req.method === 'HEAD') {
    r.body.resume();
    res.end();
    return;
  }
  r.body.pipe(res);
}

async function serve(req: Request, res: Response, projectId: number, ownerId: number): Promise<void> {
  const row = rowOfProject(projectId);
  if (!row || row.owner_id !== ownerId) return page(res, 404, 'No website here', 'There is no website at this address.');
  if (row.state === 'installing') return page(res, 503, 'WordPress is being set up', 'This website is being installed. Try again in a minute.');
  if (row.state !== 'ready') return page(res, 503, 'Website not set up', 'This website has not been set up yet.');
  if (row.desired !== 'running') return page(res, 503, 'Website offline', 'This website is switched off at the moment.');
  const project = await getProjectRow(projectId);
  if (!project) return page(res, 404, 'No website here', 'There is no website at this address.');
  const su = await ensureSysUser(ownerId);
  const root = docrootOf(projectDir(project));
  const rt = runtime(row.id);
  rt.lastRequestAt = Date.now();

  const rawPath = (req.originalUrl || '/').split('?')[0];
  let p: string;
  try {
    p = decodeURIComponent(rawPath);
  } catch {
    return page(res, 400, 'Bad request', 'This address is not valid.');
  }
  if (p.includes('\0') || p.includes('\\')) return page(res, 400, 'Bad request', 'This address is not valid.');
  p = path.posix.normalize(p.startsWith('/') ? p : `/${p}`);
  if (p.startsWith('/..')) return page(res, 400, 'Bad request', 'This address is not valid.');
  if (denied(p)) return page(res, 403, 'Not allowed', 'This file is not public.');

  let script = '';
  let pathInfo = '';
  const abs = path.join(root, p);
  const st = await fsp.stat(abs).catch(() => null);
  if (st?.isDirectory()) {
    if (!rawPath.endsWith('/')) {
      const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
      res.redirect(301, `${rawPath}/${qs}`);
      return;
    }
    if ((await fsp.stat(path.join(abs, 'index.php')).catch(() => null))?.isFile()) script = path.posix.join(p, 'index.php');
    else if (await sendStatic(req, res, su, path.join(abs, 'index.html'), p)) return;
  } else if (st?.isFile()) {
    if (/\.php$/i.test(p)) script = p;
    else if (req.method === 'GET' || req.method === 'HEAD') {
      if (await sendStatic(req, res, su, abs, p)) return;
    }
  } else {
    // /index.php/path/info
    const m = /^(.+?\.php)(\/.*)$/i.exec(p);
    if (m && (await fsp.stat(path.join(root, m[1])).catch(() => null))?.isFile() && !denied(m[1])) {
      script = m[1];
      pathInfo = m[2];
    }
  }
  // everything else is WordPress' own business (pretty permalinks, its 404 page)
  if (!script) script = '/index.php';

  try {
    await ensureStarted(row);
  } catch (err) {
    return page(res, 503, 'Website not available', err instanceof HttpError ? err.message : 'The website could not be started.');
  }
  await runPhp(req, res, row, root, script, pathInfo);
}

// ---------------------------------------------------------------------------
// Scheduled tasks (wp-cron) and idle shutdown
// ---------------------------------------------------------------------------
async function runCron(row: WpRow): Promise<void> {
  const rt = runtime(row.id);
  rt.lastCronAt = Date.now();
  const project = await getProjectRow(row.project_id);
  const site = siteHostsOfProject(row.project_id);
  if (!project || !site) return;
  const root = docrootOf(projectDir(project));
  await ensureStarted(row);
  const u = new URL(site.primary);
  const r = await fcgiRequest(
    sockPath(row.id),
    {
      GATEWAY_INTERFACE: 'CGI/1.1',
      SERVER_SOFTWARE: 'EverythingStudio',
      SERVER_PROTOCOL: 'HTTP/1.1',
      REQUEST_METHOD: 'GET',
      REQUEST_URI: '/wp-cron.php?doing_wp_cron',
      QUERY_STRING: 'doing_wp_cron',
      SCRIPT_FILENAME: path.join(root, 'wp-cron.php'),
      SCRIPT_NAME: '/wp-cron.php',
      DOCUMENT_URI: '/wp-cron.php',
      DOCUMENT_ROOT: root,
      REMOTE_ADDR: '127.0.0.1',
      REMOTE_PORT: '0',
      SERVER_ADDR: '127.0.0.1',
      SERVER_NAME: u.hostname,
      SERVER_PORT: u.port || (u.protocol === 'https:' ? '443' : '80'),
      REDIRECT_STATUS: '200',
      HTTP_HOST: u.host,
      ...(u.protocol === 'https:' ? { HTTPS: 'on' } : {}),
    },
    null,
    { timeoutMs: 300_000 },
  );
  r.body.on('error', () => {});
  r.body.resume();
}

let cronBusy = false;
async function housekeeping(): Promise<void> {
  if (cronBusy) return;
  cronBusy = true;
  try {
    const now = Date.now();
    const idleMs = config.wordpress.idleMinutes * 60_000;
    for (const row of [...rows.values()]) {
      if (row.state !== 'ready') continue;
      const rt = runtime(row.id);
      if (row.desired === 'running' && !rt.busy) {
        // visited sites: every 10 minutes; sleeping ones: every 6 hours (scheduled posts, update checks)
        const active = rt.lastRequestAt > now - 3600_000;
        if (now - rt.lastCronAt > (active ? 10 * 60_000 : 6 * 3600_000)) {
          if (!rt.lastCronAt && !active) rt.lastCronAt = now - 5.5 * 3600_000; // not all at once after a restart
          else await runCron(row).catch(() => {});
        }
      }
      if (rt.child && idleMs > 0 && !rt.busy && now - Math.max(rt.lastRequestAt, rt.lastCronAt, rt.startedAt ?? 0) > idleMs) {
        await stopFpm(row.id).catch(() => {});
        changed(row);
      }
    }
  } finally {
    cronBusy = false;
  }
}

// ---------------------------------------------------------------------------
// Installing and removing
// ---------------------------------------------------------------------------
export interface InstallInput {
  title?: string;
  adminUser?: string;
  adminEmail?: string;
  adminPassword?: string;
  locale?: string;
}

async function setState(row: WpRow, patch: Partial<Pick<WpRow, 'state' | 'last_error' | 'desired'>> & { settings?: WpSettings; info?: WpInfo; installed?: boolean }): Promise<WpRow> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.state !== undefined) (sets.push('state = ?'), vals.push(patch.state));
  if (patch.last_error !== undefined) (sets.push('last_error = ?'), vals.push(patch.last_error));
  if (patch.desired !== undefined) (sets.push('desired = ?'), vals.push(patch.desired));
  if (patch.settings !== undefined) (sets.push('settings = ?'), vals.push(JSON.stringify(patch.settings)));
  if (patch.info !== undefined) (sets.push('info = ?'), vals.push(JSON.stringify(patch.info)));
  if (patch.installed) sets.push('installed_at = UTC_TIMESTAMP(3)');
  if (sets.length) await exec(`UPDATE wordpress_sites SET ${sets.join(', ')} WHERE id = ?`, [...vals, row.id]);
  const fresh = await reloadRow(row.id);
  changed(fresh);
  return fresh;
}

async function refreshInfo(row: WpRow, su: SysUser, dir: string): Promise<WpRow> {
  const r = await wpCli(row, su, dir, ['core', 'version']);
  const version = r.code === 0 ? r.stdout.trim().split('\n').pop()?.trim() : undefined;
  if (version && version !== row.info?.version) return setState(row, { info: { ...(row.info ?? {}), version } });
  return row;
}

async function doInstall(project: ProjectRow, row: WpRow, input: Required<InstallInput>): Promise<void> {
  const su = await ensureSysUser(project.owner_id);
  const dir = projectDir(project);
  const root = docrootOf(dir);
  const rt = runtime(row.id);
  rt.job = [];
  rt.crashes = [];
  try {
    row = await setState(row, { state: 'installing', last_error: null, settings: { title: input.title, locale: input.locale, adminUser: input.adminUser, adminEmail: input.adminEmail, debug: false } });
    const site = await ensureWordPressSite(project);
    job(row, `Website: ${site.addresses.primary}`);

    if (!(await userStat(su, path.join(root, 'wp-load.php')))?.isFile) {
      job(row, `▸ Downloading WordPress (${input.locale}) from wordpress.org …`);
      await userMkdir(su, root);
      const dl = await wpCli(row, su, dir, ['core', 'download', `--locale=${input.locale}`, '--force'], { timeoutMs: 10 * 60_000, safe: false });
      if (dl.code !== 0) throw new Error(`the download failed — ${cliError(dl)} (the server needs internet access to wordpress.org)`);
    } else job(row, '▸ WordPress files are already there');

    job(row, '▸ Creating the database …');
    await ensureDatabase(row);

    if (!(await userStat(su, path.join(root, 'wp-config.php')))?.isFile) {
      await userWriteFile(su, path.join(root, 'wp-config.php'), wpConfig(row));
      await runAs(su, 'chmod', ['600', path.join(root, 'wp-config.php')]);
    }
    const mu = await fsp.readFile(path.join(kitDir(), 'mu-plugin.php'), 'utf8');
    await userWriteFile(su, path.join(root, 'wp-content', 'mu-plugins', 'everything-studio.php'), mu);

    const installed = await wpCli(row, su, dir, ['core', 'is-installed']);
    if (installed.code !== 0) {
      job(row, '▸ Setting up the site …');
      const r = await wpCli(
        row,
        su,
        dir,
        ['core', 'install', `--title=${input.title}`, `--admin_user=${input.adminUser}`, `--admin_email=${input.adminEmail}`, `--locale=${input.locale}`, '--skip-email', '--prompt=admin_password'],
        { input: `${input.adminPassword}\n`, timeoutMs: 5 * 60_000, safe: false },
      );
      if (r.code !== 0) throw new Error(cliError(r));
      await wpCli(row, su, dir, ['rewrite', 'structure', '/%postname%/']);
      await wpCli(row, su, dir, ['plugin', 'delete', 'hello']);
      if (input.locale !== 'en_US') await wpCli(row, su, dir, ['language', 'core', 'install', input.locale, '--activate'], { timeoutMs: 5 * 60_000 });
    } else job(row, '▸ The site is already set up');

    const conflicts = await linkModules(su, dir);
    for (const c of conflicts) job(row, `Note: ${c} is not linked — WordPress already has a folder with that name`);
    row = await setState(row, { state: 'ready', desired: 'running', installed: true });
    row = await refreshInfo(row, su, dir);
    await ensureStarted(row).catch((err: Error) => job(row, `Note: ${err.message}`));
    siteStateChanged(project.id);
    notifyProjectChanged(project.id);
    job(row, `✓ WordPress ${row.info?.version ?? ''} is ready — ${site.addresses.primary}`);
  } catch (err) {
    const msg = (err as Error).message.slice(0, 1000);
    job(row, `✗ ${msg}`);
    await setState(row, { state: 'error', last_error: msg }).catch(() => {});
  }
}

async function createRow(project: ProjectRow): Promise<WpRow> {
  const existing = rowOfProject(project.id) ?? (await q1<WpRow>('SELECT * FROM wordpress_sites WHERE project_id = ?', [project.id]));
  if (existing) return cache(existing);
  const n = Number((await q1<{ n: number }>('SELECT COUNT(*) AS n FROM wordpress_sites WHERE owner_id = ?', [project.owner_id]))?.n ?? 0);
  if (n >= config.wordpress.maxPerUser) throw new HttpError(429, `You already have ${n} WordPress sites (limit ${config.wordpress.maxPerUser}). Remove one first.`);
  const { insertId } = await exec('INSERT INTO wordpress_sites (owner_id, project_id, settings) VALUES (?, ?, ?)', [project.owner_id, project.id, JSON.stringify({})]);
  const prefix = config.db.database.replace(/[^A-Za-z0-9_]/g, '').slice(0, 24) || 'studio';
  await exec('UPDATE wordpress_sites SET db_name = ?, db_user = ?, db_pass_enc = ?, login_secret_enc = ? WHERE id = ?', [
    `${prefix}_wp_${insertId}`,
    `${prefix}_wp_${insertId}`.slice(0, 32),
    encryptSecret(randomToken(24)),
    encryptSecret(randomToken(32)),
    insertId,
  ]);
  return reloadRow(insertId);
}

/** Removes the installation: PHP, database, website and the wordpress/ folder. Own modules stay. */
async function uninstall(project: ProjectRow, row: WpRow): Promise<void> {
  const su = await ensureSysUser(project.owner_id);
  const dir = projectDir(project);
  await stopFpm(row.id).catch(() => {});
  await exec('DELETE FROM wordpress_sites WHERE id = ?', [row.id]);
  forget(row.id);
  await destroyRuntime(row);
  await deleteSiteOfProject(project.id).catch(() => {});
  await userRemove(su, docrootOf(dir)).catch(() => {});
  notifyProjectChanged(project.id);
  publish(`project:${project.id}`, { t: 'wordpress.changed', projectId: project.id });
}

hooks.onProjectDeleted(async (projectId: number) => {
  const row = rowOfProject(projectId) ?? (await q1<WpRow>('SELECT * FROM wordpress_sites WHERE project_id = ?', [projectId]));
  if (!row) return;
  await exec('DELETE FROM wordpress_sites WHERE id = ?', [row.id]);
  forget(row.id);
  await destroyRuntime(row);
});

// ---------------------------------------------------------------------------
// One-click sign-in
// ---------------------------------------------------------------------------
function loginUrl(row: WpRow, login: string, to: string): string {
  const site = siteHostsOfProject(row.project_id);
  if (!site || !row.login_secret_enc) throw new HttpError(409, 'WordPress is not set up yet');
  const payload = Buffer.from(JSON.stringify({ u: login, e: Math.floor(Date.now() / 1000) + 90, n: randomToken(9), t: to })).toString('base64url');
  const sig = crypto.createHmac('sha256', decryptSecret(row.login_secret_enc)).update(payload).digest('base64url');
  return `${site.primary}?studio-login=${payload}.${sig}`;
}

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------
export async function initWordPress(): Promise<void> {
  bins.wp = await which('wp');
  bins.php = await which('php');
  const sbin = await fsp.readdir('/usr/sbin').catch(() => [] as string[]);
  const fpm = sbin.filter((f) => /^php-fpm[\d.]*$/.test(f)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  bins.fpm = fpm ? path.join('/usr/sbin', fpm) : await which('php-fpm');
  if (bins.php) {
    const v = await run(bins.php, ['-r', 'echo PHP_VERSION;'], { timeoutMs: 15_000 }).catch(() => null);
    bins.phpVersion = v?.code === 0 ? v.stdout.trim() : '';
  }
  setWordPressBackend({
    ready: (projectId) => {
      const row = rowOfProject(projectId);
      return !!row && row.state === 'ready' && row.desired === 'running';
    },
    http: (req, res, projectId, ownerId) => {
      serve(req, res, projectId, ownerId).catch((err) => {
        console.error('[wordpress]', err);
        if (!res.headersSent) page(res, 500, 'Error', 'Something went wrong.');
        else res.destroy();
      });
    },
  });
  const avail = wordpressAvailable();
  if (!avail.ok) {
    console.log(`[wordpress] not available: ${avail.reason}`);
    return;
  }
  await fsp.mkdir(config.wordpressDir, { recursive: true });
  if (isolation()) await fsp.chmod(config.wordpressDir, 0o711);
  await reloadAll();
  // an installation that was interrupted by a restart can simply be started again
  for (const row of rows.values()) {
    if (row.state === 'installing') await setState(row, { state: 'error', last_error: 'The Studio restarted during the installation — press "Install" again to finish it.' }).catch(() => {});
  }
  // accounts of the sites' databases (a restored database volume has none)
  for (const row of rows.values()) {
    if (row.state === 'ready') await ensureDatabase(row).catch((err) => console.warn(`[wordpress] database of site ${row.id}: ${(err as Error).message}`));
  }
  // runtime folders of sites that no longer exist
  for (const name of await fsp.readdir(config.wordpressDir).catch(() => [] as string[])) {
    const id = /^\d+$/.test(name) ? Number(name) : NaN;
    if (Number.isInteger(id) && !rows.has(id)) await fsp.rm(path.join(config.wordpressDir, name), { recursive: true, force: true }).catch(() => {});
  }
  console.log(`[wordpress] PHP ${bins.phpVersion} (${path.basename(bins.fpm!)}), WP-CLI — ${rows.size} site${rows.size === 1 ? '' : 's'}`);
  setInterval(() => void housekeeping().catch(() => {}), 60_000).unref();
  setInterval(() => void reloadAll().catch(() => {}), 5 * 60_000).unref();
}

/** For the AI's instructions (claude/prompt.ts). */
export function wordpressPrompt(project: ProjectRow): string[] {
  if (project.area !== 'wordpress' && !rowOfProject(project.id)) return [];
  const avail = wordpressAvailable();
  if (!avail.ok) return ['## WordPress', `- ${avail.reason}.`, ''];
  const row = rowOfProject(project.id);
  const site = siteOfProjectSync(project.id);
  const port = config.sites.listenPort;
  return [
    '## WordPress — this project is a real WordPress site',
    row?.state === 'ready'
      ? `WordPress ${row.info?.version ?? ''} is installed in \`wordpress/\` (PHP ${bins.phpVersion}) and live at ${site?.addresses.primary ?? '(no address yet)'}.`
      : 'WordPress is NOT installed yet — the user sets it up in the project\'s WordPress tab (title, admin account). You can already write plugins and themes; they are linked in as soon as it is installed.',
    '- Your own code lives in `plugins/<slug>/` and `themes/<slug>/` at the project root (versioned in git). Start one with `studio wp new plugin|theme <slug> --name "…" [--template basic|settings|block|rest  ·  block|classic]`; it is linked into `wordpress/wp-content/` automatically (`studio wp link` after creating a folder by hand).',
    '- Never edit files inside `wordpress/` (core, installed plugins) — they are replaced by updates and are not versioned. Change behaviour with hooks in an own plugin or a child theme.',
    '- WP-CLI works in `wordpress/`: `cd wordpress && wp plugin activate <slug>`, `wp theme activate <slug>`, `wp plugin install <name> --activate`, `wp option get …`, `wp post create …`, `wp eval \'…\'`, `wp db query "…"`. After activating, check for errors.',
    `- Look at the result yourself: \`curl -sI -H "Host: ${site?.internal.host ?? '<name>.localhost'}" http://127.0.0.1:${port}/\`, \`studio-browser shot http://${site?.internal.host ?? '<name>.localhost'}:${port}/ --out .studio/site.png\`; for admin pages first \`studio wp login-url [--to /wp-admin/plugins.php]\` and open that address. PHP errors: \`studio wp log\` (switch notices on with \`wp config set WP_DEBUG true --raw\` in wordpress/).`,
    '- Code rules: prefix every function, class, option and hook with the module\'s prefix; escape output (`esc_html`, `esc_attr`, `esc_url`, `wp_kses_post`), sanitize input, check nonces and capabilities on every form and AJAX/REST handler; prepare SQL (`$wpdb->prepare`); load scripts/styles with `wp_enqueue_*`; make strings translatable (`__( \'…\', \'<text-domain>\' )`); no shell functions (they are disabled for the site\'s PHP).',
    '- Deliverable: `studio wp export <slug>` writes an installable zip to exports/ (the folder `<slug>/` inside, version from the header) — the user installs it on any WordPress. Keep the `Version:` header in step with the project version.',
    '- `studio wp status` shows the state, addresses and the own modules. The user manages the site in the WordPress tab (open the site/admin, plugins, themes, updates, database export) and its domains + HTTPS in the Website tab.',
    '',
  ];
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export const wordpressRouter = Router();

async function context(req: Request) {
  const c = await loadOwnedProject(req.user!, intParam(req.params.id));
  return { ...c, row: rowOfProject(c.project.id) };
}

async function readyContext(req: Request) {
  const c = await context(req);
  if (!c.row || c.row.state !== 'ready') throw new HttpError(409, 'WordPress is not installed in this project yet');
  return { ...c, row: c.row };
}

async function statusOf(project: ProjectRow, su: SysUser, dir: string) {
  const row = rowOfProject(project.id);
  const avail = wordpressAvailable();
  return {
    available: avail.ok,
    reason: avail.reason,
    wordpress: row ? publicWordPress(row) : null,
    site: siteOfProjectSync(project.id),
    modules: await ownModules(su, dir),
    templates: TEMPLATES,
    limits: { uploadMb: config.wordpress.uploadMb, memoryMb: config.wordpress.memoryMb, hardened: config.wordpress.harden },
    baseDomain: config.sites.baseDomain || null,
  };
}

wordpressRouter.get('/projects/:id/wordpress', async (req, res) => {
  const { project, su, dir } = await context(req);
  res.json(await statusOf(project, su, dir));
});

const installBody = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  adminUser: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_.@-]{3,60}$/, 'user name: 3–60 characters (letters, digits, . _ - @)')
    .optional(),
  adminEmail: z.string().trim().email().max(200).optional(),
  adminPassword: z.string().min(8, 'the password needs at least 8 characters').max(200).optional(),
  locale: z.string().trim().regex(LOCALE_RE, 'language code like en_US or de_DE').optional(),
});

wordpressRouter.post('/projects/:id/wordpress/install', async (req, res) => {
  const { project } = await context(req);
  const avail = wordpressAvailable();
  if (!avail.ok) throw new HttpError(503, avail.reason);
  const body = parse(installBody, req.body ?? {});
  const row = await createRow(project);
  if (row.state === 'ready') throw new HttpError(409, 'WordPress is already installed in this project');
  if (row.state === 'installing' || runtime(row.id).busy) throw new HttpError(409, 'The installation is running');
  const generated = !body.adminPassword;
  const input: Required<InstallInput> = {
    title: body.title ?? project.name,
    adminUser: body.adminUser ?? req.user!.username,
    adminEmail: body.adminEmail ?? req.user!.email,
    adminPassword: body.adminPassword ?? randomToken(12),
    locale: body.locale ?? 'en_US',
  };
  void serialize(row, () => doInstall(project, row, input)).catch(() => {});
  res.status(202).json({
    wordpress: publicWordPress(rows.get(row.id) ?? row),
    // shown once: the Studio does not keep the password
    adminPassword: generated ? input.adminPassword : null,
    adminUser: input.adminUser,
  });
});

for (const action of ['start', 'stop', 'restart'] as const) {
  wordpressRouter.post(`/projects/:id/wordpress/${action}`, async (req, res) => {
    const { project, su, dir, row } = await readyContext(req);
    const rt = runtime(row.id);
    if (action !== 'start') await stopFpm(row.id);
    rt.crashes = [];
    rt.message = null;
    let fresh = row;
    if (action === 'stop') fresh = await setState(row, { desired: 'stopped' });
    else {
      fresh = await setState(row, { desired: 'running' });
      await linkModules(su, dir).catch(() => {});
      await ensureStarted(fresh);
    }
    siteStateChanged(project.id);
    res.json({ wordpress: publicWordPress(fresh) });
  });
}

wordpressRouter.post('/projects/:id/wordpress/login', async (req, res) => {
  const { su, dir, row } = await readyContext(req);
  const body = parse(z.object({ to: z.string().max(300).regex(/^\/[^\s]*$/).optional() }), req.body ?? {});
  let login = row.settings?.adminUser ?? '';
  // the admin of the installation may have been renamed or removed since
  const admins = await wpJson<{ user_login: string }[]>(row, su, dir, ['user', 'list', '--role=administrator', '--fields=user_login']).catch(() => []);
  if (!admins.some((a) => a.user_login === login)) login = admins[0]?.user_login ?? '';
  if (!login) throw new HttpError(409, 'This WordPress has no administrator account');
  res.json({ url: loginUrl(row, login, body.to ?? '/wp-admin/'), user: login });
});

interface CliPlugin {
  name: string;
  title?: string;
  status: string;
  version: string;
  update: string;
  update_version?: string;
  description?: string;
}

wordpressRouter.get('/projects/:id/wordpress/extensions', async (req, res) => {
  const { su, dir, row } = await readyContext(req);
  await linkModules(su, dir).catch(() => {});
  const own = await ownModules(su, dir);
  const isOwn = (kind: ModuleKind, slug: string) => own.some((m) => m.kind === kind && m.slug === slug && m.linked);
  const [plugins, themes] = await Promise.all([
    wpJson<CliPlugin[]>(row, su, dir, ['plugin', 'list', '--fields=name,title,status,version,update,update_version,description']),
    wpJson<CliPlugin[]>(row, su, dir, ['theme', 'list', '--fields=name,title,status,version,update,update_version']),
  ]);
  const shape = (kind: ModuleKind) => (p: CliPlugin) => ({
    kind,
    slug: p.name,
    name: (p.title || p.name).replace(/<[^>]+>/g, ''),
    status: p.status,
    version: p.version || '',
    update: p.update === 'available' ? p.update_version || 'available' : null,
    description: (p.description ?? '').replace(/<[^>]+>/g, '').slice(0, 300),
    own: isOwn(kind, p.name),
  });
  res.json({
    plugins: plugins.filter((p) => p.status !== 'must-use' && p.status !== 'dropin').map(shape('plugin')),
    themes: themes.map(shape('theme')),
  });
});

const extBody = z.object({
  kind: z.enum(MODULE_KINDS),
  action: z.enum(['activate', 'deactivate', 'delete', 'update', 'install']),
  slug: z.string().regex(EXT_RE),
  activate: z.boolean().optional(),
});

wordpressRouter.post('/projects/:id/wordpress/extensions', async (req, res) => {
  const { project, su, dir, row } = await readyContext(req);
  const body = parse(extBody, req.body);
  const own = (await ownModules(su, dir)).some((m) => m.kind === body.kind && m.slug === body.slug);
  if (own && (body.action === 'delete' || body.action === 'update' || body.action === 'install')) {
    throw new HttpError(400, `"${body.slug}" is one of your own ${body.kind}s — its files are in ${body.kind}s/${body.slug}/ of the project`);
  }
  if (body.kind === 'theme' && body.action === 'deactivate') throw new HttpError(400, 'Activate another theme instead');
  const args = [body.kind, body.action, body.slug];
  if (body.action === 'install' && body.activate) args.push('--activate');
  // activating needs the other plugins loaded (a plugin may build on another one); when one of
  // them is broken, the bare mode still works
  const needsOthers = body.action === 'activate' || (body.action === 'install' && !!body.activate);
  const out = await serialize(row, async () => {
    if (needsOthers) {
      const r = await wpCli(row, su, dir, args, { timeoutMs: 5 * 60_000, safe: false });
      if (r.code === 0) return r.stdout;
      const again = await wpCli(row, su, dir, args, { timeoutMs: 5 * 60_000 });
      if (again.code === 0) return again.stdout;
      throw new HttpError(400, cliError(r));
    }
    return wpChecked(row, su, dir, args, { timeoutMs: 5 * 60_000 });
  });
  notifyProjectChanged(project.id);
  res.json({ ok: true, message: out.trim().split('\n').slice(-2).join(' ').slice(0, 400) });
});

wordpressRouter.get('/projects/:id/wordpress/search', async (req, res) => {
  const { su, dir, row } = await readyContext(req);
  const kind = req.query.kind === 'theme' ? 'theme' : 'plugin';
  const term = String(req.query.q ?? '').trim().slice(0, 80);
  if (term.length < 2) return void res.json({ results: [] });
  // the search term is one argument (no shell); "--" would be read as an option
  const safe = term.replace(/^-+/, '');
  const fields = kind === 'plugin' ? 'name,slug,version,rating,active_installs,short_description,tested' : 'name,slug,version,rating';
  const list = await wpJson<Record<string, unknown>[]>(row, su, dir, [kind, 'search', safe, '--per-page=12', `--fields=${fields}`], { timeoutMs: 60_000 });
  res.json({
    results: list.map((r) => ({
      kind,
      slug: String(r.slug ?? ''),
      name: String(r.name ?? r.slug ?? '').replace(/<[^>]+>/g, ''),
      version: String(r.version ?? ''),
      rating: Number(r.rating ?? 0),
      installs: Number(r.active_installs ?? 0),
      description: String(r.short_description ?? '').replace(/<[^>]+>/g, '').slice(0, 240),
      tested: String(r.tested ?? ''),
    })),
  });
});

const moduleBody = z.object({
  kind: z.enum(MODULE_KINDS),
  slug: z.string().trim().toLowerCase().regex(SLUG_RE, 'folder name: 2–50 characters, a–z, 0–9 and -'),
  name: z.string().trim().max(100).optional(),
  description: z.string().trim().max(400).optional(),
  author: z.string().trim().max(100).optional(),
  template: z.string().trim().max(32).optional(),
  activate: z.boolean().optional(),
});

wordpressRouter.post('/projects/:id/wordpress/modules', async (req, res) => {
  const { project, su, dir, row } = await context(req);
  const body = parse(moduleBody, req.body);
  const mod = await createModule(project, su, dir, body, req.user!.display_name || req.user!.username);
  let activated = false;
  if (body.activate && row?.state === 'ready') {
    activated = (await wpCli(row, su, dir, [body.kind, 'activate', body.slug])).code === 0;
  }
  res.status(201).json({ module: mod, activated });
});

wordpressRouter.post('/projects/:id/wordpress/modules/export', async (req, res) => {
  const { project, su, dir } = await context(req);
  const body = parse(z.object({ kind: z.enum(MODULE_KINDS), slug: z.string().regex(EXT_RE) }), req.body);
  const out = await exportModule(su, dir, body.kind, body.slug);
  notifyProjectChanged(project.id);
  res.json(out);
});

wordpressRouter.delete('/projects/:id/wordpress/modules/:kind/:slug', async (req, res) => {
  const { project, su, dir, row } = await context(req);
  const kind = parse(z.enum(MODULE_KINDS), req.params.kind);
  const slug = parse(z.string().regex(EXT_RE), req.params.slug);
  if (!(await ownModules(su, dir)).some((m) => m.kind === kind && m.slug === slug)) throw notFound(`${kind}s/${slug} does not exist`);
  if (row?.state === 'ready' && kind === 'plugin') await wpCli(row, su, dir, ['plugin', 'deactivate', slug]).catch(() => {});
  await userRemove(su, path.join(dir, `${kind}s`, slug));
  await linkModules(su, dir).catch(() => {});
  notifyProjectChanged(project.id);
  res.json({ ok: true });
});

wordpressRouter.post('/projects/:id/wordpress/link', async (req, res) => {
  const { su, dir } = await context(req);
  res.json({ conflicts: await linkModules(su, dir), modules: await ownModules(su, dir) });
});

wordpressRouter.post('/projects/:id/wordpress/debug', async (req, res) => {
  const { su, dir, row } = await readyContext(req);
  const body = parse(z.object({ enabled: z.boolean() }), req.body);
  await wpChecked(row, su, dir, ['config', 'set', 'WP_DEBUG', body.enabled ? 'true' : 'false', '--raw']);
  const fresh = await setState(row, { settings: { ...(row.settings ?? {}), debug: body.enabled } });
  res.json({ wordpress: publicWordPress(fresh) });
});

wordpressRouter.get('/projects/:id/wordpress/log', async (req, res) => {
  const { su, row } = await context(req);
  if (!row) return void res.json({ php: '', fpm: [] });
  const text = await readOwnedTail(su, phpLog(row.id), 64 * 1024);
  const fpm = await fsp
    .readFile(fpmLog(row.id), 'utf8')
    .then((t) => t.split('\n').slice(-40))
    .catch(() => [] as string[]);
  // of PHP-FPM itself only what went wrong (its start and stop notices are no errors)
  const trouble = (l: string) => !!l.trim() && !l.includes('] NOTICE:');
  res.json({ php: text.split('\n').slice(-300).join('\n'), fpm: [...fpm.filter(trouble), ...runtime(row.id).log.filter(trouble).slice(-20)] });
});

wordpressRouter.delete('/projects/:id/wordpress/log', async (req, res) => {
  const { su, row } = await context(req);
  if (row) await runAs(su, 'sh', ['-c', ': > "$1"', 'sh', phpLog(row.id)]).catch(() => {});
  res.json({ ok: true });
});

wordpressRouter.post('/projects/:id/wordpress/password', async (req, res) => {
  const { su, dir, row } = await readyContext(req);
  const body = parse(z.object({ user: z.string().regex(/^[A-Za-z0-9_.@ -]{1,60}$/).optional(), password: z.string().min(8).max(200).optional() }), req.body ?? {});
  const login = body.user ?? row.settings?.adminUser ?? '';
  if (!login) throw new HttpError(400, 'Which user?');
  const password = body.password ?? randomToken(12);
  await wpChecked(row, su, dir, ['user', 'update', login, '--prompt=user_pass', '--skip-email'], { input: `${password}\n` });
  res.json({ user: login, password: body.password ? null : password });
});

wordpressRouter.post('/projects/:id/wordpress/update', async (req, res) => {
  const { project, su, dir, row } = await readyContext(req);
  const out = await serialize(row, async () => {
    const lines: string[] = [];
    const core = await wpCli(row, su, dir, ['core', 'update'], { timeoutMs: 10 * 60_000 });
    if (core.code !== 0) throw new HttpError(400, cliError(core));
    lines.push(core.stdout.trim().split('\n').pop() ?? '');
    await wpCli(row, su, dir, ['core', 'update-db']);
    return lines;
  });
  const fresh = await refreshInfo(row, su, dir);
  notifyProjectChanged(project.id);
  res.json({ wordpress: publicWordPress(fresh), message: out.join(' ') });
});

wordpressRouter.get('/projects/:id/wordpress/updates', async (req, res) => {
  const { su, dir, row } = await readyContext(req);
  const core = await wpJson<{ version: string }[]>(row, su, dir, ['core', 'check-update', '--fields=version'], { timeoutMs: 60_000 }).catch(() => []);
  res.json({ core: core[0]?.version ?? null });
});

wordpressRouter.post('/projects/:id/wordpress/db-export', async (req, res) => {
  const { project, su, dir, row } = await readyContext(req);
  const site = siteHostsOfProject(project.id);
  const rel = `exports/${site?.slug ?? 'wordpress'}-database-${new Date().toISOString().slice(0, 10)}.sql`;
  await userMkdir(su, path.join(dir, 'exports'));
  await wpChecked(row, su, dir, ['db', 'export', path.join(dir, rel), '--add-drop-table'], { timeoutMs: 10 * 60_000 });
  notifyProjectChanged(project.id);
  const st = await userStat(su, path.join(dir, rel));
  res.json({ path: rel, size: st?.size ?? 0 });
});

wordpressRouter.delete('/projects/:id/wordpress', async (req, res) => {
  const { project, row } = await context(req);
  if (!row) throw notFound('This project has no WordPress');
  if (runtime(row.id).busy) throw new HttpError(409, 'Something is still running for this WordPress — try again in a moment');
  if (hooks.isProjectBusy(project.id)) throw new HttpError(409, 'The AI is working in this project — stop it first');
  await uninstall(project, row);
  res.json({ ok: true });
});

wordpressRouter.get('/admin/wordpress', async (_req, res) => {
  const list = await q<{ id: number; project_name: string; owner: string }>(
    `SELECT w.id, p.name AS project_name, u.username AS owner FROM wordpress_sites w
       JOIN projects p ON p.id = w.project_id JOIN users u ON u.id = w.owner_id ORDER BY w.created_at DESC`,
  );
  const avail = wordpressAvailable();
  res.json({
    available: avail.ok,
    reason: avail.reason,
    phpVersion: bins.phpVersion,
    sites: list
      .map((r) => {
        const row = rows.get(r.id);
        return row ? { ...publicWordPress(row), job: undefined, projectName: r.project_name, owner: r.owner, address: siteOfProjectSync(row.project_id)?.addresses.primary ?? null } : null;
      })
      .filter(Boolean),
  });
});

// ---- the AI (studio wp …) ----------------------------------------------------------------------
export const wordpressAgentRouter = Router();

wordpressAgentRouter.get('/agent/wordpress', async (req, res) => {
  const { project, su, dir } = await agentContext(req);
  const row = rowOfProject(project.id);
  res.json({ ...(await statusOf(project, su, dir)), log: row ? phpLog(row.id) : null, internalPort: config.sites.listenPort });
});

wordpressAgentRouter.post('/agent/wordpress/modules', async (req, res) => {
  const { project, user, su, dir } = await agentContext(req);
  const body = parse(moduleBody, req.body);
  const mod = await createModule(project, su, dir, body, user.display_name || user.username);
  res.status(201).json({ module: mod, installed: rowOfProject(project.id)?.state === 'ready' });
});

wordpressAgentRouter.post('/agent/wordpress/link', async (req, res) => {
  const { su, dir } = await agentContext(req);
  res.json({ conflicts: await linkModules(su, dir), modules: await ownModules(su, dir) });
});

wordpressAgentRouter.post('/agent/wordpress/export', async (req, res) => {
  const { project, su, dir } = await agentContext(req);
  const body = parse(z.object({ kind: z.enum(MODULE_KINDS).optional(), slug: z.string().regex(EXT_RE) }), req.body);
  const mods = (await ownModules(su, dir)).filter((m) => m.slug === body.slug && (!body.kind || m.kind === body.kind));
  if (!mods.length) throw notFound(`no own plugin or theme named "${body.slug}" (see: studio wp status)`);
  const out = await exportModule(su, dir, mods[0].kind, mods[0].slug);
  notifyProjectChanged(project.id);
  res.json({ ...out, kind: mods[0].kind });
});

wordpressAgentRouter.get('/agent/wordpress/log', async (req, res) => {
  const { project, su } = await agentContext(req);
  const row = rowOfProject(project.id);
  const tail = Math.max(1, Math.min(Number(req.query.tail) || 60, 500));
  const text = row ? await readOwnedTail(su, phpLog(row.id), 128 * 1024) : '';
  res.json({ lines: text.split('\n').filter((l) => l.trim()).slice(-tail), fpm: row ? runtime(row.id).log.slice(-10) : [] });
});

wordpressAgentRouter.post('/agent/wordpress/login', async (req, res) => {
  const { project, su, dir } = await agentContext(req);
  const row = rowOfProject(project.id);
  if (!row || row.state !== 'ready') throw new HttpError(409, 'WordPress is not installed yet — the user sets it up in the WordPress tab');
  const body = parse(z.object({ to: z.string().max(300).regex(/^\/[^\s]*$/).optional() }), req.body ?? {});
  const admins = await wpJson<{ user_login: string }[]>(row, su, dir, ['user', 'list', '--role=administrator', '--fields=user_login']).catch(() => []);
  const login = admins.find((a) => a.user_login === row.settings?.adminUser)?.user_login ?? admins[0]?.user_login;
  if (!login) throw new HttpError(409, 'This WordPress has no administrator account');
  // inside the Studio the site is reached on the website port of this machine
  const site = siteOfProjectSync(project.id);
  const url = loginUrl(row, login, body.to ?? '/wp-admin/');
  const internal = site ? url.replace(site.addresses.primary, site.internal.browser) : url;
  res.json({ url: internal, publicUrl: url, user: login });
});

wordpressAgentRouter.post('/agent/wordpress/restart', async (req, res) => {
  const { project, su, dir } = await agentContext(req);
  const row = rowOfProject(project.id);
  if (!row || row.state !== 'ready') throw new HttpError(409, 'WordPress is not installed yet');
  await stopFpm(row.id);
  runtime(row.id).crashes = [];
  await linkModules(su, dir).catch(() => {});
  await ensureStarted(row);
  res.json({ wordpress: publicWordPress(row) });
});

/** After an AI turn: new module folders are linked in (hooks.ts). */
hooks.onTurnFinished(async (projectId: number) => {
  const row = rowOfProject(projectId);
  if (!row || row.state !== 'ready') return;
  const project = await getProjectRow(projectId);
  if (!project) return;
  const su = await ensureSysUser(project.owner_id);
  await linkModules(su, projectDir(project));
});
