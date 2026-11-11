/**
 * HTTPS certificates per host name — the built-in TLS of the website port.
 *
 * Every host the Studio serves (a website's own domains, <name>.<base domain>, the Studio's own
 * domain) has a row in `tls_hosts` that says how it gets its certificate:
 *   auto        Let's Encrypt (or any ACME CA): issued and renewed by the Studio itself. The CA
 *               checks the domain with an HTTP request to port 80 (/.well-known/acme-challenge/…),
 *               which the website port answers.
 *   custom      a certificate + private key the user uploaded (from their own CA, Cloudflare origin
 *               certificates …); wildcard certificates ("*.example.com") cover all sub-domains
 *   selfsigned  generated here — for tests and private networks (browsers warn)
 *   off         no HTTPS for this host
 * The TLS listener picks the certificate by SNI. Private keys are stored encrypted (APP_SECRET).
 * Nothing here is needed when another reverse proxy terminates TLS (SITES_HTTPS=true).
 */
import 'reflect-metadata';
import crypto from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import * as x509 from '@peculiar/x509';
import acme from 'acme-client';
import { config } from './config.js';
import { exec, q } from './db.js';
import { decryptSecret, encryptSecret } from './lib/crypto.js';
import { HttpError } from './lib/http.js';
import { getSetting, setSetting } from './settings.js';

export type TlsMode = 'auto' | 'custom' | 'selfsigned' | 'off';
export type TlsKind = 'site' | 'studio' | 'wildcard';
export const TLS_MODES: TlsMode[] = ['auto', 'custom', 'selfsigned', 'off'];

interface HostRow {
  host: string;
  kind: TlsKind;
  mode: TlsMode;
  force_https: number;
  hsts: number;
  source: 'acme' | 'custom' | 'selfsigned' | null;
  cert_pem: string | null;
  key_enc: string | null;
  issuer: string | null;
  names: string | null;
  not_before: Date | null;
  not_after: Date | null;
  status: 'none' | 'pending' | 'active' | 'error';
  last_error: string | null;
  attempts: number;
  next_try_at: Date | null;
  issued_at: Date | null;
}

export interface AcmeSettings {
  /** issue certificates automatically for hosts in "auto" mode */
  enabled: boolean;
  /** contact address for the CA (expiry warnings) */
  email: string;
  directory: 'letsencrypt' | 'letsencrypt-staging' | 'custom';
  /** ACME directory of another CA (ZeroSSL, step-ca, a company CA …) */
  directoryUrl: string;
  /** the admin accepted the CA's terms of service (subscriber agreement) */
  agreedTos: boolean;
}

const RENEW_DAYS = 30;
/** new certificate orders per hour for the whole Studio — the CA's own limits are per account */
const ORDERS_PER_HOUR = Math.max(5, Number.parseInt(process.env.ACME_ORDERS_PER_HOUR ?? '', 10) || 40);
/** start times of the recent orders */
const recentOrders: number[] = [];
function ordersLastHour(): number {
  const cut = Date.now() - 3600_000;
  while (recentOrders.length && recentOrders[0] < cut) recentOrders.shift();
  return recentOrders.length;
}
/** "get it now" per host: when it was last pressed */
const lastManual = new Map<string, number>();
const BACKOFF_MIN = [5, 15, 60, 180, 360, 720, 1440];
const LE_PROD = 'https://acme-v02.api.letsencrypt.org/directory';
const LE_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';

const hosts = new Map<string, HostRow>();
const contexts = new Map<string, tls.SecureContext>();
const challenges = new Map<string, string>();
const queued = new Set<string>();
/** "get it now" was pressed: renew even though the certificate is still good */
const forced = new Set<string>();
let chain: Promise<void> = Promise.resolve();
let fallback: { cert: string; key: string; ctx: tls.SecureContext } | null = null;
let acmeCache: AcmeSettings | null = null;
let studioDomain = '';
let ready = false;

export interface WantedHost {
  host: string;
  kind: TlsKind;
  /** the host is live (a published website …): automatic certificates may be requested */
  active: boolean;
}
let provider: () => WantedHost[] = () => [];
const listeners: ((host: string) => void)[] = [];

/** sites.ts tells which hosts exist (so this module needs no knowledge of websites). */
export function setTlsHostProvider(fn: () => WantedHost[]): void {
  provider = fn;
}
export function onTlsChange(fn: (host: string) => void): void {
  listeners.push(fn);
}
function changed(host: string): void {
  for (const fn of listeners) {
    try {
      fn(host);
    } catch (err) {
      console.error('[tls] listener', err);
    }
  }
}

