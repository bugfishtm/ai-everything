/**
 * The AI providers ("agents") the Studio can run besides Claude Code.
 *
 * Claude Code keeps its own, native integration (claude/runner.ts). Every other agent
 * is driven over the Agent Client Protocol (ACP, agents/acpclient.ts) — one client for
 * all of them: OpenAI Codex (through the official codex-acp adapter), Google's Gemini CLI,
 * OpenCode (OpenAI, Google, OpenRouter, Groq, Mistral, DeepSeek, xAI, local models, its
 * free models …) and any further ACP agent an admin adds.
 *
 * Like Claude Code, none of them is part of the image: the official npm packages are
 * installed at runtime into the data volume (agents/install.ts) once an admin enables
 * them. Sign-ins happen in each agent's own login flow (a web terminal) and stay in the
 * user's sandbox home; the Studio only stores API keys the user pastes (encrypted).
 */
import { config, type PermissionMode } from '../config.js';
import { getSetting } from '../settings.js';

export interface KeyDef {
  id: string;
  label: string;
  /** environment variables the key is handed over as */
  env: string[];
  placeholder: string;
  url: string;
}

/** API keys of other vendors a user can store (the Anthropic key lives in the Claude connection). */
export const API_KEYS: KeyDef[] = [
  { id: 'openai', label: 'OpenAI', env: ['OPENAI_API_KEY'], placeholder: 'sk-proj-…', url: 'https://platform.openai.com/api-keys' },
  { id: 'gemini', label: 'Google Gemini', env: ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'], placeholder: 'AIza…', url: 'https://aistudio.google.com/apikey' },
  { id: 'openrouter', label: 'OpenRouter', env: ['OPENROUTER_API_KEY'], placeholder: 'sk-or-v1-…', url: 'https://openrouter.ai/keys' },
  { id: 'groq', label: 'Groq', env: ['GROQ_API_KEY'], placeholder: 'gsk_…', url: 'https://console.groq.com/keys' },
  { id: 'mistral', label: 'Mistral', env: ['MISTRAL_API_KEY'], placeholder: '…', url: 'https://console.mistral.ai/api-keys' },
  { id: 'deepseek', label: 'DeepSeek', env: ['DEEPSEEK_API_KEY'], placeholder: 'sk-…', url: 'https://platform.deepseek.com/api_keys' },
  { id: 'xai', label: 'xAI (Grok)', env: ['XAI_API_KEY'], placeholder: 'xai-…', url: 'https://console.x.ai' },
];

export interface LaunchOpts {
  model: string | null;
  mode: PermissionMode;
  /** the Chat page: conversation only, nothing is changed */
  casual: boolean;
}

export interface LoginFlow {
  title: string;
  bin: string;
  args: string[];
  env?: Record<string, string>;
  steps: string[];
}

export interface AgentDef {
  id: string;
  name: string;
  vendor: string;
  description: string;
  builtin: boolean;
  /** npm packages, installed together into /data/sdk/agents/<id> */
  packages: string[];
  /** program started in ACP mode, and its arguments */
  acpBin: string;
  acpArgs: (o: LaunchOpts) => string[];
  /** extra environment for ACP runs and the interactive terminal */
  env?: (o: LaunchOpts) => Record<string, string>;
  /** interactive terminal in a project (the agent's own UI) */
  tuiBin?: string;
  tuiArgs?: (o: LaunchOpts) => string[];
  login?: LoginFlow;
  /** API keys (API_KEYS ids, 'anthropic' = the Claude connection's API key) handed to this agent */
  keys: string[];
  /** ACP authMethod to select when the user's key for it is stored */
  keyAuthMethods?: Record<string, string>;
  /** ACP authMethod for a login made in the agent's own sign-in flow */
  loginAuthMethod?: string;
  /** how the chosen model reaches the agent: a launch argument, or the session's "model" option */
  modelVia: 'launch' | 'session';
  /** model ids shown as suggestions until the agent reports its own list */
  models: string[];
  /** free use without any account (e.g. OpenCode's free models) */
  freeTier?: string;
  license: string;
  homepage: string;
  terms?: string;
  notes?: string[];
}

const tomlString = (s: string) => JSON.stringify(s);

export const BUILTIN_AGENTS: AgentDef[] = [
  {
    id: 'codex',
    name: 'OpenAI Codex',
    vendor: 'OpenAI',
    description: 'OpenAI’s coding agent — with your ChatGPT plan (Plus, Pro, Business …) or an OpenAI API key.',
    builtin: true,
    packages: ['@zed-industries/codex-acp', '@openai/codex'],
    acpBin: 'codex-acp',
    acpArgs: (o) => {
      const a: string[] = [];
      if (o.model) a.push('-c', `model=${tomlString(o.model)}`);
      // the user's Linux account is the sandbox; Codex' own sandbox needs kernel features containers lack
      if (o.casual || o.mode === 'plan') a.push('-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"');
      else if (o.mode === 'bypass') a.push('-c', 'sandbox_mode="danger-full-access"', '-c', 'approval_policy="never"');
      else a.push('-c', 'sandbox_mode="danger-full-access"', '-c', 'approval_policy="untrusted"');
      return a;
    },
    tuiBin: 'codex',
    tuiArgs: (o) => {
      const a: string[] = [];
      if (o.model) a.push('-m', o.model);
      if (o.mode === 'bypass') a.push('--dangerously-bypass-approvals-and-sandbox');
      else if (o.mode === 'plan') a.push('-s', 'read-only');
      else a.push('-s', 'danger-full-access', '-a', 'on-request');
      return a;
    },
    login: {
      title: 'Sign in with ChatGPT',
      bin: 'codex',
      args: ['login', '--device-auth'],
      steps: [
        'Codex prints a link and a one-time code below.',
        'Open the link (it opens in a new tab), sign in to ChatGPT and enter the code.',
        'When the terminal says you are logged in, close this window.',
      ],
    },
    keys: ['openai'],
    keyAuthMethods: { openai: 'openai-api-key' },
    loginAuthMethod: 'chatgpt',
    modelVia: 'launch',
    models: ['gpt-5-codex', 'gpt-5'],
    license: 'Apache-2.0',
    homepage: 'https://github.com/openai/codex',
    terms: 'https://openai.com/policies/terms-of-use',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    vendor: 'Google',
    description: 'Google’s Gemini CLI — with your Google account (free daily quota, or your Gemini plan) or a Gemini API key.',
    builtin: true,
    packages: ['@google/gemini-cli'],
    acpBin: 'gemini',
    acpArgs: (o) => {
      const a = ['--acp', '--skip-trust'];
      if (o.model) a.push('-m', o.model);
      a.push('--approval-mode', o.casual || o.mode === 'plan' ? 'plan' : o.mode === 'bypass' ? 'yolo' : o.mode === 'acceptEdits' ? 'auto_edit' : 'default');
      return a;
    },
    env: () => ({ NO_BROWSER: 'true' }),
    tuiBin: 'gemini',
    tuiArgs: (o) => {
      const a = ['--skip-trust'];
      if (o.model) a.push('-m', o.model);
      a.push('--approval-mode', o.mode === 'plan' ? 'plan' : o.mode === 'bypass' ? 'yolo' : o.mode === 'acceptEdits' ? 'auto_edit' : 'default');
      return a;
    },
    login: {
      title: 'Sign in with Google',
      bin: 'gemini',
      args: ['--skip-trust'],
      env: { NO_BROWSER: 'true' },
      steps: [
        'Gemini CLI starts below. If it asks how to authenticate, choose “Sign in with Google”.',
        'Open the link it prints (new tab), sign in, and copy the authorization code.',
        'Paste the code into the terminal and press Enter. Once Gemini is ready, type /quit and close this window.',
      ],
    },
    keys: ['gemini'],
    keyAuthMethods: { gemini: 'gemini-api-key' },
    loginAuthMethod: 'oauth-personal',
    modelVia: 'launch',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    freeTier: 'Free daily quota with a personal Google account.',
    license: 'Apache-2.0',
    homepage: 'https://github.com/google-gemini/gemini-cli',
    terms: 'https://geminicli.com/docs/resources/tos-privacy/',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    vendor: 'any provider',
    description:
      'Open-source agent for almost every AI vendor: OpenAI, Google, OpenRouter, Groq, Mistral, DeepSeek, xAI, Anthropic API keys, local models — plus a few free models (limited).',
    builtin: true,
    packages: ['opencode-ai'],
    acpBin: 'opencode',
    // errors (e.g. a provider's usage limit) only reach the log — print them to stderr for the Studio
    acpArgs: () => ['acp', '--print-logs', '--log-level', 'ERROR'],
    env: (o) => ({
      // the Studio decides about permissions; never share sessions publicly; versions come from the Studio
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        autoupdate: false,
        share: 'disabled',
        permission:
          o.casual || o.mode === 'plan'
            ? { edit: 'deny', bash: 'ask', webfetch: 'allow' }
            : o.mode === 'bypass'
              ? { edit: 'allow', bash: 'allow', webfetch: 'allow' }
              : o.mode === 'acceptEdits'
                ? { edit: 'allow', bash: 'ask', webfetch: 'allow' }
                : { edit: 'ask', bash: 'ask', webfetch: 'ask' },
        ...(o.model ? { model: o.model } : {}),
      }),
      OPENCODE_DISABLE_AUTOUPDATE: 'true',
    }),
    tuiBin: 'opencode',
    tuiArgs: (o) => (o.model ? ['--model', o.model] : []),
    login: {
      title: 'Connect an AI provider in OpenCode',
      bin: 'opencode',
      args: ['auth', 'login'],
      steps: [
        'OpenCode lists AI providers below — pick one with the arrow keys and Enter.',
        'Paste that provider’s API key (or follow its sign-in link) and press Enter.',
        'Repeat for more providers, then close this window. Keys can also be stored on this page (below).',
      ],
    },
    keys: ['openai', 'gemini', 'openrouter', 'groq', 'mistral', 'deepseek', 'xai', 'anthropic'],
    modelVia: 'session',
    models: [],
    freeTier:
      'OpenCode also offers a few free models without an account, within limits OpenCode sets (they run out quickly, especially when many people share one server) — see their terms before using them for private work.',
    license: 'MIT',
    homepage: 'https://opencode.ai',
    terms: 'https://opencode.ai/docs/zen',
    notes: ['Claude subscriptions only through the Claude Code connection — in OpenCode use Anthropic API keys.'],
  },
];

