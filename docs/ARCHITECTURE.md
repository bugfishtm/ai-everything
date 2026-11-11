# Architecture

## Components

| Piece | Where | What |
|-------|-------|------|
| Website | `web/` (React 19, Vite, TypeScript) | login, areas, projects workspace, library, account, admin |
| API server | `server/` (Node 24, Express 5, ws, mysql2, node-pty) | auth, projects, files, chats, terminals, library, agent API |
| Claude Code | npm `@anthropic-ai/claude-code`, **downloaded at runtime** into `/data/sdk/claude-code` (not in the image) | spawned per user + project |
| Tools | `tools/*/` → `/opt/studio/tools` | `studio-daw`, `studio-3d`, `studio-image`, `studio-video`, `studio-stickman` (creative software), `studio` (library/packs/skills/servers/websites CLI + MCP), `browser` (headless Chromium) |
| Skills | `skills/*/SKILL.md` → `/opt/studio/skills` | built-in know-how the AI loads on demand (users add their own in the database) |
| Templates | `templates/` → `/opt/studio/templates` | project skeletons + per-area guides for `CLAUDE.md` |
| Database | MariaDB 10.11 **inside the same container** (MySQL compatible; or an external server via `MYSQL_HOST`) | users, sessions, projects, chats, chat events, assets, settings, usage |

## Image layers (Dockerfile)

1. **toolchain** (cached, rarely rebuilt): Debian bookworm + Node 24, Python venv with
   creative libraries, ffmpeg, ImageMagick, SoX, FluidSynth + GM soundfont, JDK 17 +
   Android SDK + Gradle, .NET 10 SDK, mingw-w64 + NSIS, (Wine), Playwright + Chromium +
   Playwright MCP. Each group can be switched off with a build arg.
