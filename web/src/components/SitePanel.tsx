import {
  CheckCircle2,
  ExternalLink,
  Globe,
  Lock,
  Plus,
  Power,
  RefreshCw,
  Rocket,
  ScrollText,
  Settings2,
  Trash2,
  Undo2,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errMsg, type Hosting, type Project, type Site } from '../api';
import { cls } from '../util';
import { socket } from '../ws';
import { TlsBadge, TlsControls } from './Https';
import { Spinner, useUi } from './ui';

interface SiteData {
  site: Site | null;
  log: string[];
  releases: number[];
  suggestedRoot: string;
  servers: { id: number; name: string; slug: string; state: string }[];
  suggested: boolean;
  hosting: Hosting;
}

type Check = { ok: boolean; addresses: string[]; message: string } | 'busy';

/** live / offline / not published … as a coloured badge */
export function SiteBadge({ site }: { site: Site }) {
  const label = { live: 'live', offline: 'offline', unpublished: 'not published', publishing: 'publishing' }[site.status];
  const tone = site.status === 'live' ? 'ok' : site.status === 'publishing' ? 'warn' : site.status === 'offline' ? 'danger' : '';
  return <span className={cls('badge', tone)}>{label}</span>;
}

export function fmtBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

const folderLabel = (root: string) => (root === '.' ? 'the project folder' : `${root}/`);

