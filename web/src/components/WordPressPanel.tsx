// The project's WordPress tab: set WordPress up, open the site and its admin area, manage the own
// plugins and themes (the project's code), installed plugins and themes, and the site's tools.
import {
  Blocks,
  Bug,
  Database,
  Download,
  ExternalLink,
  FileArchive,
  KeyRound,
  LogIn,
  Paintbrush,
  Plug,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Search,
  Trash2,
  Wrench,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, downloadUrl, errMsg, type Project, type WordPressStatus, type WpExtension, type WpModule, type WpModuleKind, type WpSearchResult } from '../api';
import { useStudio } from '../store';
import { cls, formatBytes } from '../util';
import { socket } from '../ws';
import { Modal, Spinner, useUi } from './ui';

const LOCALES: [string, string][] = [
  ['en_US', 'English (US)'],
  ['en_GB', 'English (UK)'],
  ['de_DE', 'Deutsch'],
  ['fr_FR', 'Français'],
  ['es_ES', 'Español'],
  ['it_IT', 'Italiano'],
  ['nl_NL', 'Nederlands'],
  ['pt_BR', 'Português (Brasil)'],
  ['pl_PL', 'Polski'],
  ['sv_SE', 'Svenska'],
  ['tr_TR', 'Türkçe'],
  ['ru_RU', 'Русский'],
  ['ja', '日本語'],
  ['zh_CN', '简体中文'],
];

type Tab = 'modules' | 'plugin' | 'theme' | 'tools';

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);

