/**
 * Tool registry. Studio software lives in /opt/studio/tools/<id>/ with a
 * tool.json manifest (see tools/README.md). The registry is shown on the
 * website and injected into Claude's system prompt, so a newly added tool
 * (e.g. the future 3D or image software) is picked up automatically.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { run, which } from './lib/system.js';

export interface ToolCommand {
  usage: string;
  description: string;
}
export interface ToolManifest {
  id: string;
  name: string;
  version?: string;
  description: string;
  /** area ids, or "*" for all */
  areas: string[];
  commands?: ToolCommand[];
  /** text formats the tool reads/writes as its save files */
  formats?: { ext: string; description: string }[];
  /** relative path to documentation Claude can read */
  docs?: string;
  /** MCP servers this tool provides: name -> { command, args } */
  mcp?: Record<string, { command: string; args?: string[] }>;
  dir: string;
}

let tools: ToolManifest[] = [];

export async function loadTools(): Promise<void> {
  const found: ToolManifest[] = [];
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(config.toolsDir);
  } catch {
    tools = [];
    return;
  }
  for (const name of entries.sort()) {
    const dir = path.join(config.toolsDir, name);
    try {
      const raw = await fsp.readFile(path.join(dir, 'tool.json'), 'utf8');
      const m = JSON.parse(raw) as Partial<ToolManifest>;
      if (!m.id || !m.name) throw new Error('id and name are required');
      found.push({
        id: m.id,
        name: m.name,
        version: m.version,
        description: m.description ?? '',
        areas: Array.isArray(m.areas) && m.areas.length ? m.areas : ['*'],
        commands: m.commands ?? [],
        formats: m.formats ?? [],
        docs: m.docs,
        mcp: m.mcp,
        dir,
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        console.warn(`[tools] skipping ${name}: ${(err as Error).message}`);
      }
    }
  }
  tools = found;
  console.log(`[tools] ${tools.length} studio tool(s): ${tools.map((t) => t.id).join(', ') || '-'}`);
}

export function allTools(): ToolManifest[] {
  return tools;
}

export function toolsForArea(area: string): ToolManifest[] {
  return tools.filter((t) => t.areas.includes('*') || t.areas.includes(area));
}

export function publicTool(t: ToolManifest) {
  const { dir, ...rest } = t;
  return { ...rest, docsPath: t.docs ? path.join(dir, t.docs) : null };
}

// ---------------------------------------------------------------------------
// Toolchains detected in the image (shown to admins and to Claude)
// ---------------------------------------------------------------------------
export interface Toolchain {
  id: string;
  name: string;
  available: boolean;
  version?: string;
}

const CHAINS: { id: string; name: string; bin: string; versionArgs?: string[] }[] = [
  // bin resolved at detection time: Claude Code may be installed at runtime (claudecli.ts)
  { id: 'claude', name: 'Claude Code (downloaded from npm, Anthropic)', bin: '', versionArgs: ['--version'] },
  { id: 'node', name: 'Node.js', bin: 'node', versionArgs: ['--version'] },
  { id: 'python', name: 'Python 3 (+ numpy, pillow, mido, trimesh …)', bin: 'python3', versionArgs: ['--version'] },
  { id: 'git', name: 'git', bin: 'git', versionArgs: ['--version'] },
  { id: 'ffmpeg', name: 'ffmpeg', bin: 'ffmpeg', versionArgs: ['-version'] },
  { id: 'imagemagick', name: 'ImageMagick', bin: 'convert', versionArgs: ['-version'] },
  { id: 'fluidsynth', name: 'FluidSynth (+ GM soundfont)', bin: 'fluidsynth', versionArgs: ['--version'] },
  { id: 'sox', name: 'SoX', bin: 'sox', versionArgs: ['--version'] },
  { id: 'java', name: 'Java (JDK)', bin: 'java', versionArgs: ['-version'] },
  { id: 'android', name: 'Android CLI + SDK (installed at runtime by an admin)', bin: 'android' },
  { id: 'gradle', name: 'Gradle', bin: 'gradle' },
  { id: 'dotnet', name: '.NET SDK', bin: 'dotnet', versionArgs: ['--version'] },
  { id: 'mingw', name: 'mingw-w64 (C/C++ → .exe)', bin: 'x86_64-w64-mingw32-gcc', versionArgs: ['--version'] },
  { id: 'nsis', name: 'NSIS installers', bin: 'makensis', versionArgs: ['-VERSION'] },
  { id: 'wine', name: 'Wine', bin: 'wine', versionArgs: ['--version'] },
  { id: 'chromium', name: 'Headless Chromium (Playwright)', bin: 'chromium' },
  { id: 'playwright-mcp', name: 'Playwright MCP (browser tools for Claude)', bin: 'playwright-mcp' },
];

let toolchains: Toolchain[] = [];

export async function detectToolchains(): Promise<void> {
  const out: Toolchain[] = [];
  for (const c of CHAINS) {
    const p = await which(c.id === 'claude' ? config.claudeBin : c.bin);
    let version: string | undefined;
    if (p && c.versionArgs) {
      try {
        const r = await run(p, c.versionArgs, { timeoutMs: 15_000 });
        version = (r.stdout || r.stderr).split('\n').find((l) => l.trim())?.trim().slice(0, 80);
      } catch {
        /* ignore */
      }
    }
    out.push({ id: c.id, name: c.name, available: !!p, version });
  }
  toolchains = out;
}

export function getToolchains(): Toolchain[] {
  return toolchains;
}

export function hasToolchain(id: string): boolean {
  return toolchains.some((t) => t.id === id && t.available);
}
