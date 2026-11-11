# API server

A small HTTP JSON API with a file in `$DATA_DIR` (survives redeploys) — extend it with the
endpoints your app needs. Deployed and run by Everything Studio (`studio service deploy`,
Server tab on the website).

- `GET /health`
- `GET /api/messages`, `POST /api/messages` `{ "text": "…" }`

Clients use the server URL the Studio shows (`…/srv/<slug>`); browser games served by the
Studio can use `${location.protocol}//${location.host}/srv/<slug>`.
