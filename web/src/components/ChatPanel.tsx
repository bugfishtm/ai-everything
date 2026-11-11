import {
  CircleAlert,
  Gauge,
  GitCommitHorizontal,
  GraduationCap,
  KeyRound,
  MessageSquarePlus,
  Paperclip,
  Pencil,
  Send,
  ShieldQuestion,
  Square,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, errMsg, upload, type Area, type Chat, type ChatEvent, type PermRequest, type PlanLimits, type Project, type Skill } from '../api';
import { useProviderName, useStudio } from '../store';
import { socket } from '../ws';
import { Markdown } from './Markdown';
import { summarize, ToolCall, type ToolBlock, type ToolResult } from './ToolCall';
import { Empty, Spinner, useUi } from './ui';

interface Props {
  project: Project;
  area?: Area;
  initialPrompt?: string;
  onOpenHistory: () => void;
  /** casual = the Chat page (plain conversation, no project work) */
  variant?: 'project' | 'casual';
  /** extra controls in the chat header (e.g. a model picker) */
  headerExtra?: ReactNode;
}

/** Elapsed time since `since` (ms), refreshed every second while mounted. */
function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.round((Date.now() - since) / 1000));
  return <span className="faint mono small">{s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`}</span>;
}

export function fmtReset(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Warns when a plan window is (nearly) used up. */
export function LimitWarning({ limits }: { limits: PlanLimits | null }) {
  const hot = (limits?.windows ?? [])
    .filter((w) => (w.percent ?? 0) >= 85 || w.status === 'rejected')
    .sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0))[0];
  if (!hot) return null;
  const blocked = hot.status === 'rejected' || (hot.percent ?? 0) >= 100;
  return (
    <div className={`notice ${blocked ? 'error' : 'warn'}`} style={{ marginBottom: 8 }}>
      <Gauge size={18} />
      <div className="grow">
        {blocked ? <b>Your Claude plan limit is reached</b> : <b>{Math.round(hot.percent ?? 0)}% of your Claude plan limit used</b>} — {hot.label.toLowerCase()}
        {hot.resetsAt ? `, resets ${fmtReset(hot.resetsAt)}` : hot.resetsText ? `, resets ${hot.resetsText}` : ''}. <Link to="/account#usage">Usage</Link>
      </div>
    </div>
  );
}

export function ChatPanel({ project, area, initialPrompt, onOpenHistory, variant = 'project', headerExtra }: Props) {
  const ui = useUi();
  const { claude, limits, agents } = useStudio();
  const providerName = useProviderName();
  const casual = variant === 'casual';
  // the AI for the next new chat: the project's, else the user's default
  const [nextProvider, setNextProvider] = useState<string>('');
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatId, setChatId] = useState<number | null>(null);
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [pending, setPending] = useState<PermRequest[]>([]);
  const [running, setRunning] = useState(false);
  const [draft, setDraft] = useState('');
  const [activity, setActivity] = useState('');
  const [activityDetail, setActivityDetail] = useState('');
  const [runStart, setRunStart] = useState<number | null>(null);
  const [text, setText] = useState(initialPrompt ?? '');
  const [sending, setSending] = useState(false);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const lastId = useRef(0);
  const sentAt = useRef(0);
  // "/" at the start of a message: pick one of the user's skills
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [slashIdx, setSlashIdx] = useState(0);
  const [slashOff, setSlashOff] = useState(false);
  const slashQuery = /^\/([a-z0-9-]*)$/i.exec(text)?.[1]?.toLowerCase();
  const slashList = useMemo(() => {
    if (slashQuery === undefined || slashOff) return [];
    const areaId = casual ? 'chat' : project.area;
    // one entry per name — the one that is really used (own, then added, then built-in)
    const rank = { mine: 0, global: 1, system: 2 } as const;
    const byName = new Map<string, Skill>();
    for (const k of skills ?? []) {
      if (!k.enabled) continue;
      const w = byName.get(k.slug);
      if (!w || rank[k.scope] < rank[w.scope]) byName.set(k.slug, k);
    }
    return [...byName.values()]
      .filter((k) => !k.areas.length || k.areas.includes(areaId))
      .filter((k) => k.slug.includes(slashQuery) || k.name.toLowerCase().includes(slashQuery))
      .sort((x, y) => Number(y.slug.startsWith(slashQuery)) - Number(x.slug.startsWith(slashQuery)) || x.slug.localeCompare(y.slug))
      .slice(0, 8);
  }, [skills, slashQuery, slashOff, casual, project.area]);
  useEffect(() => {
    setSlashIdx(0);
    if (slashQuery === undefined) {
      setSlashOff(false);
      return;
    }
    // (re)load when the menu opens: skills change on the Skills page and when the AI saves one
    if (slashQuery === '' || skills === null)
      api<{ skills: Skill[] }>('/skills')
        .then((r) => setSkills(r.skills))
        .catch(() => setSkills((k) => k ?? []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slashQuery]);
  const pickSkill = (k: Skill) => {
    setText(`/${k.slug} `);
    textarea.current?.focus();
  };

  const chat = chats.find((c) => c.id === chatId) ?? null;
  const readyAgents = (agents?.agents ?? []).filter((a) => a.install.state === 'ready');
  const defaultProvider = project.settings.provider || agents?.prefs.defaultProvider || 'claude';
  const newProvider = nextProvider || defaultProvider;
  // the AI of this chat (fixed when the chat starts), or the one a new chat would get
  const provider = chat?.provider ?? newProvider;
  const ai = providerName(provider);
  const agentInfo = (agents?.agents ?? []).find((a) => a.id === provider);

  const rel = useCallback(
    (p: string) => (project.dir && p.startsWith(project.dir + '/') ? p.slice(project.dir.length + 1) : p),
    [project.dir],
  );

  // ---- chats ------------------------------------------------------------------
  const loadChats = useCallback(async () => {
    const r = await api<{ chats: Chat[] }>(`/projects/${project.id}/chats`);
    setChats(r.chats);
    return r.chats;
  }, [project.id]);

  useEffect(() => {
    loadChats()
      .then((list) => setChatId((cur) => cur ?? list[0]?.id ?? null))
      .catch((err) => ui.toast(errMsg(err), 'error'));
  }, [loadChats, ui]);

  const mergeEvents = useCallback((incoming: ChatEvent[]) => {
    setEvents((prev) => {
      const map = new Map(prev.map((e) => [e.id, e]));
      for (const e of incoming) map.set(e.id, e);
      const list = [...map.values()].sort((a, b) => a.id - b.id);
      lastId.current = list.length ? list[list.length - 1].id : 0;
      return list;
    });
  }, []);

  const fetchEvents = useCallback(
    async (id: number, after = 0) => {
      const r = await api<{ chat: Chat; events: ChatEvent[]; pending: PermRequest[] }>(`/chats/${id}/events${after ? `?after=${after}` : ''}`);
      mergeEvents(r.events);
      setPending(r.pending);
      setRunning(r.chat.running);
      if (!r.chat.running) {
        setDraft('');
        setActivity('');
        setActivityDetail('');
        setRunStart(null);
      } else {
        setRunStart((t) => t ?? Date.now());
      }
    },
    [mergeEvents],
  );

  useEffect(() => {
    setEvents([]);
    setPending([]);
    setDraft('');
    setActivity('');
    setActivityDetail('');
    setRunStart(null);
    setRunning(false);
    lastId.current = 0;
    stick.current = true;
    if (!chatId) return;
    setLoadingEvents(true);
    fetchEvents(chatId)
      .catch((err) => ui.toast(errMsg(err), 'error'))
      .finally(() => setLoadingEvents(false));
    const unsub = socket.subscribe(`chat:${chatId}`);
    const off = socket.on((msg) => {
      if (msg.t === 'ws.open') {
        void fetchEvents(chatId, lastId.current).catch(() => {});
        return;
      }
      if (msg.chatId !== chatId) return;
      switch (msg.t) {
        case 'chat.event':
          if (msg.event.kind === 'assistant') {
            setDraft('');
            setActivity('');
            setActivityDetail('');
          }
          mergeEvents([msg.event]);
          break;
        case 'chat.delta':
          setDraft((d) => d + msg.text);
          setActivity('');
          setActivityDetail('');
          break;
        case 'chat.activity':
          setActivity(msg.activity);
          setActivityDetail(msg.detail ?? '');
          break;
        case 'chat.status':
          setRunning(msg.running);
          if (msg.running) setRunStart((t) => t ?? Date.now());
          if (!msg.running) {
            setDraft('');
            setActivity('');
            setActivityDetail('');
            setRunStart(null);
            void loadChats().catch(() => {});
          }
          break;
        case 'perm.request':
          setPending((p) => [...p.filter((x) => x.id !== msg.request.id), msg.request]);
          break;
        case 'perm.resolved':
          setPending((p) => p.filter((x) => x.id !== msg.id));
          break;
      }
    });
    return () => {
      unsub();
      off();
    };
  }, [chatId, fetchEvents, mergeEvents, loadChats, ui]);

  // ---- scrolling ------------------------------------------------------------------
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events, draft, activity, pending]);

  const onScroll = () => {
    const el = scroller.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
  };

  // ---- actions ------------------------------------------------------------------
  const newChat = async () => {
    const r = await api<{ chat: Chat }>(`/projects/${project.id}/chats`, { body: newProvider !== defaultProvider ? { provider: newProvider } : {} });
    setChats((c) => [r.chat, ...c]);
    setChatId(r.chat.id);
    return r.chat;
  };

  const send = async () => {
    const msg = text.trim();
    if (!msg || sending || running) return;
    sentAt.current = Date.now();
    setSending(true);
    try {
      const target = chat ?? (await newChat());
      stick.current = true;
      await api(`/chats/${target.id}/messages`, { body: { text: msg } });
      setText('');
      setRunning(true);
      setRunStart(Date.now());
      setActivity(`Starting ${providerName(target.provider)}…`);
      setActivityDetail('');
      if (target.title === 'New chat') void loadChats().catch(() => {});
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    // the Stop button appears where Send was: ignore the second half of a double click
    if (!chatId || Date.now() - sentAt.current < 1500) return;
    await api(`/chats/${chatId}/stop`, { body: {} }).catch((err) => ui.toast(errMsg(err), 'error'));
  };

  const reply = (req: PermRequest, allow: boolean, remember = false) => {
    socket.send({ t: 'perm.reply', id: req.id, allow, remember });
    setPending((p) => p.filter((x) => x.id !== req.id));
  };

  const attach = async (files: File[]) => {
    if (!files.length) return;
    const form = new FormData();
    for (const f of files) form.append('files', f, f.name || `pasted-${Date.now()}.png`);
    try {
      const r = await upload<{ saved: string[]; errors: string[] }>(`/projects/${project.id}/upload?dir=assets/uploads`, form);
      if (r.errors.length) ui.toast(r.errors.join('\n'), 'error');
      if (r.saved.length) setText((t) => `${t}${t && !t.endsWith('\n') ? '\n' : ''}${r.saved.map((p) => `[attached: ${p}]`).join('\n')}\n`);
    } catch (err) {
      ui.toast(errMsg(err), 'error');
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashList.length) {
      const sel = slashList[Math.min(slashIdx, slashList.length - 1)];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIdx((i) => (i + (e.key === 'ArrowDown' ? 1 : slashList.length - 1)) % slashList.length);
        return;
      }
      // Enter on a fully typed name sends it; otherwise it completes the name
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && sel.slug !== slashQuery)) {
        e.preventDefault();
        pickSkill(sel);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashOff(true);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files];
    if (files.length) {
      e.preventDefault();
      void attach(files);
    }
  };

  useEffect(() => {
    const t = textarea.current;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = `${Math.min(t.scrollHeight, 260)}px`;
  }, [text]);

  const renameChat = async () => {
    if (!chat) return;
    const title = await ui.prompt('Rename chat', chat.title);
    if (!title) return;
    await api(`/chats/${chat.id}`, { method: 'PATCH', body: { title } }).catch((err) => ui.toast(errMsg(err), 'error'));
    void loadChats();
  };
  const deleteChat = async () => {
    if (!chat) return;
    const ok = await ui.confirm({ title: 'Delete this chat?', body: 'The conversation is removed. Files and history of the project stay.', confirm: 'Delete', danger: true });
    if (!ok) return;
    await api(`/chats/${chat.id}`, { method: 'DELETE' }).catch((err) => ui.toast(errMsg(err), 'error'));
    const list = await loadChats();
    setChatId(list[0]?.id ?? null);
  };

  // ---- rendering ------------------------------------------------------------------
  const results = useMemo(() => {
    const m = new Map<string, ToolResult>();
    for (const ev of events) {
      if (ev.kind === 'tool_result') for (const r of ev.payload.results ?? []) m.set(r.toolUseId, r);
    }
    return m;
  }, [events]);

  const notConnected = provider === 'claude' ? !!claude && !claude.loggedIn : agentInfo?.status?.connected === false;
  const empty = !loadingEvents && events.length === 0 && !running;

  return (
    <div className="chat">
      <div className="chat-head">
        <select className="select" style={{ maxWidth: 340, height: 30 }} value={chatId ?? ''} onChange={(e) => setChatId(Number(e.target.value) || null)}>
          {!chats.length && <option value="">New chat</option>}
          {chats.map((c) => (
            <option key={c.id} value={c.id}>
              {c.running ? '● ' : ''}
              {c.title}
            </option>
          ))}
        </select>
        <button className="btn sm" onClick={() => void newChat().catch((err) => ui.toast(errMsg(err), 'error'))} title={`Start a new conversation with ${providerName(newProvider)}`}>
          <MessageSquarePlus size={14} /> New chat
        </button>
        {readyAgents.length > 0 && (
          <select
            className="select"
            style={{ width: 'auto', maxWidth: 190, height: 30, fontSize: 13 }}
            value={newProvider}
            onChange={(e) => setNextProvider(e.target.value)}
            title="AI for new chats"
          >
            <option value="claude">Claude</option>
            {readyAgents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        )}
        {chat && readyAgents.length > 0 && (
          <span className="badge" title="The AI of this chat">
            {ai}
          </span>
        )}
        {chat && (
          <>
            <button className="btn sm ghost icon" onClick={renameChat} title="Rename">
              <Pencil size={14} />
            </button>
            <button className="btn sm ghost icon" onClick={deleteChat} title="Delete chat">
              <Trash2 size={14} />
            </button>
          </>
        )}
        <span className="spacer" />
        {headerExtra}
        {chat && chat.totalCostUsd > 0 && (
          <span className="faint small" title="Total API cost reported by the AI for this chat (subscription plans are not billed per token)">
            ${chat.totalCostUsd.toFixed(3)}
          </span>
        )}
      </div>

      <div className="chat-scroll" ref={scroller} onScroll={onScroll}>
        <div className="chat-inner">
          {notConnected && (
            <div className="notice info">
              <KeyRound size={18} />
              <div>
                {provider === 'claude' ? 'Your Claude account is not connected yet.' : `${ai} is not connected yet.`}{' '}
                <Link to="/account">Connect it on the Account page</Link> — then {ai} can work {casual ? 'here' : 'in this project'}.
              </div>
            </div>
          )}
          {loadingEvents && (
            <div className="center" style={{ padding: 30 }}>
              <Spinner />
            </div>
          )}
          {empty &&
            (casual ? (
              <Empty icon={MessageSquarePlus} title={`Chat with ${ai}`}>
                Ask anything — questions, ideas, explanations, writing help. Attach images or files with the clip. {ai} can search the web here; to have something
                made (music, 3D, games, apps …) start a project in an area of the sidebar.
              </Empty>
            ) : (
              <Empty icon={MessageSquarePlus} title={`What should ${ai} make in “${project.name}”?`}>
                Describe it in your own words. {ai} works in this project folder, checks its work and saves a version after every turn.
              </Empty>
            ))}
          {events.map((ev) => (
            <EventView key={ev.id} ev={ev} results={results} running={running} projectId={project.id} rel={rel} onOpenHistory={onOpenHistory} ai={ai} />
          ))}
          {running && draft && (
            <div className="msg-assistant draft">
              <Markdown text={draft} />
            </div>
          )}
          {running && (
            <div className="activity-box">
              <div className="activity">
                <Spinner size={14} /> <span className="pulse grow">{activity || `${ai} is working…`}</span>
                {runStart && <Elapsed since={runStart} />}
              </div>
              {activityDetail && <pre className="activity-detail">{activityDetail}</pre>}
            </div>
          )}
        </div>
      </div>

      <div className="composer-wrap">
        <div className="composer">
          {provider === 'claude' && <LimitWarning limits={limits} />}
          {pending.map((p) => (
            <PermissionCard key={p.id} req={p} rel={rel} onReply={reply} ai={ai} />
          ))}
          {empty && area?.starters?.length ? (
            <div className="starters">
              {area.starters.map((s) => (
                <button key={s} className="chip" onClick={() => setText(s)}>
                  {s}
                </button>
              ))}
            </div>
          ) : null}
          {slashList.length > 0 && (
            <div className="slash-menu" role="listbox">
              {slashList.map((k, i) => (
                <button
                  key={k.key}
                  role="option"
                  aria-selected={i === slashIdx}
                  className={i === slashIdx ? 'active' : ''}
                  onMouseEnter={() => setSlashIdx(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickSkill(k);
                  }}
                >
                  <GraduationCap size={14} />
                  <span className="mono">/{k.slug}</span>
                  <span className="faint ellipsis grow">{k.description}</span>
                </button>
              ))}
              <div className="faint small" style={{ padding: '4px 10px 2px' }}>
                ↑↓ choose · Tab complete · Enter send — skills are managed on the <Link to="/skills">Skills</Link> page
              </div>
            </div>
          )}
          <div className="composer-box">
            <textarea
              ref={textarea}
              rows={1}
              placeholder={
                running
                  ? `${ai} is working — you can type your next message`
                  : casual
                    ? `Message ${ai}…  (Enter to send, Shift+Enter for a new line)`
                    : `Ask ${ai} to create, change or explain something…  (Enter to send, Shift+Enter for a new line)`
              }
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
            />
            <button className="btn ghost icon" title="Attach files (saved to assets/uploads)" onClick={() => fileInput.current?.click()}>
              <Paperclip size={16} />
            </button>
            {running ? (
              <button className="btn danger" onClick={stop} title={`Stop ${ai}`}>
                <Square size={14} /> Stop
              </button>
            ) : (
              <button className="btn primary" onClick={send} disabled={!text.trim() || sending}>
                {sending ? <Spinner size={14} /> : <Send size={14} />} Send
              </button>
            )}
          </div>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              void attach(files);
            }}
          />
        </div>
      </div>
    </div>
  );
}

function EventView({
  ev,
  results,
  running,
  projectId,
  rel,
  onOpenHistory,
  ai,
}: {
  ev: ChatEvent;
  results: Map<string, ToolResult>;
  running: boolean;
  projectId: number;
  rel: (p: string) => string;
  onOpenHistory: () => void;
  /** name of the chat's AI */
  ai: string;
}) {
  const p = ev.payload ?? {};
  switch (ev.kind) {
    case 'user':
      return (
        <div className="msg-user">
          {p.skill && (
            <span className="skill-chip" title={`The skill "${p.skill}" was applied to this message`}>
              <GraduationCap size={12} /> {p.skill}
            </span>
          )}
          {p.text}
        </div>
      );
    case 'assistant':
      return (
        <div className={p.parent ? 'msg-sub col' : 'col'} style={{ gap: 8 }}>
          {(p.blocks ?? []).map((b: { type: string; text?: string } & ToolBlock, i: number) =>
            b.type === 'text' ? (
              <div key={i} className="msg-assistant">
                <Markdown text={b.text ?? ''} />
              </div>
            ) : b.type === 'tool_use' ? (
              <ToolCall key={i} block={b} result={results.get(b.id)} running={running} projectId={projectId} rel={rel} />
            ) : b.type === 'thinking' ? (
              <details key={i} className="msg-thinking">
                <summary>Thinking</summary>
                <pre>{b.text}</pre>
              </details>
            ) : null,
          )}
        </div>
      );
    case 'result': {
      if (p.isError) {
        return (
          <div className="notice error">
            <CircleAlert size={18} />
            <div className="grow">
              <b>{ai} stopped with an error</b>
              {p.text && <pre>{p.text}</pre>}
              {p.errors?.length ? <pre>{p.errors.join('\n')}</pre> : null}
              {p.hint && (
                <div style={{ marginTop: 6 }}>
                  {p.hint} <Link to="/account">Open Account</Link>
                </div>
              )}
            </div>
          </div>
        );
      }
      const secs = p.durationMs ? Math.round(p.durationMs / 1000) : null;
      return (
        <div className="result-line">
          <span>
            Done{secs !== null ? ` in ${secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`}` : ''}
            {p.turns ? ` · ${p.turns} turn${p.turns === 1 ? '' : 's'}` : ''}
            {typeof p.costUsd === 'number' && p.costUsd > 0 ? ` · $${p.costUsd.toFixed(3)}` : ''}
          </span>
        </div>
      );
    }
    case 'error':
      if (p.stopped) return <div className="result-line">Stopped.</div>;
      return (
        <div className="notice error">
          <CircleAlert size={18} />
          <div className="grow">
            <b>{ai} could not run</b>
            <pre>{p.message}</pre>
            {p.hint && (
              <div style={{ marginTop: 6 }}>
                {p.hint} <Link to="/account">Open Account</Link>
              </div>
            )}
          </div>
        </div>
      );
    case 'checkpoint':
      return (
        <div className="checkpoint">
          <GitCommitHorizontal size={14} />
          <span>
            Version saved · {p.files} file{p.files === 1 ? '' : 's'} changed ·{' '}
            <a
              href="#history"
              onClick={(e) => {
                e.preventDefault();
                onOpenHistory();
              }}
            >
              history
            </a>
          </span>
        </div>
      );
    case 'system':
      if (p.subtype === 'init') {
        const other = !!p.provider && p.provider !== 'claude';
        if (p.casual) return <div className="result-line">{other ? `${p.agent ?? ai}${p.model ? ` · ${p.model}` : ''}` : (p.model ?? 'Claude')}</div>;
        const servers: { name: string; status: string }[] = Array.isArray(p.mcpServers) ? p.mcpServers : [];
        return (
          <div className="result-line">
            {other ? `${p.agent ?? ai} ${p.version ?? ''}` : `Claude Code ${p.version ?? ''}`} · {p.model ?? 'default model'}
            {p.resumed ? ' · conversation resumed' : ''}
            {servers.length ? ` · tools: ${servers.map((s) => `${s.name}${s.status === 'connected' ? '' : ` (${s.status})`}`).join(', ')}` : ''}
          </div>
        );
      }
      if (p.subtype === 'compact') return <div className="result-line">Conversation compacted to save context.</div>;
      if (p.subtype === 'notice')
        return (
          <div className={`notice ${p.level === 'error' ? 'error' : p.level === 'warning' ? 'warn' : 'info'}`}>
            <CircleAlert size={16} />
            <div className="grow">{p.text}</div>
          </div>
        );
      if (p.subtype === 'limit') {
        const info = p.info ?? {};
        const rejected = info.status === 'rejected';
        const reset = typeof info.resetsAt === 'number' ? fmtReset(new Date(info.resetsAt * 1000).toISOString()) : '';
        const pct = typeof info.utilization === 'number' ? Math.round(info.utilization * 100) : null;
        return (
          <div className={`notice ${rejected ? 'error' : 'warn'}`}>
            <Gauge size={16} />
            <div className="grow">
              {rejected ? 'Claude plan limit reached' : `Claude plan limit ${pct !== null ? `${pct}% ` : ''}used`}
              {info.rateLimitType ? ` (${String(info.rateLimitType).replace(/_/g, ' ')})` : ''}
              {reset ? ` — resets ${reset}` : ''}. <Link to="/account#usage">Usage</Link>
            </div>
          </div>
        );
      }
      return null;
    default:
      return null;
  }
}

