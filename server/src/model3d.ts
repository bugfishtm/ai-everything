/**
 * The website 3D editor (visual editor for *.scene.yaml). Everything geometric is done by the real
 * studio-3d engine, run as the project owner in the project — exactly like the AI runs it:
 *
 *   POST /projects/:id/3d/model    build the (unsaved) scene text → what was built per object, materials,
 *                                  errors per object, and a .glb in the owner's cache (~/.cache/studio-3d)
 *                                  whose nodes carry the ids of the objects in the text
 *   GET  /projects/:id/3d/catalog  shapes and modifiers (built-in, plugin, pack — also AI-made) with parameters,
 *                                  material presets, pack items, procedural textures, UV projections
 *   POST /projects/:id/3d/texture  a small preview of any texture source, or the pictures of the project
 *   GET  /projects/:id/3d/cache/*  files of that cache (read as the owner)
 *   POST /projects/:id/3d/export   glb / obj / stl / ply (+ a preview picture) into exports/
 */
import { Router } from 'express';
import path from 'node:path';
import { z } from 'zod';
import { HttpError, intParam, parse, wildcard } from './lib/http.js';
import { baseUserEnv, runAs, type SysUser } from './lib/system.js';
import { relOf, resolveIn } from './lib/userfs.js';
import { packsPathFor } from './packs.js';
import { loadOwnedProject, notifyProjectChanged, sendUserFile } from './projects.js';

export const model3dRouter = Router();

const TEXT_MAX = 2 * 1024 * 1024;

/** One engine process at a time per project and kind: bursts of edits queue instead of piling up. */
const queues = new Map<string, Promise<unknown>>();
function queued<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  queues.set(key, next);
  void next
    .finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    })
    .catch(() => undefined);
  return next;
}

interface EngineResult {
  code: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
  output: string;
}

async function engine(su: SysUser, dir: string, args: string[], input: string | undefined, timeoutMs: number): Promise<EngineResult> {
  const r = await runAs(su, 'studio-3d', args, {
    cwd: dir,
    env: baseUserEnv(su, { STUDIO_PROJECT_DIR: dir, STUDIO_PACKS_PATH: packsPathFor(su, dir) }),
    input: input ?? '',
    timeoutMs,
    maxOutput: 32 * 1024 * 1024,
  });
  const lastLine = r.stdout.trim().split('\n').pop() ?? '';
  let json: unknown = null;
  try {
    json = JSON.parse(lastLine);
  } catch {
    /* not JSON: crashed or killed */
  }
  return { code: r.code, json, output: (r.stdout.slice(-4000) + (r.stderr ? `\n${r.stderr.slice(-8000)}` : '')).trim() };
}

function engineError(r: EngineResult, what: string): never {
  const msg = r.json?.error || r.output.split('\n').filter(Boolean).slice(-3).join(' · ') || `${what} failed (${r.code})`;
  throw new HttpError(r.code === 137 || r.code === 128 ? 504 : 422, String(msg).slice(0, 4000));
}

/** The scene file as a project-relative path that can never look like an option. */
function sceneArg(dir: string, p: string): string {
  const rel = relOf(dir, resolveIn(dir, p));
  if (!rel) throw new HttpError(400, 'choose a scene file');
  return rel.startsWith('-') ? `./${rel}` : rel;
}

const sceneBody = z.object({ path: z.string().min(1).max(1024), text: z.string().max(TEXT_MAX).optional() });

/** The newest request per project: an older one that is still waiting in the queue is not built at all. */
const newest = new Map<number, number>();
let counter = 0;

model3dRouter.post('/projects/:id/3d/model', async (req, res) => {
  const { project, su, dir } = await loadOwnedProject(req.user!, intParam(req.params.id));
  const body = parse(sceneBody, req.body);
  const rel = sceneArg(dir, body.path);
  const args = body.text !== undefined ? ['model', '-', '--path', rel] : ['model', rel];
  const token = ++counter;
  newest.set(project.id, token);
  const r = await queued(`model:${project.id}`, async () => {
    if (newest.get(project.id) !== token) return null; // the text has moved on while this one waited
    return engine(su, dir, args, body.text, 3 * 60_000);
  });
  if (newest.get(project.id) === token) newest.delete(project.id);
  if (r === null) {
    res.json({ ok: false, superseded: true });
    return;
  }
  if (!r.json) engineError(r, 'building the scene');
  res.json(r.json); // { ok: false, error } is a normal answer (the editor shows it)
});

