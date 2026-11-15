/**
 * Side chat ("/btw"): a quick question about a chat — "what did it just do?", "why that file?" —
 * answered by Claude in a fresh, throwaway session that gets a summary of the main conversation.
 * The main chat's session, its events and a run that is still working stay untouched: nothing of
 * the side conversation goes into the main chat's context. The side conversation itself is kept
 * by the browser and sent along with each question.
 *
 * Claude only looks: Read, Grep and Glob in the project folder, no edits, no commands, no MCP.
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { cliNotReadyMessage, cliReady } from '../claudecli.js';
import { config } from '../config.js';
import { q } from '../db.js';
import { HttpError, intParam, parse } from '../lib/http.js';
import { ensureSysUser, killTree, spawnAs } from '../lib/system.js';
import { projectDir } from '../projects.js';
import { recordRun } from '../usage.js';
import { authHint, claudeEnv, getConnection } from './creds.js';
import { currentActivity, loadOwnedChat, queueOf } from './runner.js';

const SIDE_TOOLS = 'Read,Grep,Glob';
const SIDE_TIMEOUT_MS = 3 * 60_000;
const SIDE_PER_USER = 2;
/** how much of the main conversation the side chat gets (newest kept) */
const TRANSCRIPT_CHARS = 30_000;

const activeSide = new Map<number, number>();

function clip(s: string, max: number): string {
  const t = s.replace(/\s+\n/g, '\n').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** One line for a tool call: its name and what it worked on (file, command, pattern …). */
function toolLine(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const what = [i.file_path, i.path, i.command, i.pattern, i.url, i.query, i.description].find((v) => typeof v === 'string' && v) as string | undefined;
  return `[tool ${name}${what ? `: ${clip(what, 160)}` : ''}]`;
}

/** The main chat as plain text: messages, answers, tool calls in short, errors, saved versions. */
async function transcript(chatId: number, dir: string | null): Promise<string> {
  const rows = await q<{ kind: string; payload: unknown; created_at: Date }>(
    `SELECT kind, payload, created_at FROM (SELECT id, kind, payload, created_at FROM chat_events WHERE chat_id = ?
       AND kind IN ('user','assistant','error','checkpoint') ORDER BY id DESC LIMIT 600) t ORDER BY id`,
    [chatId],
  );
  const rel = (s: string) => (dir && s.startsWith(dir + '/') ? s.slice(dir.length + 1) : s);
  const lines: string[] = [];
  for (const r of rows) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as any;
    if (r.kind === 'user' && p?.text) lines.push(`User: ${clip(String(p.text), 4000)}`);
    else if (r.kind === 'assistant' && !p?.parent) {
      for (const b of p?.blocks ?? []) {
        if (b.type === 'text' && b.text) lines.push(`AI: ${clip(String(b.text), 4000)}`);
        else if (b.type === 'tool_use') lines.push(rel(toolLine(String(b.name), b.input)));
      }
    } else if (r.kind === 'error' && p?.message) lines.push(`[error: ${clip(String(p.message), 400)}]`);
    else if (r.kind === 'checkpoint') lines.push(`[version saved: ${clip(String(p?.message ?? ''), 120)}${p?.files ? `, ${p.files} file(s)` : ''}]`);
  }
  let text = lines.join('\n');
  if (text.length > TRANSCRIPT_CHARS) text = `… (earlier part left out)\n${text.slice(-TRANSCRIPT_CHARS)}`;
  return text || '(the main chat is still empty)';
}

const SYSTEM = `You are the side chat ("/btw") next to a chat between a user and an AI that works in a project of Everything Studio.
The user asks you quick questions about that main chat — what happened, why, what is going on right now, where something is — without disturbing it.
Rules:
- Answer briefly and concretely, in the user's language, from the main chat's transcript below and, when needed, by reading project files (Read, Grep, Glob).
- You only look. Do not change anything, and do not pretend to: if the user wants something done, tell them to ask in the main chat (or that a message they send there while the AI works is queued).
- The transcript shows tool calls in short ([tool Name: target]); say so when the detail they ask for is not in it.
- Never reveal or repeat secrets, keys or tokens you might come across.`;

export const sideRouter = Router();

