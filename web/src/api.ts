// Typed client for the Studio API.

export type Role = 'admin' | 'user';
export interface User {
  id: number;
  email: string;
  username: string;
  displayName: string;
  role: Role;
  status: 'active' | 'disabled';
  createdAt: string;
  lastLoginAt: string | null;
}

export interface Meta {
  appName: string;
  version: string;
  hasUsers: boolean;
  registrationOpen: boolean;
  /** no account yet and this browser is not in the server's private network: the setup code is needed */
  setupCode?: boolean;
}

export interface ToolCommand {
  usage: string;
  description: string;
}
export interface Tool {
  id: string;
  name: string;
  version?: string;
  description: string;
  areas: string[];
  commands?: ToolCommand[];
  formats?: { ext: string; description: string }[];
  docsPath: string | null;
}

export interface Area {
  id: string;
  name: string;
  tagline: string;
  description: string;
  color: string;
  icon: string;
  previewPath?: string;
  kinds: string[];
  starters: string[];
  /** apps of this area often need a backend: the Server tab is shown */
  services?: boolean;
  sites?: boolean;
  /** projects are WordPress sites: the WordPress tab is shown */
  wordpress?: boolean;
  /** "Versioning" is preselected for new projects of this area */
  versioning?: boolean;
  projectCount: number;
  tools: Tool[];
}

export type PermissionMode = 'bypass' | 'acceptEdits' | 'ask' | 'plan';
export interface ProjectSettings {
  /** AI for new chats: 'claude' or an agent id (empty = account default) */
  provider?: string;
  model?: string;
  effort?: string;
  permissionMode: PermissionMode;
  previewPath?: string;
  pinned?: boolean;
  archived?: boolean;
}
export interface Project {
  id: number;
  name: string;
  area: string;
  description: string;
  settings: ProjectSettings;
  /** the version the project is at — null when it is not versioned */
  version: string | null;
  pinned: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string | null;
  busy: boolean;
  dir?: string;
  /** only in project lists */
  chats?: number;
  site?: boolean;
  servers?: number;
  releases?: number;
}

/** A numbered release of a project (History tab → Releases). */
export interface Release {
  id: number;
  version: string;
  title: string;
  notes: string;
  sha: string | null;
  tag: string | null;
  /** the copy of exports/ kept with the release */
  exports: { files: number; bytes: number } | null;
  createdBy: string;
  createdAt: string;
}
export interface ReleasesData {
  versioning: { enabled: boolean; version: string };
  releases: Release[];
  /** what happened since the last release */
  pending: { commits: number; messages: string[] };
  next: { patch: string; minor: string; major: string };
  exportsLimitMb: number;
}

// ---- WordPress ------------------------------------------------------------------------------------
export interface WordPressInfo {
  id: number;
  projectId: number;
  state: 'new' | 'installing' | 'ready' | 'error';
  desired: 'running' | 'stopped';
  php: 'running' | 'starting' | 'crashed' | 'idle';
  message: string | null;
  error: string | null;
  version: string | null;
  phpVersion: string;
  title: string;
  locale: string;
  adminUser: string;
  adminEmail: string;
  debug: boolean;
  installedAt: string | null;
  job: string[];
  busy: boolean;
}
export type WpModuleKind = 'plugin' | 'theme';
export interface WpModule {
  kind: WpModuleKind;
  slug: string;
  name: string;
  version: string;
  description: string;
  file: string;
  linked: boolean;
}
export interface WpExtension {
  kind: WpModuleKind;
  slug: string;
  name: string;
  status: string;
  version: string;
  update: string | null;
  description: string;
  own: boolean;
}
export interface WpSearchResult {
  kind: WpModuleKind;
  slug: string;
  name: string;
  version: string;
  rating: number;
  installs: number;
  description: string;
  tested: string;
}
export interface WpTemplate {
  id: string;
  name: string;
  description: string;
}
export interface WordPressStatus {
  available: boolean;
  reason: string;
  wordpress: WordPressInfo | null;
  site: Site | null;
  modules: WpModule[];
  templates: Record<WpModuleKind, WpTemplate[]>;
  limits: { uploadMb: number; memoryMb: number; hardened: boolean };
  baseDomain: string | null;
}

