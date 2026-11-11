'use strict';
/**
 * Multiplayer server — WebSocket rooms. Deployed and run by Everything Studio:
 *   PORT       port to listen on (set by the Studio)
 *   DATA_DIR   folder that survives redeploys (not used here — see the storage template)
 *   PUBLIC_URL how apps reach this server, e.g. https://studio.example.com/srv/my-game
 *
 * Clients connect to  <PUBLIC_URL with ws:// or wss://>/ws  and talk JSON:
 *   → { "type": "join",  "room": "lobby", "name": "Ada" }
 *   → { "type": "state", "data": { "x": 1, "y": 2 } }      position, score … (relayed to the room)
 *   → { "type": "chat",  "text": "hi" }
 *   ← { "type": "welcome", "id": "p1", "room": "lobby", "players": [ { "id", "name", "data" } ] }
 *   ← { "type": "joined", "player": { … } }   ← { "type": "left", "id": "p2" }
 *   ← { "type": "state", "id": "p2", "data": { … } }   ← { "type": "chat", "id", "name", "text" }
 *   ← { "type": "error", "message": "…" }
 */
const http = require('node:http');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const MAX_PLAYERS_PER_ROOM = 16;

/** room name → Map(player id → player) */
const rooms = new Map();
let nextId = 1;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') return json(res, 200, { ok: true, rooms: rooms.size, players: countPlayers() });
  if (url.pathname === '/rooms') {
    return json(res, 200, [...rooms].map(([name, players]) => ({ name, players: players.size })));
  }
  json(res, 404, { error: 'not found — connect with a WebSocket to /ws' });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

wss.on('connection', (ws) => {
  const player = { id: `p${nextId++}`, name: 'player', room: null, data: {}, ws };
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(ws, { type: 'error', message: 'messages must be JSON' });
    }
    switch (msg.type) {
      case 'join':
        return join(player, String(msg.room || 'lobby').slice(0, 40), String(msg.name || 'player').slice(0, 24));
      case 'state':
        if (!player.room) return send(ws, { type: 'error', message: 'join a room first' });
        player.data = msg.data && typeof msg.data === 'object' ? msg.data : {};
        return broadcast(player.room, { type: 'state', id: player.id, data: player.data }, player);
      case 'chat':
        if (!player.room) return;
        return broadcast(player.room, { type: 'chat', id: player.id, name: player.name, text: String(msg.text || '').slice(0, 500) });
      case 'leave':
        return leave(player);
      default:
        return send(ws, { type: 'error', message: `unknown message type "${msg.type}"` });
    }
  });
  ws.on('close', () => leave(player));
});

function join(player, roomName, name) {
  leave(player);
  const room = rooms.get(roomName) ?? new Map();
  if (room.size >= MAX_PLAYERS_PER_ROOM) return send(player.ws, { type: 'error', message: 'room is full' });
  rooms.set(roomName, room);
  player.room = roomName;
  player.name = name;
  room.set(player.id, player);
  send(player.ws, { type: 'welcome', id: player.id, room: roomName, players: [...room.values()].map(publicPlayer) });
  broadcast(roomName, { type: 'joined', player: publicPlayer(player) }, player);
  console.log(`${name} (${player.id}) joined ${roomName} — ${room.size} player(s)`);
}

function leave(player) {
  if (!player.room) return;
  const room = rooms.get(player.room);
  room?.delete(player.id);
  broadcast(player.room, { type: 'left', id: player.id });
  if (room && room.size === 0) rooms.delete(player.room);
  player.room = null;
}

const publicPlayer = (p) => ({ id: p.id, name: p.name, data: p.data });
const countPlayers = () => [...rooms.values()].reduce((n, r) => n + r.size, 0);

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(roomName, msg, except) {
  const data = JSON.stringify(msg);
  for (const p of rooms.get(roomName)?.values() ?? []) if (p !== except && p.ws.readyState === p.ws.OPEN) p.ws.send(data);
}
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// drop connections that stopped answering (mobile networks, closed laptops)
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
  console.log(`multiplayer server listening on ${PORT} — clients: ${(process.env.PUBLIC_URL || '').replace(/^http/, 'ws')}/ws`);
});

process.on('SIGTERM', () => {
  clearInterval(heartbeat);
  for (const ws of wss.clients) ws.close(1001, 'server restarting');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});