model3dRouter.get('/projects/:id/3d/catalog', async (req, res) => {
  const { project, su, dir } = await loadOwnedProject(req.user!, intParam(req.params.id));
  const r = await queued(`catalog:${project.id}`, () => engine(su, dir, ['catalog', '--json'], undefined, 90_000));
  if (!r.json) engineError(r, 'listing shapes');
  res.json(r.json);
});

const textureBody = z.object({
  // a file, a texture name, or a mapping — checked by the engine
  source: z.unknown().optional(),
  list: z.boolean().optional(),
  size: z.number().int().min(16).max(1024).optional(),
  as: z.enum(['color', 'normal']).optional(),
  strength: z.number().min(0).max(20).optional(),
  pixel: z.boolean().optional(),
  path: z.string().max(1024).optional(),
});

model3dRouter.post('/projects/:id/3d/texture', async (req, res) => {
  const { project, su, dir } = await loadOwnedProject(req.user!, intParam(req.params.id));
  const body = parse(textureBody, req.body);
  const input = JSON.stringify({ ...body, path: body.path ? sceneArg(dir, body.path) : undefined });
  if (input.length > 256 * 1024) throw new HttpError(400, 'the texture description is too long');
  const r = await queued(`texture:${project.id}`, () => engine(su, dir, ['texture'], input, 2 * 60_000));
  if (!r.json) engineError(r, 'rendering the texture');
  res.json(r.json);
});

model3dRouter.get('/projects/:id/3d/cache/*path', async (req, res) => {
  const { su } = await loadOwnedProject(req.user!, intParam(req.params.id));
  const root = path.join(su.home, '.cache', 'studio-3d');
  const rel = wildcard(req.params.path);
  if (!/^(edit\/[a-f0-9]{24}\.glb|thumbs\/[a-f0-9]{24}\.png)$/.test(rel)) throw new HttpError(400, 'invalid cache file');
  // content-addressed file names: they never change, the browser may keep them
  await sendUserFile(req, res, su, resolveIn(root, rel), { cacheControl: 'private, max-age=31536000, immutable' });
});

const exportBody = z.object({
  path: z.string().min(1).max(1024),
  text: z.string().max(TEXT_MAX).optional(),
  formats: z.array(z.enum(['glb', 'obj', 'stl', 'ply'])).min(1).max(4),
  preview: z.boolean().optional(),
  name: z
    .string()
    .regex(/^[\w][\w .-]{0,80}$/)
    .optional(),
});

const exporting = new Set<number>();

model3dRouter.post('/projects/:id/3d/export', async (req, res) => {
  const { project, su, dir } = await loadOwnedProject(req.user!, intParam(req.params.id));
  const body = parse(exportBody, req.body);
  const rel = sceneArg(dir, body.path);
  if (exporting.has(project.id)) throw new HttpError(409, 'An export is already running in this project');
  const args = ['build', body.text !== undefined ? '-' : rel, '--path', rel, '--format', [...new Set(body.formats)].join(','), '--json'];
  if (body.preview) args.push('--preview');
  if (body.name) args.push('--name', body.name);
  exporting.add(project.id);
  try {
    const r = await engine(su, dir, args, body.text, 20 * 60_000);
    notifyProjectChanged(project.id);
    if (!r.json?.ok) engineError(r, 'export');
    // absolute paths → project-relative (what the website opens and downloads)
    const files: Record<string, string> = {};
    for (const [k, v] of Object.entries((r.json.files ?? {}) as Record<string, string>)) {
      const abs = path.resolve(dir, v);
      if (abs === dir || abs.startsWith(dir + path.sep)) files[k] = relOf(dir, abs);
    }
    res.json({ ...r.json, files });
  } finally {
    exporting.delete(project.id);
  }
});