export function tlsEnabled(): boolean {
  // an external TLS proxy in front (SITES_HTTPS=true, e.g. the Caddy profile) gets the certificates itself
  return config.sites.enabled && config.sites.tls.enabled && !config.sites.https;
}

// ---------------------------------------------------------------------------
// Certificates: parsing, validation, self-signed
// ---------------------------------------------------------------------------
const PEM_CERT = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

function splitChain(pem: string): string[] {
  return (pem.match(PEM_CERT) ?? []).map((c) => c.trim() + '\n');
}

function cn(dn: string): string {
  const m = /(?:^|\n)CN=([^\n]+)/.exec(dn) ?? /(?:^|\n)O=([^\n]+)/.exec(dn);
  return (m?.[1] ?? dn.split('\n')[0] ?? '').slice(0, 250);
}

function validDate(c: crypto.X509Certificate, which: 'from' | 'to'): Date {
  const d = which === 'from' ? (c.validFromDate ?? new Date(c.validFrom)) : (c.validToDate ?? new Date(c.validTo));
  return new Date(d);
}

interface CertFacts {
  issuer: string;
  names: string[];
  notBefore: Date;
  notAfter: Date;
  selfSigned: boolean;
}

function readCert(pem: string): { leaf: crypto.X509Certificate; facts: CertFacts; chain: string[] } {
  const chainPems = splitChain(pem);
  if (!chainPems.length) throw new HttpError(400, 'No certificate found — paste the PEM text (-----BEGIN CERTIFICATE----- …), the certificate first, then its chain');
  let leaf: crypto.X509Certificate;
  try {
    leaf = new crypto.X509Certificate(chainPems[0]);
    for (const c of chainPems.slice(1)) new crypto.X509Certificate(c);
  } catch (err) {
    throw new HttpError(400, `The certificate cannot be read: ${(err as Error).message}`);
  }
  const names = (leaf.subjectAltName ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('DNS:'))
    .map((s) => s.slice(4).toLowerCase());
  const subjectCn = cn(leaf.subject).toLowerCase();
  if (!names.length && subjectCn) names.push(subjectCn);
  return {
    leaf,
    chain: chainPems,
    facts: {
      issuer: cn(leaf.issuer),
      names,
      notBefore: validDate(leaf, 'from'),
      notAfter: validDate(leaf, 'to'),
      selfSigned: leaf.issuer === leaf.subject,
    },
  };
}

/** Does a certificate name (possibly "*.example.com") cover this host (possibly a wildcard itself)? */
function covers(names: string[], host: string): boolean {
  const h = host.toLowerCase();
  for (const n of names) {
    if (n === h) return true;
    if (n.startsWith('*.')) {
      const parent = n.slice(2);
      const rest = h.startsWith('*.') ? h.slice(2) : h.slice(h.indexOf('.') + 1);
      if (rest === parent && (h.startsWith('*.') || h.indexOf('.') > 0)) return true;
    }
  }
  return false;
}

function normalizeKey(pem: string, passphrase?: string): string {
  let key: crypto.KeyObject;
  try {
    key = crypto.createPrivateKey({ key: pem, format: 'pem', ...(passphrase ? { passphrase } : {}) });
  } catch (err) {
    const msg = (err as Error).message;
    throw new HttpError(
      400,
      /passphrase|bad decrypt|interrupted/i.test(msg)
        ? 'The private key is encrypted — enter its passphrase (it is only used to read the key)'
        : `The private key cannot be read (expected PEM: -----BEGIN PRIVATE KEY----- …): ${msg}`,
    );
  }
  if (!['rsa', 'ec', 'ed25519'].includes(String(key.asymmetricKeyType))) throw new HttpError(400, `Unsupported key type "${key.asymmetricKeyType}" — use RSA or ECDSA`);
  return key.export({ type: 'pkcs8', format: 'pem' }).toString();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
x509.cryptoProvider.set(crypto.webcrypto as any);

async function selfSigned(host: string, days: number): Promise<{ cert: string; key: string }> {
  const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
  const keys = (await crypto.webcrypto.subtle.generateKey(alg, true, ['sign', 'verify'])) as crypto.webcrypto.CryptoKeyPair;
  const san: { type: 'dns' | 'ip'; value: string }[] = [{ type: net.isIP(host) ? 'ip' : 'dns', value: host }];
  if (host === 'localhost') san.push({ type: 'ip', value: '127.0.0.1' });
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: `01${crypto.randomBytes(8).toString('hex')}`,
    name: `CN=${host.replace(/[,+="<>#;\\]/g, '_')}`,
    notBefore: new Date(Date.now() - 3600_000),
    notAfter: new Date(Date.now() + days * 86400_000),
    signingAlgorithm: alg,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment, true),
      new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1'], false),
      new x509.SubjectAlternativeNameExtension(san, false),
    ],
  });
  const pkcs8 = await crypto.webcrypto.subtle.exportKey('pkcs8', keys.privateKey);
  return { cert: cert.toString('pem') + '\n', key: x509.PemConverter.encode(pkcs8, 'PRIVATE KEY') + '\n' };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
