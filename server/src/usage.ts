/**
 * Usage: what each user's Claude runs consumed (tokens, API-value estimate, time)
 * and — for Claude subscriptions — how much of the plan limits is used and when
 * the windows reset.
 *
 * Plan limits come from the user's own Claude Code — the Studio itself never
 * reads or uses Claude credentials:
 *   1. live: `claude -p "/usage"` (Claude Code's own usage report, a local command)
 *   2. after every run: the rate-limit status Claude Code reports in its stream
 *      (`rate_limit_event`), stored per user
 */
import { Router } from 'express';
import { accountExtrasEnv, claudeEnv, claudeStatus } from './claude/creds.js';
import { config } from './config.js';
import { exec, q, q1 } from './db.js';
import { ensureSysUser, runAs } from './lib/system.js';
import { getSetting, setSetting } from './settings.js';
import { sendToUser } from './ws.js';

export interface LimitWindow {
  key: string;
  label: string;
  /** 0–100 */
  percent: number | null;
  resetsAt: string | null;
  /** reset time as Claude Code wrote it ("3pm (Europe/Berlin)") when no exact time is known */
  resetsText?: string | null;
  status?: string;
}

export interface PlanLimits {
  /** claude-code-usage = Claude Code's /usage just now; claude-code = reported during the last run */
  source: 'claude-code-usage' | 'claude-code' | null;
  checkedAt: string | null;
  plan: string | null;
  windows: LimitWindow[];
  extra: { enabled: boolean; usedCredits: number; monthlyLimit: number | null; percent: number | null; currency: string } | null;
  status: string | null;
  note: string | null;
}

const LABELS: Record<string, string> = {
  five_hour: 'Current session (5-hour window)',
  seven_day: 'Weekly — all models',
  seven_day_opus: 'Weekly — Opus',
  seven_day_sonnet: 'Weekly — Sonnet',
  seven_day_oauth_apps: 'Weekly — connected apps',
  seven_day_overage_included: 'Weekly — incl. extra usage',
};

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------
export interface RunUsage {
  userId: number;
  projectId: number | null;
  chatId: number | null;
  kind: 'chat' | 'casual';
  /** 'claude' or an ACP agent id */
  provider?: string;
  model: string | null;
  isError: boolean;
  turns?: number;
  durationMs?: number;
  costUsd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | null;
  sourceEventId?: number | null;
}

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