sideRouter.post('/chats/:chatId/side', async (req, res) => {
  const user = req.user!;
  const { chat, project } = await loadOwnedChat(user, intParam(req.params.chatId));
  const body = parse(
    z.object({
      question: z.string().trim().min(1).max(4000),
      // the side conversation so far (kept by the browser)
      history: z.array(z.object({ q: z.string().max(4000), a: z.string().max(8000) })).max(10).default([]),
    }),
    req.body,
  );
  if (!cliReady()) throw new HttpError(503, cliNotReadyMessage());
  const busy = activeSide.get(user.id) ?? 0;
  if (busy >= SIDE_PER_USER) throw new HttpError(429, 'Two side questions are already being answered — wait a moment');

  const su = await ensureSysUser(user.id);
  const dir = projectDir(project);
  const conn = await getConnection(user.id);
  const model = conn?.default_model || config.defaultModel;
  const now = currentActivity(chat.id);
  const queued = await queueOf(chat.id);
  const state = now.running
    ? `The main AI is working right now${now.since ? ` (for ${Math.round((Date.now() - now.since) / 1000)} s)` : ''}${now.doing ? `; its current step: ${now.doing}` : ''}.`
    : 'The main AI is not working right now.';
  const parts = [
    `# Main chat "${chat.title}" (project "${project.name}", folder ${dir})`,
    await transcript(chat.id, dir),
    `# Right now\n${state}${queued.length ? `\n${queued.length} message(s) of the user wait in the queue: ${queued.map((m) => `"${clip(m.text, 200)}"`).join('; ')}` : ''}`,
  ];
  if (body.history.length) parts.push(`# This side chat so far\n${body.history.map((h) => `User: ${h.q}\nYou: ${h.a}`).join('\n\n')}`);
  parts.push(`# The user's side question\n${body.question}`);

  const args = [
    '-p', '--output-format', 'json',
    '--system-prompt', SYSTEM,
    '--tools', SIDE_TOOLS,
    '--allowedTools', SIDE_TOOLS,
    '--strict-mcp-config',
    '--disable-slash-commands',
    // a session of its own, never resumed: the main chat's session is not touched
    '--session-id', randomUUID(),
  ];
  if (model) args.push('--model', model);
  const env = await claudeEnv(user.id, su, {});
  activeSide.set(user.id, busy + 1);
  const started = Date.now();
  try {
    const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawnAs(su, config.claudeBin, args, { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => killTree(child, 'SIGKILL'), SIDE_TIMEOUT_MS);
      // the browser gave up: no need to keep thinking
      res.on('close', () => {
        if (!res.writableEnded) killTree(child, 'SIGTERM');
      });
      child.stdout!.on('data', (d: Buffer) => (stdout = (stdout + d.toString()).slice(-400_000)));
      child.stderr!.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-8000)));
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      child.stdin!.on('error', () => {});
      child.stdin!.end(parts.join('\n\n'));
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let result: any = null;
    try {
      result = JSON.parse(out.stdout.trim().split('\n').pop() || '');
    } catch {
      /* not JSON: an error message */
    }
    if (!result || typeof result.result !== 'string') {
      const err = (out.stderr || out.stdout).trim();
      throw new HttpError(502, `The side chat got no answer${err ? `: ${clip(err, 600)}` : ' (it took too long or Claude stopped)'}${authHint(err) ? ` — ${authHint(err)}` : ''}`);
    }
    await recordRun({
      userId: user.id,
      projectId: project.id,
      chatId: chat.id,
      kind: 'side',
      provider: 'claude',
      model,
      isError: !!result.is_error,
      turns: result.num_turns,
      durationMs: Date.now() - started,
      costUsd: result.total_cost_usd,
      usage: result.usage ?? null,
    }).catch((err) => console.warn('[side] usage', (err as Error).message));
    if (result.is_error) throw new HttpError(502, clip(result.result || 'Claude could not answer', 600));
    res.json({ answer: result.result, ms: Date.now() - started, costUsd: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : undefined });
  } finally {
    const n = (activeSide.get(user.id) ?? 1) - 1;
    if (n > 0) activeSide.set(user.id, n);
    else activeSide.delete(user.id);
  }
});