/** The project's "Website" tab: publish as a website, addresses and domains, settings, releases. */
export function SitePanel({ project }: { project: Project }) {
  const ui = useUi();
  const [data, setData] = useState<SiteData | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [tab, setTab] = useState<'domains' | 'log' | 'settings' | 'releases'>('domains');
  const [busy, setBusy] = useState('');
  const [domain, setDomain] = useState('');
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const [openTls, setOpenTls] = useState('');
  const [form, setForm] = useState({ slug: '', root: '', build: '', spa: false, mode: 'static' as 'static' | 'server' | 'wordpress', serviceId: 0 });
  const logRef = useRef<HTMLPreElement>(null);
  const site = data?.site ?? null;

  const load = useCallback(async () => {
    const d = await api<SiteData>(`/projects/${project.id}/site`);
    setData(d);
    setLog(d.log);
    if (d.site) {
      const s = d.site.settings;
      setForm({ slug: d.site.slug, root: s.root, build: s.build, spa: s.spa, mode: s.mode, serviceId: s.serviceId ?? 0 });
    }
  }, [project.id]);

  useEffect(() => {
    void load().catch((err) => ui.toast(errMsg(err), 'error'));
    return socket.on((m) => {
      if (m.t === 'sites.changed' && m.projectId === project.id) void load().catch(() => {});
    });
  }, [load, project.id, ui]);

  const siteId = site?.id;
  useEffect(() => {
    if (!siteId) return;
    const unsub = socket.subscribe(`site:${siteId}`);
    const off = socket.on((m) => {
      if (m.t === 'site.log' && m.id === siteId) setLog((l) => [...l.slice(-800), m.line]);
      if (m.t === 'site.status' && m.site?.id === siteId) setData((d) => (d ? { ...d, site: m.site } : d));
      if (m.t === 'ws.open') void load().catch(() => {});
    });
    return () => {
      unsub();
      off();
    };
  }, [siteId, load]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log, tab]);

  const act = async (key: string, fn: () => Promise<unknown>, reload = true) => {
    setBusy(key);
    try {
      await fn();
      if (reload) await load();
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    } finally {
      setBusy('');
    }
  };

  const publish = (body: Record<string, unknown> = {}) =>
    act('publish', async () => {
      setTab('log');
      const r = await api<{ site: Site; done: boolean }>(`/projects/${project.id}/site/publish`, { body });
      ui.toast(r.done ? `Published — release #${r.site.release} is live` : 'Publishing … (see the log)');
    });

  const patch = (key: string, body: Record<string, unknown>, done?: string) =>
    act(key, async () => {
      await api(`/sites/${site!.id}`, { method: 'PATCH', body });
      if (done) ui.toast(done);
    });

  const addDomain = () =>
    act('domain', async () => {
      const r = await api<{ domain: string }>(`/sites/${site!.id}/domains`, { body: { domain } });
      setDomain('');
      ui.toast(`${r.domain} added — point its DNS to this server, then Check`);
    });

  const check = async (d: string) => {
    setChecks((c) => ({ ...c, [d]: 'busy' }));
    try {
      const r = await api<Exclude<Check, 'busy'>>(`/sites/${site!.id}/domains/${encodeURIComponent(d)}/check`, { body: {} });
      setChecks((c) => ({ ...c, [d]: r }));
    } catch (err) {
      setChecks((c) => ({ ...c, [d]: { ok: false, addresses: [], message: errMsg(err) } }));
    }
  };

  const remove = () =>
    act('delete', async () => {
      const ok = await ui.confirm({
        title: `Delete the website "${site!.slug}"?`,
        body: 'It goes offline at once; its releases and domain settings are deleted. The project files stay.',
        confirm: 'Delete website',
        danger: true,
      });
      if (!ok) return;
      await api(`/sites/${site!.id}`, { method: 'DELETE' });
    });

  if (!data) {
    return (
      <div className="center" style={{ height: '100%' }}>
        <Spinner />
      </div>
    );
  }
  const h = data.hosting;
  // a WordPress project: the website is WordPress itself — always live, nothing to publish
  const isWp = site ? site.settings.mode === 'wordpress' : project.area === 'wordpress';
  const builtinTls = h.tls.enabled && !h.https;
  // every public host of the website: its own domains, then <name>.<base domain>
  const hosts = site ? [...site.domains, ...(site.baseHost && !site.domains.includes(site.baseHost) ? [site.baseHost] : [])] : [];
  const urlOf = (host: string) =>
    [...(site?.addresses.custom ?? []), site?.addresses.base ?? ''].find((u) => u.split('/')[2]?.split(':')[0] === host) ?? `http://${host}/`;
  const portsHint = h.https
    ? ' Ports 80 and 443 are answered by the HTTPS proxy in front of this Studio.'
    : builtinTls
      ? h.port === 80 && h.tls.port === 443
        ? ''
        : ` The website ports must be reachable from the internet as port 80 (HTTP — automatic certificates need it) and 443 (HTTPS): they are ${h.port} and ${h.tls.port} now (on a web server: SITES_PORT=80, SITES_HTTPS_PORT=443, SITES_BIND=0.0.0.0).`
      : h.port === 80
        ? ''
        : ` The website port must be reachable as port 80 — it is ${h.port} now (SITES_PORT=80 and SITES_BIND=0.0.0.0 on a web server).`;

  return (
    <div className="svc-panel">
      <div className="svc-inner stack-lg">
        <div className="row wrap" style={{ gap: 10 }}>
          <div className="grow">
            <h2 style={{ margin: 0 }}>Website</h2>
            <div className="muted small">
              {isWp
                ? 'The website of this project is its WordPress — it is live as it is. Here you give it its name, your own domains and HTTPS; everything else is in the WordPress tab.'
                : 'Publish this project as a real website on your own domains. Publishing copies the finished files into a new release — the live website changes only when you publish again. Claude can publish too (“put it online”).'}
            </div>
          </div>
          <button className="btn sm ghost" onClick={() => void load()} title="Refresh">
            <RefreshCw size={14} />
          </button>
        </div>

        {!h.enabled && <div className="notice warn">Website hosting is switched off on this Studio (SITES_ENABLED=false).</div>}

        {!site && isWp && (
          <div className="card">
            <div className="card-body stack">
              <div className="row" style={{ gap: 10 }}>
                <Globe size={20} color="var(--accent)" />
                <b>No website yet</b>
              </div>
              <div className="muted small">Set WordPress up in the WordPress tab first — it gets its address with the installation, and you can add your own domains here afterwards.</div>
            </div>
          </div>
        )}

        {!site && !isWp && (
          <div className="card">
            <div className="card-body stack">
              <div className="row" style={{ gap: 10 }}>
                <Globe size={20} color="var(--accent)" />
                <b>Not published yet</b>
              </div>
              <div className="muted small">
                Publishing takes {folderLabel(data.suggestedRoot)}
                {data.suggestedRoot === '.' ? ' — without hidden files, node_modules, server folders, exports/, assets/uploads/ and CLAUDE.md' : ''}. It needs an{' '}
                <code className="code-inline">index.html</code> there. You get an address right away and can add your own domains afterwards.
              </div>
              <div className="row wrap" style={{ gap: 8 }}>
                <button className="btn primary" disabled={!!busy || !h.enabled} onClick={() => void publish()}>
                  {busy === 'publish' ? <Spinner size={14} /> : <Rocket size={14} />} Publish website
                </button>
              </div>
            </div>
          </div>
        )}

        {site && (
          <div className="card svc-card">
            <div className="card-head" style={{ flexWrap: 'wrap', gap: 10 }}>
              <Globe size={18} color="var(--accent)" />
              <h2 className="grow" style={{ minWidth: 160 }}>
                {site.slug}
              </h2>
              <SiteBadge site={site} />
              {isWp && <span className="badge accent">WordPress</span>}
              {!isWp && site.release > 0 && <span className="badge">release #{site.release}</span>}
            </div>
            <div className="card-body stack">
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
              {site.stats && !isWp && (
                <div className="faint small">
                  {site.stats.files} files · {fmtBytes(site.stats.bytes)} from {folderLabel(site.stats.root)}
                  {site.publishedAt ? ` · published ${new Date(site.publishedAt).toLocaleString()}` : ''}
                </div>
              )}
              {site.message && <div className="notice error">{site.message}</div>}
              {!site.ownerActive && <div className="notice warn">The owner's account is disabled — the website is offline.</div>}
              <div className="row wrap" style={{ gap: 8 }}>
                {!isWp && (
                  <button className="btn primary sm" disabled={!!busy || site.publishing} onClick={() => void publish()} title="Copy the current files into a new release">
                    {busy === 'publish' || site.publishing ? <Spinner size={14} /> : <Rocket size={14} />} {site.release ? 'Publish again' : 'Publish'}
                  </button>
                )}
                {site.status === 'live' && (
                  <a className="btn sm" href={site.addresses.primary} target="_blank" rel="noreferrer">
                    <ExternalLink size={14} /> Open website
                  </a>
                )}
                <button
                  className="btn sm"
                  disabled={!!busy}
                  onClick={() => void patch('enabled', { enabled: !site.enabled }, site.enabled ? 'The website is offline' : 'The website is online again')}
                >
                  {busy === 'enabled' ? <Spinner size={14} /> : <Power size={14} />} {site.enabled ? 'Take offline' : 'Put online'}
                </button>
                <span className="spacer" />
                {!isWp && (
                  <button className="btn sm ghost" disabled={!!busy} onClick={() => void remove()} title="Delete the website">
                    <Trash2 size={14} />
                  </button>
                )}
              </div>

              <div className="tabs">
                {(
                  [
                    ['domains', 'Domains', <Globe size={14} key="i" />],
                    ['log', isWp ? 'Log' : 'Publish log', <ScrollText size={14} key="i" />],
                    ['settings', 'Settings', <Settings2 size={14} key="i" />],
                    ['releases', 'Releases', <Undo2 size={14} key="i" />],
                  ] as const
                )
                  .filter(([k]) => !(isWp && k === 'releases'))
                  .map(([k, label, icon]) => (
                  <button key={k} className={cls('tab', tab === k && 'active')} onClick={() => setTab(k)}>
                    {icon}
                    {label}
                  </button>
                ))}
              </div>

              {tab === 'domains' && (
                <div className="stack">
                  {hosts.map((d) => {
                    const c = checks[d];
                    const t = site.tls[d];
                    const own = site.domains.includes(d);
                    return (
                      <div key={d} className="stack" style={{ gap: 6 }}>
                        <div className="row wrap" style={{ gap: 8 }}>
                          <a className="mono grow" href={urlOf(d)} target="_blank" rel="noreferrer" style={{ minWidth: 160 }}>
                            {d}
                          </a>
                          {t && <TlsBadge tls={t} />}
                          {t && (
                            <button className={cls('btn sm', openTls === d && 'primary')} onClick={() => setOpenTls(openTls === d ? '' : d)} title="Certificate and HTTPS settings of this domain">
                              <Lock size={14} /> HTTPS
                            </button>
                          )}
                          {own && (
                            <button className="btn sm" disabled={c === 'busy'} onClick={() => void check(d)} title="Does the domain reach this Studio?">
                              {c === 'busy' ? <Spinner size={14} /> : <CheckCircle2 size={14} />} Check
                            </button>
                          )}
                          {own && (
                            <button
                              className="btn sm ghost icon"
                              disabled={!!busy}
                              title="Remove the domain"
                              onClick={() => void act(`rm-${d}`, () => api(`/sites/${site.id}/domains/${encodeURIComponent(d)}`, { method: 'DELETE' }))}
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                        {openTls === d && t && (
                          <TlsControls tls={t} base={`/sites/${site.id}/domains/${encodeURIComponent(d)}/tls`} hosting={h.tls} onChanged={load} />
                        )}
                        {c && c !== 'busy' && (
                          <div className={cls('notice', c.ok ? 'ok' : 'warn')} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                            {c.ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
                            <span className="small">{c.message}</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {!hosts.length && <div className="faint small">No domains yet — the website is reachable at the address above.</div>}
                  <form
                    className="row wrap"
                    style={{ gap: 8 }}
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (domain.trim()) void addDomain();
                    }}
                  >
                    <input className="input mono grow" placeholder="example.com" value={domain} onChange={(e) => setDomain(e.target.value)} style={{ minWidth: 200 }} />
                    <button className="btn sm primary" disabled={!!busy || !domain.trim()}>
                      {busy === 'domain' ? <Spinner size={14} /> : <Plus size={14} />} Add domain
                    </button>
                  </form>
                  <div className="hint" style={{ marginTop: 0 }}>
                    At your domain provider, create an <b>A record</b> (and <b>AAAA</b> for IPv6) for the domain pointing to this server's public IP — add{' '}
                    <code className="code-inline">www.</code> too if you want both.{portsHint}
                    {builtinTls && (
                      <>
                        {' '}
                        Every domain gets its own certificate: {h.tls.auto ? `automatically from ${h.tls.ca} once it points here` : 'upload one or use a self-signed one (automatic certificates are switched on by an admin under Admin → HTTPS)'} —
                        see <b>HTTPS</b> next to the domain.
                      </>
                    )}
                    {h.baseDomain ? (
                      <>
                        {' '}
                        Every website also gets <code className="code-inline">{`${site.slug}.${h.baseDomain}`}</code> automatically.
                      </>
                    ) : null}
                  </div>
                </div>
              )}

              {tab === 'log' && (
                <pre ref={logRef} className="log-box svc-log">
                  {log.length ? log.join('\n') : 'Not published yet.'}
                </pre>
              )}

              {tab === 'settings' && (
                <div className="stack" style={{ maxWidth: 600 }}>
                  <div className="field">
                    <label className="label">Name</label>
                    <input className="input mono" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase() })} />
                    <div className="hint">
                      Used for the automatic addresses ({h.baseDomain ? `${form.slug || '…'}.${h.baseDomain}, ` : ''}
                      {form.slug || '…'}.localhost).
                    </div>
                  </div>
                  {isWp && <div className="hint" style={{ marginTop: 0 }}>The content of this website is the project's WordPress.</div>}
                  <div className="field" hidden={isWp}>
                    <label className="label">Content</label>
                    <select className="select" value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as 'static' | 'server' })}>
                      <option value="static">Published files (HTML, JS, CSS, images …)</option>
                      <option value="server" disabled={!data.servers.length}>
                        A Node.js server of this project (the server answers every request)
                      </option>
                    </select>
                    {form.mode === 'static' && (
                      <div className="hint">The project's servers stay reachable on the website at /srv/&lt;server&gt;/ (same origin).</div>
                    )}
                  </div>
                  {form.mode === 'server' && (
                    <div className="field">
                      <label className="label">Server</label>
                      <select className="select" value={form.serviceId} onChange={(e) => setForm({ ...form, serviceId: Number(e.target.value) })}>
                        <option value={0}>— choose —</option>
                        {data.servers.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name} ({s.state})
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  {form.mode === 'static' && (
                    <>
                      <div className="field">
                        <label className="label">Folder to publish</label>
                        <input
                          className="input mono"
                          placeholder={`automatic — now: ${data.suggestedRoot === '.' ? '. (project folder)' : data.suggestedRoot}`}
                          value={form.root}
                          onChange={(e) => setForm({ ...form, root: e.target.value })}
                        />
                        <div className="hint">Automatic: dist/, build/ or out/ when they contain an index.html, else the project folder.</div>
                      </div>
                      <div className="field">
                        <label className="label">Build command (runs before publishing)</label>
                        <input
                          className="input mono"
                          placeholder="none — e.g. npm ci && npm run build"
                          value={form.build}
                          onChange={(e) => setForm({ ...form, build: e.target.value })}
                        />
                      </div>
                      <label className="row" style={{ gap: 8 }}>
                        <input type="checkbox" checked={form.spa} onChange={(e) => setForm({ ...form, spa: e.target.checked })} />
                        Single-page app: paths without a file extension show index.html
                      </label>
                    </>
                  )}
                  <div>
                    <button
                      className="btn sm primary"
                      disabled={!!busy}
                      onClick={() =>
                        void patch(
                          'settings',
                          isWp
                            ? { slug: form.slug }
                            : {
                                slug: form.slug,
                                settings: {
                                  root: form.root,
                                  build: form.build,
                                  spa: form.spa,
                                  mode: form.mode,
                                  serviceId: form.mode === 'server' && form.serviceId ? form.serviceId : null,
                                },
                              },
                          isWp ? 'Saved' : form.mode === 'server' ? 'Saved — the website now shows the server' : 'Saved — publish again to apply folder / build changes',
                        )
                      }
                    >
                      Save settings
                    </button>
                  </div>
                </div>
              )}

              {tab === 'releases' && (
                <div className="stack">
                  <div className="hint" style={{ marginTop: 0 }}>
                    Every publish is a release; the last three are kept. Rolling back switches the website at once.
                  </div>
                  {!data.releases.length && <div className="faint small">No releases yet.</div>}
                  {data.releases.map((n) => (
                    <div key={n} className="row" style={{ gap: 8 }}>
                      <span className="mono">#{n}</span>
                      {n === site.release ? (
                        <span className="badge ok">live</span>
                      ) : (
                        <button className="btn sm" disabled={!!busy} onClick={() => void act('rollback', () => api(`/sites/${site.id}/rollback`, { body: { release: n } }))}>
                          <Undo2 size={14} /> Roll back to #{n}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