export function WordPressPanel({ project, onOpenFile }: { project: Project; onOpenFile?: (path: string) => void }) {
  const ui = useUi();
  const { user } = useStudio();
  const [data, setData] = useState<WordPressStatus | null>(null);
  const [ext, setExt] = useState<{ plugins: WpExtension[]; themes: WpExtension[] } | null>(null);
  const [extError, setExtError] = useState('');
  const [tab, setTab] = useState<Tab>('modules');
  const [busy, setBusy] = useState('');
  const [secret, setSecret] = useState<{ user: string; password: string } | null>(null);
  const [creating, setCreating] = useState<WpModuleKind | null>(null);
  const [form, setForm] = useState({ title: project.name, adminUser: user?.username ?? 'admin', adminEmail: user?.email ?? '', adminPassword: '', locale: 'en_US' });
  const [confirmRemove, setConfirmRemove] = useState(false);
  const jobRef = useRef<HTMLPreElement>(null);

  const wp = data?.wordpress ?? null;
  const ready = wp?.state === 'ready';

  const load = useCallback(async () => {
    setData(await api<WordPressStatus>(`/projects/${project.id}/wordpress`));
  }, [project.id]);

  const loadExt = useCallback(async () => {
    try {
      setExt(await api<{ plugins: WpExtension[]; themes: WpExtension[] }>(`/projects/${project.id}/wordpress/extensions`));
      setExtError('');
    } catch (err) {
      setExtError(errMsg(err));
    }
  }, [project.id]);

  useEffect(() => {
    void load().catch((err) => ui.toast(errMsg(err), 'error'));
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = socket.on((m) => {
      if ((m.t === 'wordpress.changed' || m.t === 'sites.changed') && m.projectId === project.id) {
        clearTimeout(t);
        t = setTimeout(() => void load().catch(() => {}), 250);
      }
    });
    return () => {
      off();
      clearTimeout(t);
    };
  }, [load, project.id, ui]);

  useEffect(() => {
    if (ready) void loadExt();
    else setExt(null);
  }, [ready, loadExt]);

  useEffect(() => {
    jobRef.current?.scrollTo({ top: jobRef.current.scrollHeight });
  }, [wp?.job.length]);

  const act = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    try {
      await fn();
      if (done) ui.toast(done);
      await load();
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    } finally {
      setBusy('');
    }
  };

  const install = () =>
    act('install', async () => {
      const r = await api<{ adminPassword: string | null; adminUser: string }>(`/projects/${project.id}/wordpress/install`, {
        body: { ...form, adminPassword: form.adminPassword || undefined },
      });
      if (r.adminPassword) setSecret({ user: r.adminUser, password: r.adminPassword });
    });

  const openAdmin = (to?: string) =>
    act('login', async () => {
      // opened first (a click may open a window; a later answer may not)
      const win = window.open('about:blank', '_blank');
      try {
        const r = await api<{ url: string }>(`/projects/${project.id}/wordpress/login`, { body: to ? { to } : {} });
        if (win) win.location.href = r.url;
        else window.location.href = r.url;
      } catch (err) {
        win?.close();
        throw err;
      }
    });

  const extAction = (e: { kind: WpModuleKind; slug: string }, action: 'activate' | 'deactivate' | 'delete' | 'update' | 'install', activate = false) =>
    act(`${action}:${e.kind}:${e.slug}`, async () => {
      await api(`/projects/${project.id}/wordpress/extensions`, { body: { kind: e.kind, slug: e.slug, action, activate } });
      await loadExt();
    });

  const exportModule = (m: WpModule) =>
    act(`export:${m.slug}`, async () => {
      const r = await api<{ path: string; size: number }>(`/projects/${project.id}/wordpress/modules/export`, { body: { kind: m.kind, slug: m.slug } });
      ui.toast(
        <>
          {r.path} ({formatBytes(r.size)}) —{' '}
          <a href={downloadUrl(project.id, r.path)} download>
            download
          </a>
        </>,
      );
    });

  const removeModule = async (m: WpModule) => {
    const ok = await ui.confirm({
      title: `Delete the ${m.kind} “${m.name}”?`,
      body: `The folder ${m.kind}s/${m.slug}/ is removed from the project. The History tab can bring it back.`,
      confirm: 'Delete',
      danger: true,
    });
    if (ok) await act(`rm:${m.slug}`, () => api(`/projects/${project.id}/wordpress/modules/${m.kind}/${m.slug}`, { method: 'DELETE' }).then(() => loadExt()));
  };

  const statusOf = useMemo(() => {
    const map = new Map<string, WpExtension>();
    for (const e of [...(ext?.plugins ?? []), ...(ext?.themes ?? [])]) map.set(`${e.kind}:${e.slug}`, e);
    return (m: { kind: WpModuleKind; slug: string }) => map.get(`${m.kind}:${m.slug}`);
  }, [ext]);

  if (!data) {
    return (
      <div className="center" style={{ height: '100%' }}>
        <Spinner />
      </div>
    );
  }

  const site = data.site;
  const remote = !['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname) && !window.location.hostname.endsWith('.localhost');
  const onlyLocal = !!site && !site.addresses.custom.length && !site.addresses.base;

  return (
    <div className="svc-panel">
      <div className="svc-inner stack-lg">
        <div className="row wrap" style={{ gap: 10 }}>
          <div className="grow">
            <h2 style={{ margin: 0 }}>WordPress</h2>
            <div className="muted small">
              A real WordPress site that belongs to this project. Your own plugins and themes live in <code className="code-inline">plugins/</code> and{' '}
              <code className="code-inline">themes/</code> — the AI writes them, WordPress runs them at once, and you export them as installable zips.
            </div>
          </div>
          <button className="btn sm ghost" onClick={() => void load().then(() => (ready ? loadExt() : undefined))} title="Refresh">
            <RefreshCw size={14} />
          </button>
        </div>

        {!data.available && <div className="notice warn">{data.reason}</div>}

        {secret && (
          <div className="notice info">
            <b>Admin account of the site:</b> user <code className="code-inline">{secret.user}</code>, password <code className="code-inline">{secret.password}</code>
            <div className="small" style={{ marginTop: 4 }}>
              Shown once — the Studio does not keep it. You rarely need it: “Open admin” signs you in.{' '}
              <a
                href="#copy"
                onClick={(e) => {
                  e.preventDefault();
                  void navigator.clipboard?.writeText(secret.password).then(() => ui.toast('Password copied'));
                }}
              >
                Copy
              </a>{' '}
              ·{' '}
              <a href="#hide" onClick={(e) => (e.preventDefault(), setSecret(null))}>
                Hide
              </a>
            </div>
          </div>
        )}

        {/* ---- not installed --------------------------------------------------------------- */}
        {data.available && (!wp || wp.state === 'new' || wp.state === 'error') && (
          <div className="card">
            <div className="card-head">
              <Blocks size={18} color="var(--accent)" />
              <h2 className="grow">Set up WordPress</h2>
            </div>
            <div className="card-body stack">
              {wp?.state === 'error' && <div className="notice error">The last installation did not finish: {wp.error} — press “Install” to continue where it stopped.</div>}
              <ol className="wp-steps">
                <li>The current WordPress is downloaded from wordpress.org into the project’s wordpress/ folder.</li>
                <li>The site gets its own database and its own address, and is switched on.</li>
                <li>Plugins and themes in the project (plugins/, themes/) are linked in — ready to activate.</li>
              </ol>
              <div className="row wrap" style={{ gap: 12, alignItems: 'flex-start' }}>
                <div className="field grow" style={{ marginTop: 0, minWidth: 220 }}>
                  <label className="label">Site title</label>
                  <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={120} />
                </div>
                <div className="field" style={{ marginTop: 0, width: 200 }}>
                  <label className="label">Language</label>
                  <select className="select" value={form.locale} onChange={(e) => setForm({ ...form, locale: e.target.value })}>
                    {LOCALES.map(([id, label]) => (
                      <option key={id} value={id}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="row wrap" style={{ gap: 12, alignItems: 'flex-start' }}>
                <div className="field grow" style={{ marginTop: 0, minWidth: 160 }}>
                  <label className="label">Admin user name</label>
                  <input className="input" value={form.adminUser} onChange={(e) => setForm({ ...form, adminUser: e.target.value })} autoComplete="off" />
                </div>
                <div className="field grow" style={{ marginTop: 0, minWidth: 200 }}>
                  <label className="label">Admin e-mail</label>
                  <input className="input" type="email" value={form.adminEmail} onChange={(e) => setForm({ ...form, adminEmail: e.target.value })} autoComplete="off" />
                </div>
                <div className="field grow" style={{ marginTop: 0, minWidth: 200 }}>
                  <label className="label">Admin password</label>
                  <input
                    className="input"
                    type="password"
                    value={form.adminPassword}
                    onChange={(e) => setForm({ ...form, adminPassword: e.target.value })}
                    placeholder="leave empty: one is made for you"
                    autoComplete="new-password"
                  />
                </div>
              </div>
              <div>
                <button className="btn primary" disabled={!!busy || !form.title.trim()} onClick={() => void install()}>
                  {busy === 'install' ? <Spinner size={14} /> : <Download size={15} />} Install WordPress
                </button>
              </div>
              {!!wp?.job.length && (
                <pre className="log-box svc-log" style={{ maxHeight: 180 }}>
                  {wp.job.join('\n')}
                </pre>
              )}
            </div>
          </div>
        )}

        {/* ---- installing ------------------------------------------------------------------- */}
        {wp?.state === 'installing' && (
          <div className="card">
            <div className="card-head">
              <Spinner size={16} />
              <h2 className="grow">Installing WordPress …</h2>
            </div>
            <div className="card-body">
              <pre ref={jobRef} className="log-box svc-log" style={{ maxHeight: 260 }}>
                {wp.job.join('\n') || 'Starting …'}
              </pre>
              <div className="hint">Takes a minute or two (download, database, set-up). You can leave this tab — it continues.</div>
            </div>
          </div>
        )}

        {/* ---- the site ---------------------------------------------------------------------- */}
        {ready && wp && (
          <div className="card svc-card">
            <div className="card-head" style={{ flexWrap: 'wrap', gap: 10 }}>
              <Blocks size={18} color="var(--accent)" />
              <h2 className="grow" style={{ minWidth: 160 }}>
                {wp.title || project.name}
              </h2>
              <span className={cls('badge', wp.desired === 'running' ? 'ok' : 'danger')}>{wp.desired === 'running' ? 'online' : 'switched off'}</span>
              {wp.version && <span className="badge">WordPress {wp.version}</span>}
              <span className="badge" title={wp.php === 'running' ? 'PHP is running' : 'PHP starts with the next visitor and stops when nobody visits'}>
                PHP {wp.phpVersion}
                {wp.php === 'running' ? '' : wp.php === 'crashed' ? ' · stopped' : ' · idle'}
              </span>
              {wp.debug && <span className="badge warn">debug</span>}
            </div>
            <div className="card-body stack">
              {site && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {[...site.addresses.custom, ...(site.addresses.base ? [site.addresses.base] : [])].map((u) => (
                    <div key={u}>
                      <a href={u} target="_blank" rel="noreferrer" className="mono small">
                        {u} <ExternalLink size={12} />
                      </a>
                    </div>
                  ))}
                  <div className="small">
                    <a href={site.addresses.local} target="_blank" rel="noreferrer" className="mono">
                      {site.addresses.local} <ExternalLink size={12} />
                    </a>{' '}
                    <span className="faint">— on the computer that runs the Studio</span>
                  </div>
                </div>
              )}
              {remote && onlyLocal && (
                <div className="notice warn">
                  This site has no address you can reach from here yet. Add a domain in the <b>Website</b> tab
                  {data.baseDomain ? '' : ' — or the admin sets SITES_BASE_DOMAIN, then every site gets <name>.<that domain> by itself'}.
                </div>
              )}
              {wp.message && <div className="notice error">{wp.message}</div>}
              <div className="row wrap" style={{ gap: 8 }}>
                {site && wp.desired === 'running' && (
                  <a className="btn primary sm" href={site.addresses.primary} target="_blank" rel="noreferrer">
                    <ExternalLink size={14} /> Open site
                  </a>
                )}
                {wp.desired === 'running' && (
                  <button className="btn sm" disabled={!!busy} onClick={() => void openAdmin()} title={`Opens the admin area, signed in as ${wp.adminUser || 'the admin'}`}>
                    {busy === 'login' ? <Spinner size={14} /> : <LogIn size={14} />} Open admin
                  </button>
                )}
                <button
                  className="btn sm"
                  disabled={!!busy}
                  onClick={() =>
                    void act(
                      'power',
                      () => api(`/projects/${project.id}/wordpress/${wp.desired === 'running' ? 'stop' : 'start'}`, { body: {} }),
                      wp.desired === 'running' ? 'The site is switched off' : 'The site is online',
                    )
                  }
                >
                  {busy === 'power' ? <Spinner size={14} /> : <Power size={14} />} {wp.desired === 'running' ? 'Switch off' : 'Switch on'}
                </button>
                {wp.desired === 'running' && (
                  <button className="btn sm" disabled={!!busy} onClick={() => void act('restart', () => api(`/projects/${project.id}/wordpress/restart`, { body: {} }), 'PHP restarted')}>
                    {busy === 'restart' ? <Spinner size={14} /> : <RotateCcw size={14} />} Restart PHP
                  </button>
                )}
              </div>

              <div className="tabs">
                {(
                  [
                    ['modules', `My plugins & themes (${data.modules.length})`, <Blocks size={14} key="i" />],
                    ['plugin', `Plugins${ext ? ` (${ext.plugins.length})` : ''}`, <Plug size={14} key="i" />],
                    ['theme', `Themes${ext ? ` (${ext.themes.length})` : ''}`, <Paintbrush size={14} key="i" />],
                    ['tools', 'Tools', <Wrench size={14} key="i" />],
                  ] as const
                ).map(([k, label, icon]) => (
                  <button key={k} className={cls('tab', tab === k && 'active')} onClick={() => setTab(k)}>
                    {icon}
                    {label}
                  </button>
                ))}
              </div>

              {tab === 'modules' && (
                <ModuleList
                  modules={data.modules}
                  statusOf={statusOf}
                  busy={busy}
                  onNew={setCreating}
                  onOpenFile={onOpenFile}
                  onExport={exportModule}
                  onDelete={removeModule}
                  onActivate={(m, on) => void extAction(m, on ? 'activate' : 'deactivate')}
                  ready
                />
              )}
              {(tab === 'plugin' || tab === 'theme') && (
                <Extensions
                  kind={tab}
                  list={ext ? (tab === 'plugin' ? ext.plugins : ext.themes) : null}
                  error={extError}
                  busy={busy}
                  projectId={project.id}
                  onAction={extAction}
                  onAdmin={() => void openAdmin(tab === 'plugin' ? '/wp-admin/plugins.php' : '/wp-admin/themes.php')}
                />
              )}
              {tab === 'tools' && (
                <Tools project={project} data={data} busy={busy} act={act} onSecret={setSecret} onRemove={() => setConfirmRemove(true)} />
              )}
            </div>
          </div>
        )}

        {/* own modules can be written before WordPress is installed */}
        {data.available && !ready && (data.modules.length > 0 || wp?.state !== 'installing') && (
          <div className="card">
            <div className="card-head">
              <Blocks size={18} color="var(--text-dim)" />
              <h2 className="grow">My plugins & themes</h2>
            </div>
            <div className="card-body">
              <ModuleList modules={data.modules} statusOf={() => undefined} busy={busy} onNew={setCreating} onOpenFile={onOpenFile} onExport={exportModule} onDelete={removeModule} onActivate={() => {}} ready={false} />
            </div>
          </div>
        )}
      </div>

      {creating && (
        <NewModuleModal
          kind={creating}
          templates={data.templates[creating]}
          projectId={project.id}
          canActivate={ready}
          onClose={() => setCreating(null)}
          onDone={(m) => {
            setCreating(null);
            ui.toast(`${m.kind === 'plugin' ? 'Plugin' : 'Theme'} “${m.name}” created in ${m.kind}s/${m.slug}/`);
            void load().then(() => (ready ? loadExt() : undefined));
            onOpenFile?.(m.file);
          }}
        />
      )}
      {confirmRemove && wp && (
        <RemoveModal
          title={wp.title || project.name}
          onClose={() => setConfirmRemove(false)}
          onConfirm={() => {
            setConfirmRemove(false);
            void act('remove', () => api(`/projects/${project.id}/wordpress`, { method: 'DELETE' }), 'WordPress was removed — your plugins and themes are still in the project');
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
function ModuleList({
  modules,
  statusOf,
  busy,
  ready,
  onNew,
  onOpenFile,
  onExport,
  onDelete,
  onActivate,
}: {
  modules: WpModule[];
  statusOf: (m: WpModule) => WpExtension | undefined;
  busy: string;
  ready: boolean;
  onNew: (kind: WpModuleKind) => void;
  onOpenFile?: (path: string) => void;
  onExport: (m: WpModule) => void;
  onDelete: (m: WpModule) => void;
  onActivate: (m: WpModule, on: boolean) => void;
}) {
  return (
    <div className="stack">
      <div className="row wrap" style={{ gap: 8 }}>
        <button className="btn sm" onClick={() => onNew('plugin')}>
          <Plus size={14} /> New plugin
        </button>
        <button className="btn sm" onClick={() => onNew('theme')}>
          <Plus size={14} /> New theme
        </button>
        <span className="faint small">…or tell the AI in the chat what the plugin or theme should do.</span>
      </div>
      {!modules.length && <div className="faint small">Nothing yet. A starter gives you a working plugin, block or theme to build on.</div>}
      <div className="wp-grid">
        {modules.map((m) => {
          const st = statusOf(m);
          const active = st?.status === 'active' || st?.status === 'active-network';
          return (
            <div key={`${m.kind}:${m.slug}`} className="wp-item">
              {m.kind === 'plugin' ? <Plug size={18} color="var(--accent)" style={{ flex: 'none', marginTop: 2 }} /> : <Paintbrush size={18} color="var(--accent-2)" style={{ flex: 'none', marginTop: 2 }} />}
              <div className="grow">
                <div className="row" style={{ gap: 6 }}>
                  <b className="ellipsis">{m.name}</b>
                  {m.version && <span className="badge">v{m.version}</span>}
                  {ready && active && <span className="badge ok">active</span>}
                  {ready && !m.linked && (
                    <span className="badge warn" title="WordPress already has a folder with this name — rename the folder in the project">
                      not linked
                    </span>
                  )}
                </div>
                <div className="faint small ellipsis mono">
                  {m.kind}s/{m.slug}/
                </div>
                {m.description && <div className="muted small" style={{ marginTop: 4 }}>{m.description}</div>}
                <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
                  {ready && m.linked && (m.kind === 'plugin' || !active) && (
                    <button className="btn sm" disabled={!!busy} onClick={() => onActivate(m, !active)}>
                      {busy.endsWith(`:${m.kind}:${m.slug}`) ? <Spinner size={13} /> : <Power size={13} />} {active ? 'Deactivate' : 'Activate'}
                    </button>
                  )}
                  {onOpenFile && (
                    <button className="btn sm" onClick={() => onOpenFile(m.file)} title={m.file}>
                      Open code
                    </button>
                  )}
                  <button className="btn sm" disabled={!!busy} onClick={() => onExport(m)} title="An installable zip in exports/ — for any WordPress">
                    {busy === `export:${m.slug}` ? <Spinner size={13} /> : <FileArchive size={13} />} Export zip
                  </button>
                  <button className="btn sm ghost icon" disabled={!!busy} onClick={() => onDelete(m)} title="Delete">
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Extensions({
  kind,
  list,
  error,
  busy,
  projectId,
  onAction,
  onAdmin,
}: {
  kind: WpModuleKind;
  list: WpExtension[] | null;
  error: string;
  busy: string;
  projectId: number;
  onAction: (e: { kind: WpModuleKind; slug: string }, action: 'activate' | 'deactivate' | 'delete' | 'update' | 'install', activate?: boolean) => void;
  onAdmin: () => void;
}) {
  const ui = useUi();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<WpSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const word = kind === 'plugin' ? 'plugin' : 'theme';

  const search = async () => {
    if (q.trim().length < 2) return;
    setSearching(true);
    try {
      setResults((await api<{ results: WpSearchResult[] }>(`/projects/${projectId}/wordpress/search?kind=${kind}&q=${encodeURIComponent(q.trim())}`)).results);
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    } finally {
      setSearching(false);
    }
  };

  const installed = new Set((list ?? []).map((e) => e.slug));
  return (
    <div className="stack">
      {error && <div className="notice error">{error}</div>}
      {!list && !error && <Spinner />}
      {list?.map((e) => {
        const active = e.status === 'active' || e.status === 'active-network';
        const key = `:${e.kind}:${e.slug}`;
        return (
          <div key={e.slug} className="row wrap" style={{ gap: 8 }}>
            <div className="grow" style={{ minWidth: 200 }}>
              <div className="row" style={{ gap: 6 }}>
                <b className="ellipsis">{e.name}</b>
                {e.version && <span className="faint small">v{e.version}</span>}
                {active && <span className="badge ok">active</span>}
                {e.own && <span className="badge accent">yours</span>}
                {e.update && <span className="badge warn">update {e.update}</span>}
              </div>
              {e.description && <div className="faint small ellipsis">{e.description}</div>}
            </div>
            {busy.endsWith(key) && <Spinner size={14} />}
            {e.update && !e.own && (
              <button className="btn sm" disabled={!!busy} onClick={() => onAction(e, 'update')}>
                Update
              </button>
            )}
            {(kind === 'plugin' || !active) && (
              <button className="btn sm" disabled={!!busy} onClick={() => onAction(e, active ? 'deactivate' : 'activate')}>
                {active ? 'Deactivate' : 'Activate'}
              </button>
            )}
            {!e.own && !active && (
              <button className="btn sm ghost icon" disabled={!!busy} onClick={() => onAction(e, 'delete')} title="Remove from the site">
                <Trash2 size={14} />
              </button>
            )}
          </div>
        );
      })}
      <hr style={{ margin: '4px 0' }} />
      <form
        className="row wrap"
        style={{ gap: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <div className="psearch" style={{ width: 320 }}>
          <Search size={15} />
          <input className="input" placeholder={`Find a ${word} on wordpress.org`} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <button className="btn sm" disabled={searching || q.trim().length < 2}>
          {searching ? <Spinner size={14} /> : <Search size={14} />} Search
        </button>
        <span className="spacer" />
        <button type="button" className="btn sm ghost" onClick={onAdmin}>
          <ExternalLink size={14} /> Manage in WordPress
        </button>
      </form>
      {results && !results.length && <div className="faint small">Nothing found.</div>}
      {results?.map((r) => (
        <div key={r.slug} className="row wrap" style={{ gap: 8 }}>
          <div className="grow" style={{ minWidth: 200 }}>
            <div className="row" style={{ gap: 6 }}>
              <b className="ellipsis">{r.name}</b>
              <span className="faint small">v{r.version}</span>
              {r.rating > 0 && <span className="faint small">★ {(r.rating / 20).toFixed(1)}</span>}
              {r.installs > 0 && <span className="faint small">{r.installs >= 1_000_000 ? `${Math.floor(r.installs / 1_000_000)}M+` : r.installs >= 1000 ? `${Math.floor(r.installs / 1000)}k+` : r.installs} sites</span>}
            </div>
            {r.description && <div className="faint small">{r.description}</div>}
          </div>
          {installed.has(r.slug) ? (
            <span className="badge">installed</span>
          ) : (
            <button className="btn sm" disabled={!!busy} onClick={() => onAction(r, 'install', kind === 'plugin')}>
              {busy === `install:${r.kind}:${r.slug}` ? <Spinner size={13} /> : <Download size={13} />} Install{kind === 'plugin' ? ' & activate' : ''}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function Tools({
  project,
  data,
  busy,
  act,
  onSecret,
  onRemove,
}: {
  project: Project;
  data: WordPressStatus;
  busy: string;
  act: (key: string, fn: () => Promise<unknown>, done?: string) => Promise<void>;
  onSecret: (s: { user: string; password: string }) => void;
  onRemove: () => void;
}) {
  const ui = useUi();
  const wp = data.wordpress!;
  const [log, setLog] = useState<{ php: string; fpm: string[] } | null>(null);
  const [update, setUpdate] = useState<string | null | undefined>(undefined);
  const base = `/projects/${project.id}/wordpress`;

  const loadLog = useCallback(async () => {
    setLog(await api<{ php: string; fpm: string[] }>(`${base}/log`).catch(() => ({ php: '', fpm: [] })));
  }, [base]);
  useEffect(() => {
    void loadLog();
    api<{ core: string | null }>(`${base}/updates`)
      .then((r) => setUpdate(r.core))
      .catch(() => setUpdate(null));
  }, [loadLog, base]);

  return (
    <div className="stack-lg">
      <div className="stack">
        <div className="row wrap" style={{ gap: 8 }}>
          <ScrollText size={15} />
          <b>PHP error log</b>
          <span className="spacer" />
          <label className="row small" style={{ gap: 6 }} title="WP_DEBUG: also log notices and warnings — for development, not for a public site">
            <input
              type="checkbox"
              checked={wp.debug}
              disabled={!!busy}
              onChange={(e) => void act('debug', () => api(`${base}/debug`, { body: { enabled: e.target.checked } }), e.target.checked ? 'Debug mode is on' : 'Debug mode is off')}
            />
            <Bug size={13} /> Debug mode (notices and warnings)
          </label>
          <button className="btn sm" onClick={() => void loadLog()}>
            <RefreshCw size={13} /> Refresh
          </button>
          <button className="btn sm ghost" onClick={() => void api(`${base}/log`, { method: 'DELETE' }).then(loadLog)}>
            Clear
          </button>
        </div>
        <pre className="log-box svc-log" style={{ maxHeight: 240 }}>
          {log ? [...log.fpm, log.php].filter((s) => s.trim()).join('\n') || 'No errors.' : '…'}
        </pre>
      </div>

      <div className="wp-grid">
        <div className="wp-item">
          <RefreshCw size={18} style={{ flex: 'none', marginTop: 2 }} />
          <div className="grow">
            <b>WordPress {wp.version}</b>
            <div className="muted small">{update === undefined ? 'Checking for updates …' : update ? `Version ${update} is available.` : 'Up to date. Security updates install themselves.'}</div>
            {update && (
              <button className="btn sm" style={{ marginTop: 8 }} disabled={!!busy} onClick={() => void act('update', () => api(`${base}/update`, { body: {} }).then(() => setUpdate(null)), 'WordPress updated')}>
                {busy === 'update' ? <Spinner size={13} /> : <Download size={13} />} Update to {update}
              </button>
            )}
          </div>
        </div>
        <div className="wp-item">
          <Database size={18} style={{ flex: 'none', marginTop: 2 }} />
          <div className="grow">
            <b>Database</b>
            <div className="muted small">The site has its own database. Export it as a .sql file into exports/ (posts, pages, settings, users).</div>
            <button
              className="btn sm"
              style={{ marginTop: 8 }}
              disabled={!!busy}
              onClick={() =>
                void act('db', async () => {
                  const r = await api<{ path: string; size: number }>(`${base}/db-export`, { body: {} });
                  ui.toast(
                    <>
                      {r.path} ({formatBytes(r.size)}) —{' '}
                      <a href={downloadUrl(project.id, r.path)} download>
                        download
                      </a>
                    </>,
                  );
                })
              }
            >
              {busy === 'db' ? <Spinner size={13} /> : <Download size={13} />} Export database
            </button>
          </div>
        </div>
        <div className="wp-item">
          <KeyRound size={18} style={{ flex: 'none', marginTop: 2 }} />
          <div className="grow">
            <b>Admin password</b>
            <div className="muted small">
              “Open admin” signs you in without it. For signing in on the site itself: set a new password for <span className="mono">{wp.adminUser || 'the admin'}</span>.
            </div>
            <button
              className="btn sm"
              style={{ marginTop: 8 }}
              disabled={!!busy}
              onClick={() =>
                void act('pw', async () => {
                  const r = await api<{ user: string; password: string | null }>(`${base}/password`, { body: {} });
                  if (r.password) onSecret({ user: r.user, password: r.password });
                })
              }
            >
              {busy === 'pw' ? <Spinner size={13} /> : <KeyRound size={13} />} New password
            </button>
          </div>
        </div>
        <div className="wp-item">
          <Wrench size={18} style={{ flex: 'none', marginTop: 2 }} />
          <div className="grow">
            <b>Hosting</b>
            <div className="muted small">
              Uploads up to {data.limits.uploadMb} MB · PHP memory {data.limits.memoryMb} MB ·{' '}
              {data.limits.hardened ? 'the site’s PHP can only reach this project and has no shell functions' : 'PHP is not confined (WORDPRESS_PHP_HARDENING=false)'}. E-mail needs an SMTP
              plugin. Domains and HTTPS: the Website tab.
            </div>
          </div>
        </div>
      </div>

      <div className="row wrap" style={{ gap: 8 }}>
        <span className="faint small grow">Removing WordPress deletes the site, its database, uploads and installed plugins. Your own plugins and themes stay in the project.</span>
        <button className="btn sm danger" disabled={!!busy} onClick={onRemove}>
          {busy === 'remove' ? <Spinner size={13} /> : <Trash2 size={13} />} Remove WordPress
        </button>
      </div>
    </div>
  );
}

function NewModuleModal({
  kind,
  templates,
  projectId,
  canActivate,
  onClose,
  onDone,
}: {
  kind: WpModuleKind;
  templates: { id: string; name: string; description: string }[];
  projectId: number;
  canActivate: boolean;
  onClose: () => void;
  onDone: (m: WpModule) => void;
}) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [template, setTemplate] = useState(templates[0]?.id ?? '');
  const [activate, setActivate] = useState(canActivate && kind === 'plugin');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const effSlug = slugTouched ? slug : slugify(name);

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ module: WpModule }>(`/projects/${projectId}/wordpress/modules`, {
        body: { kind, slug: effSlug, name: name.trim() || undefined, description: description.trim() || undefined, template, activate: activate && canActivate },
      });
      onDone(r.module);
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={kind === 'plugin' ? 'New plugin' : 'New theme'}
      icon={kind === 'plugin' ? <Plug size={18} /> : <Paintbrush size={18} />}
      size="medium"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={create} disabled={busy || effSlug.length < 2}>
            {busy ? <Spinner size={14} /> : <Plus size={15} />} Create
          </button>
        </>
      }
    >
      {error && <div className="form-error" style={{ marginBottom: 14 }}>{error}</div>}
      <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
        <div className="field grow" style={{ marginTop: 0 }}>
          <label className="label">Name</label>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'plugin' ? 'Event Calendar' : 'Bakery'} maxLength={100} />
        </div>
        <div className="field grow" style={{ marginTop: 0 }}>
          <label className="label">Folder name</label>
          <input
            className="input mono"
            value={effSlug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'));
            }}
            placeholder="event-calendar"
          />
          <div className="hint">
            {kind}s/{effSlug || '…'}/ — also the prefix of its functions.
          </div>
        </div>
      </div>
      <div className="field">
        <label className="label">What does it do? (optional)</label>
        <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={400} />
      </div>
      <div className="field">
        <label className="label">Start from</label>
        <div className="col" style={{ gap: 6 }}>
          {templates.map((t) => (
            <label key={t.id} className="row" style={{ alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
              <input type="radio" name="tpl" checked={template === t.id} onChange={() => setTemplate(t.id)} style={{ marginTop: 4 }} />
              <span>
                <b>{t.name}</b>
                <span className="muted small" style={{ display: 'block' }}>
                  {t.description}
                </span>
              </span>
            </label>
          ))}
        </div>
      </div>
      {canActivate && kind === 'plugin' && (
        <label className="row" style={{ gap: 8, marginTop: 14 }}>
          <input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} /> Activate it on the site right away
        </label>
      )}
      <div className="hint">You get working code to build on — then tell the AI in the chat what it should do.</div>
    </Modal>
  );
}

function RemoveModal({ title, onClose, onConfirm }: { title: string; onClose: () => void; onConfirm: () => void }) {
  const [text, setText] = useState('');
  return (
    <Modal
      title="Remove WordPress?"
      icon={<Trash2 size={18} />}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn danger" disabled={text.trim().toLowerCase() !== 'remove'} onClick={onConfirm}>
            Remove WordPress
          </button>
        </>
      }
    >
      <div className="muted">
        The site “{title}” is deleted with its database (posts, pages, users, settings), its uploads and the plugins and themes installed in it. Its address and
        domains are released. <b>This cannot be undone</b> — export the database first if you might need it.
        <br />
        <br />
        Your own plugins and themes (plugins/, themes/) stay in the project.
      </div>
      <div className="field">
        <label className="label">Type “remove” to confirm</label>
        <input className="input" autoFocus value={text} onChange={(e) => setText(e.target.value)} />
      </div>
    </Modal>
  );
}
