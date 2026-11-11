/**
 * What Claude learns about the Studio: an appended system prompt (dynamic:
 * installed tools, toolchains, project info) and an MCP config that wires up
 * the studio library tools, the permission bridge and the headless browser.
 */
import path from 'node:path';
import { getArea } from '../areas.js';
import { config, type PermissionMode } from '../config.js';
import { type SysUser } from '../lib/system.js';
import { userWriteFile } from '../lib/userfs.js';
import { packsPathFor, packsPrompt } from '../packs.js';
import { type ProjectRow, projectSettings } from '../projects.js';
import { versioningPrompt } from '../releases.js';
import { androidSdkSummary } from '../sdk.js';
import { servicesOfProjectSync } from '../services.js';
import { siteOfProjectSync } from '../sites.js';
import { promptAddendum } from '../skills.js';
import { allTools, getToolchains, hasToolchain, type ToolManifest, toolsForArea } from '../tools.js';
import { wordpressPrompt } from '../wordpress.js';

function toolBlock(t: ToolManifest): string {
  const lines = [`### ${t.name} (\`${t.id}\`${t.version ? ` v${t.version}` : ''})`, t.description];
  if (t.commands?.length) {
    lines.push('Commands:');
    for (const c of t.commands) lines.push(`- \`${c.usage}\` — ${c.description}`);
  }
  if (t.formats?.length) {
    lines.push('Text save formats:');
    for (const f of t.formats) lines.push(`- \`${f.ext}\` — ${f.description}`);
  }
  if (t.docs) lines.push(`Full documentation: ${path.join(t.dir, t.docs)}`);
  return lines.join('\n');
}

/** The Studio prompt of a project plus the admin's and the user's instructions and their skills. */
export async function buildProjectPrompt(project: ProjectRow, dir: string): Promise<string> {
  const extra = await promptAddendum(project.owner_id, project.area).catch(() => '');
  return [buildSystemPrompt(project, dir), extra].filter(Boolean).join('\n\n');
}

function buildSystemPrompt(project: ProjectRow, dir: string): string {
  const area = getArea(project.area);
  const settings = projectSettings(project);
  const tools = toolsForArea(project.area);
  const chains = getToolchains().filter((t) => t.available && t.id !== 'claude');
  const browser = hasToolchain('playwright-mcp') && hasToolchain('chromium');
  const L: (string | null)[] = [
    '# Everything Studio',
    'You are running inside Everything Studio, a self-hosted creative workspace. The user talks to you through a web page (chat, terminal, file browser with previews) — they cannot see your local terminal, so summarise what you did and where results are.',
    '',
    '## This project',
    `- Name: ${project.name} — area: ${area?.name ?? project.area}`,
    `- Project folder (your working directory): ${dir}. Keep all work inside it.`,
    '- The project CLAUDE.md contains the conventions for this area. Follow them.',
    '- A git checkpoint is committed automatically after each of your turns, and the user can restore any version — you do not need to commit.',
    '- Put deliverables (rendered audio, images, .glb, .apk, .exe, zips …) into exports/ — the user downloads them from there.',
    '- The file browser previews images, audio, video, 3D models (.glb/.gltf/.obj/.stl), markdown and code.',
    area?.previewPath
      ? `- The Preview tab serves ${settings.previewPath} from this folder in a sandboxed iframe: use relative URLs; localStorage/IndexedDB are unavailable there, so wrap storage access in try/catch.`
      : null,
    '',
    '## Text first',
    'Save creative work as human-readable text source files (scores, SVG, glTF JSON, timelines, generator scripts …). Text is the source of truth that you and the user can read, edit and diff; binaries are renders of those sources.',
    '',
    '## Asset library',
    'Reuse before you create. The user\'s own library and the Global Space (assets shared by all users) are searchable:',
    '- Search: `studio lib search <words> [--kind model3d|image|audio|music|video|font|code]` (or the mcp__studio__library_search tool)',
    '- Import into this project: `studio lib get <asset-id> [--to assets/name]` (mcp__studio__library_get)',
    '- Save a finished, reusable asset into the user\'s library: `studio lib add <paths…> --name "Name" --kind model3d --tags a,b --desc "…"` (mcp__studio__library_add)',
    'Only the user can publish an asset to the Global Space (on the website). Suggest it when you made something reusable.',
    '',
    '## Packs (expansion content: instruments, samples, kits, models, materials, plugins …)',
    'Studio software and you can use every pack below. Reference an item as `pack-id/item-id` (e.g. in song or scene files).',
    '- `studio packs search <words> [--type music|3d|image|video] [--kind instrument|sample|model|material|plugin …]`, `studio packs show <pack-id>`, `studio packs path <pack-id>/<item-id>` (absolute file path)',
    '- Make new packs from project files: `studio packs new <id> --type music` (creates packs/<id>/pack.json), add files + items, then `studio packs install packs/<id>` → a personal pack the user can publish to everyone.',
    packsPrompt(project.owner_id, area?.packTypes ?? []),
    '',
    ...versioningPrompt(project),
    ...wordpressPrompt(project),
    ...servicesPrompt(project),
    ...sitesPrompt(project),
    '## Headless browser',
    browser ? '- Playwright MCP tools (mcp__playwright__*) open pages, click, type and take screenshots.' : null,
    '- `studio-browser shot <file-or-url> --out shot.png` renders a page (local files/folders are served automatically) — then read the PNG to look at it. `studio-browser console <file-or-url>` prints console messages and errors. Use this to check games and web pages yourself.',
    '- There is no display: GUI programs must run headless.',
    '',
    '## Studio tools',
    'The user edits the same text files on the website: songs (*.song.yaml) open in a visual DAW there — re-read a file before you change it.',
    tools.length ? tools.map(toolBlock).join('\n\n') : '(none installed for this area yet)',
    '',
    '## Toolchains in this environment',
    chains.map((c) => `- ${c.name}${c.version ? ` — ${c.version}` : ''}`).join('\n'),
    androidSdkSummary()
      ? `- Android SDK at $ANDROID_HOME (read-only): ${androidSdkSummary()}. The Android CLI \`android\` can scaffold (\`android create\`), build (\`android build\`) and render Compose previews to PNG (\`android preview render\`).`
      : area?.id === 'android'
        ? '- The Android SDK is NOT installed yet — an admin installs it on the website (Admin → Android SDK). Tell the user if you need it.'
        : null,
    '- Shared Python packages live in /opt/venv (read-only); for more create a project venv: `python3 -m venv .venv`.',
    '- `npm install -g`, `pip install --user` and `dotnet tool install -g` install into your home directory; system paths are read-only.',
  ];
  return L.filter((l): l is string => l !== null).join('\n');
}

