import {
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  RotateCw,
  ScrollText,
  Server,
  Settings2,
  Square,
  Trash2,
  Undo2,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errMsg, type DetectedServer, type Project, type Service } from '../api';
import { cls } from '../util';
import { socket } from '../ws';
import { Empty, Spinner, useUi } from './ui';

const TEMPLATE_INFO: Record<string, string> = {
  multiplayer: 'WebSocket rooms: players, state, chat',
  storage: 'cloud saves + leaderboards (SQLite)',
  basic: 'a small JSON API',
};

/** running / starting / crashed … as a coloured badge */
export function ServiceBadge({ s }: { s: Service }) {
  const label = s.deploying ? 'deploying' : s.state === 'running' && !s.listening ? 'not listening' : s.state;
  const tone =
    s.deploying || s.state === 'starting'
      ? 'warn'
      : s.state === 'running' && s.listening
        ? 'ok'
        : s.state === 'crashed' || s.state === 'error' || s.state === 'running'
          ? 'danger'
          : '';
  return <span className={cls('badge', tone)}>{label}</span>;
}

function useCopy() {
  const ui = useUi();
  return (text: string) =>
    navigator.clipboard
      .writeText(text)
      .then(() => ui.toast('Copied'))
      .catch(() => ui.toast(text));
}