function daysLeft(row: HostRow): number | null {
  return row.not_after ? Math.floor((new Date(row.not_after).getTime() - Date.now()) / 86400_000) : null;
}

/**
 * Time to renew: 30 days before the end — or, for short-lived certificates (45-day and 6-day
 * ones, private CAs that issue for hours), when a third of the lifetime is left. A fixed 30 days
 * would renew those again and again right after they were issued.
 */
function renewDue(row: HostRow): boolean {
  if (!row.not_after) return false;
  const end = new Date(row.not_after).getTime();
  const start = row.not_before ? new Date(row.not_before).getTime() : end - 90 * 86400_000;
  const life = Math.max(end - start, 3600_000);
  return end - Date.now() < Math.min(RENEW_DAYS * 86400_000, life / 3);
}

function usable(row: HostRow): boolean {
  return row.mode !== 'off' && !!row.cert_pem && !!row.key_enc && !!row.not_after && new Date(row.not_after).getTime() > Date.now();
}

function rebuild(host: string): void {
  const row = hosts.get(host);
  contexts.delete(host);
  if (!row || !usable(row)) return;
  try {
    contexts.set(host, tls.createSecureContext({ cert: row.cert_pem!, key: decryptSecret(row.key_enc!) }));
  } catch (err) {
    console.error(`[tls] certificate of ${host} cannot be loaded: ${(err as Error).message}`);
  }
}

function wildcardFor(host: string): string | null {
  const i = host.indexOf('.');
  if (i <= 0 || host.startsWith('*.')) return null;
  const w = `*.${host.slice(i + 1)}`;
  return contexts.has(w) ? w : null;
}

/** HTTPS works for this host right now (its own certificate or a wildcard one). */
export function httpsActive(host: string): boolean {
  if (!ready || !tlsEnabled()) return false;
  const row = hosts.get(host);
  if (row?.mode === 'off') return false;
  return contexts.has(host) || !!wildcardFor(host);
}

/** HTTP requests for this host should be redirected to HTTPS. */
export function httpsForced(host: string): boolean {
  if (!httpsActive(host)) return false;
  const row = hosts.get(host);
  return row ? !!row.force_https : true;
}

export function hstsFor(host: string): boolean {
  return !!hosts.get(host)?.hsts && httpsActive(host);
}

export function sniCallback(servername: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void): void {
  const name = (servername || '').toLowerCase();
  const row = hosts.get(name);
  const own = row?.mode === 'off' ? undefined : contexts.get(name);
  const w = own ? null : row?.mode === 'off' ? null : wildcardFor(name);
  cb(null, own ?? (w ? contexts.get(w) : undefined) ?? fallback?.ctx);
}

/** Certificate and key for clients that send no server name (and for unknown hosts). */
export function fallbackCertificate(): { cert: string; key: string } {
  if (!fallback) throw new Error('TLS is not initialised');
  return { cert: fallback.cert, key: fallback.key };
}

export function acmeChallenge(token: string): string | undefined {
  return challenges.get(token);
}

export function publicTls(host: string) {
  const row = hosts.get(host);
  const w = wildcardFor(host);
  const wRow = w ? hosts.get(w) : undefined;
  const shown = row && (row.cert_pem || !wRow) ? row : (wRow ?? row);
  const left = shown ? daysLeft(shown) : null;
  const expired = !!shown?.cert_pem && left !== null && left < 0;
  const mode: TlsMode = row?.mode ?? 'auto';
  const https = httpsActive(host);
  let status: 'active' | 'pending' | 'error' | 'none' | 'off' | 'expired';
  if (mode === 'off') status = 'off';
  else if (https) status = 'active';
  else if (expired) status = 'expired';
  else if (queued.has(host) || row?.status === 'pending') status = 'pending';
  else if (row?.status === 'error') status = 'error';
  else status = 'none';
  return {
    host,
    mode,
    status,
    https,
    forceHttps: row ? !!row.force_https : true,
    hsts: !!row?.hsts,
    source: shown?.cert_pem ? shown.source : null,
    issuer: shown?.cert_pem ? shown.issuer : null,
    names: shown?.cert_pem && shown.names ? shown.names.split(',') : [],
    notBefore: shown?.cert_pem ? shown.not_before : null,
    notAfter: shown?.cert_pem ? shown.not_after : null,
    daysLeft: shown?.cert_pem ? left : null,
    viaWildcard: !row?.cert_pem && w ? w : null,
    error: row?.status === 'error' || (mode === 'auto' && !https) ? (row?.last_error ?? null) : null,
    attempts: row?.attempts ?? 0,
    nextTryAt: row?.next_try_at ?? null,
    issuedAt: shown?.issued_at ?? null,
  };
}
export type PublicTls = ReturnType<typeof publicTls>;

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------
async function load(): Promise<void> {
  hosts.clear();
  contexts.clear();
  for (const r of await q<HostRow>('SELECT * FROM tls_hosts')) {
    hosts.set(r.host, r);
    rebuild(r.host);
  }
}

