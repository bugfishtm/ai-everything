import { ListOrdered, MessageCircleQuestionMark, Pencil, Play, Send, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, errMsg, type QueuedMessage } from '../api';
import { Markdown } from './Markdown';
import { Spinner, useUi } from './ui';

// ---------------------------------------------------------------------------------------------
// Message queue: messages sent while the AI works, shown under the conversation until they start
// ---------------------------------------------------------------------------------------------
export function QueueList({ chatId, queue, paused, running, ai }: { chatId: number; queue: QueuedMessage[]; paused: boolean; running: boolean; ai: string }) {
  const ui = useUi();
  if (!queue.length) return null;
  const call = (fn: () => Promise<unknown>) => void fn().catch((err) => ui.toast(errMsg(err), 'error'));
  const edit = (m: QueuedMessage) =>
    call(async () => {
      const text = await ui.prompt('Edit the queued message', m.text);
      if (text === null || !text.trim() || text === m.text) return;
      await api(`/chats/${chatId}/queue/${m.id}`, { method: 'PATCH', body: { text } });
    });
  return (
    <div className="queue-box" aria-live="polite">
      <div className="queue-head">
        <ListOrdered size={14} />
        <b className="grow">
          {queue.length} queued message{queue.length === 1 ? '' : 's'}
          <span className="faint" style={{ fontWeight: 'normal' }}>
            {' '}
            · {paused ? 'paused' : running ? `${ai} answers them in order when this turn is done` : 'starting…'}
          </span>
        </b>
        {paused && !running && (
          <button className="btn sm primary" onClick={() => call(() => api(`/chats/${chatId}/queue/resume`, { body: {} }))} title="Send the queued messages one after another">
            <Play size={13} /> Continue
          </button>
        )}
        <button className="btn sm ghost" onClick={() => call(() => api(`/chats/${chatId}/queue`, { method: 'DELETE' }))} title="Remove all queued messages">
          Clear
        </button>
      </div>
      {paused && (
        <div className="faint small" style={{ margin: '0 0 6px' }}>
          The queue waits because the last turn was stopped or failed (or the Studio restarted). Continue when you are ready.
        </div>
      )}
      <ol className="queue-list">
        {queue.map((m) => (
          <li key={m.id}>
            <span className="grow queue-text" title={m.text}>
              {m.text}
            </span>
            <button className="btn sm ghost icon" onClick={() => edit(m)} title="Edit">
              <Pencil size={13} />
            </button>
            <button className="btn sm ghost icon" onClick={() => call(() => api(`/chats/${chatId}/queue/${m.id}`, { method: 'DELETE' }))} title="Remove">
              <Trash2 size={13} />
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Side chat (/btw): quick questions about the main chat that do not go into it
// ---------------------------------------------------------------------------------------------
export interface SideTurn {
  q: string;
  a: string | null;
  error?: string;
}

export function SideChat({
  chatId,
  turns,
  setTurns,
  ask,
  onClose,
}: {
  chatId: number;
  turns: SideTurn[];
  setTurns: (fn: (t: SideTurn[]) => SideTurn[]) => void;
  /** a question to ask right away (from "/btw …" in the main composer); id tells repeats apart */
  ask: { text: string; id: number } | null;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const asked = useRef<number | null>(null);

  const submit = async (question: string) => {
    const qText = question.trim();
    if (!qText || busy) return;
    setBusy(true);
    setText('');
    // earlier answered turns go along: the server keeps nothing of the side chat
    const history = turns.filter((t) => t.a).slice(-8).map((t) => ({ q: t.q, a: t.a! }));
    setTurns((t) => [...t, { q: qText, a: null }]);
    try {
      const r = await api<{ answer: string }>(`/chats/${chatId}/side`, { body: { question: qText, history } });
      setTurns((t) => t.map((x, i) => (i === t.length - 1 ? { ...x, a: r.answer } : x)));
    } catch (err) {
      setTurns((t) => t.map((x, i) => (i === t.length - 1 ? { ...x, a: null, error: errMsg(err) } : x)));
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  };

  useEffect(() => {
    if (ask && asked.current !== ask.id) {
      asked.current = ask.id;
      void submit(ask.text);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask]);

  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [turns, busy]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit(text);
    }
    if (e.key === 'Escape') onClose();
  };

  return (
    <div className="side-chat" role="region" aria-label="Side chat">
      <div className="side-chat-head">
        <MessageCircleQuestionMark size={15} />
        <b className="grow">
          Side chat <span className="faint" style={{ fontWeight: 'normal' }}>· /btw — not part of the main chat, does not interrupt it</span>
        </b>
        {turns.length > 0 && (
          <button className="btn sm ghost" onClick={() => setTurns(() => [])} disabled={busy} title="Start the side chat over">
            Clear
          </button>
        )}
        <button className="btn sm ghost icon" onClick={onClose} aria-label="Close the side chat">
          <X size={14} />
        </button>
      </div>
      <div className="side-chat-body" ref={box}>
        {!turns.length && (
          <div className="faint small">
            Ask about this chat — “what just happened?”, “which files did it change?”, “why did it stop?”. Claude answers from the conversation and may read
            project files, but changes nothing.
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className="side-turn">
            <div className="side-q">{t.q}</div>
            {t.a !== null ? (
              <div className="side-a">
                <Markdown text={t.a} />
              </div>
            ) : t.error ? (
              <div className="form-error small">{t.error}</div>
            ) : (
              <div className="faint small row" style={{ gap: 6 }}>
                <Spinner size={12} /> Looking at the chat…
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="side-chat-input">
        <textarea
          ref={input}
          rows={1}
          className="input"
          placeholder="Ask about this chat…  (Enter to ask, Esc to close)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          autoFocus
        />
        <button className="btn primary sm" onClick={() => void submit(text)} disabled={busy || !text.trim()}>
          {busy ? <Spinner size={13} /> : <Send size={13} />} Ask
        </button>
      </div>
    </div>
  );
}