export async function recordRun(r: RunUsage): Promise<void> {
  await exec(
    `INSERT IGNORE INTO usage_runs (user_id, project_id, chat_id, kind, provider, model, status, turns, duration_ms,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, source_event_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      r.userId,
      r.projectId,
      r.chatId,
      r.kind,
      (r.provider || 'claude').slice(0, 48),
      r.model ? r.model.slice(0, 64) : null,
      r.isError ? 'error' : 'ok',
      Math.round(n(r.turns)),
      Math.min(4_000_000_000, Math.round(n(r.durationMs))),
      Math.round(n(r.usage?.input_tokens)),
      Math.round(n(r.usage?.output_tokens)),
      Math.round(n(r.usage?.cache_read_input_tokens)),
      Math.round(n(r.usage?.cache_creation_input_tokens)),
      n(r.costUsd),
      r.sourceEventId ?? null,
    ],
  );
  sendToUser(r.userId, { t: 'usage.changed' });
}

/** Rate-limit status from Claude Code's stream (`rate_limit_event.rate_limit_info`). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function recordRateLimit(userId: number, info: any): Promise<void> {
  if (!info || typeof info !== 'object') return;
  await exec(
    `INSERT INTO claude_connections (user_id, rate_limit, rate_limit_at) VALUES (?, ?, UTC_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE rate_limit = VALUES(rate_limit), rate_limit_at = VALUES(rate_limit_at)`,
    [userId, JSON.stringify(info)],
  );
  const limits = limitsFromEvent(info, new Date());
  live.delete(userId);
  sendToUser(userId, { t: 'usage.limits', limits });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function limitsFromEvent(info: any, at: Date | null): PlanLimits {
  const windows: LimitWindow[] = [];
  const iso = (s: unknown) => (typeof s === 'number' && s > 0 ? new Date(s * 1000).toISOString() : null);
  const pct = (u: unknown) => (typeof u === 'number' && Number.isFinite(u) ? Math.round(u * 1000) / 10 : null);
  const uw = info?.unifiedWindows;
  if (uw && typeof uw === 'object') {
    for (const [key, w] of Object.entries(uw as Record<string, { utilization?: number; resetsAt?: number; status?: string }>)) {
      if (!w) continue;
      windows.push({ key, label: LABELS[key] ?? key, percent: pct(w.utilization), resetsAt: iso(w.resetsAt), status: w.status });
    }
  } else if (info?.rateLimitType) {
    windows.push({
      key: info.rateLimitType,
      label: LABELS[info.rateLimitType] ?? info.rateLimitType,
      percent: pct(info.utilization),
      resetsAt: iso(info.resetsAt),
      status: info.status,
    });
  }
  return {
    source: 'claude-code',
    checkedAt: at ? at.toISOString() : null,
    plan: null,
    windows,
    extra: null,
    status: typeof info?.status === 'string' ? info.status : null,
    note: info?.isUsingOverage ? 'Using extra usage (overage) right now.' : null,
  };
}

/** Backfill usage_runs once from results stored before the usage log existed. */
export async function backfillUsage(): Promise<void> {
  if (await getSetting<boolean>('usage_backfill_v1', false)) return;
  const rows = await q<{ id: number; chat_id: number; payload: Record<string, unknown> | null; created_at: Date; project_id: number; owner_id: number; area: string }>(
    `SELECT e.id, e.chat_id, e.payload, e.created_at, c.project_id, p.owner_id, p.area
       FROM chat_events e JOIN chats c ON c.id = e.chat_id JOIN projects p ON p.id = c.project_id
      WHERE e.kind = 'result'`,
  );
  let added = 0;
  for (const r of rows) {
    const p = (r.payload ?? {}) as { isError?: boolean; turns?: number; durationMs?: number; costUsd?: number; usage?: Record<string, number> };
    const u = p.usage ?? {};
    const { affectedRows } = await exec(
      `INSERT IGNORE INTO usage_runs (user_id, project_id, chat_id, kind, status, turns, duration_ms, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, cost_usd, source_event_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        r.owner_id,
        r.project_id,
        r.chat_id,
        r.area === 'chat' ? 'casual' : 'chat',
        p.isError ? 'error' : 'ok',
        Math.round(n(p.turns)),
        Math.round(n(p.durationMs)),
        Math.round(n(u.input)),
        Math.round(n(u.output)),
        Math.round(n(u.cacheRead)),
        Math.round(n(u.cacheWrite)),
        n(p.costUsd),
        r.id,
        r.created_at,
      ],
    );
    added += affectedRows;
  }
  await setSetting('usage_backfill_v1', true);
  if (added) console.log(`[usage] backfilled ${added} run(s) from chat history`);
}

// ---------------------------------------------------------------------------
// Live plan limits — read by the user's own Claude Code (`/usage`)
// ---------------------------------------------------------------------------
// The Studio never uses Claude credentials itself. `claude -p "/usage"` is Claude
// Code's own non-interactive usage report: a local command (no model request, no
// cost) that Claude Code answers with the user's own login. Lines look like
//   Current session: 23% used · resets 3pm (Europe/Berlin)
//   Current week (all models): 41% used · resets Nov 11, 12pm (Europe/Berlin)
const live = new Map<number, { at: number; limits: PlanLimits }>();

const WINDOW_KEYS: [RegExp, string][] = [
  [/^Current session$/i, 'five_hour'],
  [/^Current week \(all models\)$/i, 'seven_day'],
  [/^Current week \(Sonnet only\)$/i, 'seven_day_sonnet'],
  [/^Current week \(Opus only\)$/i, 'seven_day_opus'],
];

export function parseUsageReport(text: string, plan: string | null): PlanLimits | null {
  const windows: LimitWindow[] = [];
  for (const raw of text.split('\n')) {
    const m = /^\s*(Current [^:]+):\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets\s+(.+?))?\s*$/i.exec(raw);
    if (!m) continue;
    const title = m[1].trim();
    const key = WINDOW_KEYS.find(([re]) => re.test(title))?.[1] ?? `model:${title}`;
    const label =
      key === 'five_hour'
        ? LABELS.five_hour
        : key === 'seven_day'
          ? LABELS.seven_day
          : title.replace(/^Current week \((.+)\)$/i, 'Weekly — $1').replace(/ only$/i, '');
    windows.push({ key, label, percent: Number(m[2]), resetsAt: null, resetsText: m[3]?.trim() ?? null });
  }
  if (!windows.length) return null;
  const overage = /currently using your overages/i.test(text);
  return {
    source: 'claude-code-usage',
    checkedAt: new Date().toISOString(),
    plan,
    windows,
    extra: null,
    status: null,
    note: overage ? 'You are using extra usage (overage) right now.' : null,
  };
}

