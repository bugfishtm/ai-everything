/**
 * Websites — web apps and browser games of projects, hosted as real websites.
 *
 * "Publish" snapshots the project's web folder (dist/, build/, out/ … or the project
 * itself) into a release that the Studio serves on its own website port (container
 * port 8081, published as port 80 on a web server), chosen by the request's host name:
 *   custom domains          example.com → the website (DNS A/AAAA → this server)
 *   <name>.<base domain>    when SITES_BASE_DOMAIN is set (wildcard DNS *.<base domain>)
 *   <name>.localhost        to try it on the Studio's own machine
 * Files are read as the owner (tar — only what they can read) and written by the Studio
 * as root into /data/sites/<id>/releases/<n>/ through a safe extractor (plain files and
 * folders only); users cannot change a published release afterwards. The last three
 * releases are kept for rollbacks.
 * On a website's host, /srv/<slug>/ reaches the owner's Node.js servers (services.ts),
 * so a web app and its backend share one origin. A website can also be one of the
 * project's servers as a whole (a Node.js web app), or the project's WordPress
 * (wordpress.ts registers itself here; nothing is published then — WordPress is live).
 * HTTPS is built in (certs.ts): a second listener with TLS picks the certificate per domain —
 * automatic (Let's Encrypt), uploaded or self-signed, managed per domain on the website. The
 * Studio's own website can be served on that port too, under its own domain. Alternatively a
 * reverse proxy terminates TLS (SITES_HTTPS=true; the Caddy profile asks
 * /.well-known/ai-everything/tls-allowed before it gets a certificate for a host name).
 */
import crypto from 'node:crypto';
import dns from 'node:dns';
import fsp from 'node:fs/promises';
import http, { type IncomingMessage, type RequestListener } from 'node:http';
import https from 'node:https';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { domainToASCII } from 'node:url';
import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { agentContext } from './agent.js';
import { getArea } from './areas.js';
import {
  acmeChallenge,
  certificatePem,
  deleteCertificate,
  fallbackCertificate,
  hstsFor,
  httpsActive,
  httpsForced,
  initCerts,
  onTlsChange,
  publicTls,
  removeTlsHost,
  requestCertificate,
  saveAcmeSettings,
  setStudioDomain,
  setTlsHostProvider,
  setTlsOptions,
  sniCallback,
  studioTlsDomain,
  tick as tlsTick,
  TLS_MODES,
  tlsEnabled,
  tlsHosting,
  tlsOverview,
  uploadCertificate,
  type TlsKind,
} from './certs.js';
import { config } from './config.js';
import { exec, q, q1 } from './db.js';
import { hooks } from './hooks.js';
import { HttpError, intParam, isPrivateAddress, notFound, parse } from './lib/http.js';
import { baseUserEnv, closeAfterExit, ensureSysUser, killTree, spawnAs, type SysUser } from './lib/system.js';
import { extractTarSafely, TarLimitError } from './lib/tarsafe.js';
import { relOf, resolveIn, userStat } from './lib/userfs.js';
import { getProjectRow, loadOwnedProject, projectDir, projectSettings, type ProjectRow } from './projects.js';
import { detectServers, proxySrv, proxyWholeSite, servicesOfProjectSync, srvUpgrade, studioHostnames, wholeSiteUpgrade } from './services.js';
import { getSetting, setSetting } from './settings.js';
import type { AuthUser } from './users.js';
import { publish, sendToUser } from './ws.js';

// ---------------------------------------------------------------------------
// Types and state
// ---------------------------------------------------------------------------
export interface SiteSettings {
  /** folder to publish, relative to the project ("." = the project itself; empty = automatic) */
  root?: string;
  /** shell command run in the project before publishing, e.g. "npm ci && npm run build" */
  build?: string;
  /** unknown paths without a file extension serve index.html (single-page apps) */
  spa?: boolean;
  /** "server" = the website is one of the project's servers as a whole; "wordpress" = the project's WordPress */
  mode?: 'static' | 'server' | 'wordpress';
  serviceId?: number;
}

/** The WordPress of a project answers the requests of its website (wordpress.ts). */
export interface WordPressBackend {
  /** installed and switched on: the website counts as live (domains get certificates) */
  ready(projectId: number): boolean;
  http(req: Request, res: Response, projectId: number, ownerId: number): void;
}
let wordpress: WordPressBackend | null = null;
export function setWordPressBackend(b: WordPressBackend): void {
  wordpress = b;
}

interface SiteStats {
  files: number;
  bytes: number;
  skipped: number;
  root: string;
}

interface SiteRow {
  id: number;
  owner_id: number;
  project_id: number;
  slug: string;
  enabled: number;
  release_no: number;
  settings: SiteSettings | null;
  stats: SiteStats | null;
  publish_log: string | null;
  created_at: Date;
  updated_at: Date;
  published_at: Date | null;
}

interface Live {
  publishing: boolean;
  message: string | null;
  log: string[];
  busy: Promise<void> | null;
}

const rows = new Map<number, SiteRow>();
const slugIndex = new Map<string, number>();
const domainIndex = new Map<string, number>();
const siteDomains = new Map<number, string[]>();
const ownerActive = new Map<number, boolean>();
const lives = new Map<number, Live>();
const staticHandlers = new Map<string, RequestHandler>();
let instanceId = '';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/;
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** names that would be confusing (or dangerous) as <name>.<base domain> */
const RESERVED = new Set([
  'www', 'mail', 'smtp', 'imap', 'pop', 'pop3', 'ftp', 'sftp', 'api', 'admin', 'studio', 'app', 'apps', 'ns', 'ns1', 'ns2',
  'mx', 'autodiscover', 'autoconfig', 'webmail', 'cpanel', 'localhost', 'srv', 'static', 'cdn', 'assets', 'login', 'auth',
]);

const siteDir = (id: number) => path.join(config.sitesDir, String(id));
const releasesDir = (id: number) => path.join(siteDir(id), 'releases');
const releaseDir = (id: number, n: number) => path.join(releasesDir(id), String(n));

function live(id: number): Live {
  let l = lives.get(id);
  if (!l) {
    l = { publishing: false, message: null, log: [], busy: null };
    lives.set(id, l);
  }
  return l;
}

function log(id: number, line: string): void {
  const l = live(id);
  const text = `${new Date().toISOString().slice(11, 19)} ${line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')}`.slice(0, 2000);
  l.log.push(text);
  if (l.log.length > 600) l.log.splice(0, l.log.length - 600);
  publish(`site:${id}`, { t: 'site.log', id, line: text });
}