/** Online features: Node.js servers the Studio deploys and runs for the project (services.ts). */
function servicesPrompt(project: ProjectRow): string[] {
  const list = servicesOfProjectSync(project.id);
  if (!getArea(project.area)?.services && !list.length) return [];
  if (!config.services.enabled) return ['## Online features', '- Servers are switched off on this Studio (SERVICES_ENABLED=false).', ''];
  return [
    '## Online features — your own Node.js server (multiplayer, saves, accounts, leaderboards, APIs …)',
    'When the app needs a backend, write it as a Node.js server in `server/` (a package with package.json) and let the Studio run it — the user needs no other hosting. It is reachable over HTTP and WebSocket at its public URL.',
    '- Start from a template and adapt it: `studio service new --template multiplayer` (WebSocket rooms + player state), `storage` (SQLite saves + leaderboards, no dependencies) or `basic` (JSON API). Read its README.md.',
    '- Rules: listen on process.env.PORT; keep persistent data only in process.env.DATA_DIR (it survives redeploys — node:sqlite or JSON files); everything else is replaced on deploy; dependencies go in package.json (npm install runs on deploy); offer GET /health; secrets via `studio service env KEY=value`.',
    '- Deploy after every change: `studio service deploy` — copies server/, installs dependencies, restarts, prints the URLs and the first log lines (exit code 1 if it does not come up). Then `studio service logs`, `studio service status`, `studio service restart`.',
    `- Test it yourself before you report: \`curl -s ${config.internalUrl}/srv/<slug>/health\`; WebSocket: \`node -e\` with the global WebSocket (ws://127.0.0.1:${config.port}/srv/<slug>/…).`,
    '- Clients: HTTP `<public URL>/…`, WebSocket `ws(s)://<host>/srv/<slug>/<path>`. Web games served by the Studio use the page host: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/srv/<slug>/…`. Android/Windows apps keep the server URL in one config constant (default: the public URL); Android needs the INTERNET permission (and cleartext allowed for http://; the emulator reaches the host as 10.0.2.2).',
    '- The user sees and controls it in the project\'s Server tab (status, live logs, environment, restart, rollback, data download).',
    list.length
      ? `Servers of this project: ${list.map((s) => `${s.name} (folder ${s.root}/, ${s.state}, ${s.url})`).join('; ')}.`
      : 'This project has no server yet.',
    '',
  ];
}

