import { ExternalLink, Play, RotateCw, Server, Square } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errMsg, type Service } from '../api';
import { ServiceBadge } from '../components/ServicePanel';
import { Empty, Spinner, useUi } from '../components/ui';
import { socket } from '../ws';

/** All servers of the signed-in user, across projects. */
export function ServicesPage() {
  const ui = useUi();
  const [list, setList] = useState<Service[] | null>(null);
  const [limits, setLimits] = useState<{ maxPerUser: number; enabled: boolean } | null>(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    const r = await api<{ services: Service[]; limits: { maxPerUser: number; enabled: boolean } }>('/services');
    setList(r.services);
    setLimits(r.limits);
  }, []);

  useEffect(() => {
    void load().catch((err) => ui.toast(errMsg(err), 'error'));
    const t = setInterval(() => void load().catch(() => {}), 15_000);
    const off = socket.on((m) => {
      if (m.t === 'services.changed') void load().catch(() => {});
    });
    return () => {
      clearInterval(t);
      off();
    };
  }, [load, ui]);

  const act = async (s: Service, action: string) => {
    setBusy(`${s.id}:${action}`);
    try {
      await api(`/services/${s.id}/${action}`, { body: {} });
      await load();
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="page stack-lg">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1>Servers</h1>
          <p>
            Node.js backends of your projects — multiplayer, cloud saves, leaderboards, APIs — for your games, Android apps, Windows programs and web apps.
            Claude builds and deploys them from the chat; open a project's <b>Server</b> tab for logs, environment and releases.
          </p>
        </div>
      </div>
      {limits && !limits.enabled && <div className="notice warn">Servers are switched off on this Studio (SERVICES_ENABLED=false).</div>}
      {!list && <Spinner />}
      {list && !list.length && (
        <Empty icon={Server} title="No servers yet">
          In a game, app or web project ask Claude for an online feature — for example <i>“add online multiplayer”</i> or <i>“save the high scores on a server”</i>.
        </Empty>
      )}
      {list && list.length > 0 && (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Server</th>
                <th>Project</th>
                <th>Status</th>
                <th>Address</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id}>
                  <td>
                    <b>{s.name}</b>
                    <div className="faint small mono">
                      {s.root}/ · release #{s.release || '—'}
                      {s.memoryMb ? ` · ${s.memoryMb} MB` : ''}
                    </div>
                  </td>
                  <td>
                    <Link to={`/p/${s.projectId}?tab=server`}>{s.projectName}</Link>
                  </td>
                  <td>
                    <ServiceBadge s={s} />
                    {s.message && <div className="faint small">{s.message}</div>}
                  </td>
                  <td>
                    <a href={`${s.path}health`} target="_blank" rel="noreferrer" className="mono small">
                      {s.path} <ExternalLink size={12} />
                    </a>
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {s.port || s.state === 'starting' ? (
                      <button className="btn sm ghost" disabled={!!busy} onClick={() => void act(s, 'stop')} title="Stop">
                        <Square size={14} />
                      </button>
                    ) : (
                      <button className="btn sm ghost" disabled={!!busy || !s.release} onClick={() => void act(s, 'start')} title="Start">
                        <Play size={14} />
                      </button>
                    )}
                    <button className="btn sm ghost" disabled={!!busy || !s.release} onClick={() => void act(s, 'restart')} title="Restart">
                      {busy === `${s.id}:restart` ? <Spinner size={14} /> : <RotateCw size={14} />}
                    </button>
                    <Link className="btn sm" to={`/p/${s.projectId}?tab=server`}>
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {limits && (
        <div className="hint">
          Up to {limits.maxPerUser} servers per person. Servers run in your own sandbox account and are public at their address — protect write endpoints
          with a key (Environment) when needed.
        </div>
      )}
    </div>
  );
}