function logOf(row: SiteRow): string[] {
  const l = live(row.id);
  return l.log.length ? l.log : row.publish_log ? row.publish_log.split('\n') : [];
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function slugify(s: string): string {
  const out = s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return out.length >= 2 ? out : `site-${out || 'web'}`;
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------
const scheme = () => (config.sites.https ? 'https' : 'http');
const portSuffix = () => (config.sites.https || config.sites.publicPort === 80 ? '' : `:${config.sites.publicPort}`);
const tlsPortSuffix = () => (config.sites.tls.publicPort === 443 ? '' : `:${config.sites.tls.publicPort}`);
let tlsListening = false;

/** The address people use for a host: https when a proxy or the built-in TLS has a certificate for it. */
function originFor(host: string): string {
  if (config.sites.https) return `https://${host}`;
  if (tlsListening && httpsActive(host)) return `https://${host}${tlsPortSuffix()}`;
  return `http://${host}${portSuffix()}`;
}

function baseHost(row: SiteRow): string | null {
  return config.sites.baseDomain ? `${row.slug}.${config.sites.baseDomain}` : null;
}

function addressesOf(row: SiteRow) {
  const custom = (siteDomains.get(row.id) ?? []).map((d) => `${originFor(d)}/`);
  const bh = baseHost(row);
  const base = bh ? `${originFor(bh)}/` : null;
  const local = `http://${row.slug}.localhost${config.sites.publicPort === 80 ? '' : `:${config.sites.publicPort}`}/`;
  return { custom, base, local, primary: custom[0] ?? base ?? local };
}

/** HTTPS state of every public host of a website (own domains and <name>.<base domain>). */
function tlsOf(row: SiteRow) {
  if (!tlsEnabled() || config.sites.https) return {};
  const out: Record<string, ReturnType<typeof publicTls>> = {};
  for (const d of siteDomains.get(row.id) ?? []) out[d] = publicTls(d);
  const bh = baseHost(row);
  if (bh) out[bh] = publicTls(bh);
  return out;
}

function servable(row: SiteRow): boolean {
  if (!row.enabled || ownerActive.get(row.id) === false) return false;
  if (row.settings?.mode === 'wordpress') return !!wordpress?.ready(row.project_id);
  return row.settings?.mode === 'server' ? !!row.settings.serviceId : row.release_no > 0;
}

export function publicSite(row: SiteRow) {
  const l = live(row.id);
  const s = row.settings ?? {};
  const status = l.publishing
    ? 'publishing'
    : !row.enabled || ownerActive.get(row.id) === false
      ? 'offline'
      : servable(row)
        ? 'live'
        : 'unpublished';
  return {
    id: row.id,
    projectId: row.project_id,
    ownerId: row.owner_id,
    slug: row.slug,
    status,
    enabled: !!row.enabled,
    ownerActive: ownerActive.get(row.id) !== false,
    release: row.release_no,
    publishedAt: row.published_at,
    publishing: l.publishing,
    message: l.message,
    settings: { root: s.root ?? '', build: s.build ?? '', spa: !!s.spa, mode: s.mode ?? 'static', serviceId: s.serviceId ?? null },
    stats: row.stats ?? null,
    domains: siteDomains.get(row.id) ?? [],
    baseHost: baseHost(row),
    addresses: addressesOf(row),
    /** certificate per host (built-in HTTPS) */
    tls: tlsOf(row),
    /** for Claude's own checks inside the Studio */
    internal: {
      url: `http://127.0.0.1:${config.sites.listenPort}/`,
      host: `${row.slug}.localhost`,
      browser: `http://${row.slug}.localhost:${config.sites.listenPort}/`,
    },
  };
}
export type PublicSite = ReturnType<typeof publicSite>;

function changed(row: SiteRow): void {
  publish(`site:${row.id}`, { t: 'site.status', site: publicSite(row) });
  sendToUser(row.owner_id, { t: 'sites.changed', projectId: row.project_id });
}

async function hostingInfo() {
  return {
    enabled: config.sites.enabled,
    baseDomain: config.sites.baseDomain || null,
    port: config.sites.publicPort,
    https: config.sites.https,
    /** built-in HTTPS: certificates per domain */
    tls: await tlsHosting(),
    maxPerUser: config.sites.maxPerUser,
    maxMb: config.sites.maxMb,
  };
}

// ---------------------------------------------------------------------------
// Database cache (also refreshed every minute: rows removed by cascades, disabled owners)
// ---------------------------------------------------------------------------
type JoinedRow = SiteRow & { owner_status?: string };

function cache(joined: JoinedRow): SiteRow {
  const { owner_status, ...row } = joined;
  if (owner_status !== undefined) ownerActive.set(row.id, owner_status === 'active');
  const old = rows.get(row.id);
  if (old && old.slug !== row.slug && slugIndex.get(old.slug) === row.id) slugIndex.delete(old.slug);
  rows.set(row.id, row);
  slugIndex.set(row.slug, row.id);
  return row;
}

function forget(id: number): void {
  const row = rows.get(id);
  if (row && slugIndex.get(row.slug) === id) slugIndex.delete(row.slug);
  rows.delete(id);
  ownerActive.delete(id);
  for (const d of siteDomains.get(id) ?? []) if (domainIndex.get(d) === id) domainIndex.delete(d);
  siteDomains.delete(id);
  for (const k of [...staticHandlers.keys()]) if (k.startsWith(`${id}:`)) staticHandlers.delete(k);
}

async function reloadDomains(id: number): Promise<void> {
  const list = await q<{ domain: string }>('SELECT domain FROM site_domains WHERE site_id = ? ORDER BY created_at, domain', [id]);
  for (const d of siteDomains.get(id) ?? []) if (domainIndex.get(d) === id) domainIndex.delete(d);
  for (const { domain } of list) domainIndex.set(domain, id);
  siteDomains.set(
    id,
    list.map((x) => x.domain),
  );
}

async function reloadRow(id: number): Promise<SiteRow> {
  const row = await q1<JoinedRow>('SELECT s.*, u.status AS owner_status FROM sites s JOIN users u ON u.id = s.owner_id WHERE s.id = ?', [id]);
  if (!row) {
    forget(id);
    throw notFound('Website not found');
  }
  const r = cache(row);
  await reloadDomains(id);
  return r;
}

async function reloadAll(): Promise<void> {
  const list = await q<JoinedRow>('SELECT s.*, u.status AS owner_status FROM sites s JOIN users u ON u.id = s.owner_id');
  const doms = await q<{ domain: string; site_id: number }>('SELECT domain, site_id FROM site_domains ORDER BY created_at, domain');
  const seen = new Set<number>();
  for (const r of list) {
    seen.add(r.id);
    cache(r);
  }
  for (const id of [...rows.keys()]) if (!seen.has(id)) forget(id);
  domainIndex.clear();
  siteDomains.clear();
  for (const d of doms) {
    if (!seen.has(d.site_id)) continue;
    domainIndex.set(d.domain, d.site_id);
    siteDomains.set(d.site_id, [...(siteDomains.get(d.site_id) ?? []), d.domain]);
  }
}

function siteOfProject(projectId: number): SiteRow | undefined {
  return [...rows.values()].find((r) => r.project_id === projectId);
}

export function siteOfProjectSync(projectId: number): PublicSite | null {
  const r = siteOfProject(projectId);
  return r ? publicSite(r) : null;
}

async function ownedSite(user: AuthUser, id: number): Promise<SiteRow> {
  const row = await reloadRow(id).catch(() => null);
  if (!row || (row.owner_id !== user.id && user.role !== 'admin')) throw notFound('Website not found');
  return row;
}

async function serialize(id: number, fn: () => Promise<void>): Promise<void> {
  const l = live(id);
  while (l.busy) await l.busy.catch(() => {});
  const job = fn();
  l.busy = job;
  try {
    await job;
  } finally {
    if (l.busy === job) l.busy = null;
  }
}

// ---------------------------------------------------------------------------
// Creating, publishing, releases
// ---------------------------------------------------------------------------
/** The website of a WordPress project: created with the installation, shows WordPress itself. */
export async function ensureWordPressSite(project: ProjectRow): Promise<PublicSite> {
  let row = await createSite(project);
  if (row.settings?.mode !== 'wordpress') {
    await exec('UPDATE sites SET settings = ? WHERE id = ?', [JSON.stringify({ mode: 'wordpress' } satisfies SiteSettings), row.id]);
    row = await reloadRow(row.id);
    log(row.id, 'This website is the WordPress of the project.');
  }
  changed(row);
  return publicSite(row);
}

/** WordPress was installed, started or removed: the website's state (and its certificates) follow. */
export function siteStateChanged(projectId: number): void {
  const row = siteOfProject(projectId);
  if (!row) return;
  changed(row);
  void tlsTick();
}

/** Every host name a project's website answers to (own domains first), and its addresses. */
export function siteHostsOfProject(projectId: number): { hosts: string[]; primary: string; local: string; slug: string } | null {
  const row = siteOfProject(projectId);
  if (!row) return null;
  const a = addressesOf(row);
  const hosts = [...(siteDomains.get(row.id) ?? [])];
  const bh = baseHost(row);
  if (bh) hosts.push(bh);
  hosts.push(`${row.slug}.localhost`);
  return { hosts, primary: a.primary, local: a.local, slug: row.slug };
}

export async function deleteSiteOfProject(projectId: number): Promise<void> {
  const row = siteOfProject(projectId) ?? (await q1<{ id: number }>('SELECT id FROM sites WHERE project_id = ?', [projectId]));
  if (row) await deleteSite(row.id);
}

async function createSite(project: ProjectRow): Promise<SiteRow> {
  const existing = siteOfProject(project.id);
  if (existing) return existing;
  if (!config.sites.enabled) throw new HttpError(503, 'Website hosting is switched off on this Studio (SITES_ENABLED=false)');
  const n = Number((await q1<{ n: number }>('SELECT COUNT(*) AS n FROM sites WHERE owner_id = ?', [project.owner_id]))?.n ?? 0);
  if (n >= config.sites.maxPerUser) {
    throw new HttpError(429, `You already have ${n} websites (limit ${config.sites.maxPerUser}). Delete one on the Websites page first.`);
  }
  const base = slugify(project.name);
  let slug = base;
  for (let i = 2; RESERVED.has(slug) || slugIndex.has(slug) || (await q1('SELECT id FROM sites WHERE slug = ?', [slug])); i++) slug = `${base}-${i}`;
  try {
    const { insertId } = await exec('INSERT INTO sites (owner_id, project_id, slug, settings) VALUES (?, ?, ?, ?)', [
      project.owner_id,
      project.id,
      slug,
      JSON.stringify({}),
    ]);
    const row = await reloadRow(insertId);
    sendToUser(project.owner_id, { t: 'sites.changed', projectId: project.id });
    return row;
  } catch (err) {
    // created at the same moment by another request (one website per project)
    const again = await q1<{ id: number }>('SELECT id FROM sites WHERE project_id = ?', [project.id]);
    if (again) return reloadRow(again.id);
    throw err;
  }
}

function cleanSettings(s: SiteSettings): SiteSettings {
  const out: SiteSettings = {};
  const root = s.root?.trim().replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (root) out.root = root === '.' ? '.' : root;
  if (s.build?.trim()) out.build = s.build.trim();
  if (s.spa) out.spa = true;
  if (s.mode === 'server' && s.serviceId) {
    out.mode = 'server';
    out.serviceId = s.serviceId;
  }
  if (s.mode === 'wordpress') return { mode: 'wordpress' };
  return out;
}

/** The folder that gets published (relative to the project, "." = the project itself). */
async function publishRoot(su: SysUser, dir: string, project: ProjectRow, setting?: string): Promise<string> {
  if (setting) return relOf(dir, resolveIn(dir, setting)) || '.';
  const preview = (projectSettings(project).previewPath || 'index.html').replace(/^\/+/, '');
  const previewDir = path.posix.dirname(preview);
  if (previewDir && previewDir !== '.') {
    const rel = relOf(dir, resolveIn(dir, previewDir));
    if (rel && (await userStat(su, path.join(dir, rel, 'index.html')))?.isFile) return rel;
  }
  for (const cand of ['dist', 'build', 'out']) {
    if ((await userStat(su, path.join(dir, cand, 'index.html')))?.isFile) return cand;
  }
  return '.';
}

/** Never published from the project folder itself: Claude's notes, deliverables, chat uploads, server code. */
async function rootExcludes(su: SysUser, dir: string, projectId: number): Promise<string[]> {
  const out = new Set(['CLAUDE.md', 'exports', 'assets/uploads']);
  for (const d of await detectServers(su, dir, projectId).catch(() => [])) out.add(d.root);
  return [...out];
}

function publishFilter(exclude: string[]): (rel: string) => boolean {
  return (rel: string) => {
    const parts = rel.split('/');
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p === 'node_modules') return false;
      // hidden files and folders (.env, .git, .studio …) — except /.well-known/
      if (p.startsWith('.') && !(i === 0 && p === '.well-known')) return false;
    }
    return !exclude.some((e) => rel === e || rel.startsWith(`${e}/`));
  };
}