/** Publishing web apps and browser games as real websites on the user's domains (sites.ts). */
function sitesPrompt(project: ProjectRow): string[] {
  const site = siteOfProjectSync(project.id);
  if (!getArea(project.area)?.sites && !site) return [];
  if (!config.sites.enabled) return ['## Websites', '- Website hosting is switched off on this Studio (SITES_ENABLED=false).', ''];
  // a WordPress project is live as it is: nothing is published (see the WordPress section)
  if (getArea(project.area)?.wordpress || site?.settings.mode === 'wordpress') {
    return [
      '## The website of this project',
      'The website is the WordPress itself — always live, nothing to publish (`studio site publish` does not apply). Domains: `studio site domain add example.com`, `studio site domain check`, `studio site status`; HTTPS: `studio site cert`. The user manages them in the Website tab.',
      site ? `Addresses: ${[...site.addresses.custom, site.addresses.base, site.addresses.local].filter(Boolean).join(' · ')}.` : '',
      '',
    ];
  }
  const port = config.sites.listenPort;
  return [
    '## Publishing — the project as a real website',
    'The Studio hosts web apps and browser games as websites on its own web port (port 80 on a server), under the user\'s domains. Publishing copies the finished files into a new release; the live website only changes when it is published again.',
    '- `studio site publish` publishes the project and prints the addresses. Folder: the setting, else `dist/`, `build/` or `out/` when they contain an index.html, else the project folder itself — without hidden files, node_modules, server folders, exports/, assets/uploads/ and CLAUDE.md. Options (saved for the next publishes): `--root dist`, `--build "npm ci && npm run build"` (runs first), `--spa` (paths without a file extension serve index.html).',
    '- Publish when the user wants it online or asks to update the live website — not after every small change. Tell them the address.',
    '- On the website, the project\'s servers are on the same origin: `fetch("/srv/<server-slug>/…")`, WebSocket `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/srv/<server-slug>/…` — the same code works in the preview. A `404.html` is shown for unknown paths. The website is served at the root of its domain; with `--spa` deep paths (/level/3) serve index.html, so its scripts and assets need root-relative URLs (`/src/main.js`, Vite `base: "/"`).',
    `- Check it yourself after publishing: \`curl -s -H "Host: <name>.localhost" http://127.0.0.1:${port}/\` and \`studio-browser shot http://<name>.localhost:${port}/ --out .studio/site.png\` (then look at the PNG).`,
    '- Domains: the user adds them in the project\'s Website tab (or `studio site domain add example.com`); their DNS needs an A/AAAA record → this server; `studio site domain check` tests it. `studio site status` shows addresses, settings and the last publish log; `studio site offline|online`.',
    site
      ? `Website of this project: "${site.slug}", ${site.status}${site.release ? `, release #${site.release}` : ''}, ${[...site.addresses.custom, site.addresses.base, site.addresses.local].filter(Boolean).join(' · ')}.`
      : 'This project has no website yet.',
    '',
  ];
}

/** Built-in tools of a casual chat: look at attachments and the web, change nothing. */
export const CASUAL_TOOLS = 'Read,WebSearch,WebFetch';

/** System prompt of the Chat page (plain conversation, not project work). */
export async function buildCasualPrompt(user: { id: number; display_name?: string; username: string }): Promise<string> {
  const extra = await promptAddendum(user.id, 'chat', { skills: false }).catch(() => '');
  return [casualPrompt(user), extra].filter(Boolean).join('\n\n');
}

function casualPrompt(user: { display_name?: string; username: string }): string {
  const name = user.display_name || user.username;
  return [
    `You are Claude, an AI assistant made by Anthropic, chatting with ${name} on the Chat page of Everything Studio — a self-hosted workspace where people make music, images, 3D models, videos, games and apps with Claude.`,
    '',
    'This is a casual conversation. Answer naturally and helpfully, in Markdown when it helps (lists, tables, code blocks). Be concise by default and go into depth when asked. Match the language the user writes in.',
    '',
    'What you can do here:',
    '- Read files the user attaches (they appear as `[attached: assets/uploads/…]`, relative to your working directory) — images, PDFs, text, code.',
    '- Search the web and open web pages when a question needs current or specific information; say where facts came from.',
    '',
    'You cannot run programs or create files in this chat. When the user wants something made — a song, sound effects, images, a 3D model, a video, a game, an Android or Windows app, a website — help them plan it here, then suggest starting a project in the matching area (sidebar → Create), where you have the full Studio toolset.',
    '',
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
  ].join('\n');
}