2. **app-build**: compiles the server and the website.
3. **runtime**: toolchain + tools + templates + app. `VOLUME /data /var/lib/mysql`. No Claude
   Code (Anthropic's proprietary software must not be redistributed) — `INSTALL_CLAUDE_CODE=true`
   adds it for private images only.

## Claude Code at runtime (`server/src/claudecli.ts`)

* Start: `CLAUDE_BIN` (tests) → runtime install in `/data/sdk/claude-code` → a copy in a self-built
  image. Missing → `npm install --global --prefix /data/sdk/claude-code @anthropic-ai/claude-code@<version>`
  in the background (status + log on Admin → Claude Code, banner for users, chats answer 503 until
  ready). `config.claudeBin` points at the result; user PATHs include its `bin`.
* `CLAUDE_CODE_VERSION=latest` → newest release at start and daily (registry check); an exact
  version pins it. Updates replace files in place — running sessions keep their binary.

## One container, two volumes

```
tini ─ studio-entrypoint (bash)                       docker/entrypoint.sh + docker/db.sh
        ├─ mariadbd --user=mysql                      socket /run/mysqld/mysqld.sock, no TCP port
        └─ node server (root)                         everything below
```

* `studio-data` → `/data` (projects, library, packs, homes, SDKs, `home/.studio/` secrets) and
  `studio-db` → `/var/lib/mysql`. Named volumes (ext4 inside Docker) keep Linux owners and modes,
  which the per-user isolation relies on.
* First start on an empty `studio-db`: `mariadb-install-db`, then on every start the entrypoint
  ensures database `studio` and user `studio@localhost`; its password is generated once into
  `/data/home/.studio/db-password` (root 0600) and handed to the server as a file
  (`MYSQL_PASSWORD_FILE`), never through the environment. Root uses socket authentication.
* `/run/mysqld` is `0750 mysql` — sandboxed user processes cannot even reach the socket.
* The entrypoint supervises both processes: if one ends, the other is stopped and the container
  exits (the restart policy brings it back); `docker stop` shuts down Node first, then MariaDB.
* JSON columns: MariaDB stores `JSON` as `LONGTEXT`; `db.ts` parses them in a `typeCast`, so the
  code sees objects on MariaDB and MySQL alike. `studio-db import` runs the migrations first
  (`node dist/index.js --migrate-only`), so plain data dumps load too.

## Process model and isolation

Programs the server starts for a user are resolved with the **server's** PATH to an absolute
path (`systemBin` in `lib/system.ts`) — the environment handed to the child starts with the
user's `~/.local/bin`, and a bare name would be looked up there before any privilege is dropped.
Whatever a user process writes into a pipe is untrusted: files reach Studio-owned folders (sites,
packs, library) only through `lib/tarsafe.ts`, never through a root `tar -x`.

The server process is the parent of every AI run, terminal and project server, so it must not die
of a stray error: `uncaughtException` logs and keeps serving (connection errors such as
`ECONNRESET` / `EPIPE` outside a request are ignored); ten real exceptions within a minute end the
process so the container restarts clean. A port that is already in use ends start-up with a clear message.

```
tini ─ node server (root)
        ├─ setpriv --reuid u1 … claude -p …            chat run (user 1, project 5)
        │     ├─ studio-mcp            (MCP: library tools + permission bridge)
        │     ├─ playwright-mcp        (MCP: browser tools)
        │     └─ bash / python / gradle / …   (Claude's tool calls)
        ├─ setpriv --reuid u2 … claude          (PTY: interactive terminal of user 2)
        └─ setpriv --reuid u1 … git / cat / tar / zip   (file operations)
```

* User *n* ↔ Linux account `u<n>`, uid/gid `UID_BASE + n` (20000+). Accounts are
  (re)created at server start from the database, so `/etc/passwd` needs no volume.
* `/data/projects` and `/data/home` are `0711` (traversable, not listable); each user's
  folders are `0700`. The library is root-only; users reach it through the API.
* Every read of file *contents* and every write on user data runs as the owning user,
  so a symlink planted in a project cannot trick the server into touching other files.
* User processes get an allowlisted environment (no server secrets) plus
  `HOME`, the stored Claude credential, and `STUDIO_TOKEN`.

## Claude integration

* **Chat** (`server/src/claude/runner.ts`): each message spawns
  `claude -p --output-format stream-json --verbose --include-partial-messages
  --session-id|--resume <uuid> --mcp-config <file> --append-system-prompt <studio prompt>`
  with the prompt on stdin. JSON lines become `chat_events` rows and WebSocket messages
  (text deltas stream live). After the process ends a git checkpoint is committed.
* **Live activity**: partial stream events become `chat.activity` messages — tool input as it is
  generated (`input_json_delta`: file path, size, last lines of the content), thinking,
  `system/api_retry`, `thinking_tokens`, compaction — so long steps are visible.
* **Studio tools only** by default: `--strict-mcp-config --disable-slash-commands` and
  `ENABLE_CLAUDEAI_MCP_SERVERS=false CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS=1` keep the account's
  plugins, claude.ai connectors and MCP servers out of Studio runs (per-user opt-in:
  `claude_connections.account_extras`).
* **Casual chat** (Chat page): a hidden per-user project of area `chat`. Runs use
  `--system-prompt <casual prompt>` (replaces the coding-agent prompt), `--tools Read,WebSearch,WebFetch`,
  no MCP servers and no git checkpoints.
* **Usage**: every `result` adds a `usage_runs` row (tokens, API-value estimate, duration, model,
  `provider` — Claude or another AI; Account → Usage shows a per-AI table once another AI was used);
  `rate_limit_event` (5-hour / weekly windows from Anthropic's response headers) is stored per
  user and pushed live (`usage.limits`). `GET /usage` also asks the user's own Claude Code for its
  usage report — `claude -p /usage`, a local command (no model request, no cost) — parses the
  "Current session / Current week … % used · resets …" lines and caches them for a minute.
* **Permission modes** → CLI flags (`prompt.ts`): bypass = `--dangerously-skip-permissions`;
  ask modes use `--permission-prompt-tool mcp__studio__permission_prompt`: the MCP server
  long-polls `/api/agent/permission`, the browser shows Allow/Deny, the answer goes back.
* **Terminal** (`terminal.ts`): node-pty + xterm.js over the same WebSocket; sessions keep
  running when the page reloads (output buffer is replayed), idle ones are closed.
* **Login**: Claude Code's own `claude auth login` in a terminal inside the user's home (the flow
  completes at Anthropic; Claude Code keeps the credentials); status via `claude auth status --json`.
  The Studio stores only a user's own API key (encrypted) — never subscription tokens (migration 3
  deleted the ones older versions stored), and it never uses a user's login itself.
* **System prompt** (`prompt.ts`): project facts, the text-first rule, library usage,
  browser tools, installed Studio tools (from `tool.json`) and detected toolchains.

## Agent API (inside the container)

`/api/agent/*`, bearer `STUDIO_TOKEN` (random, in-memory, bound to user + project (+ chat),
revoked when the process ends):

| Route | Used by |
|-------|---------|
| `GET /agent/whoami`, `GET /agent/tools` | CLI |
| `GET /agent/library/search`, `GET /agent/library/:id` | CLI, MCP |
| `POST /agent/library/:id/import` | CLI, MCP — copy into the project (tar → user) |
| `POST /agent/library` | CLI, MCP — save project files as an asset (user tar → library) |
| `POST /agent/permission` | MCP permission bridge (long poll) |
| `GET /agent/skills[?all=1]`, `GET /agent/skills/:name`, `POST /agent/skills` | CLI — list / read a skill, save a SKILL.md as the user's own |
| `POST /agent/site/tls` | CLI — certificates of the project's website (`studio site cert [issue]`) |

## Servers of projects (`server/src/services.ts`)

Node.js backends that projects deploy for their apps (multiplayer, saves, leaderboards, APIs).

* **Detection**: a first-level project folder with a `package.json` named `server`, `backend`,
  `api`, … or marked `"studio": { "service": true }`.
* **Deploy** (website or `studio service deploy` → `/api/agent/services/deploy`): as the owner,
  `rsync` the folder (without node_modules/.git) to `/data/services/<user>/<id>/releases/<n>/`,
  `npm ci|install --omit=dev` when it has dependencies, then stop the old process and start the
  new one; the last 3 releases are kept for rollback. A failed deploy leaves the old one running.
* **Run**: `setpriv` as the owner, `bash -c "exec <scripts.start | node main>"` in its own process
  group, env = the allowlisted user env + `PORT` (42000–42999), `HOST=127.0.0.1`, `DATA_DIR`
  (`…/<id>/data`, survives deploys), `PUBLIC_URL`, `BASE_PATH`, user variables (stored
  encrypted), `NODE_OPTIONS=--max-old-space-size=<SERVICE_MEMORY_MB>`. Ready = the port accepts
  connections (30 s). Crash → restart after 1/2/5/10/30 s; 5 crashes in 5 min → `crashed`,
  desired state `stopped`. Desired `running` servers start again when the Studio starts.
* **Logs**: stdout/stderr lines → ring buffer (2000) + `/data/services/.logs/<id>.log` (root only,
  rotated at 5 MB, reloaded at start) + WebSocket topic `service:<id>`.
* **Proxy**: `/srv/<slug>/…` (HTTP via `app.use('/srv')`, WebSocket via `addUpgradeRoute`) →
  `127.0.0.1:<PORT>/…` with the prefix stripped and `X-Forwarded-*`/`X-Forwarded-Prefix` set.
  The Studio session cookie is removed from requests; responses get `Content-Security-Policy:
  sandbox …` (opaque origin, like previews), `Set-Cookie` paths are rewritten to `/srv/<slug>/`,
  and permissive CORS is added unless the server sets its own (per-server switch).
* **Control**: website routes `/api/services…` (owner or admin), `/api/admin/services`; agent
  routes `/api/agent/services…` (bearer token, only the session's project); CLI `studio service`.

## Websites of projects (`server/src/sites.ts`)

Published web apps and browser games, served on a second port by host name.

* **Data**: `sites` (one per project: slug, enabled, current release, settings `root/build/spa/
  mode/serviceId`, stats, last publish log) and `site_domains` (domain → site, unique).
* **Publish** (website or `studio site publish` → `/api/agent/site/publish`): optional build
  command as the owner in the project; the folder (setting → preview folder → `dist|build|out`
  with an index.html → the project) is streamed by `tar` **as the owner** (dereferenced, only what
  the owner can read) into `lib/tarsafe.ts`, which extracts **as root** into a fresh
  `/data/sites/<id>/releases/<n>.tmp/`: only regular files and folders, validated names, `O_EXCL`
  opens, fixed modes, size/count limits, publish filter (hidden files except `.well-known`,
  `node_modules`, and from the project folder `CLAUDE.md`, `exports/`, `assets/uploads/`, server
  folders). Renamed to `<n>` and switched in the database; the newest three releases stay.
* **Serving** (`startSitesServer`, port `SITES_LISTEN_PORT` 8081): host → site via the domain
  table, `<slug>.<SITES_BASE_DOMAIN>` or `<slug>.localhost`; `express.static` on the current
  release (ETag, ranges), SPA fallback, the site's `404.html`, neutral pages for unknown / offline
  hosts. `/srv/<slug>/` and WebSocket upgrades go to `services.ts` (`proxySrv`, `srvUpgrade`) limited
  to the website owner's servers and without the CSP sandbox (own origin); `mode=server` proxies
  the whole host to one server of the project (`proxyWholeSite`).
* **Well-known endpoints** (any host): `/.well-known/ai-everything/ping` (instance id — the
  domain check fetches it through public DNS) and `/.well-known/ai-everything/tls-allowed?domain=`
  (Caddy on-demand TLS in the https profile).
* **Cache**: rows, slugs and domains in memory, reloaded after every change and every minute
  (rows removed by cascades, disabled owners → offline). Orphaned release folders are removed at start.

## HTTPS: one certificate per host (`server/src/certs.ts`)

The website server listens a second time with TLS (`SITES_TLS_LISTEN_PORT` 8443, reached as
`SITES_HTTPS_PORT`; off with `SITES_TLS=false` or behind a proxy with `SITES_HTTPS=true`). One
`https.Server` with an `SNICallback` picks the certificate by host name.

* **Data**: `tls_hosts` — host (a website domain, `<slug>.<base domain>`, the Studio's own domain,
  or an uploaded wildcard `*.example.com`), kind, **mode** (`auto` · `custom` · `selfsigned` · `off`),
  `force_https`, `hsts`, the certificate chain (PEM), the private key (**encrypted with
  APP_SECRET**, like API keys), issuer, names, validity, status, last error, attempts, next try.
  Secure contexts are built once and cached; a fallback self-signed certificate answers clients
  without SNI and unknown hosts.
* **Automatic** (`acme-client`, HTTP-01): Let's Encrypt, its staging CA or any ACME directory.
  Off until an admin accepts the CA's terms (Admin → HTTPS, or `ACME_AGREE_TOS=yes`). The
  challenge is answered by the plain-HTTP website server at `/.well-known/acme-challenge/<token>`
  (before the HTTPS redirect). One request at a time; failures back off 5 min → 24 h with the
  CA's message kept for the owner; renewal 30 days before expiry (checked every 10 minutes).
  Only hosts of **live** websites are requested, names a public CA cannot validate are refused early.
* **Own certificate**: PEM chain + key (optional passphrase) are parsed with `crypto.X509Certificate`,
  must match each other, cover the host and be valid; the key is normalised to PKCS#8. Only the
  public chain can be downloaded again. Wildcards are admin-only and cover hosts one level below.
* **Self-signed** (`@peculiar/x509`, ECDSA P-256, 397 days, renewed automatically) for tests and
  internal names.
* **HTTP side**: a host with a working certificate redirects to HTTPS (308) unless `force_https`
  is off; `hsts` adds `Strict-Transport-Security`. The domain check and the addresses shown
  follow the active scheme.
* **The Studio's own domain** (`STUDIO_DOMAIN` / Admin → HTTPS): requests for that host on the
  HTTPS port are handed to the main Express app and its WebSocket upgrade handler — the Studio
  gets HTTPS without a proxy.
* **Routes**: owners `PATCH|POST|PUT|DELETE|GET /sites/:id/domains/:domain/tls…`, admins
  `/admin/tls…` (settings, every host, wildcards), agents `POST /agent/site/tls`.

## WordPress (`server/src/wordpress.ts`, `server/src/lib/fastcgi.ts`)

A project of the `wordpress` area holds a real WordPress: `wordpress/` (the installation, not in
git), and the user's own code in `plugins/<slug>/` and `themes/<slug>/` (in git, linked into
`wordpress/wp-content/…` with relative symlinks — after every AI turn, on start, by `studio wp link`).

* **Install** (`POST /projects/:id/wordpress/install`, a background job with a log over the
  project's WebSocket topic): WP-CLI as the owner downloads the core, the Studio creates the
  database and its account (`<db>_wp_<id>`, built-in MariaDB through `mariadb -uroot` on the socket;
  an external server needs `WORDPRESS_DB_ADMIN_*`), writes `wp-config.php` (the site's URL follows
  the request's host; `DISABLE_WP_CRON`; `FS_METHOD direct`; the sign-in secret) and a must-use
  plugin, then `wp core install` (the admin password goes over stdin, never the command line).
* **PHP**: one PHP-FPM master per site, started by the Studio as root with a generated config
  (`/data/wordpress/<id>/fpm.conf`): the pool runs as the owner's sandbox user (`user =`), `pm =
  ondemand`, a Unix socket in a root-owned folder (0600 — a user can neither connect to another
  site's PHP nor redirect the Studio to it), `open_basedir` = the project + its temp folders, shell
  functions disabled. It starts with the first request and stops after `WORDPRESS_IDLE_MINUTES`.
* **Requests**: the website server (sites.ts, mode `wordpress`) hands them to `wordpress.http`:
  the path is normalised and checked (hidden files, `wp-config.php`, logs/dumps, PHP in uploads →
  403), an existing file that is not PHP is sent by the Studio itself — opened once, and only when
  it is a regular file **owned by the site's owner** (a link to someone else's file is never
  served) — everything else goes to PHP over FastCGI (`lib/fastcgi.ts`: one connection per
  request, streamed both ways, body size limit) with `index.php` as front controller.
* **wp-cron** is called through the same FastCGI path by the Studio (every 10 minutes for visited
  sites, every 6 hours for sleeping ones) — site code only ever runs inside the confined pool.
* **Management** (plugins, themes, updates, exports, one-click sign-in): WP-CLI as the owner, with
  `--skip-plugins --skip-themes` so a broken plugin cannot lock the owner out. The sign-in link is
  an HMAC-signed, 90-second, single-use token checked by the must-use plugin.
* **Website**: the installation creates the project's `sites` row in mode `wordpress` — slug,
  domains, certificates and the Website tab are the same as for published websites; publishing is
  refused. Removing WordPress drops the database, the runtime folder, the website and `wordpress/`.

## Versioning (`server/src/releases.ts`)

Every project is a git repository with a checkpoint per AI turn. Versioning (per project, in
`settings.versioning`) adds numbered releases: `POST /projects/:id/releases` writes `VERSION`,
moves the "Unreleased" notes of `CHANGELOG.md` into the new entry, commits, creates the annotated
tag `v<version>` and zips `exports/` (as the owner) into `<projects>/<user>/.releases/<project>/`.
Downloads: `git archive` of the tag, and the kept exports. The AI uses the same code through
`studio release` (agent API) and is told about the version in its prompt.

## Skills and instructions (`server/src/skills.ts`)

Provider-independent on purpose: runs start Claude Code with slash commands disabled and other
AIs know nothing about vendor skill formats, so both features are **text in the prompt** plus
the `studio skill` CLI.

* **Instructions**: admin-wide (`settings` key `instructions.global`) and per user
  (`user_instructions`), each for scope `all` or one area (`music` … `chat`). `promptAddendum()`
  appends them to every system prompt (project runs, the Chat page, terminals, ACP agents).
* **Skills**: `SKILL.md` = front matter (`name`, `title`, `description`, `areas`, `auto`) +
  instructions. Three sources: built-in files (`/opt/studio/skills/<name>/SKILL.md`), the user's
  own (`skills` table) and published ones of others (`visibility = global`, opt-in per user via
  `skill_prefs`; `reviewed` is set by admins and reset when the text changes). Own beats added
  beats built-in when names collide.
* **Use**: the prompt lists `name — description` of the active skills for the area (not the
  bodies); the AI loads one with `studio skill show <name>` (`GET /agent/skills/:name`). A message
  that starts with `/name` is expanded on the server (`expandSkillCommand`): the skill text is put
  in front of the request, the chat event keeps the original text + the skill name.
* **Authoring**: the Skills page (create, import/export SKILL.md, enable, publish) and the AI
  itself (`studio skill new` → edit → `studio skill save`, `POST /agent/skills`).

## Other AI providers (`server/src/agents/`)

Claude Code keeps its native integration (`claude/runner.ts`, stream-json). Every other AI is an
**ACP agent** (Agent Client Protocol, JSON-RPC 2.0 over stdio):

* `registry.ts` — built-in agents (Codex via codex-acp, Gemini CLI `--acp`, OpenCode `acp`) and
  admin-defined ones (`settings: agents.custom`): npm packages, launch arguments per permission
  mode / model, sign-in command, which user API keys they get, ACP auth methods for those keys.
* `install.ts` — `npm install --global --prefix /data/sdk/agents/<id>` when switched on, one at a
  time (memory), daily updates; bin folders go on the users' PATH.
* `keys.ts` — `agent_keys` (encrypted per user), `agent_prefs` (default AI, model per AI),
  `agentEnv()` (only the agent's own keys; the Studio's environment never leaks keys).
* `acpclient.ts` — newline-delimited JSON-RPC client: requests, notifications, agent→client
  requests (`session/request_permission` answered; fs/terminal capabilities not offered).
* `acprun.ts` — one agent process per chat (idle timeout), `initialize` → `session/load` (resume)
  or `session/new` (+ the Studio instructions with the first prompt, as ACP has no system prompt;
  a recap of the chat when a session could not be resumed) → `session/prompt`. `session/update`
  becomes the same chat events as Claude's: text/thinking chunks, `tool_call`/`tool_call_update` →
  `tool_use` (Bash/Write/Edit/Read/Grep/WebFetch/mcp__… by kind and raw input) + `tool_result`,
  `plan` → TodoWrite, `usage_update` → cost. Permission requests follow the project's mode
  (bypass/plan answered by the Studio, ask modes through the existing permission cards). Model and
  plan mode go through launch flags or the session's config options; reported model lists are
  cached for the UI. A git checkpoint follows every run, like Claude's.
* `routes.ts` — `/agents` (status per user: sign-ins, keys, free tiers; test = one tiny prompt),
  `/agents/keys`, `/agents/prefs`, `/admin/agents` (switch on/off, update, remove, custom agents).
* Chats carry `provider` + `agent_session_id`; terminals open the agent's own TUI or sign-in.

## Website ↔ server

* REST under `/api` (JSON; mutating requests need header `x-studio: 1` + same origin).
* One WebSocket `/ws` per tab: topics `chat:<id>` / `project:<id>`, terminal frames,
  permission requests/replies, `claude.changed`.
* Previews: `/preview/<signed token>/<path>` — served as the owner, with
  `Content-Security-Policy: sandbox …` (opaque origin) and CORS `*`.
* Raw files: `/api/projects/:id/raw/<path>` and `/api/library/:id/file/<path>` with a strict
  sandbox CSP (safe to open directly), Range support for media.

## Database

`users`, `sessions` (sha256 of the cookie token), `settings`, `claude_connections`
(encrypted secret + hint, last rate-limit status, account-extras switch), `projects` (+ JSON
settings), `chats` (Claude session uuid), `chat_events` (JSON payloads, large outputs truncated),
`assets` (+ JSON file list), `usage_runs` (one row per AI run — Claude or another provider),
`tls_hosts` (certificate per host), `skills`, `skill_prefs`, `user_instructions`,
`project_releases` (numbered releases), `wordpress_sites` (one WordPress per project).
Migrations: `server/src/migrations.ts` (append only). Backup: `studio-db dump` (`--all` adds the
databases of the WordPress sites), `scripts/backup.sh`.

## Studio software and packs

* `tools/studio-daw`, `tools/studio-3d`, `tools/studio-image`, `tools/studio-video` and
  `tools/studio-stickman` are Python CLIs (numpy/scipy/trimesh/Pillow, ffmpeg) following the
  contract in [SOFTWARE.md](SOFTWARE.md): text in → render → JSON report + preview PNG; plugins from
  `plugins/<tool>/` of the project and from packs.
* Packs (`server/src/packs.ts`) live in `/opt/studio/packs` (system, from `packs/`),
  `/data/packs/global` (0755, everyone) and `/data/packs/users/<uid>` (root:u<uid> 0750, owner only).
  `STUDIO_PACKS_PATH` = `<project>/packs : personal : global : system` is set for every user process;
  the CLIs resolve `pack/item` from the filesystem (`studio_packs.py`, `lib/packs.js`).
* Installing a pack copies a project folder via the tar pipeline (user tar `-h` → root extract),
  validates `pack.json`, probes media (ffprobe as `nobody`) into `.studio-index.json` and writes
  `.studio-meta.json` (owner, scope, `hasCode`, `trusted`). Publishing moves it to `global/`;
  plugin code there runs only when an admin set `trusted` (Packs → Mark code as reviewed).
* `studio-3d` builds a trimesh scene graph; the last step per object (`uv.py`) gives it normals
  (`shading: auto` splits at edges sharper than `smooth_angle`) and, for textured materials, UVs by
  projection — per face corner, so seams never smear — and welds equal corners again. Textures
  (`textures.py`) are image files, or pictures made by `studio-image` in the same process
  (procedural textures, `*.image.yaml`, inline layers); purely procedural ones are kept in
  `~/.cache/studio-3d/textures`. Relief is turned into a normal map; samplers, strengths and the
  scene file's path are written into the glTF header after trimesh's export.
* `POST /api/projects/:id/tools/new` creates a `.song.yaml` / `.scene.yaml` / `.stick.yaml` from a
  template of its tool (`<tool> new <file> --template …`, as the owner) for the file tree's "New …" entries.
* `POST /api/projects/:id/tools/run` runs `studio-daw render|check` / `studio-3d build|check` /
  `studio-stickman render|check` (+ a fast draft) / `studio-image render|check` / `studio-video
  render|check` (+ draft) as the owner for the Render/Build buttons.
* `studio-image` draws every layer on its own sheet (supersampled, with room around it for blur
  and shadows), applies mask → rotation → filters, and lays it over the stack with its blend mode.
* `studio-video` composes every frame in Python — the clip's frame (ffmpeg decoders read forward,
  stills are zoomed from a pre-scaled copy), the transition, the overlays — and pipes it to one
  ffmpeg encode together with the numpy-mixed soundtrack. It is the hub of the tools: stick
  scenes, pictures, songs and sound effects named in a timeline are rendered by their own tool
  into `.studio/cache/video/` (keyed by the source file's time stamp) and reused.
* `tools/studio/python/studio_gfx.py` is the shared picture library of studio-image and
  studio-video (colors, fonts, text layout, gradients, blending, contact sheets).
* `studio-stickman` renders frames with Pillow in a process pool (forked **before** ffmpeg is
  started, so no worker inherits its pipe), pipes raw RGB into ffmpeg (libx264 + AAC) and mixes
  synthesized sound effects (numpy) with an optional soundtrack; contact sheets are its preview.

## Website 3D editor (`web/src/scene3d/`, `server/src/model3d.ts`)

`*.scene.yaml` files open in a visual 3D editor (FileViewer → 3D editor/Code, lazy chunk). Like the
DAW it re-implements nothing: the YAML is the save format, `studio-3d` is the only thing that
makes geometry.

* **Engine calls** (as the owner, cwd = project): `POST …/3d/model` → `studio-3d model - --path
  <scene>` with the (unsaved) text on stdin. The engine builds *tolerantly* (an object that fails is
  reported and left out), writes the `.glb` into `~/.cache/studio-3d/edit/<hash>.glb` and answers
  with what was built per object, the resolved materials, errors and warnings. Every node of the
  `.glb` carries `extras.sid` = the object's YAML path (`objects.2.group.0`) and `extras.inst` (the
  copy of a repeat/scatter). `GET …/3d/catalog` → shapes and modifiers (built-in, project plugins,
  packs) with parameters and UI hints, material presets, pack items, the procedural textures of
  studio-image. `POST …/3d/texture` → a small preview of any texture source. `GET …/3d/cache/*`
  serves the cache (content-addressed names). `POST …/3d/export` → `studio-3d build … --format`.
  One engine process per request, queued per project; a request that is overtaken while waiting
  is not built.
* **Edits** (`sceneDoc.ts` on `daw/yamlEdit.ts`): the object tree and every value in the panels are
  read from the text itself, so the UI never waits for the engine; an edit changes only the touched
  node of the YAML. Moving into / out of groups keeps the place in the world (matrices are composed
  like the engine does: translation · rotation x→y→z · scale).
* **View** (`stage.ts`, three.js): loads the `.glb`, maps nodes to objects by `sid`, picks by ray,
  moves a handle with TransformControls. Until the next build arrives it only moves what exists:
  the copies of the selected object follow the handle (their relation to the object's transform is
  taken from the build that is shown), plain material values are set on the three.js materials.
  When objects were added or removed the ids of the shown build no longer fit — picking pauses
  until the new build is there.
* The model viewer reads `asset.extras.studio_source` (written by `studio-3d build`) and offers
  **Edit scene**; any other model can be put into a new scene (`model:`).
* Editor, model viewer and `studio-3d preview` use the same light (neutral tone curve, room light
  at half strength): a flat surface shows the color written in the file.

## Website DAW (`web/src/daw/`, `server/src/daw.ts`)

`*.song.yaml` files open in a visual DAW (FileViewer → DAW/Code, lazy chunk). The YAML stays the
only save format and the engine stays the only implementation of the music:

* **Engine calls** (as the owner, cwd = project, `STUDIO_PACKS_PATH` like Claude's): `POST …/daw/model`
  → `studio-daw model - --path <song>` with the (unsaved) text on stdin → instruments with
  parameters and knob hints, parsed patterns with exact events (written length, gate, chord
  symbols), sections, mix, plugin errors. `GET …/daw/catalog` → built-in, project-plugin and pack
  instruments/effects. One process per request, queued per project and kind.
* **Edits** (`yamlEdit.ts`, `ops.ts`): the text is changed surgically through the `yaml` CST ranges —
  only the touched node, so comments and layout stay. Tracks are rewritten by `notation.ts`
  (chord symbols, dynamics, ties, voices, grids, the song's flat/sharp spelling); a round trip over
  real songs reproduces every event. The parsed model is updated locally at once and replaced by
  the engine's model when the text settles.
* **Sound** (`sounds.ts`, `audio.ts`): `POST …/daw/sounds` → `studio-daw sounds` renders the notes the
  song needs (pitch, held time, velocity) with the real instruments — built-ins, SoundFonts (one
  FluidSynth pass), samples, plugins — into `~/.cache/studio-daw/sounds/<soundKey>/` (FLAC chunks +
  index; the key hashes the instrument spec, plugin source and sample files; LRU at 600 MB), served
  by `GET …/daw/cache/*`. The browser schedules them with Web Audio (closest sample, pitch-shifted,
  while new ones render), approximates the built-in effects and sidechain, and skips plugin effects.
  **Render** (`POST …/daw/export`, `--preview`) plays the engine's exact mix instead.
* **Exports**: `studio-daw export` (wav, mp3, midi, stems, `--zip` bundle with the song text and the
  project plugins/samples it uses) into `exports/`, downloaded through the normal file routes.
  MIDI import (`midi.ts`) converts a `.mid` into a new song in the browser.

## Android SDK at runtime

`server/src/sdk.ts`: the plan (newest stable `platforms;android-N[.m]` + build-tools + `platform-tools`)
comes from Google's `repository2-3.xml`; after the admin accepts the terms (recorded in `settings`),
the newest command-line tools zip is downloaded and `android --no-metrics sdk install <pkg>` runs for
each package into `/data/sdk/android`; log lines stream to admins over the WebSocket.
`ANDROID_HOME`/`PATH` point there; each user gets `~/.androidrc` with `--no-metrics`.

## Extending

* **New area**: add it to `server/src/areas.ts` and create `templates/<id>/GUIDE.md` (+ `files/`).
* **New tool**: `tools/<id>/tool.json` (+ `bin/`, `install.sh`, `README.md`) — see `tools/README.md`
  and [SOFTWARE.md](SOFTWARE.md).
* **New pack**: `packs/<id>/pack.json` (+ optional `install.sh`) — see `packs/README.md`.
* **New toolchain in the image**: add it to the toolchain stage of the `Dockerfile` and to
  `CHAINS` in `server/src/tools.ts` so Claude is told about it.