function runBuild(id: number, su: SysUser, dir: string, cmd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawnAs(su, 'bash', ['-c', cmd], {
      cwd: dir,
      env: baseUserEnv(su, { CI: '1', npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' }),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const onLines = (stream: NodeJS.ReadableStream | null) => {
      let buf = '';
      stream?.on('data', (d: Buffer) => {
        buf += d.toString('utf8');
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          if (line.trim()) log(id, `  ${line}`);
        }
      });
      stream?.on('end', () => {
        if (buf.trim()) log(id, `  ${buf}`);
      });
    };
    onLines(child.stdout);
    onLines(child.stderr);
    const timer = setTimeout(() => {
      log(id, 'The build took longer than 15 minutes — stopped.');
      killTree(child, 'SIGKILL');
    }, 15 * 60_000);
    child.on('error', (err) => log(id, err.message));
    closeAfterExit(child);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

/** tar as the owner → safe extraction by the Studio into a fresh folder. */
async function copyRelease(id: number, su: SysUser, rootAbs: string, dest: string, exclude: string[]) {
  const args = [
    '-C', rootAbs, '-c', '-f', '-',
    '--dereference', '--hard-dereference', '--ignore-failed-read', '--warning=no-file-changed',
    '--exclude=node_modules', '--exclude=.git',
    ...exclude.map((e) => `--exclude=./${e}`),
    '.',
  ];
  const child = spawnAs(su, '/bin/tar', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => {
    if (stderr.length < 20_000) stderr += d.toString('utf8');
  });
  const exited = new Promise<number>((resolve) => {
    child.on('error', () => resolve(127));
    child.on('close', (code) => resolve(code ?? 1));
  });
  let result;
  try {
    result = await extractTarSafely(child.stdout!, dest, {
      maxBytes: config.sites.maxMb * 1024 * 1024,
      maxFiles: config.sites.maxFiles,
      filter: publishFilter(exclude),
    });
  } catch (err) {
    child.kill('SIGKILL');
    await exited;
    throw err;
  }
  const code = await exited;
  for (const line of stderr.split('\n').filter((l) => l.trim()).slice(0, 20)) log(id, `  ${line.replace(/^(\/bin\/)?tar: /, 'note: ')}`);
  if (code !== 0 && code !== 1) throw new Error(`copying the files failed (tar exit ${code})`);
  return result;
}

async function releaseNumbers(id: number): Promise<number[]> {
  const names = await fsp.readdir(releasesDir(id)).catch(() => [] as string[]);
  return names
    .map((n) => (/^\d+$/.test(n) ? Number(n) : NaN))
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => b - a);
}

async function dirStats(abs: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const walk = async (d: string): Promise<void> => {
    for (const e of await fsp.readdir(d, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(path.join(d, e.name));
      else if (e.isFile()) {
        files++;
        bytes += (await fsp.lstat(path.join(d, e.name))).size;
      }
    }
  };
  await walk(abs).catch(() => {});
  return { files, bytes };
}

export async function publishSite(id: number, by: string, opts: { root?: string; build?: string; spa?: boolean } = {}): Promise<void> {
  await serialize(id, async () => {
    let row = await reloadRow(id);
    if (row.settings?.mode === 'wordpress') {
      throw new HttpError(400, 'This website is the WordPress of the project — it is always live, there is nothing to publish. Change it in WordPress itself (or its plugins and themes).');
    }
    if (opts.root !== undefined || opts.build !== undefined || opts.spa !== undefined) {
      // options given with a publish become the website's settings
      const next = { ...(row.settings ?? {}) };
      if (opts.root !== undefined) next.root = opts.root;
      if (opts.build !== undefined) next.build = opts.build;
      if (opts.spa !== undefined) next.spa = opts.spa;
      await exec('UPDATE sites SET settings = ? WHERE id = ?', [JSON.stringify(cleanSettings(next)), id]);
      row = await reloadRow(id);
    }
    const project = await getProjectRow(row.project_id);
    if (!project) throw new HttpError(404, 'the project no longer exists');
    const su = await ensureSysUser(row.owner_id);
    const dir = projectDir(project);
    const l = live(id);
    l.publishing = true;
    l.message = null;
    l.log = [];
    changed(row);
    const n = Math.max((await releaseNumbers(id))[0] ?? 0, row.release_no) + 1;
    const tmp = `${releaseDir(id, n)}.tmp`;
    try {
      log(id, `Publish #${n} (${by})`);
      const build = row.settings?.build?.trim();
      if (build) {
        log(id, `▸ ${build}`);
        const code = await runBuild(id, su, dir, build);
        if (code !== 0) throw new Error(`the build command failed (exit ${code}) — see the log above`);
      }
      const root = await publishRoot(su, dir, project, row.settings?.root);
      const rootAbs = root === '.' ? dir : resolveIn(dir, root);
      const where = root === '.' ? 'the project folder' : `${root}/`;
      if (!(await userStat(su, rootAbs))?.isDir) throw new Error(`${where} does not exist`);
      if (!(await userStat(su, path.join(rootAbs, 'index.html')))?.isFile) {
        throw new Error(`there is no index.html in ${where} — publish the folder that holds the web app's index.html (setting "Folder" / --root)`);
      }
      const exclude = root === '.' ? await rootExcludes(su, dir, project.id) : [];
      log(id, `▸ copying ${where}${exclude.length ? ` — without ${exclude.map((e) => `${e}`).join(', ')}, hidden files and node_modules` : ''} …`);
      await fsp.mkdir(releasesDir(id), { recursive: true, mode: 0o755 });
      await fsp.rm(tmp, { recursive: true, force: true });
      const r = await copyRelease(id, su, rootAbs, tmp, exclude);
      await fsp.rename(tmp, releaseDir(id, n));
      const stats: SiteStats = { files: r.files, bytes: r.bytes, skipped: r.skipped, root };
      await exec('UPDATE sites SET release_no = ?, published_at = UTC_TIMESTAMP(3), stats = ? WHERE id = ?', [n, JSON.stringify(stats), id]);
      const fresh = await reloadRow(id);
      log(id, `✓ Release #${n} is live: ${r.files} files, ${fmtBytes(r.bytes)} — ${addressesOf(fresh).primary}`);
      void tlsTick(); // a first publish makes its domains eligible for certificates
      if (fresh.settings?.mode === 'server') log(id, 'Note: the website shows a server of the project (Settings → Content), not these files.');
      if (!fresh.enabled) log(id, 'Note: the website is switched offline — put it online to show it.');
      // keep the three newest releases (and the current one)
      for (const old of (await releaseNumbers(id)).slice(3)) {
        if (old !== n) await fsp.rm(releaseDir(id, old), { recursive: true, force: true }).catch(() => {});
      }
      for (const k of [...staticHandlers.keys()]) if (k.startsWith(`${id}:`) && k !== `${id}:${n}`) staticHandlers.delete(k);
    } catch (err) {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
      const msg = err instanceof TarLimitError ? `the website is too large — ${err.message} (SITE_MAX_MB, SITE_MAX_FILES)` : (err as Error).message;
      log(id, `✗ Publish #${n} failed: ${msg}`);
      l.message = `Publish failed: ${msg}`;
      throw err instanceof HttpError ? err : new HttpError(400, msg);
    } finally {
      l.publishing = false;
      await exec('UPDATE sites SET publish_log = ? WHERE id = ?', [l.log.join('\n').slice(-60_000), id]).catch(() => {});
      const fresh = await reloadRow(id).catch(() => null);
      if (fresh) changed(fresh);
    }
  });
}

async function rollbackSite(row: SiteRow, n: number, by: string): Promise<void> {
  if (!(await releaseNumbers(row.id)).includes(n)) throw new HttpError(404, `release #${n} is not kept anymore`);
  await serialize(row.id, async () => {
    const st = await dirStats(releaseDir(row.id, n));
    const stats: SiteStats = { ...(row.stats ?? { skipped: 0, root: '.' }), files: st.files, bytes: st.bytes };
    await exec('UPDATE sites SET release_no = ?, stats = ? WHERE id = ?', [n, JSON.stringify(stats), row.id]);
    log(row.id, `Rolled back to release #${n} (${by})`);
    changed(await reloadRow(row.id));
  });
}

export async function deleteSite(id: number): Promise<void> {
  await serialize(id, async () => {
    const row = rows.get(id) ?? (await q1<SiteRow>('SELECT * FROM sites WHERE id = ?', [id]));
    await exec('DELETE FROM sites WHERE id = ?', [id]);
    forget(id);
    void tlsTick(); // certificates of its domains are removed
    await fsp.rm(siteDir(id), { recursive: true, force: true }).catch(() => {});
    if (row) sendToUser(row.owner_id, { t: 'sites.changed', projectId: row.project_id });
  });
  lives.delete(id);
}

hooks.onProjectDeleted(async (projectId: number) => {
  const row = siteOfProject(projectId) ?? (await q1<{ id: number }>('SELECT id FROM sites WHERE project_id = ?', [projectId]));
  if (row) await deleteSite(row.id);
});

async function updateSite(
  row: SiteRow,
  body: { enabled?: boolean; slug?: string; settings?: Partial<Omit<SiteSettings, 'serviceId'>> & { serviceId?: number | null } },
  by: string,
): Promise<SiteRow> {
  if (body.slug && body.slug !== row.slug) {
    if (RESERVED.has(body.slug)) throw new HttpError(400, `"${body.slug}" is reserved — choose another name`);
    if (slugIndex.has(body.slug) || (await q1('SELECT id FROM sites WHERE slug = ?', [body.slug]))) throw new HttpError(409, `the name "${body.slug}" is taken`);
  }
  const settings: SiteSettings = { ...(row.settings ?? {}) };
  if (body.settings && row.settings?.mode === 'wordpress') {
    throw new HttpError(400, 'This website is the WordPress of the project — its content is managed in WordPress (the name, domains and HTTPS can be changed here)');
  }
  if (body.settings) {
    const s = body.settings;
    if (s.root !== undefined) settings.root = s.root;
    if (s.build !== undefined) settings.build = s.build;
    if (s.spa !== undefined) settings.spa = s.spa;
    if (s.mode !== undefined) settings.mode = s.mode;
    if (s.serviceId !== undefined) settings.serviceId = s.serviceId ?? undefined;
    if (settings.root && settings.root !== '.') {
      const project = await getProjectRow(row.project_id);
      if (project) resolveIn(projectDir(project), settings.root); // throws for paths outside the project
    }
    if (settings.mode === 'server') {
      const servers = servicesOfProjectSync(row.project_id);
      if (!settings.serviceId && servers.length === 1) settings.serviceId = servers[0].id;
      if (!settings.serviceId || !servers.some((x) => x.id === settings.serviceId)) {
        throw new HttpError(400, 'choose a server of this project (deploy one first)');
      }
    }
  }
  const enabled = body.enabled === undefined ? row.enabled : body.enabled ? 1 : 0;
  await exec('UPDATE sites SET slug = ?, enabled = ?, settings = ? WHERE id = ?', [body.slug ?? row.slug, enabled, JSON.stringify(cleanSettings(settings)), row.id]);
  const fresh = await reloadRow(row.id);
  if (fresh.enabled !== row.enabled) log(row.id, fresh.enabled ? `Back online (${by})` : `Taken offline (${by})`);
  if (fresh.slug !== row.slug) log(row.id, `New name: ${fresh.slug} — ${addressesOf(fresh).base ?? addressesOf(fresh).local}`);
  if (body.settings) log(row.id, `Settings changed (${by})`);
  changed(fresh);
  return fresh;
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------
function normalizeDomain(input: string): string {
  let d = input.trim().toLowerCase();
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  d = d.split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/\.$/, '');
  if (d.startsWith('*.')) throw new HttpError(400, 'wildcard domains are not supported — add each host name (or ask the admin for SITES_BASE_DOMAIN)');
  const ascii = d ? domainToASCII(d) : '';
  if (!ascii) throw new HttpError(400, `"${input}" is not a valid domain name`);
  return ascii;
}

function validateDomain(d: string): void {
  if (d.length > 253 || !DOMAIN_RE.test(d)) throw new HttpError(400, `"${d}" is not a valid domain name (example: mygame.com)`);
  if (d === 'localhost' || d.endsWith('.localhost')) throw new HttpError(400, 'localhost addresses are automatic (<name>.localhost)');
  const base = config.sites.baseDomain;
  if (base && (d === base || d.endsWith(`.${base}`))) throw new HttpError(400, `addresses under ${base} are given automatically (the website's name)`);
  // the Studio's own names: its HTTPS domain (set by an admin or STUDIO_DOMAIN) and its public address
  const own = new Set([...studioHostnames(), studioTlsDomain(), config.studioDomain].filter(Boolean));
  if (own.has(d)) throw new HttpError(400, `${d} is the address of this Studio itself`);
}

async function addDomain(row: SiteRow, input: string, by: string): Promise<string> {
  const d = normalizeDomain(input);
  validateDomain(d);
  const current = siteDomains.get(row.id) ?? [];
  if (current.includes(d)) return d;
  if (current.length >= config.sites.maxDomains) throw new HttpError(429, `a website can have up to ${config.sites.maxDomains} domains`);
  const taken = await q1<{ site_id: number }>('SELECT site_id FROM site_domains WHERE domain = ?', [d]);
  if (taken) throw new HttpError(409, `${d} is already used by another website on this Studio`);
  try {
    await exec('INSERT INTO site_domains (domain, site_id) VALUES (?, ?)', [d, row.id]);
  } catch {
    throw new HttpError(409, `${d} is already used by another website on this Studio`);
  }
  await reloadDomains(row.id);
  log(row.id, `Domain added: ${d} (${by})`);
  changed(row);
  void tlsTick(); // its certificate is requested in the background
  return d;
}

async function removeDomain(row: SiteRow, input: string, by: string): Promise<void> {
  const d = input.trim().toLowerCase().replace(/\.$/, '');
  await exec('DELETE FROM site_domains WHERE domain = ? AND site_id = ?', [d, row.id]);
  await reloadDomains(row.id);
  if (!domainIndex.has(d)) await removeTlsHost(d).catch(() => {});
  log(row.id, `Domain removed: ${d} (${by})`);
  changed(row);
}

/** Does the domain reach this Studio's website port? (DNS + an HTTP request to our ping endpoint) */
async function checkDomain(domain: string): Promise<{ ok: boolean; addresses: string[]; message: string }> {
  let addresses: string[] = [];
  try {
    addresses = (await dns.promises.lookup(domain, { all: true })).map((a) => a.address);
  } catch {
    return {
      ok: false,
      addresses,
      message: `${domain} has no DNS record yet. At your domain provider, create an A record (IPv4) — and AAAA for IPv6 — for ${domain} pointing to this server's public IP address. DNS changes can take a while.`,
    };
  }
  const bases = config.sites.https
    ? [`https://${domain}`, `http://${domain}`]
    : tlsListening && httpsActive(domain)
      ? [`https://${domain}${tlsPortSuffix()}`, `http://${domain}${portSuffix()}`]
      : [`http://${domain}${portSuffix()}`];
  let lastErr = '';
  for (const base of bases) {
    try {
      const r = await fetch(`${base}/.well-known/ai-everything/ping`, {
        redirect: 'follow',
        signal: AbortSignal.timeout(8000),
        headers: { 'user-agent': 'ai-everything-domain-check' },
      });
      const body = (await r.json().catch(() => null)) as { id?: string } | null;
      if (body?.id === instanceId) {
        void tlsTick();
        return { ok: true, addresses, message: `${domain} reaches this Studio (${base.startsWith('https') ? 'HTTPS' : 'HTTP'}).` };
      }
      return {
        ok: false,
        addresses,
        message: `${domain} points to ${addresses.join(', ')}, but a different web server answered there — not this Studio. Check the IP address in the DNS record.`,
      };
    } catch (err) {
      const e = err as Error & { cause?: { code?: string; message?: string } };
      lastErr = e.cause?.code || e.cause?.message || e.message;
    }
  }
  return {
    ok: false,
    addresses,
    message: `${domain} points to ${addresses.join(', ')}, but nothing answered (${lastErr}). Is the website port reachable — published as port 80 (SITES_PORT=80, SITES_BIND=0.0.0.0) and open in the firewall? Some routers cannot reach their own public address from inside the network: try it from a phone on mobile data.`,
  };
}

// ---------------------------------------------------------------------------
// The website port: serving by host name
// ---------------------------------------------------------------------------
export function requestHost(req: IncomingMessage): string {
  const fwd = config.trustProxy ? req.headers['x-forwarded-host'] : undefined;
  const raw = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0] ?? req.headers.host ?? '';
  const h = raw.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.replace(/:\d+$/, '').replace(/\.$/, '');
}

/**
 * `local`: <name>.localhost is only an address on this machine and its private network — a
 * visitor from the internet who merely sends that Host header does not get the website.
 */
function siteForHost(host: string, local = true): SiteRow | null {
  let id = domainIndex.get(host);
  if (id === undefined) {
    const base = config.sites.baseDomain;
    let label: string | null = null;
    if (base && host.endsWith(`.${base}`)) label = host.slice(0, -(base.length + 1));
    else if (local && host.endsWith('.localhost')) label = host.slice(0, -'.localhost'.length);
    if (label && !label.includes('.')) id = slugIndex.get(label);
  }
  return id === undefined ? null : (rows.get(id) ?? null);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function page(res: Response, status: number, title: string, text: string): void {
  res.status(status);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  res.end(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${esc(title)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;` +
      `background:#f6f7f9;color:#1f2328}@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}}` +
      `main{max-width:32rem;padding:2rem;text-align:center}h1{font-size:1.4rem;margin:0 0 .5rem}p{margin:0;opacity:.75}</style></head>` +
      `<body><main><h1>${esc(title)}</h1><p>${esc(text)}</p></main></body></html>`,
  );
}

function staticFor(row: SiteRow): RequestHandler {
  const key = `${row.id}:${row.release_no}`;
  let h = staticHandlers.get(key);
  if (!h) {
    h = express.static(releaseDir(row.id, row.release_no), {
      index: ['index.html'],
      dotfiles: 'allow', // only /.well-known/ exists in a release
      redirect: true,
      fallthrough: true,
      etag: true,
      lastModified: true,
      maxAge: 0,
      setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
    });
    staticHandlers.set(key, h);
  }
  return h;
}

function siteOf(res: Response): SiteRow {
  return res.locals.site as SiteRow;
}

/** The Studio's own website and WebSocket endpoint — served on the HTTPS port under the Studio's domain. */
let studioApp: RequestListener | null = null;
let studioUpgrade: ((req: IncomingMessage, socket: Duplex, head: Buffer) => void) | null = null;
export function setStudioHandlers(app: RequestListener, upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): void {
  studioApp = app;
  studioUpgrade = upgrade;
}

function isStudioHost(host: string): boolean {
  const d = studioTlsDomain();
  return !!d && host === d && tlsEnabled() && !config.sites.https;
}

function buildSitesApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('etag', false);

  // certificate authorities check a domain here before they issue a certificate (ACME HTTP-01)
  app.get('/.well-known/acme-challenge/:token', (req, res, next) => {
    const answer = acmeChallenge(String(req.params.token));
    if (!answer) return next();
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(answer);
  });

  // "is this domain pointed at this Studio?" (domain check) — on every host
  app.get('/.well-known/ai-everything/ping', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({ service: 'ai-everything websites', id: instanceId });
  });
  // the https profile (Caddy on-demand TLS) asks before getting a certificate for a host name
  app.get('/.well-known/ai-everything/tls-allowed', (req, res) => {
    const d = String(req.query.domain ?? '')
      .trim()
      .toLowerCase()
      .replace(/\.$/, '');
    const site = d && !d.endsWith('.localhost') ? siteForHost(d) : null;
    res.status(site && servable(site) ? 200 : 404).end();
  });

  // built-in HTTPS: redirect plain HTTP when the host has a certificate, HSTS, the Studio's own domain
  app.use((req, res, next) => {
    if (config.sites.https || !tlsListening) return next();
    const host = requestHost(req);
    if (!req.secure && httpsForced(host)) {
      res.setHeader('Cache-Control', 'no-store');
      return res.redirect(308, `https://${host}${tlsPortSuffix()}${req.originalUrl}`);
    }
    if (req.secure && hstsFor(host)) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    if (isStudioHost(host)) {
      if (!req.secure) return page(res, 503, 'HTTPS is being set up', 'The certificate for this address is not ready yet. Try again in a moment.');
      if (studioApp) return studioApp(req, res);
    }
    next();
  });

  app.use((req, res, next) => {
    const site = siteForHost(requestHost(req), isPrivateAddress(req.ip ?? req.socket.remoteAddress));
    if (!site) return page(res, 404, 'No website here', 'There is no website at this address.');
    if (!site.enabled || ownerActive.get(site.id) === false) return page(res, 503, 'Website offline', 'This website is offline at the moment.');
    res.locals.site = site;
    next();
  });

  // the owner's Node.js servers on the website's own origin
  app.use('/srv', (req, res) => proxySrv(req, res, { ownerId: siteOf(res).owner_id, sandbox: false }));

  app.use((req, res, next) => {
    const site = siteOf(res);
    const s = site.settings ?? {};
    if (s.mode === 'server' && s.serviceId) return proxyWholeSite(req, res, s.serviceId, site.owner_id);
    if (s.mode === 'wordpress') {
      if (!wordpress) return page(res, 503, 'WordPress is not available', 'WordPress is switched off on this server.');
      return wordpress.http(req, res, site.project_id, site.owner_id);
    }
    if (!site.release_no) return page(res, 404, 'Not published yet', 'This website has not been published yet.');
    staticFor(site)(req, res, next);
  });

  // not found: single-page-app fallback, the site's 404.html, or a plain page
  app.use((req, res) => {
    const site = siteOf(res);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return page(res, 405, 'Method not allowed', 'This website only serves files.');
    }
    const dir = releaseDir(site.id, site.release_no);
    if (site.settings?.spa && !path.posix.extname(req.path)) {
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.sendFile(path.join(dir, 'index.html'), (err) => {
        if (err && !res.headersSent) page(res, 404, 'Not found', 'This page does not exist.');
      });
      return;
    }
    // streamed, never read into memory: a website may bring a 404.html of any size
    res.status(404);
    res.sendFile(
      path.join(dir, '404.html'),
      { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' } },
      (err) => {
        if (err && !res.headersSent) page(res, 404, 'Not found', 'This page does not exist.');
      },
    );
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[sites]', err);
    if (!res.headersSent) page(res, 500, 'Error', 'Something went wrong.');
    else res.end();
  });
  return app;
}

function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const host = requestHost(req);
  if (isStudioHost(host)) {
    // the Studio's own WebSocket — only over TLS
    if (studioUpgrade && (socket as Duplex & { encrypted?: boolean }).encrypted) studioUpgrade(req, socket, head);
    else socket.destroy();
    return;
  }
  const site = siteForHost(host, isPrivateAddress(req.socket.remoteAddress));
  if (!site || !site.enabled || ownerActive.get(site.id) === false) {
    socket.destroy();
    return;
  }
  const s = site.settings ?? {};
  if (s.mode === 'server' && s.serviceId) return wholeSiteUpgrade(req, socket, head, s.serviceId, site.owner_id);
  if ((req.url ?? '').startsWith('/srv/')) return srvUpgrade(req, socket, head, { ownerId: site.owner_id });
  socket.destroy();
}

let sitesServer: http.Server | null = null;
let sitesTlsServer: https.Server | null = null;

export function startSitesServer(): void {
  if (!config.sites.enabled) {
    console.log('[sites] website hosting is switched off (SITES_ENABLED=false)');
    return;
  }
  const app = buildSitesApp();
  const server = http.createServer(app);
  server.headersTimeout = 60_000;
  server.requestTimeout = 300_000;
  server.on('upgrade', onUpgrade);
  server.on('error', (err) => console.error(`[sites] cannot listen on port ${config.sites.listenPort}: ${err.message}`));
  server.listen(config.sites.listenPort, config.host, () => {
    console.log(`[sites] websites on port ${config.sites.listenPort} (reached as ${scheme()}://<domain>${portSuffix()})`);
  });
  sitesServer = server;
  if (!tlsEnabled()) return;
  // built-in HTTPS: the same websites over TLS, the certificate is chosen per domain (certs.ts)
  try {
    const fb = fallbackCertificate();
    const secure = https.createServer({ cert: fb.cert, key: fb.key, SNICallback: sniCallback, minVersion: 'TLSv1.2' }, app);
    secure.headersTimeout = 60_000;
    secure.requestTimeout = 0; // the Studio's own website (uploads, long polls) can be served here too
    secure.on('upgrade', onUpgrade);
    secure.on('tlsClientError', () => {
      /* scanners and clients that refuse the certificate — not worth a log line */
    });
    secure.on('error', (err) => {
      tlsListening = false;
      console.error(`[sites] cannot listen on TLS port ${config.sites.tls.listenPort}: ${err.message}`);
    });
    secure.listen(config.sites.tls.listenPort, config.host, () => {
      tlsListening = true;
      console.log(`[sites] HTTPS on port ${config.sites.tls.listenPort} (reached as https://<domain>${tlsPortSuffix()}) — certificates per domain`);
    });
    sitesTlsServer = secure;
  } catch (err) {
    console.error(`[sites] HTTPS is not available: ${(err as Error).message}`);
  }
}

export function stopSitesServer(): void {
  sitesServer?.close();
  sitesTlsServer?.close();
}

export async function initSites(): Promise<void> {
  instanceId = await getSetting<string>('sites.instance', '');
  if (!instanceId) {
    instanceId = crypto.randomUUID();
    await setSetting('sites.instance', instanceId);
  }
  await reloadAll();
  // certificates: which hosts exist, and which of them are live (may get automatic certificates)
  setTlsHostProvider(() => {
    const out: { host: string; kind: TlsKind; active: boolean }[] = [];
    for (const row of rows.values()) {
      const active = servable(row);
      for (const d of siteDomains.get(row.id) ?? []) out.push({ host: d, kind: 'site', active });
      const bh = baseHost(row);
      if (bh) out.push({ host: bh, kind: 'site', active });
    }
    return out;
  });
  onTlsChange((host) => {
    const row = siteForHost(host);
    if (row) changed(row);
  });
  await initCerts().catch((err) => console.error('[sites] HTTPS could not be prepared:', (err as Error).message));
  // files of websites that no longer exist (deleted while the Studio was down)
  for (const name of await fsp.readdir(config.sitesDir).catch(() => [] as string[])) {
    const id = /^\d+$/.test(name) ? Number(name) : NaN;
    if (Number.isInteger(id) && !rows.has(id)) await fsp.rm(path.join(config.sitesDir, name), { recursive: true, force: true }).catch(() => {});
  }
  setInterval(() => void reloadAll().catch(() => {}), 60_000).unref();
}

// ---------------------------------------------------------------------------
// Website routes
// ---------------------------------------------------------------------------
export const sitesRouter = Router();

const publishBody = z.object({
  root: z.string().trim().max(255).optional(),
  build: z.string().trim().max(1000).optional(),
  spa: z.boolean().optional(),
});

const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(SLUG_RE, 'name: 2–63 characters, a-z, 0-9 and - (not at the start or end)');

const settingsSchema = z.object({
  root: z.string().trim().max(255).optional(),
  build: z.string().trim().max(1000).optional(),
  spa: z.boolean().optional(),
  mode: z.enum(['static', 'server']).optional(),
  serviceId: z.number().int().positive().nullable().optional(),
});

sitesRouter.get('/sites', async (req, res) => {
  const list = await q<{ id: number; project_name: string; project_area: string }>(
    `SELECT s.id, p.name AS project_name, p.area AS project_area FROM sites s JOIN projects p ON p.id = s.project_id
      WHERE s.owner_id = ? ORDER BY s.created_at DESC`,
    [req.user!.id],
  );
  const sites = [];
  for (const r of list) {
    const row = rows.get(r.id) ?? (await reloadRow(r.id).catch(() => null));
    if (row) sites.push({ ...publicSite(row), projectName: r.project_name, projectArea: r.project_area });
  }
  res.json({ sites, hosting: await hostingInfo() });
});

sitesRouter.get('/projects/:id/site', async (req, res) => {
  const { project, su, dir } = await loadOwnedProject(req.user!, intParam(req.params.id));
  const row = siteOfProject(project.id);
  res.json({
    site: row ? publicSite(row) : null,
    log: row ? logOf(row) : [],
    releases: row ? await releaseNumbers(row.id) : [],
    suggestedRoot: await publishRoot(su, dir, project, row?.settings?.root).catch(() => '.'),
    servers: servicesOfProjectSync(project.id).map((s) => ({ id: s.id, name: s.name, slug: s.slug, state: s.state })),
    suggested: !!getArea(project.area)?.sites,
    hosting: await hostingInfo(),
  });
});

sitesRouter.post('/projects/:id/site/publish', async (req, res) => {
  const { project } = await loadOwnedProject(req.user!, intParam(req.params.id));
  const body = parse(publishBody, req.body ?? {});
  const row = await createSite(project);
  const outcome = publishSite(row.id, `published by ${req.user!.username}`, body).then(
    () => ({ ok: true as const }),
    (err: unknown) => ({ ok: false as const, err }),
  );
  // small websites are done at once; builds continue in the background (progress over the WebSocket)
  const r = await Promise.race([outcome, new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000))]);
  if (r && !r.ok) throw r.err;
  const fresh = rows.get(row.id) ?? row;
  res.json({ site: publicSite(fresh), done: !!r, log: logOf(fresh) });
});