/** Last values Claude Code reported during a run; `why` explains why live numbers are missing. */
async function storedLimits(userId: number, why: string | null, empty?: string): Promise<PlanLimits> {
  const row = await q1<{ rate_limit: unknown; rate_limit_at: Date | null }>('SELECT rate_limit, rate_limit_at FROM claude_connections WHERE user_id = ?', [userId]);
  if (row?.rate_limit) {
    const l = limitsFromEvent(row.rate_limit, row.rate_limit_at);
    const note = why ? `${why} Showing what Claude Code reported during your last run.` : null;
    return { ...l, note: [note, l.note].filter(Boolean).join(' ') || null };
  }
  return { source: null, checkedAt: null, plan: null, windows: [], extra: null, status: null, note: empty ?? why };
}

export async function planLimits(userId: number, refresh = false): Promise<PlanLimits> {
  const cached = live.get(userId);
  if (cached && !refresh && Date.now() - cached.at < 60_000) return cached.limits;
  let limits: PlanLimits;
  const conn = await q1<{ method: string }>('SELECT method FROM claude_connections WHERE user_id = ?', [userId]);
  const st = await claudeStatus(userId);
  if (conn?.method === 'api_key' || st.authMethod === 'api_key') {
    limits = {
      source: null,
      checkedAt: null,
      plan: null,
      windows: [],
      extra: null,
      status: null,
      note: 'You use an Anthropic API key: it is billed per token (see the Anthropic Console) — there are no plan limits.',
    };
  } else if (!st.loggedIn || st.authMethod !== 'claude.ai') {
    limits = await storedLimits(
      userId,
      st.loggedIn ? 'Live plan limits need the Claude Code sign-in (Account → Sign in to Claude Code).' : null,
      'Sign in to Claude Code to see your plan limits.',
    );
  } else {
    // ask the user's own Claude Code (local command: no model call, no cost)
    const su = await ensureSysUser(userId);
    const env = await claudeEnv(userId, su, accountExtrasEnv(false));
    const r = await runAs(su, config.claudeBin, ['-p', '/usage', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config'], {
      env,
      cwd: su.home,
      timeoutMs: 60_000,
    }).catch(() => null);
    let text = '';
    try {
      const j = JSON.parse((r?.stdout ?? '').trim().split('\n').pop() ?? '') as { result?: string; local_command?: string };
      text = typeof j.result === 'string' ? j.result : '';
    } catch {
      /* not json */
    }
    limits = parseUsageReport(text, st.plan) ?? (await storedLimits(userId, 'Claude Code did not report plan limits just now.'));
  }
  live.set(userId, { at: Date.now(), limits });
  return limits;
}

// ---------------------------------------------------------------------------
// Local statistics
// ---------------------------------------------------------------------------
interface Totals {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  durationMs: number;
}

async function totals(userId: number, since: Date | null): Promise<Totals> {
  const row = await q1<Record<string, unknown>>(
    `SELECT COUNT(*) AS runs, COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o,
            COALESCE(SUM(cache_read_tokens),0) AS cr, COALESCE(SUM(cache_write_tokens),0) AS cw,
            COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(duration_ms),0) AS ms
       FROM usage_runs WHERE user_id = ? AND created_at >= ?`,
    [userId, since ?? new Date(0)],
  );
  return {
    runs: Number(row?.runs ?? 0),
    inputTokens: Number(row?.i ?? 0),
    outputTokens: Number(row?.o ?? 0),
    cacheReadTokens: Number(row?.cr ?? 0),
    cacheWriteTokens: Number(row?.cw ?? 0),
    costUsd: Number(row?.cost ?? 0),
    durationMs: Number(row?.ms ?? 0),
  };
}

