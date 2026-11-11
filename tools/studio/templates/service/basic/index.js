'use strict';
/**
 * A small HTTP JSON API — the starting point for any backend. Deployed and run
 * by Everything Studio:
 *   PORT       port to listen on (set by the Studio)
 *   DATA_DIR   folder that survives redeploys (put files / databases here)
 *   PUBLIC_URL how apps reach this server
 *
 *   GET  /health
 *   GET  /api/messages          → [{ id, text, at }]
 *   POST /api/messages          body: { "text": "hello" }
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'messages.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
let messages = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : [];
const save = () => fs.writeFileSync(FILE, JSON.stringify(messages, null, 2));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/health') return json(res, 200, { ok: true });
    if (url.pathname === '/api/messages' && req.method === 'GET') return json(res, 200, messages.slice(-100));
    if (url.pathname === '/api/messages' && req.method === 'POST') {
      const body = await readJson(req);
      if (typeof body.text !== 'string' || !body.text.trim()) return json(res, 400, { error: 'body: { "text": "…" }' });
      const msg = { id: messages.length + 1, text: body.text.slice(0, 1000), at: new Date().toISOString() };
      messages.push(msg);
      save();
      return json(res, 201, msg);
    }
    json(res, 404, { error: 'not found' });
  } catch (err) {
    json(res, 400, { error: err.message });
  }
});

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('body must be JSON'));
      }
    });
  });
}
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

server.listen(PORT, process.env.HOST || '127.0.0.1', () => console.log(`API listening on ${PORT} — ${process.env.PUBLIC_URL || ''}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