/** One deployed server: status, actions, live log, environment, settings, releases. */
export function ServiceCard({ service, onDeleted }: { service: Service; onDeleted?: () => void }) {
  const ui = useUi();
  const copy = useCopy();
  const [s, setS] = useState(service);
  const [tab, setTab] = useState<'logs' | 'connect' | 'env' | 'settings' | 'releases'>('logs');
  const [log, setLog] = useState<string[]>([]);
  const [env, setEnv] = useState<[string, string][]>([]);
  const [showValues, setShowValues] = useState(false);
  const [releases, setReleases] = useState<number[]>([]);
  const [busy, setBusy] = useState('');
  const [form, setForm] = useState({ name: service.name, slug: service.slug, memoryMb: service.settings.memoryMb, cors: service.settings.cors, start: service.settings.start });
  const logRef = useRef<HTMLPreElement>(null);
  const stick = useRef(true);

  const loadDetail = useCallback(async () => {
    const d = await api<{ service: Service; env: Record<string, string>; releases: number[]; log: string[] }>(`/services/${service.id}`);
    setS(d.service);
    setLog(d.log);
    setEnv(Object.entries(d.env));
    setReleases(d.releases);
    setForm({ name: d.service.name, slug: d.service.slug, memoryMb: d.service.settings.memoryMb, cors: d.service.settings.cors, start: d.service.settings.start });
  }, [service.id]);

  useEffect(() => {
    void loadDetail().catch((err) => ui.toast(errMsg(err), 'error'));
    const unsub = socket.subscribe(`service:${service.id}`);
    const off = socket.on((m) => {
      if (m.t === 'service.log' && m.id === service.id) setLog((l) => [...l.slice(-1500), m.line]);
      if (m.t === 'service.status' && m.service?.id === service.id) setS(m.service);
      if (m.t === 'ws.open') void loadDetail().catch(() => {});
    });
    return () => {
      unsub();
      off();
    };
  }, [service.id, loadDetail, ui]);

  useEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [log, tab]);

  const act = async (action: string, fn: () => Promise<unknown>) => {
    setBusy(action);
    try {
      await fn();
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    } finally {
      setBusy('');
    }
  };
  const post = (action: string) => act(action, () => api(`/services/${s.id}/${action}`, { body: {} }));

  const remove = () =>
    act('delete', async () => {
      const ok = await ui.confirm({
        title: `Delete the server "${s.name}"?`,
        body: 'It is stopped, its releases and its stored data (DATA_DIR) are deleted permanently. The source code in the project stays.',
        confirm: 'Delete server and data',
        danger: true,
      });
      if (!ok) return;
      await api(`/services/${s.id}`, { method: 'DELETE' });
      onDeleted?.();
    });

  const saveEnv = (restart: boolean) =>
    act('env', async () => {
      const obj = Object.fromEntries(env.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v]));
      await api(`/services/${s.id}/env`, { method: 'PUT', body: { env: obj, restart } });
      ui.toast(restart ? 'Saved — restarting' : 'Saved — restart to apply');
    });

  const saveSettings = () =>
    act('settings', async () => {
      const r = await api<{ service: Service }>(`/services/${s.id}`, {
        method: 'PATCH',
        body: { name: form.name, slug: form.slug, settings: { cors: form.cors, memoryMb: Number(form.memoryMb), start: form.start } },
      });
      setS(r.service);
      ui.toast('Saved — restart the server to apply memory / start command changes');
    });

  const running = !!s.port;
  const wsUrl = s.url.replace(/^http/, 'ws');
  const uptime = s.startedAt ? Math.max(0, Math.round((Date.now() - new Date(s.startedAt).getTime()) / 60000)) : null;

  return (
    <div className="card svc-card">
      <div className="card-head" style={{ flexWrap: 'wrap', gap: 10 }}>
        <Server size={18} color="var(--accent)" />
        <h2 className="grow" style={{ minWidth: 160 }}>
          {s.name} <span className="faint small mono">{s.root}/</span>
        </h2>
        <ServiceBadge s={s} />
        {s.release > 0 && <span className="badge">release #{s.release}</span>}
      </div>
      <div className="card-body stack">
        <div className="row wrap" style={{ gap: 8 }}>
          <code className="code-inline svc-url" title="Public address — apps and browsers connect here">
            {s.url}/
          </code>
          <button className="btn sm ghost icon" title="Copy address" onClick={() => copy(`${s.url}/`)}>
            <Copy size={14} />
          </button>
          <a className="btn sm ghost icon" href={`${s.path}health`} target="_blank" rel="noreferrer" title="Open /health">
            <ExternalLink size={14} />
          </a>
          <span className="spacer" />
          <span className="faint small">
            {running ? `port ${s.port}` : 'not running'}
            {uptime !== null ? ` · up ${uptime >= 120 ? `${Math.round(uptime / 60)} h` : `${uptime} min`}` : ''}
            {s.memoryMb ? ` · ${s.memoryMb} MB` : ''}
            {s.restartsLastHour ? ` · ${s.restartsLastHour} crash(es) in the last hour` : ''}
          </span>
        </div>
        {s.message && <div className={cls('notice', s.state === 'crashed' || s.state === 'error' ? 'error' : 'warn')}>{s.message}</div>}
        <div className="row wrap" style={{ gap: 8 }}>
          <button className="btn primary sm" disabled={!!busy || s.deploying} onClick={() => void post('deploy')} title="Copy the project's server folder, npm install, restart">
            {busy === 'deploy' || s.deploying ? <Spinner size={14} /> : <Rocket size={14} />} {s.release ? 'Redeploy' : 'Deploy'}
          </button>
          <button className="btn sm" disabled={!!busy || !s.release} onClick={() => void post('restart')}>
            {busy === 'restart' ? <Spinner size={14} /> : <RotateCw size={14} />} Restart
          </button>
          {running || s.state === 'starting' ? (
            <button className="btn sm" disabled={!!busy} onClick={() => void post('stop')}>
              <Square size={14} /> Stop
            </button>
          ) : (
            <button className="btn sm" disabled={!!busy || !s.release} onClick={() => void post('start')}>
              <Play size={14} /> Start
            </button>
          )}
          <span className="spacer" />
          <button className="btn sm ghost" disabled={!!busy} onClick={() => void remove()} title="Delete this server and its data">
            <Trash2 size={14} />
          </button>
        </div>

        <div className="tabs">
          {(
            [
              ['logs', 'Logs', <ScrollText size={14} key="i" />],
              ['connect', 'Connect', <Plus size={14} key="i" />],
              ['env', 'Environment', <KeyRound size={14} key="i" />],
              ['settings', 'Settings', <Settings2 size={14} key="i" />],
              ['releases', 'Releases & data', <Undo2 size={14} key="i" />],
            ] as const
          ).map(([k, label, icon]) => (
            <button key={k} className={cls('tab', tab === k && 'active')} onClick={() => setTab(k)}>
              {icon}
              {label}
            </button>
          ))}
        </div>

        {tab === 'logs' && (
          <pre
            ref={logRef}
            className="log-box svc-log"
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
          >
            {log.length ? log.join('\n') : 'No log lines yet.'}
          </pre>
        )}

        {tab === 'connect' && (
          <div className="stack small">
            <div>
              <b>HTTP</b> <code className="code-inline">{s.url}/…</code> · <b>WebSocket</b> <code className="code-inline">{wsUrl}/…</code>
            </div>
            <div>
              <b>Web games and web apps served by this Studio</b> (Play / Preview tab) use the page's host:
              <pre className="log-box">{`const SERVER = \`\${location.protocol}//\${location.host}${s.path.replace(/\/$/, '')}\`;
const ws = new WebSocket(SERVER.replace(/^http/, 'ws') + '/ws');`}</pre>
            </div>
            <div>
              <b>Android / Windows apps</b>: put the address into one config constant. The Android emulator reaches this computer as{' '}
              <code className="code-inline">10.0.2.2</code>; real phones need the Studio reachable on your network (STUDIO_BIND=0.0.0.0) or online
              behind HTTPS (PUBLIC_URL). Android needs the INTERNET permission, and cleartext allowed for http://.
            </div>
            <div className="faint">
              Inside the Studio (Claude's tests): <code className="code-inline">{s.internalUrl}/</code>
            </div>
          </div>
        )}

        {tab === 'env' && (
          <div className="stack">
            <div className="hint" style={{ marginTop: 0 }}>
              Variables for the server process — API keys, settings. PORT, DATA_DIR, PUBLIC_URL and BASE_PATH are set by the Studio. Stored encrypted.
            </div>
            {env.map(([k, v], i) => (
              <div key={i} className="row" style={{ gap: 6 }}>
                <input
                  className="input mono"
                  style={{ maxWidth: 220 }}
                  placeholder="NAME"
                  value={k}
                  onChange={(e) => setEnv((rows) => rows.map((r, j) => (j === i ? [e.target.value.toUpperCase(), r[1]] : r)))}
                />
                <input
                  className="input mono"
                  placeholder="value"
                  type={showValues ? 'text' : 'password'}
                  autoComplete="new-password"
                  spellCheck={false}
                  value={v}
                  onChange={(e) => setEnv((rows) => rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))}
                />
                <button className="btn sm ghost icon" onClick={() => setEnv((rows) => rows.filter((_, j) => j !== i))} title="Remove">
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            <div className="row wrap" style={{ gap: 8 }}>
              <button className="btn sm ghost" onClick={() => setEnv((rows) => [...rows, ['', '']])}>
                <Plus size={14} /> Variable
              </button>
              {env.length > 0 && (
                <button className="btn sm ghost" onClick={() => setShowValues((v) => !v)}>
                  {showValues ? <EyeOff size={14} /> : <Eye size={14} />} {showValues ? 'Hide values' : 'Show values'}
                </button>
              )}
              <span className="spacer" />
              <button className="btn sm" disabled={!!busy} onClick={() => void saveEnv(false)}>
                Save
              </button>
              <button className="btn sm primary" disabled={!!busy || !running} onClick={() => void saveEnv(true)}>
                Save & restart
              </button>
            </div>
          </div>
        )}

        {tab === 'settings' && (
          <div className="stack" style={{ maxWidth: 560 }}>
            <div className="field">
              <label className="label">Name</label>
              <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="field">
              <label className="label">Address</label>
              <div className="row" style={{ gap: 6 }}>
                <span className="faint mono small">/srv/</span>
                <input className="input mono" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase() })} />
              </div>
              <div className="hint">Changing it changes the URL your apps use.</div>
            </div>
            <div className="field">
              <label className="label">Memory limit (MB, JavaScript heap)</label>
              <input className="input" type="number" min={64} max={16384} value={form.memoryMb} onChange={(e) => setForm({ ...form, memoryMb: Number(e.target.value) })} />
            </div>
            <div className="field">
              <label className="label">Start command (empty = package.json "start")</label>
              <input className="input mono" placeholder="node index.js" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} />
            </div>
            <label className="row" style={{ gap: 8 }}>
              <input type="checkbox" checked={form.cors} onChange={(e) => setForm({ ...form, cors: e.target.checked })} />
              Allow requests from any web page (CORS) when the server does not set its own headers
            </label>
            <div>
              <button className="btn sm primary" disabled={!!busy} onClick={() => void saveSettings()}>
                Save settings
              </button>
            </div>
          </div>
        )}

        {tab === 'releases' && (
          <div className="stack">
            <div className="hint" style={{ marginTop: 0 }}>
              Every deploy is a release; the last three are kept. Stored data (DATA_DIR) is shared by all releases.
            </div>
            {releases.map((n) => (
              <div key={n} className="row" style={{ gap: 8 }}>
                <span className="mono">#{n}</span>
                {n === s.release ? (
                  <span className="badge ok">current</span>
                ) : (
                  <button className="btn sm" disabled={!!busy} onClick={() => void act('rollback', () => api(`/services/${s.id}/rollback`, { body: { release: n } }))}>
                    <Undo2 size={14} /> Roll back to #{n}
                  </button>
                )}
              </div>
            ))}
            <div>
              <a className="btn sm" href={`/api/services/${s.id}/data.zip`}>
                <Download size={14} /> Download stored data (zip)
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** The project's "Server" tab: detected server folders, deployed servers, templates. */
export function ServicePanel({ project }: { project: Project }) {
  const ui = useUi();
  const [data, setData] = useState<{ services: Service[]; detected: DetectedServer[]; templates: string[]; enabled: boolean } | null>(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    setData(await api(`/projects/${project.id}/services`));
  }, [project.id]);

  useEffect(() => {
    void load().catch((err) => ui.toast(errMsg(err), 'error'));
    return socket.on((m) => {
      if ((m.t === 'services.changed' && (!m.projectId || m.projectId === project.id)) || (m.t === 'project.changed' && m.projectId === project.id)) {
        void load().catch(() => {});
      }
    });
  }, [load, project.id, ui]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      await load();
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    } finally {
      setBusy('');
    }
  };

  if (!data) {
    return (
      <div className="center" style={{ height: '100%' }}>
        <Spinner />
      </div>
    );
  }
  const undeployed = data.detected.filter((d) => !d.serviceId);
  const nothing = !data.services.length && !undeployed.length;

  return (
    <div className="svc-panel">
      <div className="svc-inner stack-lg">
        <div className="row wrap" style={{ gap: 10 }}>
          <div className="grow">
            <h2 style={{ margin: 0 }}>Servers</h2>
            <div className="muted small">
              Node.js backends for this project — multiplayer, cloud saves, leaderboards, accounts, APIs. Claude writes them in the chat; the Studio runs them and
              keeps them online.
            </div>
          </div>
          <button className="btn sm ghost" onClick={() => void load()} title="Refresh">
            <RefreshCw size={14} />
          </button>
        </div>

        {!data.enabled && <div className="notice warn">Servers are switched off on this Studio (SERVICES_ENABLED=false).</div>}

        {data.services.map((s) => (
          <ServiceCard key={s.id} service={s} onDeleted={() => void load()} />
        ))}

        {undeployed.map((d) => (
          <div key={d.root} className="card">
            <div className="card-body row wrap" style={{ gap: 10 }}>
              <Server size={18} color="var(--text-faint)" />
              <div className="grow">
                <b>{d.root}/</b> <span className="muted small">— {d.description || d.name}</span>
                <div className="faint small mono">
                  {d.start}
                  {d.dependencies.length ? ` · ${d.dependencies.join(', ')}` : ''}
                </div>
              </div>
              <button className="btn primary sm" disabled={!!busy} onClick={() => void run(d.root, () => api(`/projects/${project.id}/services`, { body: { root: d.root, deploy: true } }))}>
                {busy === d.root ? <Spinner size={14} /> : <Rocket size={14} />} Deploy
              </button>
            </div>
          </div>
        ))}

        {nothing && (
          <Empty icon={Server} title="No server yet">
            Ask Claude in the chat, e.g. <i>“Add online multiplayer with a Node.js server”</i> or <i>“Save the high scores online”</i> — it writes the server, deploys
            it and connects the app. Or start from a template:
          </Empty>
        )}

        <div className="card">
          <div className="card-body stack">
            <b className="small">{nothing ? 'Start from a template' : 'Add another server from a template'}</b>
            <div className="row wrap" style={{ gap: 8 }}>
              {data.templates.map((t) => (
                <button
                  key={t}
                  className="btn sm"
                  disabled={!!busy}
                  title={TEMPLATE_INFO[t]}
                  onClick={() =>
                    void run(`tpl-${t}`, async () => {
                      const folder = nothing ? 'server' : await ui.prompt('Folder for the new server', `${t}-server`, 'Folder in the project');
                      if (!folder) return;
                      const r = await api<{ root: string }>(`/projects/${project.id}/services/scaffold`, { body: { template: t, folder } });
                      ui.toast(`Created ${r.root}/ — open it in the files, then Deploy`);
                    })
                  }
                >
                  {busy === `tpl-${t}` ? <Spinner size={14} /> : <Plus size={14} />} {t} <span className="faint">· {TEMPLATE_INFO[t]}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
