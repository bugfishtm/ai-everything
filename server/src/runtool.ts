/**
 * Lets people run the Studio software on a text file from the website
 * (e.g. "Render" on a .song.yaml, "Build" on a .scene.yaml) — the same
 * commands Claude uses, run as the project owner.
 */
import { Router } from 'express';
import { z } from 'zod';
import { HttpError, intParam, parse } from './lib/http.js';
import { baseUserEnv, runAs } from './lib/system.js';
import { relOf, resolveIn, userStat } from './lib/userfs.js';
import { packsPathFor } from './packs.js';
import { loadOwnedProject, notifyProjectChanged } from './projects.js';

const ACTIONS: Record<string, (file: string) => [string, string[]]> = {
  'daw.render': (f) => ['studio-daw', ['render', f, '--json', '--preview']],
  'daw.check': (f) => ['studio-daw', ['check', f, '--json']],
  '3d.build': (f) => ['studio-3d', ['build', f, '--json', '--preview']],
  '3d.check': (f) => ['studio-3d', ['check', f, '--json']],
  'stick.render': (f) => ['studio-stickman', ['render', f, '--json', '--preview']],
  'stick.draft': (f) => ['studio-stickman', ['render', f, '--json', '--preview', '--draft']],
  'stick.check': (f) => ['studio-stickman', ['check', f, '--json']],
  'image.render': (f) => ['studio-image', ['render', f, '--json', '--preview']],
  'image.check': (f) => ['studio-image', ['check', f, '--json']],
  'video.render': (f) => ['studio-video', ['render', f, '--json', '--preview']],
  'video.draft': (f) => ['studio-video', ['render', f, '--json', '--preview', '--draft']],
  'video.check': (f) => ['studio-video', ['check', f, '--json']],
};

/** Text formats of the Studio software: a new file starts from the tool's own starter (`<tool> new`). */
const STARTERS: { kind: string; ext: RegExp; suffix: string; cmd: string; templates: string[] }[] = [
  { kind: 'song', ext: /\.song\.ya?ml$/i, suffix: '.song.yaml', cmd: 'studio-daw', templates: ['basic', 'gm', 'ambient', 'lofi', 'chiptune', 'house'] },
  { kind: 'scene', ext: /\.scene\.ya?ml$/i, suffix: '.scene.yaml', cmd: 'studio-3d', templates: ['basic', 'props', 'terrain', 'organic', 'textured'] },
  { kind: 'stick', ext: /\.stick\.ya?ml$/i, suffix: '.stick.yaml', cmd: 'studio-stickman', templates: ['fight', 'talk', 'dance', 'blank'] },
  { kind: 'image', ext: /\.image\.ya?ml$/i, suffix: '.image.yaml', cmd: 'studio-image', templates: ['poster', 'icon', 'pixel', 'texture', 'banner', 'blank'] },
  { kind: 'video', ext: /\.video\.ya?ml$/i, suffix: '.video.yaml', cmd: 'studio-video', templates: ['trailer', 'slideshow', 'social', 'blank'] },
];

const busy = new Set<number>();

export const runToolRouter = Router();

/** What can be started from a template (for the "New …" entries of the file tree). */
runToolRouter.get('/tools/starters', (_req, res) => {
  res.json({ starters: STARTERS.map((s) => ({ kind: s.kind, suffix: s.suffix, tool: s.cmd, templates: s.templates })) });
});

runToolRouter.post('/projects/:id/tools/new', async (req, res) => {
  const { project, su, dir } = await loadOwnedProject(req.user!, intParam(req.params.id));
  const body = parse(
    z.object({ path: z.string().trim().min(1).max(1024), template: z.string().regex(/^[a-z0-9_-]{1,32}$/, 'unknown template').optional() }),
    req.body,
  );
  const abs = resolveIn(dir, body.path);
  const rel = relOf(dir, abs);
  if (!rel) throw new HttpError(400, 'choose a file name');
  const starter = STARTERS.find((s) => s.ext.test(rel));
  if (!starter) throw new HttpError(400, `Starters exist for ${STARTERS.map((s) => s.suffix).join(', ')} files`);
  if (body.template && !starter.templates.includes(body.template)) {
    throw new HttpError(400, `${starter.cmd} has no template "${body.template}" (templates: ${starter.templates.join(', ')})`);
  }
  if (await userStat(su, abs)) throw new HttpError(409, `${rel} already exists`);
  const arg = rel.startsWith('-') ? `./${rel}` : rel;
  const r = await runAs(su, starter.cmd, ['new', arg, ...(body.template ? ['--template', body.template] : [])], {
    cwd: dir,
    env: baseUserEnv(su, { STUDIO_PROJECT_DIR: dir, STUDIO_PACKS_PATH: packsPathFor(su, dir) }),
    timeoutMs: 60_000,
  });
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout).trim().split('\n').pop() ?? '';
    throw new HttpError(400, msg.replace(/^studio-[a-z0-9]+:\s*/, '') || `${starter.cmd} could not create the file`);
  }
  notifyProjectChanged(project.id);
  res.status(201).json({ ok: true, path: rel, tool: starter.cmd, template: body.template ?? starter.templates[0] });
});

runToolRouter.post('/projects/:id/tools/run', async (req, res) => {
  const { project, su, dir } = await loadOwnedProject(req.user!, intParam(req.params.id));
  const body = parse(z.object({ action: z.enum(Object.keys(ACTIONS) as [string, ...string[]]), path: z.string().min(1).max(1024) }), req.body);
  const rel = relOf(dir, resolveIn(dir, body.path));
  if (!rel) throw new HttpError(400, 'choose a file');
  const arg = rel.startsWith('-') ? `./${rel}` : rel; // never let a file name look like an option
  if (busy.has(project.id)) throw new HttpError(409, 'Another render is running in this project');
  busy.add(project.id);
  try {
    const [cmd, args] = ACTIONS[body.action](arg);
    const r = await runAs(su, cmd, args, {
      cwd: dir,
      env: baseUserEnv(su, { STUDIO_PROJECT_DIR: dir, STUDIO_PACKS_PATH: packsPathFor(su, dir) }),
      timeoutMs: 20 * 60_000,
    });
    let report: unknown = null;
    const lastLine = r.stdout.trim().split('\n').pop() ?? '';
    try {
      report = JSON.parse(lastLine);
    } catch {
      /* human output */
    }
    notifyProjectChanged(project.id);
    res.json({ ok: r.code === 0, code: r.code, report, output: (r.stdout + (r.stderr ? `\n${r.stderr}` : '')).slice(-20_000) });
  } finally {
    busy.delete(project.id);
  }
});