export async function localUsage(userId: number) {
  const ago = (days: number) => new Date(Date.now() - days * 86400_000);
  const [day, week, month, all] = await Promise.all([totals(userId, ago(1)), totals(userId, ago(7)), totals(userId, ago(30)), totals(userId, null)]);
  const daily = await q<{ d: string; runs: number; cost: number; tokens: number }>(
    `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS d, COUNT(*) AS runs, COALESCE(SUM(cost_usd),0) AS cost,
            COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens),0) AS tokens
       FROM usage_runs WHERE user_id = ? AND created_at >= ? GROUP BY DATE_FORMAT(created_at, '%Y-%m-%d') ORDER BY d`,
    [userId, ago(30)],
  );
  const projects = await q<{ pid: number | null; name: string | null; area: string | null; runs: number; cost: number }>(
    `SELECT IF(p.id IS NULL, NULL, u.project_id) AS pid, p.name, p.area, COUNT(*) AS runs, COALESCE(SUM(u.cost_usd),0) AS cost
       FROM usage_runs u LEFT JOIN projects p ON p.id = u.project_id
      WHERE u.user_id = ? AND u.created_at >= ?
      GROUP BY pid, p.name, p.area ORDER BY cost DESC LIMIT 8`,
    [userId, ago(30)],
  );
  // which AI did the work (Claude Code or another provider's agent)
  const providers = await q<{ provider: string; runs: number; cost: number; tokens: number }>(
    `SELECT provider, COUNT(*) AS runs, COALESCE(SUM(cost_usd),0) AS cost,
            COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens),0) AS tokens
       FROM usage_runs WHERE user_id = ? AND created_at >= ?
      GROUP BY provider ORDER BY runs DESC`,
    [userId, ago(30)],
  );
  return {
    periods: { day, week, month, all },
    daily: daily.map((d) => ({ date: d.d, runs: Number(d.runs), costUsd: Number(d.cost), tokens: Number(d.tokens) })),
    projects: projects.map((p) => ({
      projectId: p.pid === null ? null : Number(p.pid),
      name: p.area === 'chat' ? 'Chat' : (p.name ?? '(deleted projects)'),
      area: p.area,
      runs: Number(p.runs),
      costUsd: Number(p.cost),
    })),
    providers: providers.map((p) => ({ provider: p.provider, runs: Number(p.runs), costUsd: Number(p.cost), tokens: Number(p.tokens) })),
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export const usageRouter = Router();

usageRouter.get('/usage', async (req, res) => {
  const userId = req.user!.id;
  const [local, limits] = await Promise.all([localUsage(userId), planLimits(userId, req.query.refresh === '1')]);
  res.json({ local, limits });
});

usageRouter.get('/usage/limits', async (req, res) => {
  res.json({ limits: await planLimits(req.user!.id, req.query.refresh === '1') });
});

/** Admin: usage of everybody (last 30 days + all time) and their last known plan status. */
usageRouter.get('/admin/usage', async (_req, res) => {
  const since = new Date(Date.now() - 30 * 86400_000);
  const rows = await q<Record<string, unknown>>(
    `SELECT u.id, u.username, u.display_name,
            COUNT(r.id) AS runs, COALESCE(SUM(r.cost_usd),0) AS cost,
            COALESCE(SUM(r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens),0) AS tokens,
            MAX(r.created_at) AS last_run
       FROM users u LEFT JOIN usage_runs r ON r.user_id = u.id AND r.created_at >= ?
      GROUP BY u.id, u.username, u.display_name
      ORDER BY cost DESC, u.id`,
    [since],
  );
  const allTime = await q<{ user_id: number; cost: number; runs: number }>(
    'SELECT user_id, COALESCE(SUM(cost_usd),0) AS cost, COUNT(*) AS runs FROM usage_runs GROUP BY user_id',
  );
  const limits = await q<{ user_id: number; rate_limit: unknown; rate_limit_at: Date | null }>(
    'SELECT user_id, rate_limit, rate_limit_at FROM claude_connections WHERE rate_limit IS NOT NULL',
  );
  res.json({
    users: rows.map((r) => {
      const id = Number(r.id);
      const at = allTime.find((a) => Number(a.user_id) === id);
      const lim = limits.find((l) => Number(l.user_id) === id);
      return {
        id,
        username: r.username,
        displayName: r.display_name,
        month: { runs: Number(r.runs), costUsd: Number(r.cost), tokens: Number(r.tokens) },
        allTime: { runs: Number(at?.runs ?? 0), costUsd: Number(at?.cost ?? 0) },
        lastRun: r.last_run,
        limits: lim ? limitsFromEvent(lim.rate_limit, lim.rate_limit_at) : null,
      };
    }),
  });
});