export interface Chat {
  id: number;
  projectId: number;
  title: string;
  sessionId: string;
  /** 'claude' or the id of another AI (agent) */
  provider: string;
  started: boolean;
  totalCostUsd: number;
  createdAt: string;
  updatedAt: string;
  running: boolean;
}

export type EventKind = 'user' | 'assistant' | 'tool_result' | 'result' | 'system' | 'error' | 'checkpoint';
export interface ChatEvent {
  id: number;
  kind: EventKind;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
  createdAt: string;
}
export interface PermRequest {
  id: string;
  toolName: string;
  input: unknown;
  createdAt: number;
}

export interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'link';
  size?: number;
  mtime?: number;
  children?: TreeNode[];
  lazy?: boolean;
}

export interface FileContent {
  path: string;
  size: number;
  mtime: number;
  mime: string;
  binary: boolean;
  tooLarge?: boolean;
  text?: string;
}

export interface Commit {
  sha: string;
  short: string;
  date: string;
  author: string;
  message: string;
  files: number;
}

export interface Asset {
  id: string;
  name: string;
  kind: string;
  area: string | null;
  description: string;
  tags: string[];
  visibility: 'private' | 'global';
  mainFile: string | null;
  files: { path: string; size: number }[];
  sizeBytes: number;
  hasThumb: boolean;
  license: string | null;
  importCount: number;
  owner: { id: number; username?: string; name?: string };
  sourceProjectId: number | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

// ---- other AI providers (ACP agents) ------------------------------------------
export interface AgentStatus {
  connected: boolean | null;
  methods: string[];
}
export interface AgentInstall {
  state: 'ready' | 'queued' | 'installing' | 'missing' | 'error';
  versions: Record<string, string>;
  error: string | null;
  updating: boolean;
  installedAt: string | null;
}
export interface AgentInfo {
  id: string;
  name: string;
  vendor: string;
  description: string;
  builtin: boolean;
  enabled: boolean;
  install: AgentInstall;
  login: { title: string; steps: string[] } | null;
  keys: string[];
  tui: boolean;
  freeTier: string | null;
  license: string;
  homepage: string;
  terms: string | null;
  notes: string[];
  /** per user (GET /agents) */
  status?: AgentStatus | null;
  models?: { value: string; name: string }[];
  defaultModel?: string | null;
  /** admin listing */
  packages?: string[];
  log?: string[];
}
export interface AgentKey {
  id: string;
  label: string;
  url: string;
  placeholder: string;
  hint: string | null;
}
export interface AgentsData {
  agents: AgentInfo[];
  keys: AgentKey[];
  prefs: { defaultProvider: string; models: Record<string, string> };
}
export interface CustomAgent {
  id: string;
  name: string;
  vendor?: string;
  description?: string;
  packages?: string[];
  command: string;
  args?: string[];
  tui?: string;
  tuiArgs?: string[];
  login?: string;
  keys?: string[];
  homepage?: string;
  license?: string;
}

export interface ClaudeStatus {
  loggedIn: boolean;
  authMethod: string;
  method: 'login' | 'api_key';
  hint: string | null;
  loginExpiresAt: string | null;
  defaultModel: string | null;
  verifiedAt: string | null;
  accountExtras: boolean;
  plan: string | null;
  error?: string;
  checkedAt: number;
}

// ---- usage ------------------------------------------------------------------
export interface LimitWindow {
  key: string;
  label: string;
  /** 0–100 */
  percent: number | null;
  resetsAt: string | null;
  /** reset time as Claude Code wrote it, when no exact time is known */
  resetsText?: string | null;
  status?: string;
}
export interface PlanLimits {
  source: 'claude-code-usage' | 'claude-code' | null;
  checkedAt: string | null;
  plan: string | null;
  windows: LimitWindow[];
  extra: { enabled: boolean; usedCredits: number; monthlyLimit: number | null; percent: number | null; currency: string } | null;
  status: string | null;
  note: string | null;
}
export interface UsageTotals {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  durationMs: number;
}
export interface LocalUsage {
  periods: { day: UsageTotals; week: UsageTotals; month: UsageTotals; all: UsageTotals };
  daily: { date: string; runs: number; costUsd: number; tokens: number }[];
  projects: { projectId: number | null; name: string; area: string | null; runs: number; costUsd: number }[];
  /** last 30 days, per AI ("claude" or an agent id) */
  providers: { provider: string; runs: number; costUsd: number; tokens: number }[];
}

// ---- servers (deployed Node.js backends of projects) -----------------------------
export type ServiceState = 'stopped' | 'starting' | 'running' | 'crashed' | 'error';
export interface Service {
  id: number;
  projectId: number;
  ownerId: number;
  name: string;
  slug: string;
  root: string;
  desired: 'running' | 'stopped';
  state: ServiceState;
  deploying: boolean;
  listening: boolean;
  port: number | null;
  release: number;
  deployedAt: string | null;
  startedAt: string | null;
  restartsLastHour: number;
  lastExit: { code: number | null; signal: string | null; at: string } | null;
  message: string | null;
  memoryMb: number | null;
  url: string;
  path: string;
  internalUrl: string;
  settings: { cors: boolean; memoryMb: number; start: string };
  projectName?: string;
  projectArea?: string;
  owner?: string;
}
export interface DetectedServer {
  root: string;
  name: string;
  description: string | null;
  start: string;
  dependencies: string[];
  serviceId: number | null;
}

// ---- websites (published web apps / games of projects, by domain) -----------------
export type SiteStatus = 'live' | 'offline' | 'unpublished' | 'publishing';
export interface Site {
  id: number;
  projectId: number;
  ownerId: number;
  slug: string;
  status: SiteStatus;
  enabled: boolean;
  ownerActive: boolean;
  release: number;
  publishedAt: string | null;
  publishing: boolean;
  message: string | null;
  /** mode "wordpress": the website is the project's WordPress (nothing is published) */
  settings: { root: string; build: string; spa: boolean; mode: 'static' | 'server' | 'wordpress'; serviceId: number | null };
  stats: { files: number; bytes: number; skipped: number; root: string } | null;
  domains: string[];
  /** <name>.<base domain> when the Studio has a base domain */
  baseHost: string | null;
  addresses: { custom: string[]; base: string | null; local: string; primary: string };
  /** certificate per host (built-in HTTPS); empty when it is off */
  tls: Record<string, TlsInfo>;
  internal: { url: string; host: string; browser: string };
  projectName?: string;
  projectArea?: string;
  owner?: string;
}
export interface Hosting {
  enabled: boolean;
  baseDomain: string | null;
  port: number;
  /** a reverse proxy in front terminates TLS */
  https: boolean;
  tls: TlsHosting;
  maxPerUser: number;
  maxMb: number;
}

// ---- HTTPS: one certificate per host name ---------------------------------------
export type TlsMode = 'auto' | 'custom' | 'selfsigned' | 'off';
export interface TlsInfo {
  host: string;
  mode: TlsMode;
  status: 'active' | 'pending' | 'error' | 'none' | 'off' | 'expired';
  /** the host answers on https:// right now */
  https: boolean;
  forceHttps: boolean;
  hsts: boolean;
  source: 'acme' | 'custom' | 'selfsigned' | null;
  issuer: string | null;
  names: string[];
  notBefore: string | null;
  notAfter: string | null;
  daysLeft: number | null;
  viaWildcard: string | null;
  error: string | null;
  attempts: number;
  nextTryAt: string | null;
  issuedAt: string | null;
  /** admin listing */
  kind?: 'site' | 'studio' | 'wildcard';
}
export interface TlsHosting {
  /** the built-in HTTPS is on */
  enabled: boolean;
  /** port people reach it at (443 on a web server) */
  port: number;
  /** automatic certificates are switched on (an admin accepted the CA's terms) */
  auto: boolean;
  /** name of the certificate authority */
  ca: string;
}
export interface AcmeSettings {
  enabled: boolean;
  email: string;
  directory: 'letsencrypt' | 'letsencrypt-staging' | 'custom';
  directoryUrl: string;
  agreedTos: boolean;
  ca: string;
  activeDirectoryUrl: string;
}
export interface TlsOverview {
  enabled: boolean;
  port: number;
  httpPort: number;
  externalProxy: boolean;
  studioDomain: string;
  acme: AcmeSettings;
  hosts: TlsInfo[];
}

// ---- skills and instructions ------------------------------------------------------
export interface Skill {
  /** "sys:<name>" for built-in skills, the id otherwise */
  key: string;
  id: number | null;
  /** the /command */
  slug: string;
  name: string;
  /** when the AI should use it */
  description: string;
  areas: string[];
  /** offered to the AI by itself (false: only when called with /name) */
  auto: boolean;
  scope: 'system' | 'mine' | 'global';
  owner: string | null;
  published: boolean;
  reviewed: boolean;
  uses: number;
  updatedAt: string | null;
  /** active for me */
  enabled: boolean;
  chars: number;
  body?: string;
}
export interface Instruction {
  body: string;
  enabled: boolean;
}
export interface InstructionsData {
  mine: Record<string, Instruction>;
  global: Record<string, Instruction>;
  areas: { id: string; name: string }[];
  max: number;
}

/** Claude Code CLI on this server (downloaded from npm at runtime, not part of the image) */
export interface CliStatus {
  state: 'ready' | 'installing' | 'missing' | 'error';
  source: 'custom' | 'runtime' | 'image' | null;
  version: string | null;
  path: string | null;
  installedAt: string | null;
  wanted: string;
  autoInstall: boolean;
  autoUpdate: boolean;
  updating: boolean;
  error: string | null;
  log: string[];
}

export type PackScope = 'system' | 'global' | 'user';
export interface PackSummary {
  id: string;
  scope: PackScope;
  name: string;
  type: 'music' | '3d' | 'image' | 'video' | 'general';
  version: string | null;
  description: string;
  author: string | null;
  license: string | null;
  tags: string[];
  software: string[];
  itemCount: number;
  kinds: Record<string, number>;
  sizeBytes: number;
  fileCount: number;
  owner: { id: number; name: string | null } | null;
  installedAt: string | null;
  publishedAt: string | null;
  hasDocs: boolean;
  hasCode: boolean;
  trusted: boolean;
  reviewedBy: string | null;
}
export interface PackItem {
  id: string;
  kind: string;
  name?: string;
  file?: string;
  description?: string;
  tags?: string[];
  meta?: Record<string, unknown>;
  media?: { duration?: number; sampleRate?: number; channels?: number; width?: number; height?: number };
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const hasBody = opts.body !== undefined;
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (hasBody ? 'POST' : 'GET'),
    headers: { 'x-studio': '1', ...(hasBody ? { 'content-type': 'application/json' } : {}) },
    body: hasBody ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text.slice(0, 300) };
  }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('studio:unauthorized'));
    throw new ApiError(res.status, data.error || res.statusText || `HTTP ${res.status}`);
  }
  return data as T;
}

/** multipart upload with progress */
export function upload<T = unknown>(path: string, form: FormData, onProgress?: (pct: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api${path}`);
    xhr.setRequestHeader('x-studio', '1');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let data: { error?: string } = {};
      try {
        data = JSON.parse(xhr.responseText || '{}');
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else reject(new ApiError(xhr.status, data.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Network error during upload'));
    xhr.send(form);
  });
}

const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');
export const rawUrl = (projectId: number, path: string) => `/api/projects/${projectId}/raw/${enc(path)}`;
export const downloadUrl = (projectId: number, path = '') =>
  `/api/projects/${projectId}/download${path ? `?path=${encodeURIComponent(path)}` : ''}`;
export const assetFileUrl = (id: string, path: string) => `/api/library/${id}/file/${enc(path)}`;
export const assetThumbUrl = (id: string, v?: string | number) => `/api/library/${id}/thumb${v ? `?v=${v}` : ''}`;
export const packFileUrl = (scope: string, id: string, path: string) => `/api/packs/${scope}/${id}/file/${enc(path)}`;

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
