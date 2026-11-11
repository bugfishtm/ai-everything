/**
 * Agent API — called from inside Claude sessions by the `studio` CLI and the
 * `studio-mcp` MCP server. Each Claude process gets a short-lived bearer token
 * (in its environment) bound to one user + project (+ chat).
 *
 * Also hosts the permission bridge: in "ask" modes Claude Code calls our MCP
 * permission tool, which long-polls here while the browser asks the user.
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { randomToken, sha256, shortId } from './lib/crypto.js';
import { HttpError, parse } from './lib/http.js';
import { ensureSysUser } from './lib/system.js';
import { createAssetFromProject, getVisibleAsset, importAsset, publicAsset, searchAssets } from './library.js';
import { installPackFromProject, packSummary } from './packs.js';
import { getProjectRow, notifyProjectChanged, projectDir } from './projects.js';
import { publicTool, toolsForArea } from './tools.js';
import { getUser } from './users.js';
import { onWs, publish } from './ws.js';

export interface AgentCtx {
  userId: number;
  projectId: number;
  chatId?: number;
  kind: 'run' | 'terminal';
}

const tokens = new Map<string, AgentCtx>();

export function issueAgentToken(ctx: AgentCtx): string {
  const t = `stk_${randomToken(24)}`;
  tokens.set(sha256(t), ctx);
  return t;
}

export function revokeAgentToken(token: string | undefined): void {
  if (token) tokens.delete(sha256(token));
}

export async function agentContext(req: Request) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '');
  const ctx = m ? tokens.get(sha256(m[1])) : undefined;
  if (!ctx) throw new HttpError(401, 'invalid or expired STUDIO_TOKEN (the studio command only works inside Studio sessions)');
  const user = await getUser(ctx.userId);
  if (!user || user.status !== 'active') throw new HttpError(401, 'user disabled');
  const project = await getProjectRow(ctx.projectId);
  if (!project || project.owner_id !== user.id) throw new HttpError(404, 'project not found');
  const su = await ensureSysUser(user.id);
  return { ctx, user, project, su, dir: projectDir(project) };
}

// ---------------------------------------------------------------------------
// Permission bridge
// ---------------------------------------------------------------------------
export interface PermDecision {
  behavior: 'allow' | 'deny';
  updatedInput?: unknown;
  message?: string;
}

interface Pending {
  id: string;
  chatId: number;
  userId: number;
  toolName: string;
  input: unknown;
  createdAt: number;
  resolve: (d: PermDecision) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, Pending>();
/** tool names the user allowed "for the rest of this run" */
const remembered = new Map<number, Set<string>>();

function clipForUi(input: unknown): unknown {
  const s = JSON.stringify(input ?? {});
  if (s.length <= 8000) return input;
  return { _truncated: true, preview: s.slice(0, 8000) };
}

function finish(id: string, d: PermDecision): void {
  const p = pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(id);
  p.resolve(d);
  publish(`chat:${p.chatId}`, { t: 'perm.resolved', chatId: p.chatId, id, behavior: d.behavior });
}

function requestPermission(chatId: number, userId: number, toolName: string, input: unknown): { id: string; decision: Promise<PermDecision> } {
  const id = shortId('perm', 12);
  if (remembered.get(chatId)?.has(toolName)) {
    return { id, decision: Promise.resolve({ behavior: 'allow', updatedInput: input }) };
  }
  const decision = new Promise<PermDecision>((resolve) => {
    const timer = setTimeout(() => finish(id, { behavior: 'deny', message: 'The user did not answer in time.' }), 15 * 60_000);
    const p: Pending = { id, chatId, userId, toolName, input, createdAt: Date.now(), resolve, timer };
    pending.set(id, p);
    publish(`chat:${chatId}`, {
      t: 'perm.request',
      chatId,
      request: { id, toolName, input: clipForUi(input), createdAt: p.createdAt },
    });
  });
  return { id, decision };
}

/**
 * Ask the user in the browser (ACP agents, agents/acprun.ts). `remembered` = the user chose
 * "allow … for this run", so the agent may stop asking for this tool.
 */
export async function askUserPermission(chatId: number, userId: number, toolName: string, input: unknown): Promise<PermDecision & { remembered: boolean }> {
  const d = await requestPermission(chatId, userId, toolName, input).decision;
  return { ...d, remembered: d.behavior === 'allow' && !!remembered.get(chatId)?.has(toolName) };
}

