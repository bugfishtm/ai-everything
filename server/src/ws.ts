/**
 * One WebSocket per browser tab: chat streaming, terminals, permission prompts
 * and change notifications. Authenticated with the session cookie.
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { originAllowed, userFromRequest } from './auth.js';
import type { AuthUser } from './users.js';

export interface WsClient {
  id: number;
  ws: WebSocket;
  user: AuthUser;
  subs: Set<string>;
  alive: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Msg = Record<string, any>;
type Handler = (client: WsClient, msg: Msg) => void | Promise<void>;

const clients = new Set<WsClient>();
const handlers = new Map<string, Handler>();
const closeHandlers: ((c: WsClient) => void)[] = [];
let authorize: (user: AuthUser, topic: string) => Promise<boolean> = async () => false;
let nextId = 1;

export function onWs(type: string, h: Handler): void {
  handlers.set(type, h);
}
export function onWsClose(fn: (c: WsClient) => void): void {
  closeHandlers.push(fn);
}
export function setTopicAuthorizer(fn: (user: AuthUser, topic: string) => Promise<boolean>): void {
  authorize = fn;
}

/** Other WebSocket upgrades on the same port (e.g. /srv/<slug>/… → deployed servers). */
type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
const upgradeRoutes: [string, UpgradeHandler][] = [];
export function addUpgradeRoute(prefix: string, fn: UpgradeHandler): void {
  upgradeRoutes.push([prefix, fn]);
}

export function send(c: WsClient, msg: Msg): void {
  if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
}

export function publish(topic: string, msg: Msg): void {
  const data = JSON.stringify(msg);
  for (const c of clients) {
    if (c.subs.has(topic) && c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
  }
}

export function sendToUser(userId: number, msg: Msg): void {
  const data = JSON.stringify(msg);
  for (const c of clients) {
    if (c.user.id === userId && c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
  }
}

export function sendToAdmins(msg: Msg): void {
  const data = JSON.stringify(msg);
  for (const c of clients) {
    if (c.user.role === 'admin' && c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
  }
}

export function broadcast(msg: Msg): void {
  const data = JSON.stringify(msg);
  for (const c of clients) if (c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
}

export function connectedClients(): number {
  return clients.size;
}

/** The account was disabled, its password reset or it logged out everywhere: its open tabs lose the connection. */
export function closeUserSockets(userId: number): void {
  for (const c of clients) {
    if (c.user.id === userId) c.ws.close(4401, 'signed out');
  }
}

/**
 * Wires the WebSocket endpoint to the Studio's HTTP server. Returns the upgrade handler so
 * another listener (the HTTPS port, sites.ts) can serve the same endpoint.
 */
export function attachWs(server: Server): UpgradeHandler {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // a socket error after the upgrade request (reset, timeout) must never reach the process
    socket.on('error', () => socket.destroy());
    let url: URL;
    try {
      // request targets like "//" are not URLs
      url = new URL(req.url ?? '/', 'http://x');
    } catch {
      socket.destroy();
      return;
    }
    const route = upgradeRoutes.find(([prefix]) => url.pathname.startsWith(prefix));
    if (route) {
      try {
        route[1](req, socket, head);
      } catch (err) {
        console.warn('[ws] upgrade failed:', (err as Error).message);
        socket.destroy();
      }
      return;
    }
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    if (!originAllowed(req.headers.origin, req.headers.host)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    userFromRequest(req)
      .then((user) => {
        if (!user) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          const c: WsClient = { id: nextId++, ws, user, subs: new Set(), alive: true };
          clients.add(c);
          // protocol errors (a broken frame, a message over the size limit) end this connection only
          ws.on('error', () => ws.terminate());
          ws.on('pong', () => (c.alive = true));
          ws.on('message', (raw) => {
            let msg: Msg;
            try {
              msg = JSON.parse(raw.toString());
            } catch {
              return;
            }
            void dispatch(c, msg);
          });
          ws.on('close', () => {
            clients.delete(c);
            for (const fn of closeHandlers) {
              try {
                fn(c);
              } catch (err) {
                console.error('[ws] close handler', err);
              }
            }
          });
          send(c, { t: 'hello', userId: user.id });
        });
      })
      .catch(() => socket.destroy());
  };
  server.on('upgrade', onUpgrade);

  const ping = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      try {
        c.ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, 30_000);
  ping.unref();
  return onUpgrade;
}

async function dispatch(c: WsClient, msg: Msg): Promise<void> {
  try {
    if (msg.t === 'sub' && typeof msg.topic === 'string') {
      if (await authorize(c.user, msg.topic)) c.subs.add(msg.topic);
      else send(c, { t: 'error', error: `not allowed: ${msg.topic}` });
      return;
    }
    if (msg.t === 'unsub' && typeof msg.topic === 'string') {
      c.subs.delete(msg.topic);
      return;
    }
    const h = handlers.get(msg.t);
    if (h) await h(c, msg);
  } catch (err) {
    send(c, { t: 'error', ref: msg.id, error: (err as Error).message });
  }
}
