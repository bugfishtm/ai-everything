import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function str(name: string, def = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}
function int(name: string, def: number): number {
  const v = Number.parseInt(str(name, ''), 10);
  return Number.isFinite(v) ? v : def;
}
function bool(name: string, def: boolean): boolean {
  const v = str(name, '').toLowerCase();
  if (!v) return def;
  return ['1', 'true', 'yes', 'on'].includes(v);
}
/** Docker-secrets style: the value lives in a file (e.g. written by the entrypoint). */
function readSecretFile(file: string): string {
  if (!file) return '';
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

const studioHome = str('STUDIO_HOME', path.resolve(process.cwd(), '..'));
const dataDir = str('DATA_DIR', '/data');
const homesDir = str('HOMES_DIR', path.join(dataDir, 'home'));

export const config = {
  appName: str('APP_NAME', 'Everything Studio'),
  version: '1.4.0',
  port: int('PORT', 8080),
  host: str('HOST', '0.0.0.0'),
  /** Optional public URL (https://studio.example.com). Used for Origin checks behind proxies. */
  publicUrl: str('PUBLIC_URL', ''),
  trustProxy: bool('TRUST_PROXY', false),
  /** auto = Secure cookie when the request arrived over https */
  cookieSecure: str('COOKIE_SECURE', 'auto') as 'auto' | 'true' | 'false',

  /**
   * Database. Default: the MariaDB server built into the image, reached over its
   * Unix socket (started by the entrypoint, data in the /var/lib/mysql volume).
   * Set MYSQL_HOST to use an external MySQL/MariaDB server instead.
   */
  db: {
    host: str('MYSQL_HOST', ''),
    port: int('MYSQL_PORT', 3306),
    socket: str('MYSQL_SOCKET', str('MYSQL_HOST', '') ? '' : '/run/mysqld/mysqld.sock'),
    user: str('MYSQL_USER', 'studio'),
    password: str('MYSQL_PASSWORD', '') || readSecretFile(str('MYSQL_PASSWORD_FILE', '')),
    database: str('MYSQL_DATABASE', 'studio'),
  },

  dataDir,
  projectsDir: str('PROJECTS_DIR', path.join(dataDir, 'projects')),
  libraryDir: str('LIBRARY_DIR', path.join(dataDir, 'library')),
  homesDir,
  /** root-only state (generated secrets) */
  stateDir: path.join(homesDir, '.studio'),
  templatesDir: str('TEMPLATES_DIR', path.join(studioHome, 'templates')),
  toolsDir: str('TOOLS_DIR', path.join(studioHome, 'tools')),
  /** built-in skills shipped with the image: <name>/SKILL.md (skills.ts) */
  skillsDir: str('SKILLS_DIR', path.join(studioHome, 'skills')),
  webDir: str('WEB_DIR', path.join(studioHome, 'web')),
  /** packs shipped with the image (read-only) */
  systemPacksDir: str('STUDIO_SYSTEM_PACKS', path.join(studioHome, 'packs')),
  /** installed packs: global/<id> for everyone, users/<uid>/<id> personal */
  packsDir: str('PACKS_DIR', path.join(dataDir, 'packs')),
  /** runtime-installed SDKs (Android) */
  sdkDir: str('SDK_DIR', path.join(dataDir, 'sdk')),
  /** deployed Node.js servers of projects: <user>/<service>/{releases,data} (services.ts) */
  servicesDir: str('SERVICES_DIR', path.join(dataDir, 'services')),
  services: {
    enabled: bool('SERVICES_ENABLED', true),
    maxPerUser: int('MAX_SERVICES_PER_USER', 3),
    /** V8 heap limit of each server process */
    memoryMb: int('SERVICE_MEMORY_MB', 512),
    portMin: int('SERVICE_PORT_MIN', 42000),
    portMax: int('SERVICE_PORT_MAX', 42999),
  },
  /** published websites of projects: <site>/releases/<n>/ (sites.ts, root only) */
  sitesDir: str('SITES_DIR', path.join(dataDir, 'sites')),
  sites: {
    enabled: bool('SITES_ENABLED', true),
    /** port the website server listens on inside the container */
    listenPort: int('SITES_LISTEN_PORT', 8081),
    /** port people reach it at (the published host port: 80 on a web server) — for the addresses shown */
    publicPort: int('SITES_PORT', 8081),
    /** addresses are https:// (the https profile or another TLS proxy in front) */
    https: bool('SITES_HTTPS', false),
    /** optional: every website also gets <name>.<base domain> (wildcard DNS *.<base domain> → this server) */
    baseDomain: str('SITES_BASE_DOMAIN', '')
      .trim()
      .toLowerCase()
      .replace(/^\*\./, '')
      .replace(/^\.+|\.+$/g, ''),
    maxPerUser: int('MAX_SITES_PER_USER', 10),
    maxMb: int('SITE_MAX_MB', 500),
    maxFiles: int('SITE_MAX_FILES', 50000),
    maxDomains: int('SITE_MAX_DOMAINS', 20),
    /**
     * Built-in HTTPS (certs.ts): the website server also listens with TLS and picks the certificate
     * per domain — automatic (Let's Encrypt), uploaded or self-signed, managed on the website.
     */
    tls: {
      enabled: bool('SITES_TLS', true),
      /** TLS port inside the container */
      listenPort: int('SITES_TLS_LISTEN_PORT', 8443),
      /** port people reach it at (443 on a web server) — for the addresses shown */
      publicPort: int('SITES_HTTPS_PORT', 8443),
    },
  },
  /**
   * WordPress (wordpress.ts): projects of the WordPress area run a real WordPress — PHP-FPM as the
   * owner's sandbox user, an own database in the built-in MariaDB, served through the website port.
   */
  wordpressDir: str('WORDPRESS_DIR', path.join(dataDir, 'wordpress')),
  wordpress: {
    enabled: bool('WORDPRESS_ENABLED', true),
    maxPerUser: int('MAX_WORDPRESS_PER_USER', 5),
    /** PHP memory_limit of a site */
    memoryMb: int('WORDPRESS_MEMORY_MB', 256),
    /** PHP worker processes a site may use at the same time */
    maxWorkers: int('WORDPRESS_MAX_WORKERS', 6),
    /** largest upload (media, plugin zips) */
    uploadMb: int('WORDPRESS_UPLOAD_MB', 64),
    /** PHP is stopped after this time without a visitor and started again on the next request (0 = never) */
    idleMinutes: int('WORDPRESS_IDLE_MINUTES', 60),
    /** open_basedir + no shell functions for the PHP of a site (a hacked plugin stays inside the project) */
    harden: bool('WORDPRESS_PHP_HARDENING', true),
    /** an account that may create databases on an EXTERNAL MySQL server (MYSQL_HOST); empty = the Studio's own */
    dbAdminUser: str('WORDPRESS_DB_ADMIN_USER', ''),
    dbAdminPassword: str('WORDPRESS_DB_ADMIN_PASSWORD', ''),
  },
  /** defaults for automatic certificates; admins change them on the website (Admin → HTTPS) */
  acme: {
    email: str('ACME_EMAIL', ''),
    /** another ACME certificate authority instead of Let's Encrypt */
    directoryUrl: str('ACME_DIRECTORY_URL', ''),
    /** "yes" = the deployer accepts the CA's terms of service (unattended setups) */
    agreeTos: str('ACME_AGREE_TOS', '').toLowerCase() === 'yes',
  },
  /** serve the Studio's own website on the HTTPS port under this host name (admins can set it on the website) */
  studioDomain: str('STUDIO_DOMAIN', '').trim().toLowerCase(),
  /**
   * More AI providers besides Claude Code (agents/*): ACP agents installed at runtime into
   * /data/sdk/agents. AGENTS = the ones switched on at first start (codex,gemini,opencode);
   * afterwards admins switch them on and off on the website.
   */
  agents: {
    enabled: str('AGENTS', '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    autoUpdate: bool('AGENTS_AUTO_UPDATE', true),
    /** an agent process stays up between messages of a chat for this long */
    idleMinutes: int('AGENT_IDLE_MINUTES', 10),
  },
  androidHome: str('ANDROID_HOME', path.join(dataDir, 'sdk', 'android')),
  android: {
    /** "yes" = the deployer accepts the Android SDK License Agreement (unattended installs) */
    acceptLicense: str('ANDROID_SDK_ACCEPT_LICENSE', '').toLowerCase() === 'yes',
    autoInstall: bool('ANDROID_SDK_AUTO_INSTALL', false),
    /** explicit package list instead of "newest stable", e.g. "platform-tools platforms/android-36 build-tools/36.0.0" */
    packages: str('ANDROID_SDK_PACKAGES', ''),
    /** mirror / proxy for the command-line tools zip */
    toolsUrl: str('ANDROID_SDK_TOOLS_URL', ''),
  },

  /** resolved at startup by claudecli.ts (CLAUDE_BIN, an image copy, or the runtime install) */
  claudeBin: str('CLAUDE_BIN', 'claude'),
  /**
   * Claude Code is Anthropic's proprietary software and is not part of a published image:
   * the Studio downloads the official npm package on first start (claudecli.ts).
   */
  claudeCode: {
    /** "latest" (kept up to date) or an exact version to pin */
    version: str('CLAUDE_CODE_VERSION', 'latest'),
    autoInstall: bool('CLAUDE_CODE_AUTO_INSTALL', true),
    /** with version=latest: update to the newest release at start and once a day */
    autoUpdate: bool('CLAUDE_CODE_AUTO_UPDATE', true),
  },
  /** uid = every website user gets an own Linux account; none = everything runs as the server user */
  isolation: str('ISOLATION', 'auto') as 'auto' | 'uid' | 'none',
  uidBase: int('UID_BASE', 20000),
  /** URL the in-container tools (studio CLI / MCP) use to reach this server */
  internalUrl: str('INTERNAL_URL', `http://127.0.0.1:${int('PORT', 8080)}`),

  registrationDefault: str('REGISTRATION', 'closed') as 'open' | 'closed',
  admin: {
    email: str('ADMIN_EMAIL', ''),
    username: str('ADMIN_USERNAME', 'admin'),
    password: str('ADMIN_PASSWORD', ''),
  },

  limits: {
    runsPerUser: int('MAX_RUNS_PER_USER', 2),
    terminalsPerUser: int('MAX_TERMINALS_PER_USER', 4),
    runTimeoutMin: int('RUN_TIMEOUT_MINUTES', 60),
    terminalIdleMin: int('TERMINAL_IDLE_MINUTES', 30),
    uploadMb: int('UPLOAD_LIMIT_MB', 500),
    packMb: int('PACK_LIMIT_MB', 4096),
    sessionDays: int('SESSION_DAYS', 30),
    trashDays: int('TRASH_DAYS', 7),
    /** largest exports/ folder that is kept with a release (releases.ts) */
    releaseExportsMb: int('RELEASE_EXPORTS_MB', 1024),
  },
  defaultPermissionMode: str('DEFAULT_PERMISSION_MODE', 'bypass') as PermissionMode,
  defaultModel: str('DEFAULT_MODEL', ''),
  /** extra env var names passed through to user processes (comma separated) */
  userEnvAllow: str('USER_ENV_ALLOW', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  appSecret: '',
};

export type PermissionMode = 'bypass' | 'acceptEdits' | 'ask' | 'plan';
export const PERMISSION_MODES: PermissionMode[] = ['bypass', 'acceptEdits', 'ask', 'plan'];

/** APP_SECRET encrypts stored Claude credentials and signs preview links. */
export function loadAppSecret(): void {
  const fromEnv = str('APP_SECRET', '');
  if (fromEnv) {
    if (fromEnv.length < 24) console.warn('[config] APP_SECRET is short — use at least 32 random characters.');
    config.appSecret = fromEnv;
    return;
  }
  const file = path.join(config.stateDir, 'app-secret');
  try {
    config.appSecret = fs.readFileSync(file, 'utf8').trim();
    if (config.appSecret) return;
  } catch {
    /* generate below */
  }
  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  config.appSecret = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(file, config.appSecret + '\n', { mode: 0o600 });
  console.warn(`[config] APP_SECRET not set — generated one and stored it in ${file}. Keep this file (it encrypts saved Claude keys).`);
}