sitesRouter.get('/sites/:id', async (req, res) => {
  const row = await ownedSite(req.user!, intParam(req.params.id));
  const project = await getProjectRow(row.project_id);
  res.json({
    site: publicSite(row),
    project: project ? { id: project.id, name: project.name, area: project.area } : null,
    log: logOf(row),
    releases: await releaseNumbers(row.id),
  });
});

sitesRouter.patch('/sites/:id', async (req, res) => {
  const row = await ownedSite(req.user!, intParam(req.params.id));
  const body = parse(z.object({ enabled: z.boolean().optional(), slug: slugSchema.optional(), settings: settingsSchema.optional() }), req.body);
  const fresh = await updateSite(row, body, req.user!.username);
  res.json({ site: publicSite(fresh) });
});

sitesRouter.post('/sites/:id/domains', async (req, res) => {
  const row = await ownedSite(req.user!, intParam(req.params.id));
  const body = parse(z.object({ domain: z.string().trim().min(1).max(300) }), req.body);
  const domain = await addDomain(row, body.domain, req.user!.username);
  res.status(201).json({ domain, site: publicSite(rows.get(row.id) ?? row) });
});

sitesRouter.delete('/sites/:id/domains/:domain', async (req, res) => {
  const row = await ownedSite(req.user!, intParam(req.params.id));
  await removeDomain(row, String(req.params.domain), req.user!.username);
  res.json({ site: publicSite(rows.get(row.id) ?? row) });
});

