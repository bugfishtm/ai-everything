/**
 * Versioning — numbered releases of a project (1.0.0, 1.1.0 …).
 *
 * The History tab already keeps every step (a git checkpoint after each AI turn). Versioning adds
 * what people mean by "version 1.2 of my app": a version number the project carries (the VERSION
 * file), a CHANGELOG.md, and releases — each one a git tag (`v1.2.0`) on a checkpoint, with notes
 * and, if wanted, a copy of the finished files in exports/ (the APK, the .exe, the song …) that
 * stays downloadable after the project moved on.
 *   <projects>/<user>/.releases/<project>/<version>.zip    the exports/ of a release
 * It can be switched on when a project is created (every area) or later in the History tab.
 */
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { agentContext } from './agent.js';
import { config } from './config.js';
import { exec, q, q1 } from './db.js';
import { archiveZip, checkpoint, commitsSince, createTag, deleteTag, headSha, restore, tagExists } from './git.js';
import { hooks } from './hooks.js';
import { HttpError, intParam, notFound, parse } from './lib/http.js';
import { ensureSysUser, runAs, type SysUser } from './lib/system.js';
import { userMkdir, userReadFile, userRemove, userStat, userWriteFile, userWriteStream, userZip } from './lib/userfs.js';
import { authorOf, getProjectRow, loadOwnedProject, notifyProjectChanged, sendUserFile, type ProjectRow } from './projects.js';
import type { AuthUser } from './users.js';

export interface Versioning {
  enabled: boolean;
  /** the version the project is at: the last release, or the start version before the first one */
  version: string;
}

interface ReleaseRow {
  id: number;
  project_id: number;
  version: string;
  title: string | null;
  notes: string | null;
  sha: string | null;
  tag: string | null;
  artifacts: { files: number; bytes: number } | null;
  created_by: string | null;
  created_at: Date;
}

export const VERSION_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;
const DEFAULT_VERSION = '0.1.0';

export function versioningOf(p: ProjectRow): Versioning {
  const v = (p.settings ?? {}).versioning;
  const version = typeof v?.version === 'string' && VERSION_RE.test(v.version) ? v.version : DEFAULT_VERSION;
  return { enabled: !!v?.enabled, version };
}

