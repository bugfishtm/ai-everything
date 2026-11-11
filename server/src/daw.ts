/**
 * The website DAW (visual editor for *.song.yaml). Everything musical is done by the real
 * studio-daw engine, run as the project owner in the project — exactly like Claude runs it:
 *
 *   POST /projects/:id/daw/model    parse the (unsaved) song text → instruments, patterns, events
 *   GET  /projects/:id/daw/catalog  built-in, plugin (project/pack, also AI-made) and pack instruments + effects
 *   POST /projects/:id/daw/sounds   render single notes with the song's instruments into the owner's
 *                                   sound cache (~/.cache/studio-daw) — the browser plays them live
 *   GET  /projects/:id/daw/cache/*  files of that cache (read as the owner)
 *   POST /projects/:id/daw/export   wav / mp3 / midi / stems / zip bundle into exports/
 */
import { Router } from 'express';
import path from 'node:path';
import { z } from 'zod';
import { HttpError, intParam, parse, wildcard } from './lib/http.js';
import { baseUserEnv, runAs, type SysUser } from './lib/system.js';
import { relOf, resolveIn } from './lib/userfs.js';
import { packsPathFor } from './packs.js';
import { loadOwnedProject, notifyProjectChanged, sendUserFile } from './projects.js';

export const dawRouter = Router();

const TEXT_MAX = 2 * 1024 * 1024;

/** One engine process at a time per project and kind: bursts of edits queue instead of piling up. */
const queues = new Map<string, Promise<unknown>>();
function queued<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  queues.set(key, next);
  void next.finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  }).catch(() => undefined);
  return next;
}

interface EngineResult {
  code: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
  output: string;
}

async function engine(su: SysUser, dir: string, args: string[], input: string | undefined, timeoutMs: number): Promise<EngineResult> {
  const r = await runAs(su, 'studio-daw', args, {
    cwd: dir,
    env: baseUserEnv(su, { STUDIO_PROJECT_DIR: dir, STUDIO_PACKS_PATH: packsPathFor(su, dir) }),
    input: input ?? '',
    timeoutMs,
    maxOutput: 64 * 1024 * 1024,
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

/** The song file as a project-relative path that can never look like an option. */
function songArg(dir: string, p: string): string {
  const rel = relOf(dir, resolveIn(dir, p));
  if (!rel) throw new HttpError(400, 'choose a song file');
  return rel.startsWith('-') ? `./${rel}` : rel;
}

const songBody = z.object({ path: z.string().min(1).max(1024), text: z.string().max(TEXT_MAX).optional() });

dawRouter.post('/projects/:id/daw/model', async (req, res) => {
  const { project, su, dir } = await loadOwnedProject(req.user!, intParam(req.params.id));
  const body = parse(songBody, req.body);
  const rel = songArg(dir, body.path);
  const args = body.text !== undefined ? ['model', '-', '--path', rel] : ['model', rel];
  const r = await queued(`model:${project.id}`, () => engine(su, dir, args, body.text, 90_000));
  if (!r.json) engineError(r, 'reading the song');
  res.json(r.json); // { ok: false, error } is a normal answer (the editor shows it)
});

dawRouter.get('/projects/:id/daw/catalog', async (req, res) => {
  const { project, su, dir } = await loadOwnedProject(req.user!, intParam(req.params.id));
  const r = await queued(`catalog:${project.id}`, () => engine(su, dir, ['catalog', '--json'], undefined, 90_000));
  if (!r.json) engineError(r, 'listing instruments');
  res.json(r.json);
});

const noteReq = z.object({
  id: z.string().min(1).max(80),
  p: z.number().int().min(0).max(127).nullable().optional(),
  k: z.string().max(64).nullable().optional(),
  d: z.number().min(0).max(120),
  v: z.number().min(0).max(1),
});

dawRouter.post('/projects/:id/daw/sounds', async (req, res) => {
  const { project, su, dir } = await loadOwnedProject(req.user!, intParam(req.params.id));
  const body = parse(
    z.object({
      path: z.string().min(1).max(1024),
      text: z.string().max(TEXT_MAX),
      requests: z.record(z.string().max(128), z.array(noteReq).max(400)),
    }),
    req.body,
  );
  if (Object.keys(body.requests).length > 64) throw new HttpError(400, 'too many instruments in one request');
  const input = JSON.stringify({ yaml: body.text, path: songArg(dir, body.path), requests: body.requests });
  const r = await queued(`sounds:${project.id}`, () => engine(su, dir, ['sounds', '--json'], input, 10 * 60_000));
  if (!r.json) engineError(r, 'rendering sounds');
  res.json(r.json);
});

dawRouter.get('/projects/:id/daw/cache/*path', async (req, res) => {
  const { su } = await loadOwnedProject(req.user!, intParam(req.params.id));
  const root = path.join(su.home, '.cache', 'studio-daw', 'sounds');
  const rel = wildcard(req.params.path);
  if (!/^[a-f0-9]{8,64}\/[a-f0-9]{6,64}\.(flac|wav)$/.test(rel)) throw new HttpError(400, 'invalid sound file');
  // content-addressed file names: they never change, the browser may keep them
  await sendUserFile(req, res, su, resolveIn(root, rel), { cacheControl: 'private, max-age=31536000, immutable' });
});

const exportBody = z.object({
  path: z.string().min(1).max(1024),
  text: z.string().max(TEXT_MAX).optional(),
  what: z.array(z.enum(['wav', 'mp3', 'midi', 'stems', 'yaml'])).min(1).max(5),
  zip: z.boolean().optional(),
  preview: z.boolean().optional(),
  from: z.number().min(1).max(100_000).optional(),
  to: z.number().min(1).max(100_000).optional(),
  name: z
    .string()
    .regex(/^[\w][\w .-]{0,80}$/)
    .optional(),
});

const exporting = new Set<number>();

dawRouter.post('/projects/:id/daw/export', async (req, res) => {
  const { project, su, dir } = await loadOwnedProject(req.user!, intParam(req.params.id));
  const body = parse(exportBody, req.body);
  const rel = songArg(dir, body.path);
  if (exporting.has(project.id)) throw new HttpError(409, 'An export is already running in this project');
  const args = ['export', body.text !== undefined ? '-' : rel, '--path', rel, '--what', body.what.join(','), '--json'];
  if (body.zip) args.push('--zip');
  if (body.preview) args.push('--preview');
  if (body.from) args.push('--from', String(body.from));
  if (body.to) args.push('--to', String(body.to));
  if (body.name) args.push('--name', body.name);
  exporting.add(project.id);
  try {
    const r = await engine(su, dir, args, body.text, 20 * 60_000);
    notifyProjectChanged(project.id);
    if (!r.json?.ok) engineError(r, 'export');
    // absolute paths → project-relative (what the website downloads)
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