async function save(row: HostRow): Promise<void> {
  await exec(
    `INSERT INTO tls_hosts (host, kind, mode, force_https, hsts, source, cert_pem, key_enc, issuer, names, not_before, not_after,
                            status, last_error, attempts, next_try_at, issued_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE kind = VALUES(kind), mode = VALUES(mode), force_https = VALUES(force_https), hsts = VALUES(hsts),
       source = VALUES(source), cert_pem = VALUES(cert_pem), key_enc = VALUES(key_enc), issuer = VALUES(issuer), names = VALUES(names),
       not_before = VALUES(not_before), not_after = VALUES(not_after), status = VALUES(status), last_error = VALUES(last_error),
       attempts = VALUES(attempts), next_try_at = VALUES(next_try_at), issued_at = VALUES(issued_at)`,
    [
      row.host, row.kind, row.mode, row.force_https, row.hsts, row.source, row.cert_pem, row.key_enc, row.issuer, row.names,
      row.not_before, row.not_after, row.status, row.last_error, row.attempts, row.next_try_at, row.issued_at,
    ],
  );
  hosts.set(row.host, row);
  rebuild(row.host);
  changed(row.host);
}

function blank(host: string, kind: TlsKind): HostRow {
  return {
    host, kind, mode: kind === 'wildcard' ? 'custom' : 'auto', force_https: 1, hsts: 0, source: null, cert_pem: null, key_enc: null,
    issuer: null, names: null, not_before: null, not_after: null, status: 'none', last_error: null, attempts: 0, next_try_at: null, issued_at: null,
  };
}

function normHost(input: string): string {
  return input.trim().toLowerCase().replace(/\.$/, '');
}

async function rowFor(host: string, kind: TlsKind = 'site'): Promise<HostRow> {
  const h = normHost(host);
  let row = hosts.get(h);
  if (!row) {
    row = blank(h, kind);
    await save(row);
  } else if (row.kind !== kind && kind !== 'site') {
    row.kind = kind;
    await save(row);
  }
  return row;
}

async function store(row: HostRow, source: 'acme' | 'custom' | 'selfsigned', certPem: string, keyPem: string): Promise<void> {
  const { facts, chain: chainPems } = readCert(certPem);
  // refuse a pair that cannot be loaded before it replaces a working one
  tls.createSecureContext({ cert: chainPems.join(''), key: keyPem });
  Object.assign(row, {
    source,
    cert_pem: chainPems.join(''),
    key_enc: encryptSecret(keyPem),
    issuer: facts.selfSigned ? 'self-signed' : facts.issuer,
    names: facts.names.join(',').slice(0, 60000),
    not_before: facts.notBefore,
    not_after: facts.notAfter,
    status: 'active',
    last_error: null,
    attempts: 0,
    next_try_at: null,
    issued_at: new Date(),
  } satisfies Partial<HostRow>);
  await save(row);
}

/** The host leaves the Studio (domain removed, website deleted): its certificate goes too. */
export async function removeTlsHost(host: string): Promise<void> {
  const h = normHost(host);
  if (!hosts.has(h)) return;
  await exec('DELETE FROM tls_hosts WHERE host = ?', [h]);
  hosts.delete(h);
  contexts.delete(h);
  forced.delete(h);
  changed(h);
}

