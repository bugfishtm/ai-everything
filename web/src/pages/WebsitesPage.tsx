import { ExternalLink, Globe, Power } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errMsg, type Hosting, type Site } from '../api';
import { TlsBadge } from '../components/Https';
import { fmtBytes, SiteBadge } from '../components/SitePanel';
import { Empty, Spinner, useUi } from '../components/ui';
import { socket } from '../ws';

/** All websites of the signed-in user, across projects. */
export function WebsitesPage() {
  const ui = useUi();
  const [list, setList] = useState<Site[] | null>(null);
  const [hosting, setHosting] = useState<Hosting | null>(null);
  const [busy, setBusy] = useState(0);

  const load = useCallback(async () => {
    const r = await api<{ sites: Site[]; hosting: Hosting }>('/sites');
    setList(r.sites);
    setHosting(r.hosting);
  }, []);

  useEffect(() => {
    void load().catch((err) => ui.toast(errMsg(err), 'error'));
    const off = socket.on((m) => {
      if (m.t === 'sites.changed') void load().catch(() => {});
    });
    return off;
  }, [load, ui]);

  const toggle = async (s: Site) => {
    setBusy(s.id);
    try {
      await api(`/sites/${s.id}`, { method: 'PATCH', body: { enabled: !s.enabled } });
      await load();
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    } finally {
      setBusy(0);
    }
  };

  return (
    <div className="page stack-lg">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1>Websites</h1>
          <p>
            Web apps and games of your projects, published as real websites on your own domains. Publish from a project's <b>Website</b> tab or ask Claude to
            “put it online”; add domains there.
          </p>
        </div>
      </div>
      {hosting && !hosting.enabled && <div className="notice warn">Website hosting is switched off on this Studio (SITES_ENABLED=false).</div>}
      {!list && <Spinner />}
      {list && !list.length && (
        <Empty icon={Globe} title="No websites yet">
          Open a web app or game project and publish it in its <b>Website</b> tab — or ask Claude: <i>“publish this as a website”</i>.
        </Empty>
      )}
      {list && list.length > 0 && (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Website</th>
                <th>Project</th>
                <th>Status</th>
                <th>Addresses</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id}>
                  <td>
                    <b>{s.slug}</b>
                    <div className="faint small mono">
                      release #{s.release || '—'}
                      {s.stats ? ` · ${s.stats.files} files · ${fmtBytes(s.stats.bytes)}` : ''}
                    </div>
                  </td>
                  <td>
                    <Link to={`/p/${s.projectId}?tab=site`}>{s.projectName}</Link>
                  </td>
                  <td>
                    <SiteBadge site={s} />
                  </td>
                  <td>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {[...s.addresses.custom, ...(s.addresses.base ? [s.addresses.base] : []), s.addresses.local].map((u) => {
                        const t = s.tls?.[u.split('/')[2]?.split(':')[0] ?? ''];
                        return (
                          <div key={u} className="row" style={{ gap: 8 }}>
                            <a href={u} target="_blank" rel="noreferrer" className="mono small">
                              {u.replace(/^https?:\/\//, '').replace(/\/$/, '')} <ExternalLink size={11} />
                            </a>
                            {t && t.status !== 'active' && t.status !== 'off' && <TlsBadge tls={t} />}
                          </div>
                        );
                      })}
                    </div>
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn sm ghost" disabled={!!busy} onClick={() => void toggle(s)} title={s.enabled ? 'Take offline' : 'Put online'}>
                      {busy === s.id ? <Spinner size={14} /> : <Power size={14} />}
                    </button>
                    <Link className="btn sm" to={`/p/${s.projectId}?tab=site`}>
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {hosting && (
        <div className="hint">
          Up to {hosting.maxPerUser} websites per person, {hosting.maxMb} MB each.
          {hosting.baseDomain ? ` Every website also gets <name>.${hosting.baseDomain}.` : ''} Websites are public — everyone with the address can open them.
        </div>
      )}
    </div>
  );
}
