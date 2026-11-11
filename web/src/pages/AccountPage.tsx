import { BadgeCheck, Gauge, KeyRound, LogIn, LogOut, Plug, RefreshCw, Save, Terminal, Zap } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api, errMsg, type ClaudeStatus, type LocalUsage, type PlanLimits, type UsageTotals, type User } from '../api';
import { fmtReset } from '../components/ChatPanel';
import { socket } from '../ws';
import { TerminalView } from '../components/lazy';
import { Modal, Spinner, useUi } from '../components/ui';
import { AgentConnectionsCard } from '../components/AgentConnections';
import { useProviderName, useStudio } from '../store';
import { MODEL_SUGGESTIONS, timeAgo } from '../util';

// `authMethod` values of `claude auth status --json`
const METHOD_LABEL: Record<string, string> = {
  'claude.ai': 'Claude subscription (Claude Code sign-in)',
  oauth_token: 'a token you configured in your Claude Code settings',
  api_key: 'API key',
  api_key_helper: 'API key helper',
  third_party: 'a cloud provider',
  none: 'not connected',
};

function LoginTerminal({ mode, onClose }: { mode: 'claudeai' | 'console'; onClose: () => void }) {
  const { refreshClaude } = useStudio();
  return (
    <Modal
      title={mode === 'console' ? 'Sign in to Claude Code with Anthropic Console' : 'Sign in to Claude Code'}
      size="wide"
      icon={<Terminal size={18} />}
      onClose={() => {
        void refreshClaude(true);
        onClose();
      }}
    >
      <ol className="muted small" style={{ margin: '0 0 12px', paddingLeft: 18, lineHeight: 1.7 }}>
        <li>Claude Code starts below and prints a sign-in link — click it (it opens in a new tab).</li>
        <li>Sign in and approve. You get a code: copy it.</li>
        <li>
          Click into the terminal, paste the code (<kbd>Ctrl</kbd>+<kbd>V</kbd> or right-click → paste) and press <kbd>Enter</kbd>.
        </li>
        <li>When it says you are logged in, close this window.</li>
      </ol>
      <div style={{ height: 430, border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', display: 'flex' }}>
        <TerminalView kind="login" mode={mode} title="claude auth login" onExit={() => void refreshClaude(true)} />
      </div>
      <p className="faint small" style={{ marginTop: 10 }}>
        This is Claude Code's own sign-in: you sign in on Anthropic's site, and Claude Code keeps the login in your private sandbox account. The Studio
        itself never sees your password and does not store or use Claude tokens. Use your own Claude account — accounts must not be shared.
      </p>
    </Modal>
  );
}

function ClaudeCard() {
  const ui = useUi();
  const { claude, refreshClaude } = useStudio();
  const [terminal, setTerminal] = useState<'claudeai' | 'console' | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [test, setTest] = useState<{ ok: boolean; message: string; hint?: string; ms: number } | null>(null);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    } finally {
      setBusy('');
    }
  };

  const saveKey = (secret: string) =>
    run('api_key', async () => {
      await api<{ status: ClaudeStatus }>('/claude/credentials', { method: 'PUT', body: { method: 'api_key', secret } });
      setApiKey('');
      await refreshClaude(true);
      ui.toast('API key saved (encrypted)');
    });

  const removeSecret = () =>
    run('remove', async () => {
      await api('/claude/credentials', { method: 'DELETE' });
      await refreshClaude(true);
      ui.toast('Stored API key removed');
    });

  const logout = () =>
    run('logout', async () => {
      const ok = await ui.confirm({ title: 'Sign out of Claude?', body: 'Signs Claude Code out in your sandbox account (a stored API key stays until you remove it).', confirm: 'Sign out' });
      if (!ok) return;
      await api('/claude/logout', { body: {} });
      await refreshClaude(true);
    });

  const runTest = () =>
    run('test', async () => {
      setTest(null);
      setTest(await api<{ ok: boolean; message: string; hint?: string; ms: number }>('/claude/test', { body: {} }));
      await refreshClaude(true);
    });

  const saveModel = () =>
    run('model', async () => {
      await api('/claude/settings', { method: 'PATCH', body: { defaultModel: model ?? '' } });
      await refreshClaude(true);
      ui.toast('Default model saved');
    });

  const s = claude;
  return (
    <div className="card">
      <div className="card-head">
        <KeyRound size={18} color="var(--accent)" />
        <h2 className="grow">Claude connection</h2>
        <button className="btn sm ghost" onClick={() => run('refresh', () => refreshClaude(true))}>
          {busy === 'refresh' ? <Spinner size={14} /> : <RefreshCw size={14} />} Refresh
        </button>
      </div>
      <div className="card-body stack">
        <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
          <span className={`status-dot ${s?.loggedIn ? 'ok' : 'bad'}`} style={{ width: 12, height: 12 }} />
          <div className="grow">
            <b style={{ fontSize: 15 }}>{s ? (s.loggedIn ? 'Connected' : 'Not connected') : 'Checking…'}</b>
            {s && (
              <div className="muted small">
                {s.loggedIn ? `via ${METHOD_LABEL[s.authMethod] ?? s.authMethod}` : 'Choose one of the ways below.'}
                {s.hint ? ` · stored key ${s.hint}` : ''}
                {s.loginExpiresAt ? ` · login valid until ${new Date(s.loginExpiresAt).toLocaleDateString()}` : ''}
                {s.verifiedAt ? ` · last verified ${timeAgo(s.verifiedAt)}` : ''}
              </div>
            )}
            {s?.error && <div className="small" style={{ color: 'var(--danger)' }}>{s.error}</div>}
          </div>
          <button className="btn" onClick={runTest} disabled={!!busy}>
            {busy === 'test' ? <Spinner size={14} /> : <Zap size={14} />} Test connection
          </button>
          {s?.hint && (
            <button className="btn ghost" onClick={removeSecret} disabled={!!busy}>
              Remove stored key
            </button>
          )}
          {s?.loggedIn && s.authMethod === 'claude.ai' && (
            <button className="btn ghost" onClick={logout} disabled={!!busy}>
              <LogOut size={14} /> Sign out
            </button>
          )}
        </div>
        {test && (
          <div className={`notice ${test.ok ? 'info' : 'error'}`}>
            {test.ok ? <BadgeCheck size={18} color="var(--ok)" /> : <Zap size={18} />}
            <div>
              {test.ok ? (
                <>
                  Claude answered “{test.message}” in {(test.ms / 1000).toFixed(1)}s — everything works.
                </>
              ) : (
                <>
                  <b>The test failed.</b>
                  <pre>{test.message}</pre>
                  {test.hint && <div>{test.hint}</div>}
                </>
              )}
            </div>
          </div>
        )}

        <div className="method-grid">
          <div className="method">
            <h3>
              <LogIn size={16} /> Claude subscription <span className="badge accent">recommended</span>
            </h3>
            <p className="muted small">
              For Claude Pro / Max / Team plans. Sign in to Claude Code once in a browser terminal — the sign-in happens on Anthropic's site, and Claude Code
              keeps the login fresh by itself.
            </p>
            <div className="row wrap">
              <button className="btn primary" onClick={() => setTerminal('claudeai')}>
                <LogIn size={14} /> Sign in to Claude Code
              </button>
              <button className="btn ghost sm" onClick={() => setTerminal('console')}>
                Anthropic Console sign-in
              </button>
            </div>
          </div>

          <div className="method">
            <h3>
              <KeyRound size={16} /> API key
            </h3>
            <p className="muted small">
              Pay per use with your own key from the Anthropic Console (<code className="code-inline">sk-ant-api…</code>). Stored encrypted, used only for your
              own Claude Code sessions.
            </p>
            <div className="row">
              <input className="input mono" type="password" placeholder="sk-ant-api03-…" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />
              <button className="btn" disabled={apiKey.trim().length < 20 || !!busy} onClick={() => saveKey(apiKey.trim())}>
                {busy === 'api_key' ? <Spinner size={14} /> : <Save size={14} />} Save
              </button>
            </div>
          </div>
        </div>

        <div className="field" style={{ maxWidth: 460 }}>
          <label className="label">Default model for your projects</label>
          <div className="row">
            <input
              className="input"
              list="model-list-account"
              placeholder="account default"
              value={model ?? s?.defaultModel ?? ''}
              onChange={(e) => setModel(e.target.value)}
            />
            <datalist id="model-list-account">
              {MODEL_SUGGESTIONS.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <button className="btn" onClick={saveModel} disabled={model === null || !!busy}>
              Save
            </button>
          </div>
          <div className="hint">Projects can override this in their settings.</div>
        </div>

        <label className="row" style={{ gap: 10, alignItems: 'flex-start', maxWidth: 720, cursor: 'pointer' }}>
          <input
            type="checkbox"
            style={{ marginTop: 3 }}
            checked={!!s?.accountExtras}
            disabled={!s || !!busy}
            onChange={(e) =>
              void run('extras', async () => {
                await api('/claude/settings', { method: 'PATCH', body: { accountExtras: e.target.checked } });
                await refreshClaude(true);
              })
            }
          />
          <span>
            <span className="row" style={{ gap: 6 }}>
              <Plug size={14} /> <b>Use my account's plugins, connectors and MCP servers</b>
            </span>
            <span className="hint" style={{ display: 'block' }}>
              Off (recommended): Claude in your projects uses only the Studio tools — it starts faster and stays focused. On: plugins, claude.ai connectors (Gmail,
              Slack …) and MCP servers of your Claude account load too (dozens of extra tools; some need you to sign in to them).
            </span>
          </span>
        </label>
      </div>
      {terminal && <LoginTerminal mode={terminal} onClose={() => setTerminal(null)} />}
    </div>
  );
}

const fmtInt = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(0)}k` : n.toLocaleString());
const fmtUsd = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);
const fmtDur = (ms: number) => {
  const m = Math.round(ms / 60000);
  return m >= 120 ? `${Math.round(m / 60)} h` : `${m} min`;
};

function Meter({ pct }: { pct: number }) {
  const v = Math.max(0, Math.min(100, pct));
  return (
    <div className={`meter ${v >= 95 ? 'bad' : v >= 80 ? 'warn' : ''}`}>
      <span style={{ width: `${v}%` }} />
    </div>
  );
}

function PlanLimitsView({ limits, onRefresh, busy }: { limits: PlanLimits | null; onRefresh: () => void; busy: boolean }) {
  if (!limits) return <Spinner />;
  return (
    <div className="stack">
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <b className="grow">
          Claude plan limits{limits.plan ? ` · ${limits.plan}` : ''}
        </b>
        {limits.checkedAt && (
          <span className="faint small">
            {limits.source === 'claude-code-usage' ? "from Claude Code's usage report" : 'reported by Claude Code during your last run'} ·{' '}
            {new Date(limits.checkedAt).toLocaleString()}
          </span>
        )}
        <button className="btn sm ghost" onClick={onRefresh} disabled={busy}>
          {busy ? <Spinner size={14} /> : <RefreshCw size={14} />} Refresh
        </button>
      </div>
      {limits.windows.length === 0 && <div className="muted small">{limits.note ?? 'No limit information yet — it appears after your first Claude message.'}</div>}
      {limits.windows.map((w) => {
        const pct = w.percent ?? 0;
        return (
          <div key={w.key} className="stack" style={{ gap: 4 }}>
            <div className="row small" style={{ justifyContent: 'space-between', gap: 10 }}>
              <span>{w.label}</span>
              <span className="muted">
                <b style={{ color: 'var(--text)' }}>{w.percent === null ? '—' : `${Math.round(pct)}% used`}</b>
                {w.percent !== null ? ` · ${Math.max(0, 100 - Math.round(pct))}% left` : ''}
                {w.resetsAt ? ` · resets ${fmtReset(w.resetsAt)}` : w.resetsText ? ` · resets ${w.resetsText}` : ''}
              </span>
            </div>
            <Meter pct={pct} />
          </div>
        );
      })}
      {limits.extra?.enabled && (
        <div className="row small muted" style={{ gap: 6 }}>
          Extra usage: {limits.extra.usedCredits.toFixed(2)} {limits.extra.currency}
          {limits.extra.monthlyLimit !== null ? ` of ${limits.extra.monthlyLimit.toFixed(2)} ${limits.extra.currency} this month` : ''}
        </div>
      )}
      {limits.windows.length > 0 && limits.note && <div className="faint small">{limits.note}</div>}
    </div>
  );
}

function UsageCard() {
  const ui = useUi();
  const { refreshLimits } = useStudio();
  const loc = useLocation();
  const ref = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<{ local: LocalUsage; limits: PlanLimits } | null>(null);
  const [busy, setBusy] = useState(false);
  const providerName = useProviderName();

  const load = useCallback(
    async (refresh = false) => {
      setBusy(true);
      try {
        const r = await api<{ local: LocalUsage; limits: PlanLimits }>(`/usage${refresh ? '?refresh=1' : ''}`);
        setData(r);
        if (refresh) void refreshLimits();
      } catch (err) {
        ui.toast(errMsg(err), 'error');
      } finally {
        setBusy(false);
      }
    },
    [ui, refreshLimits],
  );

  useEffect(() => {
    void load();
    return socket.on((msg) => {
      if (msg.t === 'usage.changed' || msg.t === 'usage.limits') void load();
    });
  }, [load]);

  useEffect(() => {
    if (loc.hash === '#usage') setTimeout(() => ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
  }, [loc.hash, data]);

  const periods: [string, UsageTotals | undefined][] = [
    ['Last 24 hours', data?.local.periods.day],
    ['Last 7 days', data?.local.periods.week],
    ['Last 30 days', data?.local.periods.month],
    ['All time', data?.local.periods.all],
  ];
  const daily = data?.local.daily ?? [];
  const maxTokens = Math.max(1, ...daily.map((d) => d.tokens));
  // the totals include every AI the user worked with — say so once another AI than Claude did work
  const byAi = data?.local.providers ?? [];
  const otherAis = byAi.some((p) => p.provider !== 'claude');
  return (
    <div className="card" id="usage" ref={ref}>
      <div className="card-head">
        <Gauge size={18} color="var(--accent)" />
        <h2 className="grow">Usage</h2>
      </div>
      <div className="card-body stack-lg">
        <PlanLimitsView limits={data?.limits ?? null} onRefresh={() => void load(true)} busy={busy} />

        <div className="stack">
          <b>{otherAis ? 'Your AI runs in the Studio' : 'Your Claude runs in the Studio'}</b>
          <div className="usage-grid">
            {periods.map(([label, t]) => (
              <div key={label} className="usage-stat">
                <span className="faint small">{label}</span>
                <b>{t ? `${t.runs} message${t.runs === 1 ? '' : 's'}` : '—'}</b>
                {t && (
                  <span className="muted small">
                    {fmtInt(t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens)} tokens · {fmtInt(t.outputTokens)} written
                    <br />≈ {fmtUsd(t.costUsd)} API value · {fmtDur(t.durationMs)}
                  </span>
                )}
              </div>
            ))}
          </div>
          {daily.length > 1 && (
            <div className="stack" style={{ gap: 4 }}>
              <span className="faint small">Tokens per day (last 30 days)</span>
              <div className="usage-bars">
                {daily.map((d) => (
                  <span
                    key={d.date}
                    style={{ height: `${Math.max(4, (d.tokens / maxTokens) * 100)}%` }}
                    title={`${d.date}: ${d.runs} message(s), ${fmtInt(d.tokens)} tokens, ≈ ${fmtUsd(d.costUsd)}`}
                  />
                ))}
              </div>
            </div>
          )}
          {otherAis && (
            <table className="table small">
              <thead>
                <tr>
                  <th>AI (last 30 days)</th>
                  <th style={{ textAlign: 'right' }}>Messages</th>
                  <th style={{ textAlign: 'right' }}>Tokens</th>
                  <th style={{ textAlign: 'right' }}>≈ API value</th>
                </tr>
              </thead>
              <tbody>
                {byAi.map((p) => (
                  <tr key={p.provider}>
                    <td>{providerName(p.provider)}</td>
                    <td style={{ textAlign: 'right' }}>{p.runs}</td>
                    <td style={{ textAlign: 'right' }}>{fmtInt(p.tokens)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtUsd(p.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {(data?.local.projects.length ?? 0) > 0 && (
            <table className="table small">
              <thead>
                <tr>
                  <th>Where (last 30 days)</th>
                  <th style={{ textAlign: 'right' }}>Messages</th>
                  <th style={{ textAlign: 'right' }}>≈ API value</th>
                </tr>
              </thead>
              <tbody>
                {data!.local.projects.map((p) => (
                  <tr key={String(p.projectId)}>
                    <td>{p.name}</td>
                    <td style={{ textAlign: 'right' }}>{p.runs}</td>
                    <td style={{ textAlign: 'right' }}>{fmtUsd(p.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="hint">
            “API value” is what Claude Code reports these runs would cost at API prices. With a Claude subscription you are not billed per token — the plan limits
            above are what counts. With an API key it is your actual cost.
            {otherAis &&
              ' Other AIs count against your own account or key with that provider, not your Claude plan; their API value appears only when the provider reports a cost.'}
          </div>
        </div>
      </div>
    </div>
  );
}

function ProfileCard() {
  const ui = useUi();
  const { user, setUser } = useStudio();
  const [name, setName] = useState(user?.displayName ?? '');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');

  const saveName = async () => {
    try {
      const r = await api<{ user: User }>('/account', { method: 'PATCH', body: { displayName: name } });
      setUser(r.user);
      ui.toast('Profile saved');
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    }
  };
  const changePassword = async () => {
    try {
      await api('/account/password', { body: { current, next } });
      setCurrent('');
      setNext('');
      ui.toast('Password changed — other sessions were logged out');
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h2>Profile</h2>
      </div>
      <div className="card-body">
        <div className="method-grid">
          <div>
            <div className="field">
              <label className="label">Display name</label>
              <div className="row">
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
                <button className="btn" onClick={saveName} disabled={!name.trim() || name === user?.displayName}>
                  Save
                </button>
              </div>
            </div>
            <dl className="kv" style={{ marginTop: 16 }}>
              <dt>Username</dt>
              <dd>@{user?.username}</dd>
              <dt>Email</dt>
              <dd>{user?.email}</dd>
              <dt>Role</dt>
              <dd>{user?.role}</dd>
            </dl>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void changePassword();
            }}
          >
            <div className="field">
              <label className="label">Current password</label>
              <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
            </div>
            <div className="field">
              <label className="label">New password</label>
              <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
            </div>
            <button className="btn" style={{ marginTop: 12 }} disabled={!current || next.length < 8}>
              Change password
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

export function AccountPage() {
  return (
    <div className="page stack-lg">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1>Account & AI</h1>
          <p>Connect your own Claude account — and other AI providers if this Studio offers them. Every AI session in your projects runs with your own accounts, inside your private sandbox account.</p>
        </div>
      </div>
      <ClaudeCard />
      <AgentConnectionsCard />
      <UsageCard />
      <ProfileCard />
    </div>
  );
}