export interface StdioServer {
  type: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** The Studio's MCP servers for one session: library/packs tools and the headless browser. */
export function studioMcpServers(su: SysUser, token: string, projectDir: string): Record<string, StdioServer> {
  const toolEnv = {
    STUDIO_TOKEN: token,
    STUDIO_API_URL: config.internalUrl,
    STUDIO_PROJECT_DIR: projectDir,
    STUDIO_PACKS_PATH: packsPathFor(su, projectDir),
  };
  const servers: Record<string, StdioServer> = {};
  for (const t of allTools()) {
    for (const [key, s] of Object.entries(t.mcp ?? {})) {
      if (!servers[key]) servers[key] = { type: 'stdio', command: s.command, args: s.args ?? [], env: toolEnv };
    }
  }
  if (hasToolchain('playwright-mcp') && hasToolchain('chromium')) {
    servers.playwright = {
      type: 'stdio',
      command: 'playwright-mcp',
      args: [
        '--headless',
        '--isolated',
        '--no-sandbox',
        '--allow-unrestricted-file-access',
        '--executable-path',
        process.env.CHROMIUM_PATH || 'chromium',
        '--output-dir',
        path.join(projectDir, '.studio', 'browser'),
      ],
    };
  }
  return servers;
}

/** Writes the per-session MCP config into the user's home (not readable by others). */
export async function writeMcpConfig(su: SysUser, name: string, token: string, projectDir: string): Promise<string> {
  const servers = studioMcpServers(su, token, projectDir);
  const file = path.join(su.home, '.studio', 'mcp', `${name}.json`);
  await userWriteFile(su, file, JSON.stringify({ mcpServers: servers }, null, 2));
  return file;
}

/**
 * Studio instructions for the other AI agents (ACP, agents/acprun.ts) — sent with the first
 * message of a session, as ACP has no system prompt.
 */
export async function buildAgentContext(project: ProjectRow, dir: string, agentName: string): Promise<string> {
  return [
    await buildProjectPrompt(project, dir),
    '',
    `## You (${agentName}) in this Studio`,
    `- You are ${agentName}, working in this project for the user. Read the project's CLAUDE.md first: it holds the conventions of this area (the file name comes from another agent — it applies to you too).`,
    '- Studio tools: the MCP servers "studio" (asset library, packs) and "playwright" (headless browser), and the `studio` command line — use whichever you can reach.',
    '- When something needs the user (a decision, an account, a key), say so in your answer — they read it on the website.',
  ].join('\n');
}

/** The Chat page (casual conversation) for other AI agents. */
export async function buildCasualContext(user: { id: number; display_name?: string; username: string }, agentName: string): Promise<string> {
  const extra = await promptAddendum(user.id, 'chat', { skills: false }).catch(() => '');
  return [casualContext(user, agentName), extra].filter(Boolean).join('\n\n');
}

function casualContext(user: { display_name?: string; username: string }, agentName: string): string {
  const name = user.display_name || user.username;
  return [
    `You are ${agentName}, an AI assistant chatting with ${name} on the Chat page of Everything Studio — a self-hosted workspace where people make music, images, 3D models, videos, games and apps with AI.`,
    '',
    'This is a casual conversation. Answer naturally and helpfully, in Markdown when it helps (lists, tables, code blocks). Be concise by default and go into depth when asked. Match the language the user writes in.',
    '',
    'You can read files the user attaches (they appear as `[attached: assets/uploads/…]`, relative to your working directory) and search or open web pages when a question needs current information — say where facts came from.',
    'You cannot change files or run programs in this chat (such actions are refused). When the user wants something made, help them plan it here, then suggest starting a project in the matching area (sidebar → Create).',
    '',
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
  ].join('\n');
}

export const PERMISSION_TOOL = 'mcp__studio__permission_prompt';

/** CLI flags for a permission mode. `print` = chat (-p), `tui` = interactive terminal. */
export function permissionArgs(mode: PermissionMode, kind: 'print' | 'tui'): string[] {
  switch (mode) {
    case 'bypass':
      return ['--dangerously-skip-permissions'];
    case 'plan':
      return ['--permission-mode', 'plan'];
    case 'acceptEdits':
      return kind === 'print'
        ? [
            '--permission-mode', 'acceptEdits',
            '--permission-prompt-tool', PERMISSION_TOOL,
            '--allowedTools', 'mcp__studio,Bash(studio *),Bash(studio-browser *)',
          ]
        : ['--permission-mode', 'acceptEdits'];
    case 'ask':
    default:
      return kind === 'print'
        ? [
            '--permission-prompt-tool', PERMISSION_TOOL,
            '--allowedTools', 'mcp__studio__library_search,mcp__studio__library_info,mcp__studio__studio_tools',
          ]
        : [];
  }
}
