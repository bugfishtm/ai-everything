# Multiplayer server

WebSocket rooms: players join a room, send their state (position, score …) and chat;
everybody in the room receives it. Deployed and run by Everything Studio
(`studio service deploy`, Server tab on the website).

- WebSocket: `<server URL>/ws` (`wss://` for `https://`, `ws://` for `http://`)
- `GET /health`, `GET /rooms`
- Messages: see the top of `index.js`.

## Clients

**Browser / JS game** (served by the Studio — same host):

```js
const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/srv/<slug>/ws`;
const ws = new WebSocket(url);
ws.onopen = () => ws.send(JSON.stringify({ type: 'join', room: 'lobby', name: 'Ada' }));
ws.onmessage = (e) => { const msg = JSON.parse(e.data); /* welcome, joined, left, state, chat */ };
// every frame or every 100 ms:
ws.send(JSON.stringify({ type: 'state', data: { x, y } }));
```

**Android (Kotlin, OkHttp)** — needs `<uses-permission android:name="android.permission.INTERNET"/>`
(and `android:usesCleartextTraffic="true"` for `ws://`):

```kotlin
val client = OkHttpClient()
val ws = client.newWebSocket(Request.Builder().url("$SERVER_URL/ws").build(), object : WebSocketListener() {
    override fun onOpen(ws: WebSocket, r: Response) { ws.send("""{"type":"join","room":"lobby","name":"Ada"}""") }
    override fun onMessage(ws: WebSocket, text: String) { /* parse JSON */ }
})
```

**Windows (C#)**:

```csharp
using var ws = new System.Net.WebSockets.ClientWebSocket();
await ws.ConnectAsync(new Uri($"{ServerUrl}/ws"), CancellationToken.None);
await ws.SendAsync(Encoding.UTF8.GetBytes("{\"type\":\"join\",\"room\":\"lobby\",\"name\":\"Ada\"}"),
    WebSocketMessageType.Text, true, CancellationToken.None);
```

Use the server URL the Studio shows (`ws://…` / `wss://…` + `/srv/<slug>`), keep it in one
config constant so it can change.