// ---------------------------------------------------------------------------
// ACME (Let's Encrypt and compatible CAs)
// ---------------------------------------------------------------------------
export async function acmeSettings(): Promise<AcmeSettings> {
  if (acmeCache) return acmeCache;
  const def: AcmeSettings = {
    enabled: config.acme.agreeTos,
    email: config.acme.email,
    directory: config.acme.directoryUrl ? 'custom' : 'letsencrypt',
    directoryUrl: config.acme.directoryUrl,
    agreedTos: config.acme.agreeTos,
  };
  acmeCache = { ...def, ...(await getSetting<Partial<AcmeSettings>>('tls.acme', {})) };
  return acmeCache;
}

export async function saveAcmeSettings(patch: Partial<AcmeSettings>): Promise<AcmeSettings> {
  const cur = await acmeSettings();
  const next: AcmeSettings = { ...cur, ...patch };
  next.email = next.email.trim();
  next.directoryUrl = next.directoryUrl.trim();
  if (next.directory === 'custom') {
    let ok = false;
    try {
      ok = new URL(next.directoryUrl).protocol === 'https:';
    } catch {
      /* invalid */
    }
    if (!ok) throw new HttpError(400, 'Enter the https:// address of the ACME directory');
  }
  if (next.enabled && !next.agreedTos) throw new HttpError(400, "Accept the certificate authority's terms of service to switch automatic certificates on");
  if (next.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email)) throw new HttpError(400, 'That is not an email address');
  await setSetting('tls.acme', next);
  acmeCache = next;
  if (next.enabled) {
    // hosts that failed while it was off get a fresh start
    for (const row of hosts.values()) {
      if (row.mode === 'auto' && row.status === 'error') {
        row.attempts = 0;
        row.next_try_at = null;
      }
    }
    void tick();
  }
  return next;
}

function directoryUrlOf(s: AcmeSettings): string {
  return s.directory === 'custom' ? s.directoryUrl : s.directory === 'letsencrypt-staging' ? LE_STAGING : LE_PROD;
}

function caName(s: AcmeSettings): string {
  if (s.directory === 'letsencrypt') return "Let's Encrypt";
  if (s.directory === 'letsencrypt-staging') return "Let's Encrypt (staging, test certificates)";
  try {
    return new URL(s.directoryUrl).host;
  } catch {
    return 'custom CA';
  }
}

interface AcmeAccount {
  keyEnc: string;
  url?: string;
}

async function accountFor(directoryUrl: string): Promise<{ key: string; url?: string; save: (url: string) => Promise<void> }> {
  const all = await getSetting<Record<string, AcmeAccount>>('tls.acme.accounts', {});
  let acc = all[directoryUrl];
  if (!acc) {
    acc = { keyEnc: encryptSecret((await acme.crypto.createPrivateEcdsaKey()).toString()) };
    await setSetting('tls.acme.accounts', { ...all, [directoryUrl]: acc });
  }
  return {
    key: decryptSecret(acc.keyEnc),
    url: acc.url,
    save: async (url: string) => {
      if (url === acc!.url) return;
      const cur = await getSetting<Record<string, AcmeAccount>>('tls.acme.accounts', {});
      await setSetting('tls.acme.accounts', { ...cur, [directoryUrl]: { ...acc!, url } });
    },
  };
}

const PRIVATE_SUFFIX = /(^|\.)(localhost|local|localdomain|test|invalid|example|internal|lan|home|corp|home\.arpa)$/;