function PermissionCard({
  req,
  rel,
  onReply,
  ai,
}: {
  req: PermRequest;
  rel: (p: string) => string;
  onReply: (r: PermRequest, allow: boolean, remember?: boolean) => void;
  ai: string;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const input = (req.input ?? {}) as Record<string, any>;
  const { label, detail } = summarize(req.toolName, input, rel);
  return (
    <div className="perm-card">
      <div className="row">
        <ShieldQuestion size={18} color="var(--warn)" />
        <b>
          {ai} wants to {label.toLowerCase()}
        </b>
        <span className="faint small mono">{req.toolName}</span>
      </div>
      <pre>{req.toolName === 'Bash' ? input.command : req.toolName === 'Write' ? `${detail}\n\n${String(input.content ?? '').slice(0, 1500)}` : detail || JSON.stringify(input, null, 2)}</pre>
      <div className="row">
        <button className="btn primary sm" onClick={() => onReply(req, true)}>
          Allow
        </button>
        <button className="btn sm" onClick={() => onReply(req, true, true)} title={`Allow ${req.toolName} without asking until this run ends`}>
          Allow {req.toolName} for this run
        </button>
        <span className="spacer" />
        <button className="btn danger sm" onClick={() => onReply(req, false)}>
          Deny
        </button>
      </div>
    </div>
  );
}
