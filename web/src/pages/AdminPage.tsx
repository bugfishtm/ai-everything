import { AppWindow, Bot, Check, Cpu, Download, Gauge, Power, RefreshCw, Server, Shield, Smartphone, Square, Trash2, UserPlus, Users, Wrench, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { socket } from '../ws';
import { Navigate } from 'react-router-dom';
import { api, errMsg, type Hosting, type PlanLimits, type Service, type Site, type Tool, type User } from '../api';
import { ServiceBadge } from '../components/ServicePanel';
import { SiteBadge } from '../components/SitePanel';
import { AgentsAdminCard } from '../components/AgentsAdmin';
import { HttpsAdminCard, InstructionsAdminCard } from '../components/AdminExtras';
import { Modal, Spinner, useUi } from '../components/ui';
import { useStudio } from '../store';
import { timeAgo } from '../util';

type AdminUser = User & { projects: number; assets: number };
interface SystemInfo {
  version: string;
  claudeVersion: string | null;
  isolation: string;
  uptimeSec: number;
  activeRuns: number;
  terminals: number;
  wsClients: number;
  limits: Record<string, number>;
  defaultPermissionMode: string;
  toolchains: { id: string; name: string; available: boolean; version?: string }[];
  tools: Tool[];
  paths: Record<string, string>;
}

export function AdminPage() {
  const ui = useUi();
  const { user } = useStudio();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [registration, setRegistration] = useState<'open' | 'closed' | null>(null);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const [u, s, sys] = await Promise.all([
        api<{ users: AdminUser[] }>('/admin/users'),
        api<{ registration: 'open' | 'closed' }>('/admin/settings'),
        api<SystemInfo>('/admin/system'),
      ]);
      setUsers(u.users);
      setRegistration(s.registration);
      setSystem(sys);
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    }
  }, [ui]);
  useEffect(() => {
    void load();
  }, [load]);

  if (user?.role !== 'admin') return <Navigate to="/" replace />;

  const patchUser = async (u: AdminUser, body: Record<string, unknown>) => {
    try {
      await api(`/admin/users/${u.id}`, { method: 'PATCH', body });
      void load();
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    }
  };
  const resetPassword = async (u: AdminUser) => {
    const pw = await ui.prompt(`New password for @${u.username}`, '', 'At least 8 characters — tell it to the user.');
    if (!pw) return;
    await patchUser(u, { password: pw });
    ui.toast('Password changed');
  };
  const deleteUser = async (u: AdminUser) => {
    const ok = await ui.confirm({
      title: `Delete @${u.username} for good?`,
      body: (
        <>
          This deletes the account of <b>{u.displayName}</b> with everything in it: {u.projects} project(s), {u.assets} library asset(s), chats, packs, skills, servers and
          websites (their domains go offline) — and the files on the server. It cannot be undone. To only lock someone out, use <b>Disable</b>.
        </>
      ),
      confirm: 'Delete user and all data',
      danger: true,
    });
    if (!ok) return;
    const typed = await ui.prompt(`Type the user name to confirm: ${u.username}`, '', 'This is the last question.');
    if (typed === null) return;
    if (typed.trim().replace(/^@/, '') !== u.username) return ui.toast('The name does not match — nothing was deleted', 'error');
    try {
      await api(`/admin/users/${u.id}`, { method: 'DELETE' });
      ui.toast(`@${u.username} was deleted`);
      void load();
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    }
  };
  const toggleRegistration = async () => {
    const next = registration === 'open' ? 'closed' : 'open';
    try {
      await api('/admin/settings', { method: 'PUT', body: { registration: next } });
      setRegistration(next);
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    }
  };
  const rescan = async () => {
    try {
      await api('/admin/system/rescan', { body: {} });
      void load();
      ui.toast('Tools rescanned');
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    }
  };

  return (
    <div className="page stack-lg">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div className="row" style={{ gap: 12 }}>
          <Shield size={28} color="var(--accent)" />
          <div>
            <h1>Administration</h1>
            <p>Users, registration and what is installed in this image.</p>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <Users size={18} />
          <h2 className="grow">Users</h2>
          <label className="row small muted" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={registration === 'open'} onChange={toggleRegistration} disabled={!registration} /> Anyone can register
          </label>
          <button className="btn sm primary" onClick={() => setCreating(true)}>
            <UserPlus size={14} /> Add user
          </button>
        </div>
        <div style={{ overflowX: 'auto' }}>
          {!users ? (
            <div style={{ padding: 20 }}>
              <Spinner />
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Projects</th>
                  <th>Assets</th>
                  <th>Last login</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <b>{u.displayName}</b> <span className="faint">@{u.username}</span>
                      <div className="faint small">{u.email}</div>
                    </td>
                    <td>
                      <span className={`badge ${u.role === 'admin' ? 'accent' : ''}`}>{u.role}</span>
                    </td>
                    <td>
                      <span className={`badge ${u.status === 'active' ? 'ok' : 'danger'}`}>{u.status}</span>
                    </td>
                    <td>{u.projects}</td>
                    <td>{u.assets}</td>
                    <td className="faint small">{u.lastLoginAt ? timeAgo(u.lastLoginAt) : 'never'}</td>
                    <td>
                      {u.id !== user?.id && (
                        <div className="row" style={{ justifyContent: 'flex-end' }}>
                          <button className="btn sm ghost" onClick={() => patchUser(u, { role: u.role === 'admin' ? 'user' : 'admin' })}>
                            {u.role === 'admin' ? 'Make user' : 'Make admin'}
                          </button>
                          <button className="btn sm ghost" onClick={() => patchUser(u, { status: u.status === 'active' ? 'disabled' : 'active' })}>
                            {u.status === 'active' ? 'Disable' : 'Enable'}
                          </button>
                          <button className="btn sm ghost" onClick={() => resetPassword(u)}>
                            Reset password
                          </button>
                          <button className="btn sm ghost" style={{ color: 'var(--danger)' }} onClick={() => void deleteUser(u)} title="Delete the account with all its data">
                            <Trash2 size={14} />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <Cpu size={18} />
          <h2 className="grow">System</h2>
          <button className="btn sm" onClick={rescan}>
            <RefreshCw size={14} /> Rescan tools
          </button>
        </div>
        <div className="card-body">
          {!system ? (
            <Spinner />
          ) : (
            <div className="method-grid">
              <dl className="kv">
                <dt>Studio</dt>
                <dd>{system.version}</dd>
                <dt>Claude Code</dt>
                <dd>{system.claudeVersion ?? <span style={{ color: 'var(--danger)' }}>not found</span>}</dd>
                <dt>Isolation</dt>
                <dd>{system.isolation}</dd>
                <dt>Uptime</dt>
                <dd>{Math.round(system.uptimeSec / 60)} min</dd>
                <dt>Running</dt>
                <dd>
                  {system.activeRuns} Claude run(s) · {system.terminals} terminal(s) · {system.wsClients} browser connection(s)
                </dd>
                <dt>Default mode</dt>
                <dd>{system.defaultPermissionMode}</dd>
                <dt>Limits</dt>
                <dd className="small">
                  {Object.entries(system.limits)
                    .map(([k, v]) => `${k}=${v}`)
                    .join(' · ')}
                </dd>
                {Object.entries(system.paths).map(([k, v]) => (
                  <div key={k} style={{ display: 'contents' }}>
                    <dt>{k}</dt>
                    <dd className="mono small">{v}</dd>
                  </div>
                ))}
              </dl>
              <div>
                <div className="label">Toolchains in the image</div>
                <div className="col" style={{ gap: 4 }}>
                  {system.toolchains.map((t) => (
                    <div key={t.id} className="row small">
                      {t.available ? <Check size={14} color="var(--ok)" /> : <X size={14} color="var(--text-faint)" />}
                      <span className={t.available ? '' : 'faint'}>{t.name}</span>
                      {t.version && <span className="faint ellipsis" style={{ maxWidth: 220 }}>{t.version}</span>}
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="label row">
                  <Wrench size={13} /> Studio tools ({system.tools.length})
                </div>
                <div className="col" style={{ gap: 8 }}>
                  {system.tools.map((t) => (
                    <div key={t.id} className="small">
                      <b>{t.name}</b> <span className="faint">({t.id}{t.version ? ` v${t.version}` : ''}) · {t.areas.join(', ')}</span>
                      <div className="muted">{t.description}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <ClaudeCodeCard />
      <AgentsAdminCard />
      <InstructionsAdminCard />
      <ServersAdminCard />
      <SitesAdminCard />
      <HttpsAdminCard />
      <UsageAdminCard />
      <AndroidSdkCard />

      {creating && <CreateUserModal onClose={() => setCreating(false)} onDone={() => { setCreating(false); void load(); }} />}
    </div>
  );
}

interface SdkInfo {
  status: {
    installed: boolean;
    androidHome: string;
    platforms: string[];
    buildTools: string[];
    platformTools: boolean;
    installedAt: string | null;
    license: { acceptedBy: string; acceptedAt: string } | null;
    termsUrl: string;
    job: { state: string; startedAt: number; finishedAt?: number; packages: string[]; log: string[] } | null;
  };
  plan: { cmdlineToolsUrl: string; packages: string[]; source: string } | null;
  planError?: string;
}

function AndroidSdkCard() {
  const ui = useUi();
  const [info, setInfo] = useState<SdkInfo | null>(null);
  const [accept, setAccept] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const logRef = useRef<HTMLPreElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<SdkInfo>('/admin/sdk/android');
      setInfo(r);
      setLog(r.status.job?.log ?? []);
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    }
  }, [ui]);

  useEffect(() => {
    void load();
    return socket.on((m) => {
      if (m.t === 'sdk.log') setLog((l) => [...l.slice(-800), m.line]);
      if (m.t === 'sdk.status') void load();
    });
  }, [load]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const install = async () => {
    try {
      await api('/admin/sdk/android/install', { body: { accept } });
      setLog([]);
      void load();
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    }
  };

  const s = info?.status;
  const running = s?.job?.state === 'running';
  return (
    <div className="card">
      <div className="card-head">
        <Smartphone size={18} />
        <h2 className="grow">Android SDK</h2>
        {s && <span className={`badge ${s.installed ? 'ok' : 'warn'}`}>{s.installed ? 'installed' : 'not installed'}</span>}
      </div>
      <div className="card-body stack">
        {!info ? (
          <Spinner />
        ) : (
          <>
            <p className="muted small">
              The Android SDK is not part of the image (its license does not allow redistribution). It is downloaded from Google into{' '}
              <code className="code-inline">{s!.androidHome}</code> (in the data volume) and shared read-only by all projects. The newest stable platforms and build-tools are
              picked automatically; update any time.
            </p>
            {s!.installed && (
              <dl className="kv">
                <dt>Platforms</dt>
                <dd>{s!.platforms.join(', ') || '—'}</dd>
                <dt>Build tools</dt>
                <dd>{s!.buildTools.join(', ') || '—'}</dd>
                <dt>Installed</dt>
                <dd>{s!.installedAt ? new Date(s!.installedAt).toLocaleString() : '—'}</dd>
                {s!.license && (
                  <>
                    <dt>License accepted</dt>
                    <dd>
                      by {s!.license.acceptedBy}, {new Date(s!.license.acceptedAt).toLocaleString()}
                    </dd>
                  </>
                )}
              </dl>
            )}
            {info.plan && (
              <div className="small">
                <span className="muted">{s!.installed ? 'Update would install' : 'Will install'} ({info.plan.source === 'auto' ? 'newest stable' : 'ANDROID_SDK_PACKAGES'}): </span>
                <code className="code-inline">{info.plan.packages.join('  ')}</code>
              </div>
            )}
            {info.planError && <div className="small" style={{ color: 'var(--danger)' }}>Cannot reach Google's repository: {info.planError}</div>}
            <div className="method">
              <label className="row" style={{ alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
                <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} style={{ marginTop: 3 }} />
                <span className="small">
                  I have read and accept the{' '}
                  <a href={s!.termsUrl} target="_blank" rel="noopener noreferrer">
                    Android Software Development Kit License Agreement
                  </a>{' '}
                  on behalf of this installation. (Unattended setups: <code className="code-inline">ANDROID_SDK_ACCEPT_LICENSE=yes</code> +{' '}
                  <code className="code-inline">ANDROID_SDK_AUTO_INSTALL=true</code>.)
                </span>
              </label>
              <div>
                <button className="btn primary" disabled={!accept || running} onClick={install}>
                  {running ? <Spinner size={14} /> : <Download size={14} />} {s!.installed ? 'Update to newest SDK' : 'Install newest Android SDK'}
                </button>
              </div>
            </div>
            {(running || log.length > 0) && (
              <pre ref={logRef} className="small" style={{ maxHeight: 260, overflow: 'auto', background: '#0b0e14', border: '1px solid var(--border)', borderRadius: 8, padding: 10, margin: 0 }}>
                {log.join('\n') || 'starting…'}
              </pre>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function CreateUserModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ email: '', username: '', displayName: '', password: '', role: 'user' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await api('/admin/users', { body: { ...form, displayName: form.displayName || undefined } });
      onDone();
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Add user"
      icon={<UserPlus size={18} />}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={submit}>
            {busy && <Spinner size={14} />} Create
          </button>
        </>
      }
    >
      {error && <div className="form-error" style={{ marginBottom: 14 }}>{error}</div>}
      {(['email', 'username', 'displayName', 'password'] as const).map((k) => (
        <div className="field" key={k}>
          <label className="label">{k === 'displayName' ? 'Display name (optional)' : k[0].toUpperCase() + k.slice(1)}</label>
          <input className="input" type={k === 'password' ? 'password' : k === 'email' ? 'email' : 'text'} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
        </div>
      ))}
      <div className="field">
        <label className="label">Role</label>
        <select className="select" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
          <option value="user">User</option>
          <option value="admin">Admin</option>
        </select>
      </div>
    </Modal>
  );
}

interface UserUsage {
  id: number;
  username: string;
  displayName: string;
  month: { runs: number; costUsd: number; tokens: number };
  allTime: { runs: number; costUsd: number };
  lastRun: string | null;
  limits: PlanLimits | null;
}

function UsageAdminCard() {
  const [rows, setRows] = useState<UserUsage[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api<{ users: UserUsage[] }>('/admin/usage')
      .then((r) => setRows(r.users))
      .catch((err) => setError(errMsg(err)));
  }, []);
  useEffect(() => load(), [load]);
  const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : String(n));
  return (
    <div className="card">
      <div className="card-head">
        <Gauge size={18} color="var(--accent)" />
        <h2 className="grow">Usage by user</h2>
        <button className="btn sm ghost" onClick={load}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
      <div className="card-body" style={{ overflowX: 'auto' }}>
        {error && <div className="form-error">{error}</div>}
        {!rows && !error && <Spinner />}
        {rows && (
          <table className="table small">
            <thead>
              <tr>
                <th>User</th>
                <th style={{ textAlign: 'right' }}>Messages (30 d)</th>
                <th style={{ textAlign: 'right' }}>Tokens (30 d)</th>
                <th style={{ textAlign: 'right' }}>≈ API value (30 d)</th>
                <th style={{ textAlign: 'right' }}>All time</th>
                <th>Plan limits (last reported)</th>
                <th>Last message</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id}>
                  <td>
                    {u.displayName} <span className="faint">@{u.username}</span>
                  </td>
                  <td style={{ textAlign: 'right' }}>{u.month.runs}</td>
                  <td style={{ textAlign: 'right' }}>{fmt(u.month.tokens)}</td>
                  <td style={{ textAlign: 'right' }}>${u.month.costUsd.toFixed(2)}</td>
                  <td style={{ textAlign: 'right' }}>
                    {u.allTime.runs} · ${u.allTime.costUsd.toFixed(2)}
                  </td>
                  <td>
                    {u.limits?.windows.length
                      ? u.limits.windows
                          .filter((w) => w.percent !== null)
                          .map((w) => `${w.key === 'five_hour' ? '5 h' : w.key === 'seven_day' ? 'week' : w.key.replace(/_/g, ' ')} ${Math.round(w.percent ?? 0)}%`)
                          .join(' · ')
                      : '—'}
                  </td>
                  <td className="faint">{u.lastRun ? timeAgo(u.lastRun) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="hint">
          Messages and tokens of every AI (Claude Code and the other AI providers). “API value” = what the AI reports at API prices (other providers only when
          they report a cost); subscription users are limited by their plan windows instead.
        </div>
      </div>
    </div>
  );
}

/** Claude Code CLI: downloaded from npm at runtime (Anthropic's software is not part of the image). */
function ClaudeCodeCard() {
  const ui = useUi();
  const { cli, refreshCli } = useStudio();
  const [log, setLog] = useState<string[]>([]);
  const [version, setVersion] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void refreshCli();
    return socket.on((m) => {
      if (m.t === 'claude.cli.log') setLog((l) => [...l.slice(-300), m.line]);
    });
  }, [refreshCli]);
  useEffect(() => {
    if (cli?.log?.length) setLog((l) => (l.length ? l : cli.log));
  }, [cli]);
  const install = async (v?: string) => {
    setBusy(true);
    try {
      await api('/admin/claude-cli/install', { body: v ? { version: v } : {} });
      await refreshCli();
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  const working = cli?.state === 'installing' || !!cli?.updating;
  return (
    <div className="card" id="claude-code">
      <div className="card-head">
        <Bot size={18} color="var(--accent)" />
        <h2 className="grow">Claude Code</h2>
        <span className={`badge ${cli?.state === 'ready' ? 'ok' : cli?.state === 'error' ? 'danger' : 'warn'}`}>
          {cli?.state === 'ready' ? (cli.updating ? 'updating' : 'ready') : (cli?.state ?? '…')}
        </span>
      </div>
      <div className="card-body stack">
        <p className="muted small" style={{ margin: 0 }}>
          Claude Code is Anthropic's proprietary software, so it is not part of the ai-everything image: the server downloads the official, unmodified npm
          package <code className="code-inline">@anthropic-ai/claude-code</code> into the data volume and keeps it up to date. Every person uses it with their
          own Claude account or API key, under{' '}
          <a href="https://code.claude.com/docs/en/legal-and-compliance" target="_blank" rel="noreferrer">
            Anthropic's terms
          </a>
          . If you run this Studio for other people, Anthropic's Commercial Terms apply to you as the operator.
        </p>
        <dl className="kv">
          <dt>Version</dt>
          <dd>{cli?.version ?? '—'}</dd>
          <dt>Source</dt>
          <dd>
            {cli?.source === 'runtime'
              ? 'downloaded from npm (data volume)'
              : cli?.source === 'image'
                ? 'built into this image (INSTALL_CLAUDE_CODE=true — do not publish such an image)'
                : cli?.source === 'custom'
                  ? `CLAUDE_BIN = ${cli.path}`
                  : '—'}
          </dd>
          <dt>Updates</dt>
          <dd>
            {cli?.wanted === 'latest'
              ? cli.autoUpdate
                ? 'newest release (checked at start and daily)'
                : 'manual (CLAUDE_CODE_AUTO_UPDATE=false)'
              : `pinned to ${cli?.wanted} (CLAUDE_CODE_VERSION)`}
          </dd>
          {cli?.installedAt && (
            <>
              <dt>Installed</dt>
              <dd>{new Date(cli.installedAt).toLocaleString()}</dd>
            </>
          )}
          {cli?.error && (
            <>
              <dt>Error</dt>
              <dd style={{ color: 'var(--danger)' }}>{cli.error}</dd>
            </>
          )}
        </dl>
        {cli?.source !== 'custom' && (
          <div className="row wrap">
            <button className="btn primary" disabled={busy || working} onClick={() => void install()}>
              {working ? <Spinner size={14} /> : <Download size={14} />} {cli?.state === 'ready' ? 'Update to the newest version' : 'Install Claude Code'}
            </button>
            <input className="input" style={{ width: 150 }} placeholder="or a version, e.g. 2.1.319" value={version} onChange={(e) => setVersion(e.target.value)} />
            <button className="btn" disabled={busy || working || !version.trim()} onClick={() => void install(version.trim())}>
              Install this version
            </button>
          </div>
        )}
        {log.length > 0 && <pre className="log-box">{log.slice(-40).join(String.fromCharCode(10))}</pre>}
      </div>
    </div>
  );
}

/** Every deployed server on this Studio (all users). */
function ServersAdminCard() {
  const ui = useUi();
  const [list, setList] = useState<Service[] | null>(null);
  const [cfg, setCfg] = useState<{ enabled: boolean; maxPerUser: number; memoryMb: number } | null>(null);
  const load = useCallback(() => {
    api<{ services: Service[]; config: { enabled: boolean; maxPerUser: number; memoryMb: number } }>('/admin/services')
      .then((r) => {
        setList(r.services);
        setCfg(r.config);
      })
      .catch((err) => ui.toast(errMsg(err), 'error'));
  }, [ui]);
  useEffect(() => {
    load();
    return socket.on((m) => {
      if (m.t === 'services.changed') load();
    });
  }, [load]);
  const stop = async (s: Service) => {
    const ok = await ui.confirm({ title: `Stop "${s.name}" of ${s.owner}?`, body: 'The server stops until its owner starts it again.', confirm: 'Stop', danger: true });
    if (!ok) return;
    await api(`/admin/services/${s.id}/stop`, { body: {} }).catch((err) => ui.toast(errMsg(err), 'error'));
    load();
  };
  return (
    <div className="card">
      <div className="card-head">
        <Server size={18} color="var(--accent)" />
        <h2 className="grow">Servers</h2>
        {cfg && (
          <span className="faint small">
            {cfg.enabled ? `on · ≤ ${cfg.maxPerUser} per user · ${cfg.memoryMb} MB heap each` : 'switched off (SERVICES_ENABLED=false)'}
          </span>
        )}
        <button className="btn sm ghost" onClick={load}>
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="card-body" style={{ overflowX: 'auto' }}>
        {!list && <Spinner />}
        {list && !list.length && <div className="muted small">No server has been deployed yet.</div>}
        {list && list.length > 0 && (
          <table className="table small">
            <thead>
              <tr>
                <th>Server</th>
                <th>Owner</th>
                <th>Project</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Memory</th>
                <th>Address</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>{s.owner}</td>
                  <td>{s.projectName}</td>
                  <td>
                    <ServiceBadge s={s} />
                    {s.restartsLastHour ? <span className="faint"> · {s.restartsLastHour} crash(es)/h</span> : null}
                  </td>
                  <td style={{ textAlign: 'right' }}>{s.memoryMb ? `${s.memoryMb} MB` : '—'}</td>
                  <td className="mono">{s.path}</td>
                  <td style={{ textAlign: 'right' }}>
                    {(s.port || s.state === 'starting') && (
                      <button className="btn sm ghost" onClick={() => void stop(s)} title="Stop">
                        <Square size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function SitesAdminCard() {
  const ui = useUi();
  const [list, setList] = useState<Site[] | null>(null);
  const [hosting, setHosting] = useState<Hosting | null>(null);
  const load = useCallback(() => {
    api<{ sites: Site[]; hosting: Hosting }>('/admin/sites')
      .then((r) => {
        setList(r.sites);
        setHosting(r.hosting);
      })
      .catch((err) => ui.toast(errMsg(err), 'error'));
  }, [ui]);
  useEffect(() => {
    load();
    return socket.on((m) => {
      if (m.t === 'sites.changed') load();
    });
  }, [load]);
  const toggle = async (s: Site) => {
    if (s.enabled) {
      const ok = await ui.confirm({
        title: `Take "${s.slug}" of ${s.owner} offline?`,
        body: 'Visitors see an "offline" page until the owner (or an admin) puts it online again.',
        confirm: 'Take offline',
        danger: true,
      });
      if (!ok) return;
    }
    await api(`/sites/${s.id}`, { method: 'PATCH', body: { enabled: !s.enabled } }).catch((err) => ui.toast(errMsg(err), 'error'));
    load();
  };
  return (
    <div className="card">
      <div className="card-head">
        <AppWindow size={18} color="var(--accent)" />
        <h2 className="grow">Websites</h2>
        {hosting && (
          <span className="faint small">
            {hosting.enabled
              ? `port ${hosting.port}${hosting.https ? ' · HTTPS' : ''}${hosting.baseDomain ? ` · *.${hosting.baseDomain}` : ''} · ≤ ${hosting.maxPerUser} per user`
              : 'switched off (SITES_ENABLED=false)'}
          </span>
        )}
        <button className="btn sm ghost" onClick={load}>
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="card-body" style={{ overflowX: 'auto' }}>
        {!list && <Spinner />}
        {list && !list.length && <div className="muted small">No website has been published yet.</div>}
        {list && list.length > 0 && (
          <table className="table small">
            <thead>
              <tr>
                <th>Website</th>
                <th>Owner</th>
                <th>Project</th>
                <th>Status</th>
                <th>Domains</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id}>
                  <td className="mono">{s.slug}</td>
                  <td>{s.owner}</td>
                  <td>{s.projectName}</td>
                  <td>
                    <SiteBadge site={s} />
                    {s.release ? <span className="faint"> · #{s.release}</span> : null}
                  </td>
                  <td className="mono">{s.domains.join(', ') || '—'}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn sm ghost" onClick={() => void toggle(s)} title={s.enabled ? 'Take offline' : 'Put online'}>
                      <Power size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