/** A name a public certificate authority can validate. */
export function isPublicHostName(host: string): boolean {
  return host.includes('.') && !net.isIP(host) && !host.startsWith('*.') && !PRIVATE_SUFFIX.test(host);
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function acmeError(err: unknown, host: string): string {
  const e = err as Error & { response?: { data?: { detail?: string; type?: string } } };
  const detail = e.response?.data?.detail || e.message || String(err);
  let hint = '';
  if (/rateLimited|too many/i.test(detail)) hint = ' — the certificate authority limits requests; the Studio tries again later';
  else if (/unauthorized|connection|timeout|refused|NXDOMAIN|DNS problem|no valid (A|IP)/i.test(detail)) {
    hint = ` — the certificate authority must reach http://${host}/ on port 80 (DNS A/AAAA record → this server, website port published as port 80, firewall open)`;
  }
  return `${detail}${hint}`.slice(0, 1500);
}

async function issueAcme(row: HostRow): Promise<void> {
  const s = await acmeSettings();
  if (!s.enabled || !s.agreedTos) {
    throw new Error('Automatic certificates are switched off on this Studio — an admin switches them on in Admin → HTTPS (or upload a certificate)');
  }
  const host = row.host;
  if (host.startsWith('*.')) throw new Error('Wildcard certificates cannot be issued automatically (the check is an HTTP request) — upload one');
  if (s.directory !== 'custom' && !isPublicHostName(host)) {
    throw new Error(`${host} is not a public domain name — a public certificate authority cannot issue for it (use a self-signed or your own certificate)`);
  }
  try {
    await dns.promises.lookup(host);
  } catch {
    throw new Error(`${host} has no DNS record yet — create an A record (IPv4, and AAAA for IPv6) that points to this server`);
  }
  const directoryUrl = directoryUrlOf(s);
  const account = await accountFor(directoryUrl);
  const client = new acme.Client({ directoryUrl, accountKey: account.key, accountUrl: account.url });
  // (a common name holds 64 characters at most: longer names are in the alternative names only)
  const [key, csr] = await acme.crypto.createCsr({ ...(host.length <= 64 ? { commonName: host } : {}), altNames: [host] }, await acme.crypto.createPrivateEcdsaKey());
  recentOrders.push(Date.now());
  const tokens: string[] = [];
  try {
    const cert = await withTimeout(
      client.auto({
        csr,
        email: s.email || undefined,
        termsOfServiceAgreed: true,
        challengePriority: ['http-01'],
        // the CA decides: a self-check from inside a home network often cannot reach the public address
        skipChallengeVerification: true,
        challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
          if (challenge.type !== 'http-01') throw new Error(`the CA offered no HTTP check (${challenge.type})`);
          challenges.set(challenge.token, keyAuthorization);
          tokens.push(challenge.token);
        },
        challengeRemoveFn: async (_authz, challenge) => {
          challenges.delete(challenge.token);
        },
      }),
      4 * 60_000,
      'The certificate request',
    );
    try {
      await account.save(client.getAccountUrl());
    } catch {
      /* the account URL is only an optimisation */
    }
    await store(row, 'acme', cert.toString(), key.toString());
    console.log(`[tls] certificate for ${host} issued by ${caName(s)} (valid until ${row.not_after?.toISOString().slice(0, 10)})`);
  } finally {
    for (const t of tokens) challenges.delete(t);
  }
}

// ---------------------------------------------------------------------------
// Work queue
// ---------------------------------------------------------------------------
function needsWork(row: HostRow): boolean {
  if (forced.has(row.host) && (row.mode === 'auto' || row.mode === 'selfsigned')) return true;
  if (row.mode === 'auto') return !row.cert_pem || row.source !== 'acme' || renewDue(row);
  if (row.mode === 'selfsigned') return !row.cert_pem || row.source !== 'selfsigned' || renewDue(row);
  return false;
}

async function work(host: string): Promise<void> {
  const row = hosts.get(host);
  if (!row || !needsWork(row)) return;
  const wasForced = forced.delete(host);
  // the order budget of the whole Studio: many hosts that fail (or one user pressing "get it now"
  // in a loop) must not use up the CA's limits for everybody — wait, without counting it a failure
  if (row.mode === 'auto' && ordersLastHour() >= (wasForced ? ORDERS_PER_HOUR * 2 : ORDERS_PER_HOUR)) {
    row.next_try_at = new Date(Date.now() + 20 * 60_000);
    if (!usable(row)) row.last_error = 'Many certificates were requested in the last hour — this one is requested a little later.';
    await save(row).catch(() => {});
    return;
  }
  try {
    if (row.mode === 'selfsigned') {
      const c = await selfSigned(host, 397);
      await store(row, 'selfsigned', c.cert, c.key);
      return;
    }
    row.status = 'pending';
    changed(host);
    await issueAcme(row);
  } catch (err) {
    const still = hosts.get(host);
    if (!still) return;
    still.attempts += 1;
    still.status = usable(still) ? 'active' : 'error';
    still.last_error = row.mode === 'auto' ? acmeError(err, host) : String((err as Error).message).slice(0, 1500);
    still.next_try_at = new Date(Date.now() + BACKOFF_MIN[Math.min(still.attempts, BACKOFF_MIN.length) - 1] * 60_000);
    await save(still).catch(() => {});
    console.warn(`[tls] ${host}: ${still.last_error}`);
  }
}

function enqueue(host: string): void {
  if (queued.has(host)) return;
  queued.add(host);
  changed(host);
  chain = chain
    .then(() => work(host))
    .catch((err) => console.error('[tls] work', err))
    .finally(() => {
      queued.delete(host);
      changed(host);
    });
}

