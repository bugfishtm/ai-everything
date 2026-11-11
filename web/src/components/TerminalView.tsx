import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { RotateCcw, Power } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { randomId } from '../util';
import { socket } from '../ws';

export type TermKind = 'claude' | 'shell' | 'login';

export interface TerminalViewProps {
  kind: TermKind;
  projectId?: number;
  mode?: string;
  /** another AI than Claude Code: its own sign-in (login) or interactive UI (claude) */
  provider?: string;
  resumeChatId?: number;
  title?: ReactNode;
  onExit?: (code: number) => void;
  /** show the bar with restart / stop */
  bar?: boolean;
}

export function TerminalView({ kind, projectId, mode, provider, resumeChatId, title, onExit, bar = true }: TerminalViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'connecting' | 'running' | 'exited' | 'error'>('connecting');
  const actions = useRef<{ restart: () => void; kill: () => void } | null>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  useEffect(() => {
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', 'Cascadia Code', Menlo, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 8000,
      allowProposedApi: true,
      theme: {
        background: '#0b0d12',
        foreground: '#e7e9ee',
        cursor: '#a78bfa',
        selectionBackground: 'rgba(167,139,250,0.35)',
        black: '#1a1f2a',
        brightBlack: '#5b6478',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener,noreferrer')));
    term.open(host.current!);
    try {
      fit.fit();
    } catch {
      /* hidden */
    }

    const id = randomId();
    const open = (restart = false) => {
      setStatus('connecting');
      socket.send({ t: 'term.open', id, kind, projectId, mode, provider, resumeChatId, cols: term.cols, rows: term.rows, restart });
    };
    const off = socket.on((msg) => {
      if (msg.t === 'ws.open') {
        open();
        return;
      }
      if (msg.id !== id) return;
      switch (msg.t) {
        case 'term.attached':
          term.reset();
          setStatus('running');
          break;
        case 'term.out':
          term.write(msg.data);
          break;
        case 'term.exit':
          term.write(`\r\n\x1b[90m[process exited with code ${msg.code}]\x1b[0m\r\n`);
          setStatus('exited');
          onExitRef.current?.(msg.code);
          break;
        case 'term.error':
          term.write(`\r\n\x1b[31m${msg.error}\x1b[0m\r\n`);
          setStatus('error');
          break;
      }
    });
    const input = term.onData((data) => socket.send({ t: 'term.in', id, data }));
    const ro = new ResizeObserver(() => {
      if (!host.current?.clientWidth) return;
      try {
        fit.fit();
        socket.send({ t: 'term.resize', id, cols: term.cols, rows: term.rows });
      } catch {
        /* ignore */
      }
    });
    ro.observe(host.current!);
    actions.current = {
      restart: () => {
        term.reset();
        open(true);
      },
      kill: () => socket.send({ t: 'term.close', id, kill: true }),
    };
    open();
    if (kind !== 'login') term.focus();

    return () => {
      off();
      input.dispose();
      ro.disconnect();
      socket.send({ t: 'term.close', id });
      term.dispose();
    };
  }, [kind, projectId, mode, provider, resumeChatId]);

  return (
    <div className="col" style={{ flex: 1, minHeight: 0, gap: 0, height: '100%' }}>
      {bar && (
        <div className="term-bar">
          <span className={`status-dot ${status === 'running' ? 'ok' : 'bad'}`} />
          <span className="muted">{title ?? kind}</span>
          <span className="faint small">{status}</span>
          <span className="spacer" />
          <button className="btn sm ghost" onClick={() => actions.current?.restart()} title="Restart">
            <RotateCcw size={14} /> Restart
          </button>
          {status === 'running' && (
            <button className="btn sm ghost" onClick={() => actions.current?.kill()} title="Stop the process">
              <Power size={14} /> Stop
            </button>
          )}
        </div>
      )}
      <div className="term-wrap">
        <div ref={host} style={{ height: '100%' }} />
      </div>
    </div>
  );
}