export function replyPermission(userId: number, id: string, allow: boolean, remember = false, message?: string): boolean {
  const p = pending.get(id);
  if (!p || p.userId !== userId) return false;
  if (allow && remember) {
    if (!remembered.has(p.chatId)) remembered.set(p.chatId, new Set());
    remembered.get(p.chatId)!.add(p.toolName);
  }
  finish(id, allow ? { behavior: 'allow', updatedInput: p.input } : { behavior: 'deny', message: message || 'The user denied this action. Ask them how to proceed.' });
  return true;
}

export function cancelPermissions(chatId: number): void {
  for (const p of [...pending.values()]) if (p.chatId === chatId) finish(p.id, { behavior: 'deny', message: 'The run ended.' });
  remembered.delete(chatId);
}

export function pendingForChat(chatId: number) {
  return [...pending.values()]
    .filter((p) => p.chatId === chatId)
    .map((p) => ({ id: p.id, toolName: p.toolName, input: clipForUi(p.input), createdAt: p.createdAt }));
}

onWs('perm.reply', (c, msg) => {
  replyPermission(c.user.id, String(msg.id), !!msg.allow, !!msg.remember, typeof msg.message === 'string' ? msg.message : undefined);
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export const agentRouter = Router();

agentRouter.get('/agent/whoami', async (req, res) => {
  const { user, project, dir } = await agentContext(req);
  res.json({
    user: { username: user.username, displayName: user.display_name },
    project: { id: project.id, name: project.name, area: project.area, dir },
  });
});

agentRouter.get('/agent/tools', async (req, res) => {
  const { project } = await agentContext(req);
  res.json({ tools: toolsForArea(project.area).map(publicTool) });
});

agentRouter.get('/agent/library/search', async (req, res) => {
  const { user } = await agentContext(req);
  const scope = (['mine', 'global', 'all'] as const).find((s) => s === req.query.scope) ?? 'all';
  const { items, total } = await searchAssets(user, {
    q: typeof req.query.q === 'string' ? req.query.q : '',
    kind: typeof req.query.kind === 'string' ? req.query.kind : '',
    scope,
    limit: Number(req.query.limit) || 20,
  });
  res.json({
    total,
    items: items.map((a) => {
      const p = publicAsset(a);
      return {
        id: p.id,
        name: p.name,
        kind: p.kind,
        description: p.description,
        tags: p.tags,
        mainFile: p.mainFile,
        fileCount: p.files.length,
        sizeBytes: p.sizeBytes,
        visibility: p.visibility,
        owner: p.owner.username,
      };
    }),
  });
});

agentRouter.get('/agent/library/:id', async (req, res) => {
  const { user } = await agentContext(req);
  res.json({ asset: publicAsset(await getVisibleAsset(user, String(req.params.id))) });
});

agentRouter.post('/agent/library/:id/import', async (req, res) => {
  const { user, project, su, dir } = await agentContext(req);
  const body = parse(z.object({ dest: z.string().max(1024).optional() }), req.body ?? {});
  const asset = await getVisibleAsset(user, String(req.params.id));
  const r = await importAsset(asset, su, dir, body.dest);
  notifyProjectChanged(project.id);
  res.json({ ...r, asset: { id: asset.id, name: asset.name, mainFile: asset.main_file } });
});

agentRouter.post('/agent/library', async (req, res) => {
  const { user, project, su, dir } = await agentContext(req);
  const body = parse(
    z.object({
      paths: z.array(z.string().max(2048)).min(1).max(200),
      name: z.string().trim().min(1).max(160),
      kind: z.string().optional(),
      description: z.string().max(4000).optional(),
      tags: z.union([z.array(z.string()), z.string()]).optional(),
      main: z.string().max(1024).optional(),
    }),
    req.body,
  );
  const asset = await createAssetFromProject(user, project, su, dir, body.paths, body);
  res.status(201).json({ asset: publicAsset(asset) });
});

agentRouter.post('/agent/packs/install', async (req, res) => {
  const { user, project, su, dir } = await agentContext(req);
  const body = parse(z.object({ path: z.string().min(1).max(2048) }), req.body);
  const p = await installPackFromProject(user, su, dir, body.path, `Claude in project #${project.id}`);
  res.status(201).json({ pack: packSummary(p) });
});

agentRouter.post('/agent/permission', async (req, res) => {
  const { ctx, user } = await agentContext(req);
  if (!ctx.chatId) throw new HttpError(400, 'permission prompts are only available in chat runs');
  const body = parse(z.object({ tool_name: z.string().max(200), input: z.unknown().optional() }), req.body);
  const { id, decision } = requestPermission(ctx.chatId, user.id, body.tool_name, body.input ?? {});
  // the MCP server went away (Claude stopped) → drop the question
  res.on('close', () => {
    if (!res.writableEnded) finish(id, { behavior: 'deny', message: 'aborted' });
  });
  res.json(await decision);
});
