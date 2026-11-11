'use strict';
/**
 * Storage server — cloud saves (key-value) and leaderboards, in SQLite (built into
 * Node.js, no dependencies). Deployed and run by Everything Studio:
 *   PORT       port to listen on (set by the Studio)
 *   DATA_DIR   folder that survives redeploys → the database lives here
 *   API_KEY    optional: when set, writes need the header  x-api-key: <API_KEY>
 *              (studio service env API_KEY=…)
 *
 *   GET    /health
 *   GET    /api/kv/:space                 list keys       e.g. space = player id
 *   GET    /api/kv/:space/:key            → JSON value (404 if missing)
 *   PUT    /api/kv/:space/:key            body: any JSON  (max 256 KB)
 *   DELETE /api/kv/:space/:key
 *   POST   /api/scores/:board             body: { "player": "Ada", "score": 1200 }
 *   GET    /api/scores/:board?limit=10    → best scores, highest first
 */
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const API_KEY = process.env.API_KEY || '';
const MAX_BODY = 256 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS kv (space TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (space, key));
  CREATE TABLE IF NOT EXISTS scores (id INTEGER PRIMARY KEY, board TEXT NOT NULL, player TEXT NOT NULL,
    score REAL NOT NULL, at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE INDEX IF NOT EXISTS scores_board ON scores (board, score DESC);
`);

const q = {
  keys: db.prepare('SELECT key, updated_at FROM kv WHERE space = ? ORDER BY key'),
  get: db.prepare('SELECT value FROM kv WHERE space = ? AND key = ?'),
  put: db.prepare(`INSERT INTO kv (space, key, value) VALUES (?, ?, ?)
                   ON CONFLICT (space, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`),
  del: db.prepare('DELETE FROM kv WHERE space = ? AND key = ?'),
  addScore: db.prepare('INSERT INTO scores (board, player, score) VALUES (?, ?, ?)'),
  top: db.prepare('SELECT player, score, at FROM scores WHERE board = ? ORDER BY score DESC, at ASC LIMIT ?'),
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const write = req.method !== 'GET' && req.method !== 'HEAD';
    if (write && API_KEY && req.headers['x-api-key'] !== API_KEY) return json(res, 401, { error: 'missing or wrong x-api-key' });

    if (url.pathname === '/health') return json(res, 200, { ok: true });

    if (parts[0] === 'api' && parts[1] === 'kv' && parts[2]) {
      const [space, key] = [parts[2], parts[3]];
      if (!key && req.method === 'GET') return json(res, 200, q.keys.all(space));
      if (key && req.method === 'GET') {
        const row = q.get.get(space, key);
        return row ? json(res, 200, JSON.parse(row.value)) : json(res, 404, { error: 'not found' });
      }
      if (key && req.method === 'PUT') {
        const body = await readJson(req);
        q.put.run(space, key, JSON.stringify(body));
        return json(res, 200, { ok: true });
      }
      if (key && req.method === 'DELETE') {
        q.del.run(space, key);
        return json(res, 200, { ok: true });
      }
    }

    if (parts[0] === 'api' && parts[1] === 'scores' && parts[2]) {
      const board = parts[2];
      if (req.method === 'POST') {
        const { player, score } = await readJson(req);
        if (typeof player !== 'string' || !player.trim() || !Number.isFinite(Number(score))) {
          return json(res, 400, { error: 'body: { "player": "name", "score": number }' });
        }
        q.addScore.run(board, player.trim().slice(0, 40), Number(score));
        return json(res, 201, { ok: true });
      }
      if (req.method === 'GET') {
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 10));
        return json(res, 200, q.top.all(board, limit));
      }
    }
    json(res, 404, { error: 'not found' });
  } catch (err) {
    json(res, err.status || 500, { error: err.message });
  }
});

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(Object.assign(new Error('body must be JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

server.listen(PORT, process.env.HOST || '127.0.0.1', () => console.log(`storage server listening on ${PORT}, data in ${DATA_DIR}`));
process.on('SIGTERM', () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
});
