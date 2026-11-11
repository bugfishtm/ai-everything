import { BadgeCheck, Bot, ExternalLink, KeyRound, LogIn, LogOut, Save, Sparkles, Terminal, Trash2, Zap } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errMsg, type AgentInfo } from '../api';
import { useStudio } from '../store';
import { TerminalView } from './lazy';
import { Modal, Spinner, useUi } from './ui';

/** The agent's own sign-in (Codex: ChatGPT device login, Gemini: Google, OpenCode: provider logins) in a web terminal. */
function AgentLoginTerminal({ agent, onClose }: { agent: AgentInfo; onClose: () => void }) {
  const { refreshAgents } = useStudio();
  return (
    <Modal
      title={`${agent.name}: ${agent.login?.title ?? 'sign in'}`}
      size="wide"
      icon={<Terminal size={18} />}
      onClose={() => {
        void refreshAgents();
        onClose();
      }}
    >
      <ol className="muted small" style={{ margin: '0 0 12px', paddingLeft: 18, lineHeight: 1.7 }}>
        {(agent.login?.steps ?? []).map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <div style={{ height: 430, border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', display: 'flex' }}>
        <TerminalView kind="login" provider={agent.id} title={agent.login?.title ?? 'sign in'} onExit={() => void refreshAgents()} />
      </div>
      <p className="faint small" style={{ marginTop: 10 }}>
        This is {agent.name}'s own sign-in: it completes on the provider's site and the login stays in your private sandbox account. The Studio does not store
        it. Use your own account — accounts must not be shared.
      </p>
    </Modal>
  );
}

function AgentCard({ agent }: { agent: AgentInfo }) {
  const ui = useUi();
  const { refreshAgents } = useStudio();
  const [login, setLogin] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [test, setTest] = useState<{ ok: boolean; message: string; ms: number; model?: string | null } | null>(null);
  const ready = agent.install.state === 'ready';
  const st = agent.status;

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

  const signedIn = (st?.methods ?? []).some((m) => /sign-in|sign-ins|login/i.test(m));
  return (
    <div className="method" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
        <span
          className={`status-dot ${!ready ? 'bad' : st?.connected ? 'ok' : st?.connected === null ? '' : 'bad'}`}
          style={{ width: 11, height: 11, marginTop: 5 }}
        />
        <div className="grow" style={{ minWidth: 0 }}>
          <h3 style={{ margin: 0 }}>
            {agent.name} {agent.vendor !== 'any provider' && agent.vendor !== 'custom' && <span className="faint small">· {agent.vendor}</span>}
          </h3>
          <div className="muted small">{agent.description}</div>
          <div className="small" style={{ marginTop: 4 }}>
            {!ready ? (
              <span className="faint">
                {agent.install.state === 'error' ? `Could not be installed: ${agent.install.error}` : 'Being installed on this server …'}
              </span>
            ) : st?.connected ? (
              <span>
                Connected via {st.methods.join(' · ')}
              </span>
            ) : st?.connected === null ? (
              <span className="faint">Status unknown — use Test.</span>
            ) : (
              <span style={{ color: 'var(--warn)' }}>Not connected yet</span>
            )}
          </div>
        </div>
      </div>
      {test && (
        <div className={`notice ${test.ok ? 'info' : 'error'}`}>
          {test.ok ? <BadgeCheck size={18} color="var(--ok)" /> : <Zap size={18} />}
          <div className="grow">
            {test.ok ? (
              <>
                {agent.name} answered “{test.message}” in {(test.ms / 1000).toFixed(1)}s{test.model ? ` (${test.model})` : ''} — it works.
              </>
            ) : (
              <>
                <b>The test failed.</b>
                <pre>{test.message}</pre>
              </>
            )}
          </div>
        </div>
      )}
      <div className="row wrap" style={{ gap: 8 }}>
        {agent.login && (
          <button className="btn sm primary" disabled={!ready} onClick={() => setLogin(true)}>
            <LogIn size={14} /> {agent.login.title}
          </button>
        )}
        <button
          className="btn sm"
          disabled={!ready || !!busy}
          onClick={() =>
            void run('test', async () => {
              setTest(null);
              setTest(await api(`/agents/${agent.id}/test`, { body: {} }));
              await refreshAgents();
            })
          }
        >
          {busy === 'test' ? <Spinner size={14} /> : <Zap size={14} />} Test
        </button>
        {signedIn && (
          <button
            className="btn sm ghost"
            disabled={!!busy}
            onClick={() =>
              void run('logout', async () => {
                const ok = await ui.confirm({
                  title: `Sign out of ${agent.name}?`,
                  body: `Removes ${agent.name}'s own sign-in from your sandbox account. Stored API keys stay until you remove them below.`,
                  confirm: 'Sign out',
                });
                if (!ok) return;
                await api(`/agents/${agent.id}/logout`, { body: {} });
                await refreshAgents();
              })
            }
          >
            <LogOut size={14} /> Sign out
          </button>
        )}
        <span className="spacer" />
        <input
          className="input"
          style={{ maxWidth: 230, height: 30 }}
          list={`models-${agent.id}`}
          placeholder="default model"
          value={model ?? agent.defaultModel ?? ''}
          onChange={(e) => setModel(e.target.value)}
          title={`Default model for ${agent.name} (projects can override it)`}
        />
        <datalist id={`models-${agent.id}`}>
          {(agent.models ?? []).map((m) => (
            <option key={m.value} value={m.value}>
              {m.name}
            </option>
          ))}
        </datalist>
        <button
          className="btn sm"
          disabled={model === null || !!busy}
          onClick={() =>
            void run('model', async () => {
              await api('/agents/prefs', { method: 'PATCH', body: { models: { [agent.id]: model ?? '' } } });
              setModel(null);
              await refreshAgents();
              ui.toast('Default model saved');
            })
          }
        >
          <Save size={14} />
        </button>
      </div>
      {(agent.freeTier || agent.notes.length > 0) && (
        <div className="hint" style={{ marginTop: 0 }}>
          {[agent.freeTier, ...agent.notes].filter(Boolean).join(' ')}
        </div>
      )}
      <div className="faint small">
        {agent.license}
        {agent.homepage && (
          <>
            {' · '}
            <a href={agent.homepage} target="_blank" rel="noreferrer">
              about {agent.name} <ExternalLink size={11} />
            </a>
          </>
        )}
        {agent.terms && (
          <>
            {' · '}
            <a href={agent.terms} target="_blank" rel="noreferrer">
              terms <ExternalLink size={11} />
            </a>
          </>
        )}
      </div>
      {login && <AgentLoginTerminal agent={agent} onClose={() => setLogin(false)} />}
    </div>
  );
}

function ApiKeys() {
  const ui = useUi();
  const { agents, refreshAgents } = useStudio();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  if (!agents) return null;
  const save = async (id: string) => {
    setBusy(id);
    try {
      await api(`/agents/keys/${id}`, { method: 'PUT', body: { secret: (values[id] ?? '').trim() } });
      setValues((v) => ({ ...v, [id]: '' }));
      await refreshAgents();
      ui.toast('Key saved (encrypted)');
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    } finally {
      setBusy('');
    }
  };
  const remove = async (id: string) => {
    setBusy(id);
    try {
      await api(`/agents/keys/${id}`, { method: 'DELETE' });
      await refreshAgents();
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    } finally {
      setBusy('');
    }
  };
  // only keys an enabled AI can use
  const usable = new Set(agents.agents.flatMap((a) => a.keys));
  const keys = agents.keys.filter((k) => usable.has(k.id));
  if (!keys.length) return null;
  return (
    <div className="stack">
      <h3 className="row" style={{ gap: 8, margin: 0 }}>
        <KeyRound size={16} /> API keys of other AI vendors
      </h3>
      <div className="muted small">
        Pay per use with your own keys. Stored encrypted and handed only to your own AI sessions — each AI gets just the keys it can use (e.g. Codex the OpenAI
        key, OpenCode all of them). Your Anthropic API key is set in the Claude connection above.
      </div>
      <div className="col" style={{ gap: 8 }}>
        {keys.map((k) => (
          <div key={k.id} className="row wrap" style={{ gap: 8 }}>
            <span style={{ width: 130 }}>
              <b>{k.label}</b>
            </span>
            {k.hint ? (
              <>
                <span className="badge ok">stored {k.hint}</span>
                <button className="btn sm ghost" disabled={busy === k.id} onClick={() => void remove(k.id)} title="Remove the stored key">
                  <Trash2 size={14} />
                </button>
              </>
            ) : null}
            <input
              className="input mono grow"
              style={{ minWidth: 200, maxWidth: 380, height: 30 }}
              type="password"
              autoComplete="new-password"
              placeholder={k.hint ? 'replace with a new key' : k.placeholder}
              value={values[k.id] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [k.id]: e.target.value }))}
            />
            <button className="btn sm" disabled={(values[k.id] ?? '').trim().length < 10 || busy === k.id} onClick={() => void save(k.id)}>
              {busy === k.id ? <Spinner size={14} /> : <Save size={14} />} Save
            </button>
            {!k.hint && (
              <a className="faint small" href={k.url} target="_blank" rel="noreferrer">
                get a key <ExternalLink size={11} />
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** "AI connections": every AI besides Claude Code that the admin switched on. */
export function AgentConnectionsCard() {
  const ui = useUi();
  const { agents, refreshAgents, user } = useStudio();
  const [busy, setBusy] = useState(false);
  if (!agents) return null;
  const list = agents.agents;
  return (
    <div className="card" id="ai">
      <div className="card-head">
        <Bot size={18} color="var(--accent)" />
        <h2 className="grow">More AI providers</h2>
        {list.length > 0 && (
          <label className="row small" style={{ gap: 8 }}>
            Default AI for new chats
            <select
              className="select"
              style={{ width: 'auto', height: 30 }}
              value={agents.prefs.defaultProvider}
              disabled={busy}
              onChange={async (e) => {
                setBusy(true);
                try {
                  await api('/agents/prefs', { method: 'PATCH', body: { defaultProvider: e.target.value } });
                  await refreshAgents();
                } catch (err) {
                  ui.toast(errMsg(err), 'error');
                } finally {
                  setBusy(false);
                }
              }}
            >
              <option value="claude">Claude Code</option>
              {list.map((a) => (
                <option key={a.id} value={a.id} disabled={a.install.state !== 'ready'}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="card-body stack">
        {!list.length ? (
          <div className="row" style={{ gap: 10 }}>
            <Sparkles size={18} color="var(--text-faint)" />
            <div className="muted small">
              Besides Claude, this Studio can run OpenAI Codex (ChatGPT plans, OpenAI keys), Google Gemini (Google account, Gemini keys) and OpenCode (OpenRouter,
              Groq, Mistral, DeepSeek, xAI, local models …).{' '}
              {user?.role === 'admin' ? (
                <>
                  Switch them on in <Link to="/admin#ai">Admin → AI providers</Link>.
                </>
              ) : (
                'An admin can switch them on.'
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="muted small">
              Use other AIs in your projects and chats — each chat keeps the AI it started with; projects can set their own in their settings. Everything runs in your
              private sandbox account, like Claude.
            </div>
            <div className="method-grid">
              {list.map((a) => (
                <AgentCard key={a.id} agent={a} />
              ))}
            </div>
            <ApiKeys />
          </>
        )}
      </div>
    </div>
  );
}
