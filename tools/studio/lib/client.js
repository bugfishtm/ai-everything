'use strict';
/**
 * Tiny HTTP client for the Studio agent API (no dependencies, no timeouts —
 * permission prompts can wait for the user for several minutes).
 */
const http = require('http');
const https = require('https');

const API = (process.env.STUDIO_API_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const TOKEN = process.env.STUDIO_TOKEN || '';

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    if (!TOKEN) {
      reject(new Error('STUDIO_TOKEN is not set — this only works inside sessions started by Everything Studio.'));
      return;
    }
    const url = new URL('/api/agent' + path, API);
    const lib = url.protocol === 'https:' ? https : http;
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = lib.request(
      url,
      {
        method,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          accept: 'application/json',
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data;
          try {
            data = text ? JSON.parse(text) : {};
          } catch {
            data = { error: text };
          }
          if (res.statusCode >= 400) reject(new Error(data.error || `HTTP ${res.statusCode}`));
          else resolve(data);
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function fmtSize(n) {
  if (!Number.isFinite(n)) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatSearch(r) {
  if (!r.items.length) return 'No matching assets.';
  const lines = [`${r.total} asset(s)${r.total > r.items.length ? `, showing ${r.items.length}` : ''}:`];
  for (const a of r.items) {
    lines.push(
      `- ${a.id}  ${a.name}  [${a.kind}${a.visibility === 'global' ? `, global by ${a.owner}` : ', mine'}]  ${a.fileCount} file(s), ${fmtSize(a.sizeBytes)}` +
        (a.tags.length ? `  #${a.tags.join(' #')}` : '') +
        (a.description ? `\n    ${a.description.split('\n')[0].slice(0, 160)}` : ''),
    );
  }
  lines.push('Import one with: studio lib get <id>   (or mcp__studio__library_get)');
  return lines.join('\n');
}

function formatInfo(a) {
  const lines = [
    `${a.id} — ${a.name}`,
    `kind: ${a.kind}   visibility: ${a.visibility}   owner: ${a.owner.username}   size: ${fmtSize(a.sizeBytes)}`,
  ];
  if (a.tags.length) lines.push(`tags: ${a.tags.join(', ')}`);
  if (a.license) lines.push(`license: ${a.license}`);
  if (a.description) lines.push('', a.description);
  lines.push('', `files (main: ${a.mainFile || '-'}):`);
  for (const f of a.files.slice(0, 200)) lines.push(`  ${f.path}  (${fmtSize(f.size)})`);
  if (a.files.length > 200) lines.push(`  … ${a.files.length - 200} more`);
  return lines.join('\n');
}

function formatTools(r) {
  if (!r.tools.length) return 'No Studio tools installed for this area.';
  return r.tools
    .map((t) => {
      const lines = [`${t.name} (${t.id}${t.version ? ' v' + t.version : ''}) — ${t.description}`];
      for (const c of t.commands || []) lines.push(`  ${c.usage}\n      ${c.description}`);
      if (t.docsPath) lines.push(`  docs: ${t.docsPath}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

module.exports = { request, fmtSize, formatSearch, formatInfo, formatTools };
