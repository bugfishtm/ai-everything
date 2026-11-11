import fsp from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { activeRunCount } from './claude/runner.js';
import { claudeVersion } from './claude/creds.js';
import { terminalCount } from './claude/terminal.js';
import { config } from './config.js';
import { exec, q } from './db.js';
import { hooks } from './hooks.js';
import { hashPassword } from './lib/crypto.js';
import { HttpError, intParam, parse } from './lib/http.js';
import { isolation, removeSysUser, sysUserFor } from './lib/system.js';
import { assetRoot } from './library.js';
import { reloadPacks } from './packs.js';
import { setServicesOwnerDisabled } from './services.js';
import { getSetting, setSetting } from './settings.js';
import { allTools, detectToolchains, getToolchains, loadTools, publicTool } from './tools.js';
import { createUser, emailSchema, getUser, listUsers, passwordSchema, publicUser, usernameSchema } from './users.js';
import { closeUserSockets, connectedClients } from './ws.js';

export const adminRouter = Router();
const startedAt = Date.now();

adminRouter.get('/admin/users', async (_req, res) => {
  const users = await listUsers();
  const projects = await q<{ owner_id: number; n: number }>("SELECT owner_id, COUNT(*) AS n FROM projects WHERE area <> 'chat' GROUP BY owner_id");
  const assets = await q<{ owner_id: number; n: number }>('SELECT owner_id, COUNT(*) AS n FROM assets GROUP BY owner_id');
  res.json({
    users: users.map((u) => ({
      ...publicUser(u),
      projects: Number(projects.find((p) => p.owner_id === u.id)?.n ?? 0),
      assets: Number(assets.find((a) => a.owner_id === u.id)?.n ?? 0),
    })),
  });
});

adminRouter.post('/admin/users', async (req, res) => {
  const body = parse(
    z.object({
      email: emailSchema,
      username: usernameSchema,
      displayName: z.string().trim().max(128).optional(),
      password: passwordSchema,
      role: z.enum(['admin', 'user']).default('user'),
    }),
    req.body,
  );
  const user = await createUser(body);
  res.status(201).json({ user: publicUser(user) });
});

adminRouter.patch('/admin/users/:id', async (req, res) => {
  const id = intParam(req.params.id);
  const body = parse(
    z.object({
      role: z.enum(['admin', 'user']).optional(),
      status: z.enum(['active', 'disabled']).optional(),
      password: passwordSchema.optional(),
      displayName: z.string().trim().min(1).max(128).optional(),
    }),
    req.body,
  );
  const target = await getUser(id);
  if (!target) throw new HttpError(404, 'User not found');
  if (id === req.user!.id && (body.role === 'user' || body.status === 'disabled')) {
    throw new HttpError(400, 'You cannot demote or disable yourself');
  }
  if (body.role && body.role !== target.role) {
    await exec('UPDATE users SET role = ? WHERE id = ?', [body.role, id]);
    // open connections were authorized with the old role
    closeUserSockets(id);
  }
  if (body.displayName) await exec('UPDATE users SET display_name = ? WHERE id = ?', [body.displayName, id]);
  if (body.status) {
    await exec('UPDATE users SET status = ? WHERE id = ?', [body.status, id]);
    if (body.status === 'disabled') {
      await exec('DELETE FROM sessions WHERE user_id = ?', [id]);
      closeUserSockets(id);
      // nothing of a disabled account keeps running: AI runs, terminals, its deployed servers
      for (const p of await q<{ id: number }>('SELECT id FROM projects WHERE owner_id = ?', [id])) await hooks.stopProject(p.id).catch(() => {});
    }
    await setServicesOwnerDisabled(id, body.status === 'disabled').catch(() => {});
  }
  if (body.password) {
    await exec('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(body.password), id]);
    await exec('DELETE FROM sessions WHERE user_id = ?', [id]);
    closeUserSockets(id);
  }
  res.json({ user: publicUser((await getUser(id))!) });
});

/**
 * Deletes an account with everything it owns: projects (with their servers and websites), chats,
 * library assets (also published ones), personal packs, skills, saved keys and its files.
 * Packs it published to the Global Space stay (they are everyone's by then).
 */
adminRouter.delete('/admin/users/:id', async (req, res) => {
  const id = intParam(req.params.id);
  if (id === req.user!.id) throw new HttpError(400, 'You cannot delete your own account');
  const target = await getUser(id);
  if (!target) throw new HttpError(404, 'User not found');
  // no new logins or runs while it is taken apart
  await exec("UPDATE users SET status = 'disabled' WHERE id = ?", [id]);
  await exec('DELETE FROM sessions WHERE user_id = ?', [id]);
  closeUserSockets(id);
  for (const p of await q<{ id: number }>('SELECT id FROM projects WHERE owner_id = ?', [id])) {
    await hooks.stopProject(p.id).catch(() => {});
    await hooks.projectDeleted(p.id); // deployed servers, published websites (+ their certificates)
  }
  const assets = await q<{ id: string }>('SELECT id FROM assets WHERE owner_id = ?', [id]);
  await exec('DELETE FROM users WHERE id = ?', [id]); // cascades to everything stored in the database
  for (const a of assets) {
    try {
      await fsp.rm(assetRoot(a.id), { recursive: true, force: true });
    } catch {
      /* odd id: nothing on disk */
    }
  }
  const su = sysUserFor(id);
  await removeSysUser(id);
  for (const dir of [su.projectsRoot, su.home, path.join(config.packsDir, 'users', String(id)), path.join(config.servicesDir, String(id))]) {
    await fsp.rm(dir, { recursive: true, force: true }).catch((err) => console.warn(`[admin] could not remove ${dir}: ${(err as Error).message}`));
  }
  await reloadPacks('all').catch(() => {});
  console.log(`[admin] ${req.user!.username} deleted the account ${target.username} (#${id})`);
  res.json({ ok: true });
});

adminRouter.get('/admin/settings', async (_req, res) => {
  res.json({ registration: await getSetting('registration', config.registrationDefault) });
});

adminRouter.put('/admin/settings', async (req, res) => {
  const body = parse(z.object({ registration: z.enum(['open', 'closed']) }), req.body);
  await setSetting('registration', body.registration);
  res.json({ registration: body.registration });
});

adminRouter.get('/admin/system', async (_req, res) => {
  res.json({
    version: config.version,
    claudeVersion: await claudeVersion(),
    isolation: isolation() ? 'per-user Linux accounts' : 'disabled (single user)',
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    activeRuns: activeRunCount(),
    terminals: terminalCount(),
    wsClients: connectedClients(),
    limits: config.limits,
    defaultPermissionMode: config.defaultPermissionMode,
    toolchains: getToolchains(),
    tools: allTools().map(publicTool),
    paths: {
      projects: config.projectsDir,
      library: config.libraryDir,
      homes: config.homesDir,
      tools: config.toolsDir,
      templates: config.templatesDir,
    },
  });
});

adminRouter.post('/admin/system/rescan', async (_req, res) => {
  await loadTools();
  await detectToolchains();
  res.json({ ok: true, tools: allTools().length });
});
