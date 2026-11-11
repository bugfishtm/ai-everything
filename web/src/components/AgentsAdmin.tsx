import { Bot, ChevronDown, ChevronRight, Download, ExternalLink, Plus, Power, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, errMsg, type AgentInfo, type CustomAgent } from '../api';
import { socket } from '../ws';
import { Spinner, useUi } from './ui';

const KEY_IDS = ['openai', 'gemini', 'openrouter', 'groq', 'mistral', 'deepseek', 'xai', 'anthropic'];
const words = (s: string) => s.split(/\s+/).filter(Boolean);

function InstallBadge({ a }: { a: AgentInfo }) {
  const s = a.install.state;
  if (s === 'ready') {
    return (
      <span className="badge ok" title={Object.entries(a.install.versions).map(([p, v]) => `${p} ${v}`).join('\n')}>
        installed{a.install.updating ? ' · updating…' : ''}
      </span>
    );
  }
  if (s === 'queued' || s === 'installing') return <span className="badge warn">{s === 'queued' ? 'waiting to install' : 'installing…'}</span>;
  if (s === 'error') return <span className="badge danger" title={a.install.error ?? ''}>install failed</span>;
  return <span className="badge">not installed</span>;
}

/** Admin → AI providers: switch agents on (installs them), update, remove, add custom ACP agents. */
export function AgentsAdminCard() {
  const ui = useUi();
  const [list, setList] = useState<AgentInfo[] | null>(null);
  const [custom, setCustom] = useState<CustomAgent[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [form, setForm] = useState<{ id: string; name: string; command: string; args: string; packages: string; tui: string; tuiArgs: string; login: string; keys: string[]; homepage: string; license: string } | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ agents: AgentInfo[]; custom: CustomAgent[] }>('/admin/agents');
    setList(r.agents);
    setCustom(r.custom);
  }, []);

  useEffect(() => {
    void load().catch((err) => ui.toast(errMsg(err), 'error'));
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = socket.on((m) => {
      if (m.t === 'agents.changed' || m.t === 'agents.log') {
        clearTimeout(t);
        t = setTimeout(() => void load().catch(() => {}), m.t === 'agents.log' ? 800 : 200);
      }
    });
    return () => {
      off();
      clearTimeout(t);
    };
  }, [load, ui]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
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

  const saveCustom = () =>
    act('custom', async () => {
      if (!form) return;
      await api('/admin/agents/custom', {
        method: 'PUT',
        body: {
          id: form.id.trim(),
          name: form.name.trim(),
          command: form.command.trim(),
          args: words(form.args),
          packages: words(form.packages),
          tui: form.tui.trim() || undefined,
          tuiArgs: words(form.tuiArgs),
          login: form.login.trim() || undefined,
          keys: form.keys,
          homepage: form.homepage.trim() || undefined,
          license: form.license.trim() || undefined,
        },
      });
      setForm(null);
      ui.toast('Saved — switch it on to install and use it');
    });

  return (
    <div className="card" id="ai">
      <div className="card-head">
        <Bot size={18} color="var(--accent)" />
        <h2 className="grow">AI providers</h2>
        <button className="btn sm ghost" onClick={() => void load()}>
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="card-body stack">
        <div className="muted small">
          Claude Code is always available. These AIs can be switched on in addition — switching one on downloads its official npm package into the data volume
          (one at a time, several 100 MB each; nothing of it is in the image). Users then connect their own accounts or keys on their Account page. Each one is
          run over the open Agent Client Protocol (ACP).
        </div>
        {!list && <Spinner />}
        {list?.map((a) => (
          <div key={a.id} className="method" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="row wrap" style={{ gap: 10 }}>
              <div className="grow" style={{ minWidth: 220 }}>
                <b>{a.name}</b> <span className="faint small">· {a.vendor} · {a.license}</span>
                <div className="muted small">{a.description}</div>
                <div className="faint small mono">{(a.packages ?? []).join(' + ') || 'uses a program that is already on this server'}</div>
              </div>
              <InstallBadge a={a} />
              {a.enabled ? (
                <button
                  className="btn sm"
                  disabled={!!busy}
                  onClick={() =>
                    void act(`off-${a.id}`, async () => {
                      const ok = await ui.confirm({
                        title: `Switch ${a.name} off?`,
                        body: 'Running chats with it stop; its chats cannot continue until it is switched on again. The installed files stay (remove them below).',
                        confirm: 'Switch off',
                        danger: true,
                      });
                      if (ok) await api(`/admin/agents/${a.id}/disable`, { body: {} });
                    })
                  }
                >
                  <Power size={14} /> Switch off
                </button>
              ) : (
                <button className="btn sm primary" disabled={!!busy} onClick={() => void act(`on-${a.id}`, () => api(`/admin/agents/${a.id}/enable`, { body: {} }))}>
                  {busy === `on-${a.id}` ? <Spinner size={14} /> : <Power size={14} />} Switch on
                </button>
              )}
              {a.install.state === 'ready' && (a.packages ?? []).length > 0 && (
                <button className="btn sm ghost" disabled={!!busy || a.install.updating} onClick={() => void act(`up-${a.id}`, () => api(`/admin/agents/${a.id}/install`, { body: {} }))} title="Install the newest version">
                  <Download size={14} /> Update
                </button>
              )}
              {a.install.state === 'error' && (
                <button className="btn sm ghost" disabled={!!busy} onClick={() => void act(`up-${a.id}`, () => api(`/admin/agents/${a.id}/install`, { body: {} }))}>
                  <RefreshCw size={14} /> Retry
                </button>
              )}
              {!a.enabled && a.install.state === 'ready' && (a.packages ?? []).length > 0 && (
                <button className="btn sm ghost" disabled={!!busy} title="Delete the installed files" onClick={() => void act(`rm-${a.id}`, () => api(`/admin/agents/${a.id}/files`, { method: 'DELETE' }))}>
                  <Trash2 size={14} />
                </button>
              )}
              {!a.builtin && (
                <button
                  className="btn sm ghost"
                  disabled={!!busy}
                  title="Remove this custom AI"
                  onClick={() =>
                    void act(`del-${a.id}`, async () => {
                      const ok = await ui.confirm({ title: `Remove ${a.name}?`, body: 'Its definition and installed files are deleted.', confirm: 'Remove', danger: true });
                      if (ok) await api(`/admin/agents/custom/${a.id}`, { method: 'DELETE' });
                    })
                  }
                >
                  <Trash2 size={14} /> Remove
                </button>
              )}
              {(a.log?.length ?? 0) > 0 && (
                <button className="btn sm ghost icon" onClick={() => setOpen(open === a.id ? null : a.id)} title="Install log">
                  {open === a.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
              )}
            </div>
            {a.install.error && <div className="small" style={{ color: 'var(--danger)' }}>{a.install.error}</div>}
            {open === a.id && <pre className="log-box" style={{ maxHeight: 220 }}>{(a.log ?? []).join('\n')}</pre>}
            {a.homepage && (
              <div className="faint small">
                <a href={a.homepage} target="_blank" rel="noreferrer">
                  {a.homepage} <ExternalLink size={11} />
                </a>
                {a.terms && (
                  <>
                    {' · '}
                    <a href={a.terms} target="_blank" rel="noreferrer">
                      terms <ExternalLink size={11} />
                    </a>
                  </>
                )}
              </div>
            )}
          </div>
        ))}

        {!form ? (
          <div>
            <button
              className="btn sm ghost"
              onClick={() => setForm({ id: '', name: '', command: '', args: '', packages: '', tui: '', tuiArgs: '', login: '', keys: [], homepage: '', license: '' })}
            >
              <Plus size={14} /> Add another ACP agent
            </button>
            {custom.length > 0 && <span className="faint small"> · {custom.length} custom</span>}
          </div>
        ) : (
          <div className="method stack">
            <b>Another ACP agent</b>
            <div className="hint" style={{ marginTop: 0 }}>
              Any program that speaks the Agent Client Protocol over stdio — e.g. Qwen Code (package <code className="code-inline">@qwen-code/qwen-code</code>, command{' '}
              <code className="code-inline">qwen --acp</code>). It runs as each user's sandbox account in their project.
            </div>
            <div className="row wrap" style={{ gap: 8 }}>
              <input className="input" style={{ maxWidth: 160 }} placeholder="id (qwen)" value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value.toLowerCase() })} />
              <input className="input grow" placeholder="Name (Qwen Code)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <input className="input grow mono" placeholder="npm packages (optional)" value={form.packages} onChange={(e) => setForm({ ...form, packages: e.target.value })} />
            </div>
            <div className="row wrap" style={{ gap: 8 }}>
              <input className="input mono" style={{ maxWidth: 200 }} placeholder="command (qwen)" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} />
              <input className="input mono grow" placeholder="ACP arguments (--acp)" value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} />
            </div>
            <div className="row wrap" style={{ gap: 8 }}>
              <input className="input mono" style={{ maxWidth: 200 }} placeholder="terminal command (optional)" value={form.tui} onChange={(e) => setForm({ ...form, tui: e.target.value })} />
              <input className="input mono grow" placeholder="terminal arguments" value={form.tuiArgs} onChange={(e) => setForm({ ...form, tuiArgs: e.target.value })} />
              <input className="input mono grow" placeholder="sign-in command (optional, e.g. qwen auth)" value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value })} />
            </div>
            <div className="row wrap small" style={{ gap: 10 }}>
              <span className="muted">Hand over the users' keys:</span>
              {KEY_IDS.map((k) => (
                <label key={k} className="row" style={{ gap: 4 }}>
                  <input
                    type="checkbox"
                    checked={form.keys.includes(k)}
                    onChange={(e) => setForm({ ...form, keys: e.target.checked ? [...form.keys, k] : form.keys.filter((x) => x !== k) })}
                  />
                  {k}
                </label>
              ))}
            </div>
            <div className="row wrap" style={{ gap: 8 }}>
              <input className="input grow" placeholder="homepage (optional)" value={form.homepage} onChange={(e) => setForm({ ...form, homepage: e.target.value })} />
              <input className="input" style={{ maxWidth: 160 }} placeholder="license" value={form.license} onChange={(e) => setForm({ ...form, license: e.target.value })} />
              <button className="btn sm" onClick={() => setForm(null)}>
                Cancel
              </button>
              <button className="btn sm primary" disabled={!form.id || !form.name || !form.command || busy === 'custom'} onClick={() => void saveCustom()}>
                {busy === 'custom' && <Spinner size={14} />} Save
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