export function normalizeVersion(input: string): string {
  const v = input.trim().replace(/^v/i, '');
  // "1" and "1.2" are what people type: fill them up
  const m = /^(\d{1,6})(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?(-[0-9A-Za-z.]+)?$/.exec(v);
  if (!m) throw new HttpError(400, 'A version looks like 1.2.3 (optionally 1.2.3-beta.1)');
  const out = `${Number(m[1])}.${Number(m[2] ?? 0)}.${Number(m[3] ?? 0)}${m[4] ?? ''}`;
  if (!VERSION_RE.test(out)) throw new HttpError(400, 'A version looks like 1.2.3 (optionally 1.2.3-beta.1)');
  return out;
}

export function bumpVersion(version: string, bump: 'patch' | 'minor' | 'major'): string {
  const m = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(version);
  if (!m) return DEFAULT_VERSION;
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // leaving a pre-release (1.2.0-beta.1 → 1.2.0) is the "patch" step
  if (m[4] && bump === 'patch') return `${maj}.${min}.${pat}`;
  if (bump === 'major') return `${maj + 1}.0.0`;
  if (bump === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

/** 1 when a is newer than b, -1 when older (pre-releases sort before their release). */
export function compareVersions(a: string, b: string): number {
  const pa = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(a);
  const pb = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(b);
  if (!pa || !pb) return a.localeCompare(b);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return d > 0 ? 1 : -1;
  }
  if (pa[4] === pb[4]) return 0;
  if (!pa[4]) return 1;
  if (!pb[4]) return -1;
  return pa[4].localeCompare(pb[4], undefined, { numeric: true }) > 0 ? 1 : -1;
}

function publicRelease(r: ReleaseRow) {
  return {
    id: r.id,
    version: r.version,
    title: r.title ?? '',
    notes: r.notes ?? '',
    sha: r.sha,
    tag: r.tag,
    exports: r.artifacts ?? null,
    createdBy: r.created_by ?? '',
    createdAt: r.created_at,
  };
}

const snapshotDir = (su: SysUser, projectId: number) => path.join(su.projectsRoot, '.releases', String(projectId));
const snapshotFile = (su: SysUser, projectId: number, version: string) => path.join(snapshotDir(su, projectId), `${version}.zip`);

// ---------------------------------------------------------------------------
// VERSION and CHANGELOG.md
// ---------------------------------------------------------------------------
const CHANGELOG_HEAD = '# Changelog\n\nAll notable changes to this project are written down here, newest first.\n';

/** Puts the notes of a release into the changelog; what was collected under "Unreleased" moves into it. */
export function updateChangelog(text: string, version: string, date: string, notes: string): string {
  const section = (body: string) => `## [${version}] - ${date}\n\n${body.trim() || '- (no notes)'}\n`;
  let src = text.replace(/\r\n/g, '\n');
  if (!src.trim()) src = CHANGELOG_HEAD;
  const lines = src.split('\n');
  const isHeading = (l: string) => /^##\s+\S/.test(l);
  const un = lines.findIndex((l) => /^##\s+\[?unreleased\]?\s*$/i.test(l.trim()));
  if (un >= 0) {
    let end = lines.findIndex((l, i) => i > un && isHeading(l));
    if (end < 0) end = lines.length;
    const collected = lines.slice(un + 1, end).join('\n').trim();
    const body = [notes.trim(), collected].filter(Boolean).join('\n\n');
    const before = lines.slice(0, un).join('\n').replace(/\n+$/, '');
    const after = lines.slice(end).join('\n').replace(/^\n+/, '');
    return `${before}\n\n## [Unreleased]\n\n${section(body)}${after ? `\n${after}` : ''}`.replace(/\n{3,}/g, '\n\n').replace(/\n*$/, '\n');
  }
  const first = lines.findIndex(isHeading);
  if (first < 0) return `${src.replace(/\n*$/, '\n')}\n## [Unreleased]\n\n${section(notes)}`;
  const before = lines.slice(0, first).join('\n').replace(/\n+$/, '');
  const after = lines.slice(first).join('\n');
  return `${before}\n\n## [Unreleased]\n\n${section(notes)}\n${after}`.replace(/\n{3,}/g, '\n\n').replace(/\n*$/, '\n');
}

async function readText(su: SysUser, abs: string): Promise<string> {
  const st = await userStat(su, abs);
  if (!st?.isFile) return '';
  return (await userReadFile(su, abs, 2 * 1024 * 1024)).data.toString('utf8');
}

/** The files a versioned project carries: VERSION and CHANGELOG.md (kept when they exist). */
export async function writeVersionFiles(su: SysUser, dir: string, version: string): Promise<void> {
  await userWriteFile(su, path.join(dir, 'VERSION'), `${version}\n`);
  const changelog = path.join(dir, 'CHANGELOG.md');
  if (!(await userStat(su, changelog))) await userWriteFile(su, changelog, `${CHANGELOG_HEAD}\n## [Unreleased]\n`);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------
async function saveVersioning(project: ProjectRow, v: Versioning): Promise<ProjectRow> {
  const settings = { ...(project.settings ?? {}), versioning: v };
  await exec('UPDATE projects SET settings = ? WHERE id = ?', [JSON.stringify(settings), project.id]);
  return (await getProjectRow(project.id))!;
}

async function listReleases(projectId: number): Promise<ReleaseRow[]> {
  return q<ReleaseRow>('SELECT * FROM project_releases WHERE project_id = ? ORDER BY created_at DESC, id DESC', [projectId]);
}

async function overview(project: ProjectRow, su: SysUser, dir: string) {
  const v = versioningOf(project);
  const rows = await listReleases(project.id);
  const last = rows[0] ?? null;
  const pending = await commitsSince(su, dir, last?.sha ?? null, 60).catch(() => ({ count: 0, messages: [] as string[] }));
  // the release commit itself and automatic saves are no news
  const messages = pending.messages.filter((m) => !/^(Release v|Auto-save before restore|Project created$)/.test(m));
  const first = rows.length === 0;
  return {
    versioning: v,
    releases: rows.map(publicRelease),
    pending: { commits: last ? pending.count : Math.max(0, pending.count - 1), messages: messages.slice(0, 40) },
    // the first release publishes the start version itself
    next: {
      patch: first ? v.version : bumpVersion(v.version, 'patch'),
      minor: first ? v.version : bumpVersion(v.version, 'minor'),
      major: first ? (compareVersions(v.version, '1.0.0') < 0 ? '1.0.0' : v.version) : bumpVersion(v.version, 'major'),
    },
    exportsLimitMb: config.limits.releaseExportsMb,
  };
}

async function exportsCount(su: SysUser, dir: string): Promise<number> {
  const r = await runAs(su, 'sh', ['-c', 'find "$1" -type f ! -name .gitkeep 2>/dev/null | head -n 5000 | wc -l', 'sh', path.join(dir, 'exports')], { timeoutMs: 30_000 });
  return Number(r.stdout.trim()) || 0;
}

/** Zips exports/ into the release store (as the owner). Returns null when there is nothing to keep. */
async function snapshotExports(su: SysUser, project: ProjectRow, dir: string, version: string): Promise<{ files: number; bytes: number } | null> {
  const files = await exportsCount(su, dir);
  if (!files) return null;
  const target = snapshotFile(su, project.id, version);
  await userMkdir(su, snapshotDir(su, project.id));
  const limit = config.limits.releaseExportsMb * 1024 * 1024;
  const zip = userZip(su, path.join(dir, 'exports'));
  const { child, done } = userWriteStream(su, target);
  let bytes = 0;
  let tooBig = false;
  zip.stdout!.on('data', (d: Buffer) => {
    bytes += d.length;
    if (bytes > limit && !tooBig) {
      tooBig = true;
      zip.kill('SIGKILL');
    }
  });
  child.stdin!.on('error', () => zip.kill('SIGKILL'));
  zip.stdout!.pipe(child.stdin!);
  const zipCode = await new Promise<number>((resolve) => {
    zip.on('error', () => resolve(1));
    zip.on('close', (code) => resolve(code ?? 1));
  });
  await done.catch(() => {});
  if (tooBig || (zipCode !== 0 && zipCode !== 12)) {
    await userRemove(su, target).catch(() => {});
    if (tooBig) throw new HttpError(413, `exports/ is larger than ${config.limits.releaseExportsMb} MB — release without the copy of exports/, or clean the folder up first`);
    return null;
  }
  return { files, bytes };
}

export interface ReleaseInput {
  bump?: 'patch' | 'minor' | 'major';
  version?: string;
  title?: string;
  notes?: string;
  /** keep a copy of exports/ with the release (default: yes when there is something in it) */
  exports?: boolean;
}

const releasing = new Set<number>();

export async function createRelease(user: AuthUser, project: ProjectRow, su: SysUser, dir: string, input: ReleaseInput) {
  if (releasing.has(project.id)) throw new HttpError(409, 'A release of this project is being made right now');
  releasing.add(project.id);
  try {
    let current = versioningOf(project);
    const rows = await listReleases(project.id);
    let version: string;
    if (input.version) version = normalizeVersion(input.version);
    else if (!rows.length) version = input.bump === 'major' && compareVersions(current.version, '1.0.0') < 0 ? '1.0.0' : current.version;
    else version = bumpVersion(current.version, input.bump ?? 'patch');
    if (rows.some((r) => r.version === version)) throw new HttpError(409, `Version ${version} was already released — choose a higher number`);
    const tag = `v${version}`;
    if (await tagExists(su, dir, tag)) throw new HttpError(409, `The git tag ${tag} already exists in this project`);
    if (!(await headSha(su, dir))) throw new HttpError(409, 'This project has no git history (the .git folder is missing) — versions need it');
    if (!current.enabled) {
      project = await saveVersioning(project, { enabled: true, version: current.version });
      current = versioningOf(project);
    }
    const author = authorOf(user);
    const notes = (input.notes ?? '').trim();
    const title = (input.title ?? '').trim().slice(0, 200);
    const date = new Date().toISOString().slice(0, 10);
    await userWriteFile(su, path.join(dir, 'VERSION'), `${version}\n`);
    const changelog = path.join(dir, 'CHANGELOG.md');
    await userWriteFile(su, changelog, updateChangelog(await readText(su, changelog), version, date, [title ? `**${title}**` : '', notes].filter(Boolean).join('\n\n')));
    await checkpoint(su, dir, `Release ${tag}${title ? ` — ${title}` : ''}`, author);
    const sha = await headSha(su, dir);
    if (!sha) throw new HttpError(500, 'The release could not be saved in the history');
    await createTag(su, dir, tag, [`${project.name} ${version}${title ? ` — ${title}` : ''}`, notes].filter(Boolean).join('\n\n'), author);
    let artifacts: { files: number; bytes: number } | null = null;
    let exportsNote: string | null = null;
    if (input.exports !== false) {
      try {
        artifacts = await snapshotExports(su, project, dir, version);
      } catch (err) {
        // the release itself stands; only the copy of exports/ is missing
        exportsNote = (err as Error).message;
      }
    }
    const { insertId } = await exec(
      'INSERT INTO project_releases (project_id, version, title, notes, sha, tag, artifacts, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [project.id, version, title || null, notes || null, sha, tag, artifacts ? JSON.stringify(artifacts) : null, author.name.slice(0, 128)],
    );
    await saveVersioning(project, { enabled: true, version });
    notifyProjectChanged(project.id);
    const row = (await q1<ReleaseRow>('SELECT * FROM project_releases WHERE id = ?', [insertId]))!;
    return { release: publicRelease(row), exportsNote };
  } finally {
    releasing.delete(project.id);
  }
}

async function ownedRelease(projectId: number, id: number): Promise<ReleaseRow> {
  const row = await q1<ReleaseRow>('SELECT * FROM project_releases WHERE id = ? AND project_id = ?', [id, projectId]);
  if (!row) throw notFound('Release not found');
  return row;
}

hooks.onProjectDeleted(async (projectId: number) => {
  const p = await getProjectRow(projectId);
  if (!p) return;
  const su = await ensureSysUser(p.owner_id);
  await userRemove(su, snapshotDir(su, projectId)).catch(() => {});
});

function slugOf(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_-]+/g, '-')
      .slice(0, 60) || 'project'
  );
}

function zipHeaders(res: Response, name: string): void {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('Cache-Control', 'private, no-store');
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export const releasesRouter = Router();

const releaseBody = z.object({
  bump: z.enum(['patch', 'minor', 'major']).optional(),
  version: z.string().trim().max(64).optional(),
  title: z.string().trim().max(200).optional(),
  notes: z.string().max(20_000).optional(),
  exports: z.boolean().optional(),
});

releasesRouter.get('/projects/:id/releases', async (req, res) => {
  const { project, su, dir } = await loadOwnedProject(req.user!, intParam(req.params.id));
  res.json(await overview(project, su, dir));
});

/** Switch versioning on or off, or set the version the project is at (before the next release). */
releasesRouter.post('/projects/:id/versioning', async (req, res) => {
  const { project, su, dir } = await loadOwnedProject(req.user!, intParam(req.params.id));
  const body = parse(z.object({ enabled: z.boolean(), version: z.string().trim().max(64).optional() }), req.body);
  const cur = versioningOf(project);
  const version = body.version ? normalizeVersion(body.version) : cur.version;
  if (body.enabled) {
    if (hooks.isProjectBusy(project.id)) throw new HttpError(409, 'The AI is working in this project — try again when it is done');
    const st = await userStat(su, path.join(dir, 'VERSION'));
    if (!st || version !== cur.version || !cur.enabled) await writeVersionFiles(su, dir, version);
    await checkpoint(su, dir, cur.enabled ? `Version set to ${version}` : `Versioning switched on (${version})`, authorOf(req.user!));
    notifyProjectChanged(project.id);
  }
  const fresh = await saveVersioning(project, { enabled: body.enabled, version });
  res.json(await overview(fresh, su, dir));
});

releasesRouter.post('/projects/:id/releases', async (req, res) => {
  const { project, su, dir } = await loadOwnedProject(req.user!, intParam(req.params.id));
  if (hooks.isProjectBusy(project.id)) throw new HttpError(409, 'The AI is working in this project — release when it is done (or ask it to release)');
  const body = parse(releaseBody, req.body ?? {});
  const made = await createRelease(req.user!, project, su, dir, body);
  res.status(201).json({ ...made, ...(await overview((await getProjectRow(project.id))!, su, dir)) });
});

releasesRouter.patch('/projects/:id/releases/:rid', async (req, res) => {
  const { project } = await loadOwnedProject(req.user!, intParam(req.params.id));
  const row = await ownedRelease(project.id, intParam(req.params.rid, 'release'));
  const body = parse(z.object({ title: z.string().trim().max(200).optional(), notes: z.string().max(20_000).optional() }), req.body);
  await exec('UPDATE project_releases SET title = ?, notes = ? WHERE id = ?', [
    body.title === undefined ? row.title : body.title || null,
    body.notes === undefined ? row.notes : body.notes.trim() || null,
    row.id,
  ]);
  res.json({ release: publicRelease((await ownedRelease(project.id, row.id))!) });
});

releasesRouter.delete('/projects/:id/releases/:rid', async (req, res) => {
  const { project, su, dir } = await loadOwnedProject(req.user!, intParam(req.params.id));
  const row = await ownedRelease(project.id, intParam(req.params.rid, 'release'));
  await exec('DELETE FROM project_releases WHERE id = ?', [row.id]);
  if (row.tag) await deleteTag(su, dir, row.tag).catch(() => {});
  await userRemove(su, snapshotFile(su, project.id, row.version)).catch(() => {});
  // the project is at its newest remaining release again
  const rest = await listReleases(project.id);
  const cur = versioningOf(project);
  if (cur.version === row.version && rest[0]) await saveVersioning(project, { enabled: cur.enabled, version: rest[0].version });
  res.json(await overview((await getProjectRow(project.id))!, su, dir));
});

/** The project's files as they were at this version (everything git tracks). */
releasesRouter.get('/projects/:id/releases/:rid/source.zip', async (req: Request, res: Response) => {
  const { project, su, dir } = await loadOwnedProject(req.user!, intParam(req.params.id));
  const row = await ownedRelease(project.id, intParam(req.params.rid, 'release'));
  const ref = row.tag && (await tagExists(su, dir, row.tag)) ? row.tag : row.sha;
  if (!ref) throw notFound('The files of this version are not in the history anymore');
  const name = `${slugOf(project.name)}-${row.version}`;
  zipHeaders(res, `${name}.zip`);
  const child = archiveZip(su, dir, ref, name);
  child.on('error', () => res.destroy());
  child.on('close', (code) => {
    if (code !== 0) res.destroy();
  });
  child.stdout!.pipe(res);
  res.on('close', () => child.kill());
});

/** The exports/ folder as it was when the version was released. */
releasesRouter.get('/projects/:id/releases/:rid/exports.zip', async (req, res) => {
  const { project, su } = await loadOwnedProject(req.user!, intParam(req.params.id));
  const row = await ownedRelease(project.id, intParam(req.params.rid, 'release'));
  const file = snapshotFile(su, project.id, row.version);
  if (!row.artifacts || !(await userStat(su, file))?.isFile) throw notFound('No copy of exports/ was kept with this version');
  zipHeaders(res, `${slugOf(project.name)}-${row.version}-exports.zip`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  await sendUserFile(req, res, su, file, { download: false, cacheControl: 'private, no-store' });
});

releasesRouter.post('/projects/:id/releases/:rid/restore', async (req, res) => {
  const { project, su, dir } = await loadOwnedProject(req.user!, intParam(req.params.id));
  if (hooks.isProjectBusy(project.id)) throw new HttpError(409, 'The AI is working in this project — stop it first');
  const row = await ownedRelease(project.id, intParam(req.params.rid, 'release'));
  if (!row.sha) throw notFound('The files of this version are not in the history anymore');
  const commit = await restore(su, dir, row.sha, authorOf(req.user!));
  notifyProjectChanged(project.id);
  res.json({ ok: true, commit });
});

// ---- the AI (studio release …) --------------------------------------------------------------
export const releasesAgentRouter = Router();

releasesAgentRouter.get('/agent/releases', async (req, res) => {
  const { project, su, dir } = await agentContext(req);
  res.json(await overview(project, su, dir));
});

releasesAgentRouter.post('/agent/releases', async (req, res) => {
  const { user, project, su, dir } = await agentContext(req);
  const body = parse(releaseBody, req.body ?? {});
  const made = await createRelease(user, project, su, dir, body);
  res.status(201).json({ ...made, ...(await overview((await getProjectRow(project.id))!, su, dir)) });
});

/** For the AI's instructions (claude/prompt.ts). */
export function versioningPrompt(project: ProjectRow): string[] {
  const v = versioningOf(project);
  if (!v.enabled) return [];
  return [
    '## Versioning',
    `This project is versioned. It is at version ${v.version} (the VERSION file; releases are git tags like v${v.version}).`,
    '- Note every user-visible change under "## [Unreleased]" in CHANGELOG.md as you work (short bullet points: Added / Changed / Fixed).',
    '- Release only when the user asks for a release / a new version: `studio release patch|minor|major --notes "…"` (or an exact number: `studio release 2.0.0`). It writes VERSION, moves the Unreleased notes into the changelog entry, tags the checkpoint and keeps a copy of exports/. patch = fixes, minor = new features, major = breaking changes. `studio release status` lists the versions.',
    '- Before releasing: build the deliverables into exports/ and make the version number inside the software match VERSION (package.json "version", Android versionName/versionCode, .csproj <Version>, a plugin header, an About screen …) — read it from the VERSION file instead of hard-coding where possible.',
    '',
  ];
}
