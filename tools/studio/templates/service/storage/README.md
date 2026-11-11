# Storage server

Cloud saves (key-value per player/space) and leaderboards in SQLite — no dependencies (Node's
built-in `node:sqlite`). The database file lives in `$DATA_DIR`, which survives redeploys.
Deployed and run by Everything Studio (`studio service deploy`, Server tab on the website).

| Method | Path | |
|--------|------|-|
| GET | `/health` | |
| GET | `/api/kv/<space>` | list keys (space = player id, device id …) |
| GET / PUT / DELETE | `/api/kv/<space>/<key>` | JSON value |
| POST | `/api/scores/<board>` | `{ "player": "Ada", "score": 1200 }` |
| GET | `/api/scores/<board>?limit=10` | best scores |

Writes can require an API key: `studio service env API_KEY=…` → header `x-api-key`.

## Clients

```js
// JS (browser game served by the Studio — same host)
const API = `${location.protocol}//${location.host}/srv/<slug>`;
await fetch(`${API}/api/kv/${playerId}/save`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state) });
const top = await (await fetch(`${API}/api/scores/main?limit=10`)).json();
```

```kotlin
// Android (OkHttp) — INTERNET permission; cleartext allowed for http://
val body = """{"player":"Ada","score":1200}""".toRequestBody("application/json".toMediaType())
client.newCall(Request.Builder().url("$SERVER_URL/api/scores/main").post(body).build()).execute()
```

```csharp
// Windows (C#)
using var http = new HttpClient { BaseAddress = new Uri(ServerUrl + "/") };
await http.PutAsync($"api/kv/{playerId}/save", new StringContent(json, Encoding.UTF8, "application/json"));
```