sitesRouter.post('/sites/:id/domains/:domain/check', async (req, res) => {
  const row = await ownedSite(req.user!, intParam(req.params.id));
  const d = String(req.params.domain).toLowerCase();
  const own = (siteDomains.get(row.id) ?? []).includes(d) || (config.sites.baseDomain && d === `${row.slug}.${config.sites.baseDomain}`);
  if (!own) throw notFound('This domain does not belong to the website');
  res.json(await checkDomain(d));
});

// ---- HTTPS: the certificate of one host of a website --------------------------------
function ownHost(row: SiteRow, raw: unknown): string {
  const d = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  const own = (siteDomains.get(row.id) ?? []).includes(d) || d === baseHost(row);
  if (!own) throw notFound('This domain does not belong to the website');
  if (!tlsEnabled()) throw new HttpError(409, 'The built-in HTTPS is switched off on this Studio (SITES_TLS=false)');
  if (config.sites.https) throw new HttpError(409, 'A reverse proxy in front of this Studio handles HTTPS (SITES_HTTPS=true) — certificates are managed there');
  return d;
}

const tlsOptionsSchema = z.object({ mode: z.enum(TLS_MODES as [string, ...string[]]).optional(), forceHttps: z.boolean().optional(), hsts: z.boolean().optional() });
const certificateSchema = z.object({ cert: z.string().min(50).max(100_000), key: z.string().min(50).max(40_000), passphrase: z.string().max(500).optional() });