/** An admin-defined ACP agent (any program that speaks the Agent Client Protocol). */
export interface CustomAgent {
  id: string;
  name: string;
  vendor?: string;
  description?: string;
  /** npm packages to install (optional — the program may already exist in the image) */
  packages?: string[];
  command: string;
  args?: string[];
  /** interactive terminal program + arguments (optional) */
  tui?: string;
  tuiArgs?: string[];
  login?: string;
  keys?: string[];
  homepage?: string;
  license?: string;
}

function fromCustom(c: CustomAgent): AgentDef {
  const words = (s: string | undefined) => (s ? s.split(/\s+/).filter(Boolean) : []);
  const login = words(c.login);
  return {
    id: c.id,
    name: c.name,
    vendor: c.vendor || 'custom',
    description: c.description || 'An ACP agent added by the admin.',
    builtin: false,
    packages: c.packages ?? [],
    acpBin: c.command,
    acpArgs: () => c.args ?? [],
    tuiBin: c.tui || undefined,
    tuiArgs: () => c.tuiArgs ?? [],
    login: login.length ? { title: `Sign in to ${c.name}`, bin: login[0], args: login.slice(1), steps: ['Follow the instructions in the terminal, then close this window.'] } : undefined,
    keys: c.keys ?? [],
    modelVia: 'session',
    models: [],
    license: c.license || '—',
    homepage: c.homepage || '',
  };
}

let customCache: { at: number; list: AgentDef[] } = { at: 0, list: [] };

export async function customAgents(): Promise<AgentDef[]> {
  if (Date.now() - customCache.at < 5000) return customCache.list;
  const raw = await getSetting<CustomAgent[]>('agents.custom', []);
  customCache = { at: Date.now(), list: (Array.isArray(raw) ? raw : []).map(fromCustom) };
  return customCache.list;
}

export function invalidateCustomAgents(): void {
  customCache.at = 0;
}

export async function allAgents(): Promise<AgentDef[]> {
  return [...BUILTIN_AGENTS, ...(await customAgents())];
}

export async function getAgent(id: string): Promise<AgentDef | undefined> {
  return (await allAgents()).find((a) => a.id === id);
}

/** Agents the admin switched on (AGENTS env as the starting value). */
export async function enabledAgentIds(): Promise<string[]> {
  const fromEnv = config.agents.enabled;
  const stored = await getSetting<string[] | null>('agents.enabled', null);
  return Array.isArray(stored) ? stored : fromEnv;
}

export const CLAUDE_ID = 'claude';
