/**
 * Minimal Agent Client Protocol (ACP, protocol version 1) client: newline-delimited
 * JSON-RPC 2.0 over the agent's stdio. https://agentclientprotocol.com
 *
 * The Studio is the "client" (like an editor): it starts an agent process (Gemini CLI,
 * OpenCode, Codex via codex-acp, …), opens sessions, sends prompts, receives streaming
 * `session/update` notifications and answers `session/request_permission` requests.
 * File system and terminal capabilities are NOT offered — agents use their own tools,
 * which run as the user's sandbox account anyway.
 */
import type { ChildProcess } from 'node:child_process';
import readline from 'node:readline';

export const ACP_PROTOCOL_VERSION = 1;

export interface AcpError extends Error {
  code?: number;
  data?: unknown;
}

export type PermissionOutcome = { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string };

export interface AcpHandlers {
  onUpdate: (params: { sessionId: string; update: Record<string, unknown> }) => void;
  onPermission: (params: {
    sessionId: string;
    toolCall: Record<string, unknown>;
    options: { optionId: string; name: string; kind: string }[];
  }) => Promise<PermissionOutcome>;
  /** stderr lines and anything else worth logging */
  onLog?: (line: string) => void;
}

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: AcpError) => void;
  timer: NodeJS.Timeout | null;
}

export class AcpClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;
  stderrTail = '';
  exitInfo: { code: number | null; signal: string | null } | null = null;

  constructor(
    readonly child: ChildProcess,
    private readonly handlers: AcpHandlers,
  ) {
    const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
    rl.on('line', (line) => this.onLine(line));
    child.stderr?.on('data', (d: Buffer) => {
      const s = d.toString();
      this.stderrTail = (this.stderrTail + s).slice(-8000);
      for (const l of s.split('\n')) if (l.trim()) this.handlers.onLog?.(l);
    });
    child.stdin?.on('error', () => {});
    child.on('close', (code, signal) => {
      this.exitInfo = { code, signal };
      this.failAll(`the agent process ended (${signal ? `signal ${signal}` : `exit code ${code}`})`);
    });
    child.on('error', (err) => this.failAll(err.message));
  }

  get alive(): boolean {
    return !this.closed && this.exitInfo === null;
  }

  private failAll(message: string): void {
    this.closed = true;
    const tail = this.stderrTail.trim().split('\n').slice(-12).join('\n');
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(Object.assign(new Error(tail ? `${message}\n${tail}` : message), { code: -32099 }));
      this.pending.delete(id);
    }
  }

  private write(msg: Record<string, unknown>): void {
    if (this.closed || !this.child.stdin?.writable) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = 120_000): Promise<T> {
    if (this.closed) return Promise.reject(Object.assign(new Error('the agent process is not running'), { code: -32099 }));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(Object.assign(new Error(`${method}: no answer within ${Math.round(timeoutMs / 1000)}s`), { code: -32098 }));
            }, timeoutMs)
          : null;
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  private respond(id: unknown, result: unknown): void {
    this.write({ id, result });
  }

  private respondError(id: unknown, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // some agents print banners or logs on stdout
      this.handlers.onLog?.(line);
      return;
    }
    const method = typeof m.method === 'string' ? m.method : null;
    // a response to one of our requests
    if (!method && m.id !== undefined) {
      const p = this.pending.get(Number(m.id));
      if (!p) return;
      this.pending.delete(Number(m.id));
      if (p.timer) clearTimeout(p.timer);
      if (m.error) {
        const e = m.error as { code?: number; message?: string; data?: unknown };
        const detail = e.data && typeof e.data === 'object' ? JSON.stringify(e.data).slice(0, 600) : e.data ? String(e.data).slice(0, 600) : '';
        p.reject(Object.assign(new Error(`${e.message ?? 'error'}${detail ? ` — ${detail}` : ''}`), { code: e.code, data: e.data }));
      } else p.resolve(m.result);
      return;
    }
    if (!method) return;
    const params = (m.params ?? {}) as Record<string, unknown>;
    // notifications from the agent
    if (m.id === undefined) {
      if (method === 'session/update') {
        try {
          this.handlers.onUpdate(params as { sessionId: string; update: Record<string, unknown> });
        } catch (err) {
          this.handlers.onLog?.(`update handler failed: ${(err as Error).message}`);
        }
      }
      return;
    }
    // requests from the agent
    if (method === 'session/request_permission') {
      this.handlers
        .onPermission(params as Parameters<AcpHandlers['onPermission']>[0])
        .then((outcome) => this.respond(m.id, { outcome }))
        .catch(() => this.respond(m.id, { outcome: { outcome: 'cancelled' } }));
      return;
    }
    // fs/*, terminal/*, elicitation/* … are not offered (see initialize)
    this.respondError(m.id, -32601, `${method} is not supported by this client`);
  }

  close(): void {
    this.closed = true;
    this.failAll('closed');
  }
}