let ticking = false;
/** Looks at every host: new ones get a row, due ones are issued / renewed, gone ones are removed. */
export async function tick(): Promise<void> {
  if (!ready || !tlsEnabled() || ticking) return;
  ticking = true;
  try {
    const wanted = provider();
    if (studioDomain) wanted.push({ host: studioDomain, kind: 'studio', active: true });
    const known = new Set(wanted.map((w) => w.host));
    for (const w of wanted) {
      if (!hosts.has(w.host)) await save(blank(w.host, w.kind));
    }
    for (const row of [...hosts.values()]) {
      if (row.kind !== 'wildcard' && !known.has(row.host)) await removeTlsHost(row.host);
    }
    const s = await acmeSettings();
    const now = Date.now();
    for (const w of wanted) {
      const row = hosts.get(w.host);
      if (!row || !needsWork(row)) continue;
      if (row.mode === 'auto') {
        if (!w.active || !s.enabled || !s.agreedTos) continue;
        if (wildcardFor(row.host) && !row.cert_pem) continue; // covered by an uploaded wildcard certificate
        if (row.next_try_at && new Date(row.next_try_at).getTime() > now) continue;
      }
      enqueue(row.host);
    }
    for (const row of hosts.values()) if (row.kind === 'wildcard' && needsWork(row)) enqueue(row.host);
  } catch (err) {
    console.error('[tls] tick', err);
  } finally {
    ticking = false;
  }
}

// ---------------------------------------------------------------------------
// Operations (website owners and admins)
// ---------------------------------------------------------------------------
export async function setTlsOptions(host: string, kind: TlsKind, opts: { mode?: TlsMode; forceHttps?: boolean; hsts?: boolean }): Promise<PublicTls> {
  const row = await rowFor(host, kind);
  if (opts.mode && opts.mode !== row.mode) {
    if (row.host.startsWith('*.') && opts.mode === 'auto') throw new HttpError(400, 'Wildcard certificates cannot be issued automatically — upload one');
    // (switching to "custom" before the upload: the old certificate keeps serving until then)
    row.mode = opts.mode;
    // visitors of a self-signed host get a browser warning: do not push them there unless the owner says so
    if (opts.mode === "selfsigned" && opts.forceHttps === undefined) row.force_https = 0;
    row.attempts = 0;
    row.next_try_at = null;
    row.last_error = null;
    row.status = usable(row) ? 'active' : 'none';
  }
  if (opts.forceHttps !== undefined) row.force_https = opts.forceHttps ? 1 : 0;
  if (opts.hsts !== undefined) row.hsts = opts.hsts ? 1 : 0;
  await save(row);
  if (needsWork(row)) void tick();
  return publicTls(row.host);
}

/** "Get the certificate now": forgets the waiting time after failures and tries again. */
export async function requestCertificate(host: string, kind: TlsKind): Promise<PublicTls> {
  if (!tlsEnabled()) throw new HttpError(409, 'The built-in HTTPS is switched off on this Studio (SITES_TLS=false)');
  const row = await rowFor(host, kind);
  if (row.mode === 'custom') throw new HttpError(400, 'This host uses an uploaded certificate — upload a new one, or switch to "automatic"');
  if (row.mode === 'off') throw new HttpError(400, 'HTTPS is switched off for this host');
  if (row.mode === 'auto') {
    const s = await acmeSettings();
    if (!s.enabled || !s.agreedTos) throw new HttpError(409, 'Automatic certificates are switched off on this Studio — an admin switches them on in Admin → HTTPS');
    // certificate authorities count every order: no new one for a certificate that is fresh
    const issued = row.source === 'acme' && row.issued_at && usable(row) ? new Date(row.issued_at).getTime() : 0;
    if (issued && Date.now() - issued < 3600_000) {
      throw new HttpError(429, `This certificate was issued ${Math.max(1, Math.round((Date.now() - issued) / 60_000))} minutes ago — it is valid, nothing to do.`);
    }
    const last = lastManual.get(row.host) ?? 0;
    if (Date.now() - last < 60_000) throw new HttpError(429, 'A request for this certificate was just started — give it a minute.');
    lastManual.set(row.host, Date.now());
    if (lastManual.size > 5000) for (const [h, t] of lastManual) if (Date.now() - t > 3600_000) lastManual.delete(h);
  }
  row.attempts = 0;
  row.next_try_at = null;
  row.status = usable(row) ? 'active' : 'pending';
  forced.add(row.host);
  await save(row);
  enqueue(row.host);
  return publicTls(row.host);
}

