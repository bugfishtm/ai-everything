/**
 * Skills and instructions — how users shape what the AI does here.
 *
 * Instructions are standing rules that are always part of the AI's prompt:
 *   the admin's (for everyone) and each user's own, for all work or for one area
 *   (music, game … and "chat" for the Chat page).
 *
 * Skills are know-how the AI loads only when it needs it — a SKILL.md: a name, "when to use
 * this" and the instructions themselves. The prompt lists the names and descriptions; the AI
 * reads a skill with `studio skill show <name>` before it starts a matching task, and users call
 * one directly by starting a message with /name. Skills come from three places:
 *   built-in   shipped with the Studio (skills/<name>/SKILL.md)
 *   mine       written by the user on the website — or by the AI (`studio skill save`)
 *   global     published by other users to the Global Space; a user adds the ones they want
 * Every AI provider gets them the same way (they are text in the prompt, not a vendor feature).
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { agentContext } from './agent.js';
import { AREAS, CHAT_AREA } from './areas.js';
import { config } from './config.js';
import { exec, q, q1 } from './db.js';
import { HttpError, intParam, notFound, parse } from './lib/http.js';
import { getSetting, setSetting } from './settings.js';
import type { AuthUser } from './users.js';

// ---------------------------------------------------------------------------
// SKILL.md
// ---------------------------------------------------------------------------
export interface SkillDoc {
  /** short id (becomes the /command) */
  name: string;
  /** display name */
  title?: string;
  description: string;
  areas: string[];
  /** listed to the AI by itself (false: only when the user calls it with /name) */
  auto: boolean;
  body: string;
}

const AREA_IDS = [...AREAS.map((a) => a.id), CHAT_AREA.id];
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const BODY_MAX = 60_000;

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9\s_-]/g, '')
      .trim()
      .replace(/[\s_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/, '') || 'skill'
  );
}

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

/**
 * One front matter value as YAML means it: without the trailing comment ("x   # note"), quotes
 * removed and their escapes resolved ("a \"b\" c" — what skillToMd writes). A # inside quotes stays.
 */