sitesRouter.patch('/sites/:id/domains/:domain/tls', async (req, res) => {
  const row = await ownedSite(req.user!, intParam(req.params.id));
  const d = ownHost(row, req.params.domain);
  const body = parse(tlsOptionsSchema, req.body);
  await setTlsOptions(d, 'site', body as Parameters<typeof setTlsOptions>[2]);
  log(row.id, `HTTPS of ${d}: ${Object.entries(body).map(([k, v]) => `${k} = ${v}`).join(', ')} (${req.user!.username})`);
  res.json({ tls: publicTls(d), site: publicSite(rows.get(row.id) ?? row) });
});

sitesRouter.post('/sites/:id/domains/:domain/tls/issue', async (req, res) => {
  const row = await ownedSite(req.user!, intParam(req.params.id));
  const d = ownHost(row, req.params.domain);
  if (!servable(row)) throw new HttpError(409, 'Publish the website first — certificates are issued for live websites');
  await requestCertificate(d, 'site');
  log(row.id, `Certificate for ${d} requested (${req.user!.username})`);
  res.json({ tls: publicTls(d), site: publicSite(rows.get(row.id) ?? row) });
});

sitesRouter.put('/sites/:id/domains/:domain/tls/certificate', async (req, res) => {
  const row = await ownedSite(req.user!, intParam(req.params.id));
  const d = ownHost(row, req.params.domain);
  const body = parse(certificateSchema, req.body);
  const t = await uploadCertificate(d, 'site', body);
  log(row.id, `Certificate for ${d} uploaded (${t.issuer ?? 'unknown issuer'}, valid until ${t.notAfter ? new Date(t.notAfter).toISOString().slice(0, 10) : '?'}) (${req.user!.username})`);
  res.json({ tls: t, site: publicSite(rows.get(row.id) ?? row) });
});

