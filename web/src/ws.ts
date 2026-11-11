// Single WebSocket per tab with automatic reconnect and topic subscriptions.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WsMessage = { t: string; [k: string]: any };
type Listener = (msg: WsMessage) => void;

class Socket {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private topics = new Map<string, number>();
  private queue: string[] = [];
  private retry = 0;
  private stopped = true;
  connected = false;

  start(): void {
    this.stopped = false;
    if (!this.ws) this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.retry = 0;
      for (const topic of this.topics.keys()) ws.send(JSON.stringify({ t: 'sub', topic }));
      for (const m of this.queue.splice(0)) ws.send(m);
      this.emit({ t: 'ws.open' });
    };
    ws.onmessage = (e) => {
      try {
        this.emit(JSON.parse(e.data as string));
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      const was = this.connected;
      this.connected = false;
      if (this.ws === ws) this.ws = null;
      if (was) this.emit({ t: 'ws.close' });
      if (!this.stopped) setTimeout(() => !this.ws && !this.stopped && this.connect(), Math.min(10_000, 400 * 2 ** this.retry++));
    };
  }

  send(msg: WsMessage): void {
    const s = JSON.stringify(msg);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(s);
    else {
      this.queue.push(s);
      this.start();
    }
  }

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  subscribe(topic: string): () => void {
    const n = this.topics.get(topic) ?? 0;
    this.topics.set(topic, n + 1);
    if (n === 0 && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'sub', topic }));
    this.start();
    return () => {
      const m = (this.topics.get(topic) ?? 1) - 1;
      if (m <= 0) {
        this.topics.delete(topic);
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'unsub', topic }));
      } else this.topics.set(topic, m);
    };
  }

  private emit(msg: WsMessage): void {
    for (const l of [...this.listeners]) {
      try {
        l(msg);
      } catch (err) {
        console.error(err);
      }
    }
  }
}

export const socket = new Socket();