function scalar(v: string): string {
  const t = v.trim();
  const quote = t[0];
  if (quote === '"' || quote === "'") {
    for (let i = 1; i < t.length; i++) {
      if (quote === '"' && t[i] === '\\') {
        i++;
        continue;
      }
      if (t[i] !== quote) continue;
      if (quote === "'" && t[i + 1] === "'") {
        i++;
        continue;
      }
      const inner = t.slice(1, i);
      if (quote === "'") return inner.replace(/''/g, "'");
      try {
        return String(JSON.parse(`"${inner}"`));
      } catch {
        return inner.replace(/\\(["\\])/g, '$1');
      }
    }
    return t.slice(1); // no closing quote: take the rest as it is
  }
  return uncomment(t);
}

/** Cuts a YAML comment off an unquoted piece of text (" #" starts one, "C#" does not). */
function uncomment(t: string): string {
  if (t.startsWith('#')) return '';
  const m = /\s#/.exec(t);
  return (m ? t.slice(0, m.index) : t).trim();
}

/** The description the scaffold of `studio skill new` comes with — a skill saved with it would never be picked. */
const TEMPLATE_DESCRIPTION = /^One or two sentences on WHEN to use this skill/i;

function cleanAreas(list: string[]): string[] {
  const out = [...new Set(list.map((a) => a.trim().toLowerCase()).filter((a) => AREA_IDS.includes(a)))];
  return out.length === AREA_IDS.length ? [] : out;
}

/** Reads a SKILL.md: optional front matter (name, description, areas, auto) + the instructions. */
export function parseSkillMd(text: string): Partial<SkillDoc> & { body: string } {
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (!m) return { body: src.trim() };
  const meta: Record<string, string> = {};
  let key = '';
  let block = false; // inside a "key: >" / "key: |" text block (a # is text there)
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv && !/^\s/.test(line)) {
      key = kv[1].toLowerCase();
      block = /^[>|][+-]?\s*(#.*)?$/.test(kv[2].trim());
      meta[key] = block ? '' : scalar(kv[2]);
    } else if (key && line.trim()) {
      if (!block && line.trim().startsWith('#')) continue;
      const piece = block ? line.trim() : uncomment(line.trim());
      meta[key] = `${meta[key]} ${block ? piece : piece.replace(/^-\s+/, ', ')}`.trim();
    }
  }
  const out: Partial<SkillDoc> & { body: string } = { body: src.slice(m[0].length).trim() };
  if (meta.name) out.name = meta.name.slice(0, 128);
  if (meta.title) out.title = meta.title.slice(0, 128);
  if (meta.description) out.description = meta.description.replace(/\s+/g, ' ').slice(0, 1024);
  if (meta.areas !== undefined) {
    out.areas = cleanAreas(
      meta.areas
        .replace(/^[\s,]*\[|\][\s,]*$/g, '')
        .split(',')
        .map(unquote),
    );
  }
  if (meta.auto !== undefined) out.auto = !/^(false|no|off|0)$/i.test(meta.auto.trim());
  return out;
}

export function skillToMd(s: { slug: string; name: string; description: string; areas: string[]; auto: boolean; body: string }): string {
  const head = ['---', `name: ${s.slug}`, `description: ${JSON.stringify(s.description)}`];
  if (s.name && s.name !== s.slug) head.push(`title: ${JSON.stringify(s.name)}`);
  if (s.areas.length) head.push(`areas: [${s.areas.join(', ')}]`);
  if (!s.auto) head.push('auto: false');
  head.push('---', '');
  return `${head.join('\n')}\n${s.body.trim()}\n`;
}

// ---------------------------------------------------------------------------
// Skills: built-in (files) + stored (database)
// ---------------------------------------------------------------------------
interface SkillRow {
  id: number;
  owner_id: number;
  slug: string;
  name: string;
  description: string;
  body: string;
  areas: string;
  auto: number;
  visibility: 'private' | 'global';
  reviewed: number;
  uses: number;
  created_at: Date;
  updated_at: Date;
  published_at: Date | null;
  owner_name?: string;
}

export interface Skill {
  /** "sys:<slug>" for built-in skills, the database id otherwise */
  key: string;
  id: number | null;
  slug: string;
  name: string;
  description: string;
  body: string;
  areas: string[];
  auto: boolean;
  scope: 'system' | 'mine' | 'global';
  ownerId: number | null;
  ownerName: string | null;
  published: boolean;
  reviewed: boolean;
  uses: number;
  updatedAt: Date | null;
}

let systemSkills: Skill[] = [];

export async function loadSystemSkills(): Promise<void> {
  const found: Skill[] = [];
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(config.skillsDir);
  } catch {
    systemSkills = [];
    return;
  }
  for (const dir of entries.sort()) {
    if (!SLUG_RE.test(dir)) continue;
    try {
      const file = path.join(config.skillsDir, dir, 'SKILL.md');
      const doc = parseSkillMd(await fsp.readFile(file, 'utf8'));
      if (!doc.description || !doc.body) throw new Error('needs a description and instructions');
      const st = await fsp.stat(file);
      found.push({
        key: `sys:${dir}`, id: null, slug: dir, name: doc.title || titleOf(doc.body) || doc.name || dir, description: doc.description, body: doc.body,
        areas: doc.areas ?? [], auto: doc.auto ?? true, scope: 'system', ownerId: null, ownerName: null, published: true, reviewed: true,
        uses: 0, updatedAt: st.mtime,
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') console.warn(`[skills] skipping ${dir}: ${(err as Error).message}`);
    }
  }
  systemSkills = found;
  console.log(`[skills] ${found.length} built-in skill(s)`);
}

function titleOf(body: string): string {
  return (/^#\s+(.+)$/m.exec(body)?.[1] ?? '').trim().slice(0, 128);
}

function fromRow(r: SkillRow, viewer: number): Skill {
  return {
    key: String(r.id), id: r.id, slug: r.slug, name: r.name, description: r.description, body: r.body,
    areas: r.areas ? r.areas.split(',').filter(Boolean) : [], auto: !!r.auto,
    scope: r.owner_id === viewer ? 'mine' : 'global', ownerId: r.owner_id, ownerName: r.owner_name ?? null,
    published: r.visibility === 'global', reviewed: !!r.reviewed, uses: Number(r.uses), updatedAt: r.updated_at,
  };
}

async function prefsOf(userId: number): Promise<Map<string, boolean>> {
  const rows = await q<{ skill_key: string; enabled: number }>('SELECT skill_key, enabled FROM skill_prefs WHERE user_id = ?', [userId]);
  return new Map(rows.map((r) => [r.skill_key, !!r.enabled]));
}

/** Own and built-in skills are on unless switched off; skills of others are off until added. */
function isEnabled(s: Skill, prefs: Map<string, boolean>): boolean {
  return prefs.get(s.key) ?? s.scope !== 'global';
}

/** Everything a user can see: their own skills, published ones and the built-in ones. */
async function visibleSkills(userId: number): Promise<{ skills: Skill[]; prefs: Map<string, boolean> }> {
  const rows = await q<SkillRow>(
    `SELECT s.*, u.username AS owner_name FROM skills s JOIN users u ON u.id = s.owner_id
      WHERE s.owner_id = ? OR s.visibility = 'global' ORDER BY s.name`,
    [userId],
  );
  return { skills: [...rows.map((r) => fromRow(r, userId)), ...systemSkills], prefs: await prefsOf(userId) };
}

/** The skills that work for a user: enabled ones; when names collide: own, then added, then built-in. */
export async function activeSkills(userId: number, area?: string): Promise<Skill[]> {
  const { skills, prefs } = await visibleSkills(userId);
  const rank = { mine: 0, global: 1, system: 2 } as const;
  const bySlug = new Map<string, Skill>();
  for (const s of skills.filter((x) => isEnabled(x, prefs)).sort((a, b) => rank[a.scope] - rank[b.scope])) {
    if (!bySlug.has(s.slug)) bySlug.set(s.slug, s);
  }
  return [...bySlug.values()].filter((s) => !area || !s.areas.length || s.areas.includes(area)).sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function findSkill(userId: number, slug: string): Promise<Skill | null> {
  const name = slug.trim().toLowerCase();
  return (await activeSkills(userId)).find((s) => s.slug === name) ?? null;
}

function publicSkill(s: Skill, prefs: Map<string, boolean>, withBody = false) {
  return {
    key: s.key, id: s.id, slug: s.slug, name: s.name, description: s.description, areas: s.areas, auto: s.auto, scope: s.scope,
    owner: s.ownerName, published: s.published, reviewed: s.reviewed, uses: s.uses, updatedAt: s.updatedAt,
    enabled: isEnabled(s, prefs), chars: s.body.length, ...(withBody ? { body: s.body } : {}),
  };
}

const skillInput = z.object({
  slug: z.string().trim().toLowerCase().max(64).optional(),
  name: z.string().trim().min(1).max(128),
  description: z.string().trim().min(8, 'describe when the AI should use this skill (a sentence)').max(1024),
  body: z.string().min(1, 'the skill needs instructions').max(BODY_MAX),
  areas: z.array(z.string()).max(20).optional(),
  auto: z.boolean().optional(),
});
type SkillInput = z.infer<typeof skillInput>;

async function saveSkill(userId: number, input: SkillInput, existing?: SkillRow): Promise<number> {
  const slug = input.slug ? input.slug : existing ? existing.slug : slugify(input.name);
  if (!SLUG_RE.test(slug)) throw new HttpError(400, 'name for /commands: 1–64 characters, a-z, 0-9 and - (not at the start or end)');
  const areas = cleanAreas(input.areas ?? []).join(',');
  const description = input.description.replace(/\s+/g, ' ');
  const taken = await q1<{ id: number }>('SELECT id FROM skills WHERE owner_id = ? AND slug = ? AND id <> ?', [existing?.owner_id ?? userId, slug, existing?.id ?? 0]);
  if (taken) throw new HttpError(409, `you already have a skill called "${slug}"`);
  if (existing) {
    // a published skill that changes must be looked at again
    const changed = existing.body !== input.body || existing.description !== description;
    await exec('UPDATE skills SET slug = ?, name = ?, description = ?, body = ?, areas = ?, auto = ?, reviewed = IF(?, 0, reviewed) WHERE id = ?', [
      slug, input.name, description, input.body, areas, input.auto === false ? 0 : 1, changed ? 1 : 0, existing.id,
    ]);
    return existing.id;
  }
  const n = Number((await q1<{ n: number }>('SELECT COUNT(*) AS n FROM skills WHERE owner_id = ?', [userId]))?.n ?? 0);
  if (n >= 300) throw new HttpError(429, 'You have 300 skills — delete some first');
  const { insertId } = await exec('INSERT INTO skills (owner_id, slug, name, description, body, areas, auto) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    userId, slug, input.name, description, input.body, areas, input.auto === false ? 0 : 1,
  ]);
  return insertId;
}

async function ownedRow(user: AuthUser, id: number, adminToo = false): Promise<SkillRow> {
  const row = await q1<SkillRow>('SELECT * FROM skills WHERE id = ?', [id]);
  if (!row || (row.owner_id !== user.id && !(adminToo && user.role === 'admin'))) throw notFound('Skill not found');
  return row;
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------
const INSTRUCTION_MAX = 20_000;
type Instr = { body: string; enabled: boolean };

function validScope(scope: string): string {
  if (scope !== 'all' && !AREA_IDS.includes(scope)) throw new HttpError(400, 'unknown area');
  return scope;
}

async function userInstructions(userId: number): Promise<Record<string, Instr>> {
  const rows = await q<{ scope: string; body: string; enabled: number }>('SELECT scope, body, enabled FROM user_instructions WHERE user_id = ?', [userId]);
  return Object.fromEntries(rows.map((r) => [r.scope, { body: r.body, enabled: !!r.enabled }]));
}

async function globalInstructions(): Promise<Record<string, Instr>> {
  return getSetting<Record<string, Instr>>('instructions.global', {});
}

// ---------------------------------------------------------------------------
// What goes into the AI's prompt
// ---------------------------------------------------------------------------
function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n… (cut: too long)` : s;
}

/** Standing instructions (admin + user, for all areas + this area) and the list of skills. */
export async function promptAddendum(userId: number, area: string, opts: { skills?: boolean } = {}): Promise<string> {
  const [global, mine] = await Promise.all([globalInstructions(), userInstructions(userId)]);
  const pick = (set: Record<string, Instr>) =>
    ['all', area]
      .map((scope) => set[scope])
      .filter((x): x is Instr => !!x && x.enabled && !!x.body.trim())
      .map((x) => clip(x.body.trim(), INSTRUCTION_MAX));
  const L: string[] = [];
  const g = pick(global);
  if (g.length) L.push("## Instructions from this Studio's admin", ...g, '');
  const u = pick(mine);
  if (u.length) L.push("## The user's standing instructions", 'The user set these for all their work here — follow them unless they say otherwise in the chat.', ...u, '');
  if (opts.skills !== false) {
    const skills = (await activeSkills(userId, area)).filter((s) => s.auto);
    if (skills.length) {
      L.push(
        '## Skills',
        'Know-how the user set up for recurring tasks. When a task matches a skill, read it first with `studio skill show <name>` and follow it (it is quick; do not guess its content). The user can also call a skill with /name at the start of a message.',
      );
      let used = 0;
      for (const s of skills) {
        const line = `- \`${s.slug}\` — ${clip(s.description, 400)}`;
        used += line.length;
        if (used > 9000) {
          L.push(`- … more: \`studio skill list\``);
          break;
        }
        L.push(line);
      }
      L.push('Save a workflow the user wants to keep as a new skill: write a SKILL.md and run `studio skill save <file>` (see `studio skill new`).', '');
    }
  }
  return L.join('\n').trim();
}

/** "/name …" at the start of a message calls a skill: its instructions are put in front of the request. */
export async function expandSkillCommand(userId: number, text: string): Promise<{ prompt: string; skill: Skill } | null> {
  const m = /^\/([a-z0-9][a-z0-9-]{0,63})(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  const skill = await findSkill(userId, m[1]);
  if (!skill) return null;
  const rest = (m[2] ?? '').trim();
  exec('UPDATE skills SET uses = uses + 1 WHERE id = ?', [skill.id ?? 0]).catch(() => {});
  return {
    skill,
    prompt: [
      `The user called the skill "${skill.slug}" (${skill.name}). Follow these instructions for this request:`,
      '',
      `<skill name="${skill.slug}">`,
      skill.body.trim(),
      '</skill>',
      '',
      rest ? `The user's request: ${rest}` : 'The user gave no further details — apply the skill to the current project (ask only if something essential is missing).',
    ].join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Website routes
// ---------------------------------------------------------------------------
export const skillsRouter = Router();

skillsRouter.get('/skills', async (req, res) => {
  const { skills, prefs } = await visibleSkills(req.user!.id);
  res.json({
    skills: skills.map((s) => publicSkill(s, prefs)),
    areas: [...AREAS.map((a) => ({ id: a.id, name: a.name })), { id: CHAT_AREA.id, name: CHAT_AREA.name }],
  });
});

async function skillByKey(user: AuthUser, key: string): Promise<{ skill: Skill; prefs: Map<string, boolean> }> {
  const { skills, prefs } = await visibleSkills(user.id);
  const skill = skills.find((s) => s.key === key);
  if (!skill) throw notFound('Skill not found');
  return { skill, prefs };
}

skillsRouter.get('/skills/:key', async (req, res) => {
  const { skill, prefs } = await skillByKey(req.user!, String(req.params.key));
  res.json({ skill: publicSkill(skill, prefs, true) });
});

skillsRouter.get('/skills/:key/export', async (req, res) => {
  const { skill } = await skillByKey(req.user!, String(req.params.key));
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${skill.slug}.SKILL.md"`);
  res.end(skillToMd(skill));
});

skillsRouter.post('/skills', async (req, res) => {
  const id = await saveSkill(req.user!.id, parse(skillInput, req.body));
  const { skill, prefs } = await skillByKey(req.user!, String(id));
  res.status(201).json({ skill: publicSkill(skill, prefs, true) });
});

/** A SKILL.md file (front matter + instructions) becomes a skill. */
skillsRouter.post('/skills/import', async (req, res) => {
  const body = parse(z.object({ markdown: z.string().min(1).max(BODY_MAX + 4000), slug: z.string().optional() }), req.body);
  const doc = parseSkillMd(body.markdown);
  if (doc.description && TEMPLATE_DESCRIPTION.test(doc.description)) {
    throw new HttpError(400, 'This SKILL.md still has the description of the template — write when the skill should be used (the AI decides by that sentence)');
  }
  const slug = slugify(body.slug || doc.name || doc.title || titleOf(doc.body) || 'skill');
  const input = parse(skillInput, {
    slug,
    name: doc.title || titleOf(doc.body) || doc.name || slug,
    description: doc.description ?? '',
    body: doc.body,
    areas: doc.areas ?? [],
    auto: doc.auto ?? true,
  });
  const existing = await q1<SkillRow>('SELECT * FROM skills WHERE owner_id = ? AND slug = ?', [req.user!.id, slug]);
  const id = await saveSkill(req.user!.id, input, existing ?? undefined);
  const { skill, prefs } = await skillByKey(req.user!, String(id));
  res.status(existing ? 200 : 201).json({ skill: publicSkill(skill, prefs, true), updated: !!existing });
});

skillsRouter.put('/skills/:id', async (req, res) => {
  const row = await ownedRow(req.user!, intParam(req.params.id));
  await saveSkill(req.user!.id, parse(skillInput, req.body), row);
  const { skill, prefs } = await skillByKey(req.user!, String(row.id));
  res.json({ skill: publicSkill(skill, prefs, true) });
});

skillsRouter.delete('/skills/:id', async (req, res) => {
  const row = await ownedRow(req.user!, intParam(req.params.id), true);
  await exec('DELETE FROM skills WHERE id = ?', [row.id]);
  await exec('DELETE FROM skill_prefs WHERE skill_key = ?', [String(row.id)]);
  res.json({ ok: true });
});

/** Switch a skill on or off for yourself (adding a published skill of someone else = switching it on). */
skillsRouter.post('/skills/:key/enable', async (req, res) => {
  const body = parse(z.object({ enabled: z.boolean() }), req.body);
  const { skill } = await skillByKey(req.user!, String(req.params.key));
  await exec('INSERT INTO skill_prefs (user_id, skill_key, enabled) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)', [
    req.user!.id, skill.key, body.enabled ? 1 : 0,
  ]);
  res.json({ ok: true, enabled: body.enabled });
});

skillsRouter.post('/skills/:id/publish', async (req, res) => {
  const row = await ownedRow(req.user!, intParam(req.params.id));
  const clash = await q1<{ id: number }>("SELECT id FROM skills WHERE visibility = 'global' AND slug = ? AND id <> ?", [row.slug, row.id]);
  if (clash) throw new HttpError(409, `the Global Space already has a skill called "${row.slug}" — rename yours first`);
  if (systemSkills.some((s) => s.slug === row.slug)) throw new HttpError(409, `"${row.slug}" is the name of a built-in skill — rename yours first`);
  await exec("UPDATE skills SET visibility = 'global', published_at = UTC_TIMESTAMP(3), reviewed = ? WHERE id = ?", [req.user!.role === 'admin' ? 1 : 0, row.id]);
  res.json({ ok: true });
});

skillsRouter.post('/skills/:id/unpublish', async (req, res) => {
  const row = await ownedRow(req.user!, intParam(req.params.id), true);
  await exec("UPDATE skills SET visibility = 'private', published_at = NULL WHERE id = ?", [row.id]);
  // people who added it lose it
  await exec('DELETE FROM skill_prefs WHERE skill_key = ? AND user_id <> ?', [String(row.id), row.owner_id]);
  res.json({ ok: true });
});

/** Admins mark published skills as looked at (they are instructions other people's AI will follow). */
skillsRouter.post('/admin/skills/:id/review', async (req, res) => {
  const body = parse(z.object({ reviewed: z.boolean() }), req.body);
  await exec('UPDATE skills SET reviewed = ? WHERE id = ?', [body.reviewed ? 1 : 0, intParam(req.params.id)]);
  res.json({ ok: true });
});

// ---- instructions -------------------------------------------------------------
const instrBody = z.object({ body: z.string().max(INSTRUCTION_MAX), enabled: z.boolean().optional() });

skillsRouter.get('/instructions', async (req, res) => {
  const global = await globalInstructions();
  res.json({
    mine: await userInstructions(req.user!.id),
    // everyone may read what the admin tells the AI; only admins change it
    global: Object.fromEntries(Object.entries(global).filter(([, v]) => v.enabled && v.body.trim())),
    areas: [{ id: 'all', name: 'Everything' }, ...AREAS.map((a) => ({ id: a.id, name: a.name })), { id: CHAT_AREA.id, name: 'Chat page' }],
    max: INSTRUCTION_MAX,
  });
});

skillsRouter.put('/instructions/:scope', async (req, res) => {
  const scope = validScope(String(req.params.scope));
  const body = parse(instrBody, req.body);
  if (!body.body.trim()) await exec('DELETE FROM user_instructions WHERE user_id = ? AND scope = ?', [req.user!.id, scope]);
  else {
    await exec('INSERT INTO user_instructions (user_id, scope, body, enabled) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE body = VALUES(body), enabled = VALUES(enabled)', [
      req.user!.id, scope, body.body, body.enabled === false ? 0 : 1,
    ]);
  }
  res.json({ mine: await userInstructions(req.user!.id) });
});

skillsRouter.get('/admin/instructions', async (_req, res) => {
  res.json({ global: await globalInstructions() });
});

skillsRouter.put('/admin/instructions/:scope', async (req, res) => {
  const scope = validScope(String(req.params.scope));
  const body = parse(instrBody, req.body);
  const all = { ...(await globalInstructions()) };
  if (!body.body.trim()) delete all[scope];
  else all[scope] = { body: body.body, enabled: body.enabled !== false };
  await setSetting('instructions.global', all);
  res.json({ global: all });
});

// ---------------------------------------------------------------------------
// Agent routes (bearer STUDIO_TOKEN) — `studio skill …` inside AI sessions
// ---------------------------------------------------------------------------
export const skillsAgentRouter = Router();

skillsAgentRouter.get('/agent/skills', async (req, res) => {
  const { user, project } = await agentContext(req);
  const all = req.query.all === '1';
  const list = await activeSkills(user.id, all ? undefined : project.area);
  res.json({
    area: project.area,
    skills: list.map((s) => ({ name: s.slug, title: s.name, description: s.description, areas: s.areas, scope: s.scope, auto: s.auto, chars: s.body.length })),
  });
});

skillsAgentRouter.get('/agent/skills/:slug', async (req, res) => {
  const { user } = await agentContext(req);
  const slug = String(req.params.slug).toLowerCase();
  const skill = await findSkill(user.id, slug);
  if (!skill) {
    const names = (await activeSkills(user.id)).map((s) => s.slug);
    throw notFound(`no skill "${slug}" — skills: ${names.join(', ') || '(none)'}`);
  }
  if (skill.id) exec('UPDATE skills SET uses = uses + 1 WHERE id = ?', [skill.id]).catch(() => {});
  res.json({ skill: { name: skill.slug, title: skill.name, description: skill.description, areas: skill.areas, scope: skill.scope, body: skill.body } });
});

/** The AI saves a SKILL.md as the user's own skill (new, or a new version of an own skill). */
skillsAgentRouter.post('/agent/skills', async (req, res) => {
  const { user } = await agentContext(req);
  const body = parse(z.object({ markdown: z.string().min(1).max(BODY_MAX + 4000), slug: z.string().max(64).optional() }), req.body);
  const doc = parseSkillMd(body.markdown);
  const slug = slugify(body.slug || doc.name || doc.title || titleOf(doc.body) || '');
  if (!doc.description) throw new HttpError(400, 'the SKILL.md needs front matter with "description:" — one or two sentences on WHEN to use the skill (the AI decides by it)');
  if (TEMPLATE_DESCRIPTION.test(doc.description)) {
    throw new HttpError(400, 'the SKILL.md still has the description of the template — replace it with one or two sentences on WHEN to use the skill, then save again');
  }
  if (!doc.body.trim()) throw new HttpError(400, 'the SKILL.md has no instructions below the front matter');
  const input = parse(skillInput, { slug, name: doc.title || titleOf(doc.body) || doc.name || slug, description: doc.description, body: doc.body, areas: doc.areas ?? [], auto: doc.auto ?? true });
  const existing = await q1<SkillRow>('SELECT * FROM skills WHERE owner_id = ? AND slug = ?', [user.id, slug]);
  await saveSkill(user.id, input, existing ?? undefined);
  res.json({ name: slug, updated: !!existing, areas: input.areas ?? [] });
});