sitesRouter.delete('/sites/:id/domains/:domain/tls/certificate', async (req, res) => {
  const row = await ownedSite(req.user!, intParam(req.params.id));
  const d = ownHost(row, req.params.domain);
  await deleteCertificate(d);
  log(row.id, `Certificate of ${d} removed (${req.user!.username})`);
  res.json({ tls: publicTls(d), site: publicSite(rows.get(row.id) ?? row) });
});

/** The public certificate (chain) as a PEM file — never the private key. */
sitesRouter.get('/sites/:id/domains/:domain/tls/certificate', async (req, res) => {
  const row = await ownedSite(req.user!, intParam(req.params.id));
  const d = ownHost(row, req.params.domain);
  const pem = certificatePem(d);
  if (!pem) throw notFound('This host has no certificate yet');
  res.setHeader('Content-Type', 'application/x-pem-file');
  res.setHeader('Content-Disposition', `attachment; filename="${d.replace(/[^a-z0-9.-]/g, '_')}.pem"`);
  res.end(pem);
});

// ---- HTTPS: admin (certificate authority, the Studio's own domain, every certificate) ----
sitesRouter.get('/admin/tls', async (_req, res) => {
  res.json({ tls: await tlsOverview() });
});

sitesRouter.put('/admin/tls', async (req, res) => {
  const body = parse(
    z.object({
      acme: z
        .object({
          enabled: z.boolean(),
          email: z.string().trim().max(255),
          directory: z.enum(['letsencrypt', 'letsencrypt-staging', 'custom']),
          directoryUrl: z.string().trim().max(500),
          agreedTos: z.boolean(),
        })
        .partial()
        .optional(),
      studioDomain: z.string().trim().max(253).optional(),
    }),
    req.body,
  );
  if (body.studioDomain !== undefined) {
    const d = body.studioDomain.toLowerCase();
    if (d && (domainIndex.has(d) || siteForHost(d))) throw new HttpError(409, `${d} is the address of a website on this Studio`);
    await setStudioDomain(body.studioDomain);
  }
  if (body.acme) await saveAcmeSettings(body.acme);
  res.json({ tls: await tlsOverview() });
});