export async function uploadCertificate(
  host: string,
  kind: TlsKind,
  input: { cert: string; key: string; passphrase?: string },
): Promise<PublicTls> {
  const h = normHost(host);
  const { leaf, facts, chain: chainPems } = readCert(input.cert);
  const keyPem = normalizeKey(input.key, input.passphrase);
  if (!leaf.checkPrivateKey(crypto.createPrivateKey(keyPem))) throw new HttpError(400, 'The private key does not belong to this certificate');
  if (facts.notAfter.getTime() < Date.now()) throw new HttpError(400, `This certificate expired on ${facts.notAfter.toISOString().slice(0, 10)}`);
  if (facts.notBefore.getTime() > Date.now() + 86400_000) throw new HttpError(400, `This certificate is not valid before ${facts.notBefore.toISOString().slice(0, 10)}`);
  if (!covers(facts.names, h)) {
    throw new HttpError(400, `This certificate is for ${facts.names.slice(0, 6).join(', ') || 'another name'} — not for ${h}`);
  }
  try {
    tls.createSecureContext({ cert: chainPems.join(''), key: keyPem });
  } catch (err) {
    throw new HttpError(400, `Certificate and key cannot be used together: ${(err as Error).message}`);
  }
  const row = await rowFor(h, kind);
  row.mode = 'custom';
  await store(row, 'custom', chainPems.join(''), keyPem);
  return publicTls(h);
}

/** Removes the stored certificate (the mode stays; "auto" gets a new one). */
export async function deleteCertificate(host: string): Promise<PublicTls> {
  const h = normHost(host);
  const row = hosts.get(h);
  if (!row) return publicTls(h);
  if (row.kind === 'wildcard') {
    await removeTlsHost(h);
    return publicTls(h);
  }
  Object.assign(row, { source: null, cert_pem: null, key_enc: null, issuer: null, names: null, not_before: null, not_after: null, status: 'none', last_error: null, attempts: 0, next_try_at: null, issued_at: null });
  await save(row);
  void tick();
  return publicTls(h);
}

/** The public certificate chain (PEM) — never the key. */
export function certificatePem(host: string): string | null {
  const h = normHost(host);
  return hosts.get(h)?.cert_pem ?? null;
}

// ---------------------------------------------------------------------------
// The Studio's own domain, admin overview
// ---------------------------------------------------------------------------
export function studioTlsDomain(): string {
  return studioDomain;
}

export async function setStudioDomain(input: string): Promise<string> {
  const d = normHost(input.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#:]/)[0] ?? '');
  if (d && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(d)) throw new HttpError(400, `"${input}" is not a host name`);
  const old = studioDomain;
  studioDomain = d;
  await setSetting('tls.studioDomain', d);
  if (old && old !== d) await removeTlsHost(old);
  void tick();
  return d;
}

export async function tlsOverview() {
  const s = await acmeSettings();
  return {
    enabled: tlsEnabled(),
    port: config.sites.tls.publicPort,
    httpPort: config.sites.publicPort,
    externalProxy: config.sites.https,
    studioDomain,
    acme: { ...s, ca: caName(s), activeDirectoryUrl: directoryUrlOf(s) },
    hosts: [...hosts.values()]
      .sort((a, b) => a.host.localeCompare(b.host))
      .map((r) => ({ ...publicTls(r.host), kind: r.kind })),
  };
}

/** What website owners need to know about HTTPS here. */
export async function tlsHosting() {
  const s = await acmeSettings();
  return {
    enabled: tlsEnabled(),
    port: config.sites.tls.publicPort,
    auto: tlsEnabled() && s.enabled && s.agreedTos,
    ca: caName(s),
  };
}

export async function initCerts(): Promise<void> {
  if (!tlsEnabled()) return;
  studioDomain = normHost(await getSetting<string>('tls.studioDomain', config.studioDomain));
  let fb = await getSetting<{ cert: string; keyEnc: string } | null>('tls.fallback', null);
  let key = '';
  try {
    if (fb) key = decryptSecret(fb.keyEnc);
    if (fb && new crypto.X509Certificate(fb.cert).validToDate.getTime() < Date.now() + 30 * 86400_000) fb = null;
  } catch {
    fb = null;
  }
  if (!fb) {
    const c = await selfSigned('localhost', 3650);
    fb = { cert: c.cert, keyEnc: encryptSecret(c.key) };
    key = c.key;
    await setSetting('tls.fallback', fb);
  }
  fallback = { cert: fb.cert, key, ctx: tls.createSecureContext({ cert: fb.cert, key }) };
  await load();
  ready = true;
  setTimeout(() => void tick(), 5000).unref();
  setInterval(() => void tick(), 10 * 60_000).unref();
  // certificates that expire are dropped from the listener in time
  setInterval(() => {
    for (const h of [...contexts.keys()]) {
      const row = hosts.get(h);
      if (!row || !usable(row)) rebuild(h);
    }
  }, 3600_000).unref();
}
