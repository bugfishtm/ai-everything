/**
 * ai-everything — Studio server entry point.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { adminRouter } from './admin.js';
import { agentRouter } from './agent.js';
import { accountRouter, announceSetup, attachUser, authRouter, bootstrapAdmin, csrfGuard, requireAdmin, requireUser } from './auth.js';
import { claudeRouter } from './claude/creds.js';
import { claudeCliRouter, initClaudeCli, scheduleClaudeUpdates } from './claudecli.js';
import { canAccessChat, chatRouter, isProjectRunning, stopAllRuns, stopProjectRuns } from './claude/runner.js';
import { initTerminals, stopAllTerminals, stopProjectTerminals } from './claude/terminal.js';
import { config, loadAppSecret } from './config.js';
import { connectDb, dbAlive, exec, migrate, q, q1 } from './db.js';
import { hooks } from './hooks.js';
import { errorHandler, HttpError } from './lib/http.js';
import { ensureSysUser, isolation, prepareDataDirs } from './lib/system.js';
import { libraryRouter, libraryStats } from './library.js';
import { packsRouter, reloadPacks } from './packs.js';
import { getProjectRow, previewRouter, projectsRouter, purgeTrash } from './projects.js';
import { releasesAgentRouter, releasesRouter } from './releases.js';
import { runToolRouter } from './runtool.js';
import { dawRouter } from './daw.js';
import { model3dRouter } from './model3d.js';
import { maybeAutoInstallSdk, sdkRouter, sdkStatus } from './sdk.js';
import { initServices, rememberOrigin, serviceHttpProxy, servicesAgentRouter, servicesRouter, stopAllServices } from './services.js';
import { initSites, setStudioHandlers, sitesAgentRouter, sitesRouter, startSitesServer, stopSitesServer } from './sites.js';
import { initAgents } from './agents/install.js';
import { agentsRouter } from './agents/routes.js';
import { detectToolchains, loadTools } from './tools.js';
import { loadSystemSkills, skillsAgentRouter, skillsRouter } from './skills.js';
import { backfillUsage, usageRouter } from './usage.js';
import { initWordPress, stopAllWordPress, wordpressAgentRouter, wordpressRouter } from './wordpress.js';
import { attachWs, setTopicAuthorizer } from './ws.js';

async function main(): Promise<void> {
  if (process.argv.includes('--migrate-only')) {
    // used by `studio-db import`: create/upgrade the tables, nothing else
    await connectDb();
    await migrate();
    console.log('[db] schema is up to date');
    process.exit(0);
  }
  console.log(`[studio] ${config.appName} ${config.version} starting (node ${process.version})`);
  loadAppSecret();
  await prepareDataDirs();
  await connectDb();
  await migrate();
  await backfillUsage().catch((err) => console.warn('[usage] backfill failed:', (err as Error).message));
  await bootstrapAdmin();
  await announceSetup();
  console.log(`[studio] isolation: ${isolation() ? 'per-user Linux accounts' : 'off'}`);
  for (const u of await q<{ id: number }>('SELECT id FROM users')) {
    await ensureSysUser(u.id).catch((err) => console.error(`[studio] could not prepare account for user ${u.id}:`, err.message));
  }
  await loadTools();
  await loadSystemSkills();
  await initClaudeCli();
  scheduleClaudeUpdates();
  // other AI providers (ACP agents) — installed at runtime once an admin switches them on
  await initAgents();
  await detectToolchains();
  await reloadPacks('all');
  await sdkStatus();
  maybeAutoInstallSdk().catch((err) => console.error('[sdk] auto install failed:', err.message));

  hooks.isProjectBusy = (id) => isProjectRunning(id);
  hooks.stopProject = async (id) => {
    await stopProjectRuns(id);
    stopProjectTerminals(id);
  };
  initTerminals();
  setTopicAuthorizer(async (user, topic) => {
    const [kind, idStr] = topic.split(':');
    const id = Number(idStr);
    if (!Number.isInteger(id) || id <= 0) return false;
    if (kind === 'chat') return canAccessChat(user, id);
    if (kind === 'project') {
      const p = await getProjectRow(id);
      return !!p && p.owner_id === user.id;
    }
    if (kind === 'service') {
      const s = await q1<{ owner_id: number }>('SELECT owner_id FROM services WHERE id = ?', [id]);
      return !!s && (s.owner_id === user.id || user.role === 'admin');
    }
    if (kind === 'site') {
      const s = await q1<{ owner_id: number }>('SELECT owner_id FROM sites WHERE id = ?', [id]);
      return !!s && (s.owner_id === user.id || user.role === 'admin');
    }
    return false;
  });
  await initServices();
  await initSites();
  await initWordPress().catch((err) => console.error('[wordpress] could not be prepared:', (err as Error).message));

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('etag', false);

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  });

  // sandboxed previews (token in the URL, no cookies needed)
  app.use(previewRouter);

  // deployed Node.js servers of projects: /srv/<slug>/… → the server's own port (public, sandboxed)
  app.use('/srv', serviceHttpProxy);

  app.get('/api/health', async (_req, res) => {
    const db = await dbAlive();
    res.status(db ? 200 : 503).json({ ok: db, version: config.version, db });
  });

  const api = express.Router();
  api.use(express.json({ limit: '8mb' }));
  // in-container agent API (bearer token, not cookies)
  api.use(agentRouter);
  api.use(servicesAgentRouter);
  api.use(sitesAgentRouter);
  api.use(skillsAgentRouter);
  api.use(releasesAgentRouter);
  api.use(wordpressAgentRouter);
  api.use(csrfGuard);
  api.use(attachUser);
  api.use(rememberOrigin);
  api.use(authRouter);
  api.use(requireUser);
  api.use(accountRouter);
  api.use(claudeRouter);
  api.use(projectsRouter);
  api.use(releasesRouter);
  api.use(chatRouter);
  api.use(libraryRouter);
  api.use(packsRouter);
  api.use(runToolRouter);
  api.use(dawRouter);
  api.use(model3dRouter);
  api.get('/stats', async (req, res) => {
    res.json({ library: await libraryStats(req.user!.id) });
  });
  api.use('/admin', requireAdmin);
  api.use(adminRouter);
  api.use(sdkRouter);
  api.use(usageRouter); // /usage for everyone, /admin/usage behind requireAdmin above
  api.use(claudeCliRouter); // /claude/cli for everyone, /admin/claude-cli/* behind requireAdmin above
  api.use(servicesRouter); // /services… for owners, /admin/services behind requireAdmin above
  api.use(sitesRouter); // /sites… for owners, /admin/sites behind requireAdmin above
  api.use(agentsRouter); // /agents… (other AI providers) for everyone, /admin/agents behind requireAdmin above
  api.use(skillsRouter); // /skills, /instructions for everyone, /admin/… behind requireAdmin above
  api.use(wordpressRouter); // /projects/:id/wordpress… for owners, /admin/wordpress behind requireAdmin above
  api.use((_req, _res, next) => next(new HttpError(404, 'Unknown API route')));
  app.use('/api', api);

  // website (built React app)
  const indexHtml = path.join(config.webDir, 'index.html');
  if (fs.existsSync(indexHtml)) {
    app.use(
      express.static(config.webDir, {
        index: false,
        maxAge: '1h',
        setHeaders(res, file) {
          if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        },
      }),
    );
    app.get('/{*path}', (_req, res) => {
      res.setHeader(
        'Content-Security-Policy',
        [
          "default-src 'self'",
          "script-src 'self' 'wasm-unsafe-eval'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "media-src 'self' blob:",
          "font-src 'self' data:",
          "connect-src 'self' ws: wss: blob: data:",
          "frame-src 'self'",
          "worker-src 'self' blob:",
          "object-src 'none'",
          "base-uri 'self'",
        ].join('; '),
      );
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexHtml);
    });
  } else {
    console.warn(`[studio] no website build found at ${config.webDir} — API only`);
  }

  app.use(errorHandler);

  const server = http.createServer(app);
  server.requestTimeout = 0; // long uploads / permission long-polls
  server.headersTimeout = 60_000;
  const wsUpgrade = attachWs(server);
  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(`[studio] cannot listen on ${config.host}:${config.port}: ${err.code === 'EADDRINUSE' ? 'the port is already in use' : err.message}`);
    process.exit(1);
  });
  server.listen(config.port, config.host, () => {
    console.log(`[studio] listening on http://${config.host}:${config.port}`);
  });
  // second port: the published websites of projects, by domain (sites.ts) — and its HTTPS twin,
  // which can also serve this website under the Studio's own domain (Admin → HTTPS)
  setStudioHandlers(app, wsUpgrade);
  startSitesServer();

  purgeTrash().catch(() => {});
  setInterval(() => purgeTrash().catch(() => {}), 24 * 3600_000).unref();
  // expired logins
  const purgeSessions = () => exec('DELETE FROM sessions WHERE expires_at < UTC_TIMESTAMP(3)').catch(() => {});
  void purgeSessions();
  setInterval(() => void purgeSessions(), 6 * 3600_000).unref();

  const shutdown = (sig: string) => {
    console.log(`[studio] ${sig} — stopping AI runs, terminals and servers`);
    stopAllRuns();
    stopAllTerminals();
    stopAllServices();
    stopAllWordPress();
    stopSitesServer();
    server.close();
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (err) => console.error('[studio] unhandled rejection', err));

// One stray socket or stream error must not take every user's AI sessions, terminals and servers
// down with it: log it and keep serving. Only a burst of real exceptions means the process is broken.
const recentCrashes: number[] = [];
const CONNECTION_ERRORS = ['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ECANCELED', 'ETIMEDOUT', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END', 'ERR_STREAM_PREMATURE_CLOSE'];
process.on('uncaughtException', (err) => {
  const e = err as NodeJS.ErrnoException;
  if (CONNECTION_ERRORS.includes(String(e?.code))) {
    console.warn(`[studio] connection error outside a request (ignored): ${e.code} ${e.message}`);
    return;
  }
  console.error('[studio] uncaught exception (still running):', err);
  const now = Date.now();
  recentCrashes.push(now);
  while (recentCrashes.length && recentCrashes[0] < now - 60_000) recentCrashes.shift();
  if (recentCrashes.length >= 10) {
    console.error('[studio] 10 uncaught exceptions within a minute — exiting so the container restarts clean');
    process.exit(1);
  }
});

main().catch((err) => {
  console.error('[studio] fatal:', err);
  process.exit(1);
});