/** Admin actions on one host: a website domain, the Studio's own domain or a wildcard ("*.example.com"). */
function adminHost(raw: unknown): { host: string; kind: TlsKind } {
  const host = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  if (!tlsEnabled()) throw new HttpError(409, 'The built-in HTTPS is switched off on this Studio (SITES_TLS=false)');
  if (host.startsWith('*.') && DOMAIN_RE.test(host.slice(2))) return { host, kind: 'wildcard' };
  if (host && host === studioTlsDomain()) return { host, kind: 'studio' };
  if (siteForHost(host)) return { host, kind: 'site' };
  throw notFound(`${host || 'this host'} is not served by this Studio — add it as a website domain or as the Studio's own domain first`);
}

sitesRouter.patch('/admin/tls/hosts/:host', async (req, res) => {
  const { host, kind } = adminHost(req.params.host);
  await setTlsOptions(host, kind, parse(tlsOptionsSchema, req.body) as Parameters<typeof setTlsOptions>[2]);
  res.json({ tls: await tlsOverview() });
});

sitesRouter.post('/admin/tls/hosts/:host/issue', async (req, res) => {
  const { host, kind } = adminHost(req.params.host);
  await requestCertificate(host, kind);
  res.json({ tls: await tlsOverview() });
});

sitesRouter.put('/admin/tls/hosts/:host/certificate', async (req, res) => {
  const { host, kind } = adminHost(req.params.host);
  await uploadCertificate(host, kind, parse(certificateSchema, req.body));
  res.json({ tls: await tlsOverview() });
});

sitesRouter.delete('/admin/tls/hosts/:host/certificate', async (req, res) => {
  const { host } = adminHost(req.params.host);
  await deleteCertificate(host);
  res.json({ tls: await tlsOverview() });
});

sitesRouter.get('/admin/tls/hosts/:host/certificate', async (req, res) => {
  const { host } = adminHost(req.params.host);
  const pem = certificatePem(host);
  if (!pem) throw notFound('This host has no certificate yet');
  res.setHeader('Content-Type', 'application/x-pem-file');
  res.setHeader('Content-Disposition', `attachment; filename="${host.replace(/^[*]/, 'wildcard').replace(/[^a-z0-9.-]/g, '_')}.pem"`);
  res.end(pem);
});

sitesRouter.post('/sites/:id/rollback', async (req, res) => {
  const row = await ownedSite(req.user!, intParam(req.params.id));
  const body = parse(z.object({ release: z.number().int().positive() }), req.body);
  await rollbackSite(row, body.release, req.user!.username);
  res.json({ site: publicSite(rows.get(row.id) ?? row) });
});

sitesRouter.delete('/sites/:id', async (req, res) => {
  const row = await ownedSite(req.user!, intParam(req.params.id));
  await deleteSite(row.id);
  res.json({ ok: true });
});

/** Admin: every website on this Studio (actions use the routes above — admins may act on any website). */
sitesRouter.get('/admin/sites', async (_req, res) => {
  const list = await q<{ id: number; username: string; project_name: string }>(
    `SELECT s.id, u.username, p.name AS project_name FROM sites s
       JOIN users u ON u.id = s.owner_id JOIN projects p ON p.id = s.project_id ORDER BY s.id`,
  );
  const sites = [];
  for (const r of list) {
    const row = rows.get(r.id) ?? (await reloadRow(r.id).catch(() => null));
    if (row) sites.push({ ...publicSite(row), owner: r.username, projectName: r.project_name });
  }
  res.json({ sites, hosting: await hostingInfo() });
});

// ---------------------------------------------------------------------------
// Agent routes (bearer STUDIO_TOKEN) — `studio site` inside Claude sessions
// ---------------------------------------------------------------------------
export const sitesAgentRouter = Router();

function agentReport(row: SiteRow, tail = 30) {
  return { site: publicSite(row), log: logOf(row).slice(-tail) };
}

sitesAgentRouter.get('/agent/site', async (req, res) => {
  const { project, su, dir } = await agentContext(req);
  const row = siteOfProject(project.id);
  res.json({
    ...(row ? agentReport(row) : { site: null, log: [] }),
    suggestedRoot: await publishRoot(su, dir, project, row?.settings?.root).catch(() => '.'),
    hosting: await hostingInfo(),
  });
});

/** Create (if needed) + publish and wait — Claude gets the result and the addresses at once. */
sitesAgentRouter.post('/agent/site/publish', async (req, res) => {
  const { project } = await agentContext(req);
  const body = parse(publishBody, req.body ?? {});
  const row = await createSite(project);
  try {
    await publishSite(row.id, 'published by Claude', body);
  } catch (err) {
    const tail = logOf(rows.get(row.id) ?? row).slice(-25);
    throw new HttpError(err instanceof HttpError ? err.status : 400, `${(err as Error).message}\n--- publish log ---\n${tail.join('\n')}`);
  }
  res.json(agentReport(rows.get(row.id) ?? row));
});

sitesAgentRouter.patch('/agent/site', async (req, res) => {
  const { project } = await agentContext(req);
  const row = siteOfProject(project.id);
  if (!row) throw notFound('this project has no website yet — run: studio site publish');
  const body = parse(z.object({ enabled: z.boolean().optional(), slug: slugSchema.optional(), settings: settingsSchema.optional() }), req.body ?? {});
  res.json(agentReport(await updateSite(row, body, 'Claude')));
});

sitesAgentRouter.post('/agent/site/domains', async (req, res) => {
  const { project } = await agentContext(req);
  const row = siteOfProject(project.id);
  if (!row) throw notFound('this project has no website yet — run: studio site publish');
  const body = parse(z.object({ add: z.array(z.string().max(300)).max(20).optional(), remove: z.array(z.string().max(300)).max(20).optional() }), req.body ?? {});
  const errors: string[] = [];
  for (const d of body.add ?? []) await addDomain(row, d, 'Claude').catch((err: Error) => errors.push(err.message));
  for (const d of body.remove ?? []) await removeDomain(row, d, 'Claude').catch((err: Error) => errors.push(err.message));
  res.json({ ...agentReport(rows.get(row.id) ?? row, 5), errors });
});

/** `studio site cert [issue] [domain]` — HTTPS state of the website's hosts, or request certificates now. */
sitesAgentRouter.post('/agent/site/tls', async (req, res) => {
  const { project } = await agentContext(req);
  const row = siteOfProject(project.id);
  if (!row) throw notFound('this project has no website yet — run: studio site publish');
  const body = parse(z.object({ action: z.enum(['status', 'issue']).default('status'), domain: z.string().max(300).optional() }), req.body ?? {});
  const all = [...(siteDomains.get(row.id) ?? []), ...(baseHost(row) ? [baseHost(row)!] : [])];
  const wanted = body.domain ? [ownHost(row, body.domain)] : all;
  const errors: string[] = [];
  if (body.action === 'issue') {
    if (!servable(row)) throw new HttpError(409, 'publish the website first — certificates are issued for live websites');
    for (const d of wanted) await requestCertificate(d, 'site').catch((err: Error) => errors.push(`${d}: ${err.message}`));
  }
  res.json({ hosts: wanted.map((d) => publicTls(d)), hosting: await hostingInfo(), errors, site: publicSite(row) });
});

sitesAgentRouter.post('/agent/site/check', async (req, res) => {
  const { project } = await agentContext(req);
  const row = siteOfProject(project.id);
  if (!row) throw notFound('this project has no website yet — run: studio site publish');
  const results = [];
  for (const d of siteDomains.get(row.id) ?? []) results.push({ domain: d, ...(await checkDomain(d)) });
  res.json({ results });
});
