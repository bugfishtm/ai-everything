# ai-everything — Everything Studio

> This is the full technical manual. A shorter overview is in the [README](../README.md); the illustrated
> documentation — install, server and HTTPS, guide, configuration — is at
> [bugfishtm.github.io/ai-everything](https://bugfishtm.github.io/ai-everything/).

A self-hosted creative studio that runs **Claude Code**: music, images, 3D models, video, JS games,
Android apps, Windows software, web apps and more — plus a plain **Chat** for everyday questions.
**One container** holds the website, our own **text-driven creative software** (a DAW, a 3D tool,
an image tool, a video editor and a stick figure animator that Claude uses and can extend
itself), all toolchains and the database. People log in, connect
**their own** Claude account and start projects.

> ai-everything is independent open-source software (GPL-3.0). It is **not affiliated with or endorsed by
> Anthropic** (or OpenAI, Google and the other AI vendors it can connect to). Claude and Claude Code are
> trademarks of Anthropic, PBC; OpenAI, ChatGPT and Codex of OpenAI; Google and Gemini of Google LLC. Claude Code is Anthropic's
> proprietary software and is **not included** in this repository or the image: each installation
> downloads the official package on first start, and every person uses it with their own account
> under Anthropic's terms — see [Legal](#legal-claude-code-android-sdk-and-publishing).

```
 Browser ──► Studio website (login, areas, projects, chat, terminal, files, previews, library, packs)
                 │
                 ▼
            Studio server ──► Claude Code (downloaded on first start; per user, per project, in a sandbox account)
                 │            ──► other AIs over ACP: OpenAI Codex · Google Gemini · OpenCode (any provider) · more
                 │                 │
                 │                 ├─► studio-daw   songs (text) → WAV/MP3/MIDI + report + spectrogram
                 │                 ├─► studio-3d    scenes (text) → .glb + stats + 4-view preview
                 │                 ├─► studio-image pictures (text) → PNG/JPG/WebP/ICO + preview + report
                 │                 ├─► studio-video timelines (text) → MP4 + subtitles + contact sheet
                 │                 ├─► studio-stickman  scenes (text) → MP4 with sound + contact sheet, sprite sheets
                 │                 ├─► skills       know-how the AI loads on demand · instructions that always apply
                 │                 ├─► packs        instruments · samples · kits · presets · models · materials · plugins
                 │                 ├─► servers      Node.js backends the apps use: /srv/<name>/ (HTTP + WebSocket)
                 │                 ├─► websites     published web apps/games on own domains, HTTPS with a certificate per domain
                 │                 └─► toolchains   Python, ffmpeg, FluidSynth, Node, .NET, mingw, JDK/Gradle,
                 │                                  headless Chromium, Android SDK (installed at runtime)
                 ▼
            built-in database (MariaDB)      volumes: studio-data → /data · studio-db → /var/lib/mysql
```

## The idea

1. **Areas** — Music · Image · 3D Models · Video · JS Games · Android Apps · Windows Software · Web Apps · Anything Else — and **Chat** for casual conversations (no project needed; Claude can read attachments and search the web).
2. **Projects** — a folder (git repo) per project with a `CLAUDE.md` for its area; every Claude turn is saved as a restorable version.
3. **Text first** — songs are `*.song.yaml`, 3D scenes `*.scene.yaml`, … Claude (and you) write text, the Studio software renders it. Claude cannot hear or see directly, so every render returns **numbers and a preview image** it checks before answering.
   Songs also open in a **visual DAW** on the website (arrangement, piano roll, drum grid, mixer, live playback, MIDI/WAV/MP3/stems export) — every click is written back into the same YAML, so you and Claude keep working on one file.
4. **Packs** — expansions for the software (General MIDI orchestra, drum kits, synth presets, 3D nature kit …). Their manifests are text the AI reads; items are used as `pack-id/item-id`.
5. **Self-extending** — when a sound, effect or shape is missing, Claude writes a plugin (`plugins/daw/*.py`, `plugins/3d/*.py`), can turn it into a pack, and you can publish it for everyone.
6. **Library + Global Space** — finished assets and packs are shared: everybody — and every Claude — can reuse them.

## Quick start

Requirements: Docker (Docker Desktop on Windows/macOS, Docker Engine on Linux), ~15 GB disk.

```bash
docker compose up -d --build
```

That's all — no `.env` needed (copy `.env.example` to `.env` to change port, limits or the image
build). The first build takes 10–30 minutes. On the first start the Studio downloads Claude Code
from npm (about 300 MB, a minute — Admin → Claude Code shows it). Open **http://localhost:8080** —
the first account becomes admin. Then: **Account & Claude** → sign in to Claude Code;
**Admin → Android SDK** → install it if you want Android apps (you accept Google's license there).

Without Compose, the same image runs with plain Docker (or from Docker Hub — see
[Publishing](#publishing-on-docker-hub)):

```bash
docker build -t ai-everything .
docker run -d --name ai-everything -p 127.0.0.1:8080:8080 -p 127.0.0.1:8081:8081 --shm-size=1g \
  --restart unless-stopped -v studio-data:/data -v studio-db:/var/lib/mysql ai-everything
```

### Data — two Docker volumes

| Volume | Mounted at | Content |
|--------|-----------|---------|
| `studio-data` | `/data` | `projects/<user>/<project>/` (git repos) · `library/` (assets + Global Space) · `packs/` (`global/`, `users/<id>/`) · `home/<id>/` (each user's Claude Code login, caches) · `sdk/` (Claude Code, Android SDK — downloaded at runtime) · `home/.studio/` (generated secrets) |
| `studio-db` | `/var/lib/mysql` | the built-in database (MariaDB, MySQL compatible) — users, projects, chats, library, usage |

The database runs inside the container and is reachable only through its Unix socket (no port).
`docker compose exec studio studio-db shell|dump|status` manages it. To use an external
MySQL/MariaDB server instead, set `MYSQL_HOST` (+ user, password, database) in `.env`.

Volumes survive rebuilds, updates and `docker compose down` (only `down -v` deletes them).

- **Backup:** `./scripts/backup.sh` → `backups/<date>/studio-db.sql.gz` + `studio-data.tar.gz`
  (restore steps are in the script header).
- **Coming from the old layout** (folders in `./data` + a separate MySQL container):
  `./scripts/migrate-to-volumes.sh` copies projects, library, packs, Claude logins and the database
  into the volumes and starts the new container. `./data` stays untouched until you delete it.

## The creative software

### studio-daw — music from text

```yaml
song: { title: Night Drive, bpm: 92, swing: 0.2 }
instruments:
  drums: { use: studio-drums/kit }
  bass:  { use: bass, octave: 2 }
  piano: { use: gm-instruments/electric-piano-1 }
patterns:
  beat:
    drums: |
      kick:  x---x---x---x---
      snare: ----x-------x---
      hat:   x-x-x-x-x-x-xoxo
  groove:
    bass:  "A:q. A:e r:e E:e G:q | F:q. F:e r C3:e E:q"
    piano: { chords: "Am7 | Fmaj7" }
arrangement:
  - { section: intro, bars: 4, play: [groove] }
  - { section: verse, bars: 8, play: [beat, groove] }
mix:
  piano: { reverb: 0.3, pan: -0.2 }
```

`studio-daw render song.song.yaml --preview` → `exports/song.wav/.mp3`, a spectrogram PNG and a
report (LUFS, peaks, per-track levels). Notes, chords, drum grids, arrangement with tempo changes,
swing/humanize, 21 effects incl. sidechain and **automation** (fades, pans and filter sweeps along the
bars), mastering to a loudness target, stems and MIDI export. `studio-daw import tune.mid` turns a
MIDI file into a song, `studio-daw sfx coin,jump,hit` makes one-shot sound effects for games, and
`studio-daw new --template lofi|chiptune|house|…` starts from a genre sketch.
Reference: [tools/studio-daw/README.md](../tools/studio-daw/README.md).

**The DAW on the website.** Open any `*.song.yaml` (or click **DAW** in a project) and the song
becomes a DAW: sections × patterns arrangement, piano roll (draw/move/resize notes, chords,
velocities, copy/paste), drum step grid, mixer (faders, pan, sends, mute/solo, effect chains),
instrument browser with knobs, live playback, undo/redo. It does not re-implement anything:
the real `studio-daw` engine parses the text and renders every instrument's notes into a cached
sample bank, so the browser plays the actual sounds — built-ins, SoundFonts, samples and plugins
Claude just wrote (their parameters become knobs automatically). **Render** plays the exact mix
(all effects, humanize, mastering); **Export** writes MIDI (tempo map, GM programs), WAV, MP3,
stems or one zip with everything plus the song file and the plugins/samples it uses.
Edits change only the touched part of the YAML (comments and layout stay), so diffs stay small.
**Open** loads a `.song.yaml` from your computer or imports a `.mid` file as a new song.

**Play and record it.** The transport bar has record, loop, metronome, count-in, tap tempo and a
bar.beat display. Connect a **MIDI keyboard** (Web MIDI: Chrome, Edge, Firefox — over HTTPS or on
localhost) or use the **on-screen keyboard** and your computer keys (A S D F …) to play the armed
track with its real sound; **Record** writes what you play into the piano roll or the drum grid
(input quantize from 1/4 to 1/32 and triplets, overdub in a loop, one undo step per take). A MIDI
**output** drives an external synth with the armed track. Song and Pattern mode, track headers
with arm/mute/solo and level meters, peak-hold meters in the mixer, zoom with Ctrl+wheel, `?`
for the shortcuts.

### studio-3d — 3D models from text

```yaml
objects:
  - { name: ground, shape: terrain, size: [40, 40], height: 3, flat: 6, material: grass }
  - { name: forest, use: basic-3d/pine, scatter: { count: 30, area: [36, 36], min_distance: 2.5 } }
  - name: arch
    boolean: { op: difference, objects: [ { shape: box, size: [3, 3, 0.6] }, { shape: cylinder, radius: 0.9, height: 1, rotation: [90, 0, 0], position: [0, 1.4, -0.5] } ] }
    material: stone
```

`studio-3d build scene.scene.yaml --preview` → `exports/scene.glb` and a perspective/front/side/top
preview. Shapes, lathe, extrude, tubes, terrain, booleans, groups, repeat/scatter (instanced),
modifiers, PBR materials, pack models and prefabs — and organic modelling: `loft` (smooth bodies
through cross-sections: fish, bottles, hulls) and `blob` (primitives melted into one sculpted,
high-poly surface: creatures, characters); `studio-3d new x.scene.yaml --template organic` starts
with a fish. **Textures:** image files, pictures drawn with `studio-image`, or procedural textures
written in place (`texture: { type: bricks, colors: [...] }`), laid on by projection (box, planar,
cylinder, sphere, fit), with relief (`bump`), normal / roughness / metal / glow maps. Smooth or
faceted shading, exports as `.glb`, `.obj`, `.stl` (3D printing), `.ply`.
Reference: [tools/studio-3d/README.md](../tools/studio-3d/README.md).

**The 3D editor on the website.** Open any `*.scene.yaml` (or click **3D editor** in a project) and
the scene becomes an editor: a view to orbit in, click to select, a gizmo to move / rotate / scale
(with snapping), the list of objects (drag into groups, hide, rename), every parameter of a shape
as a field you can type or drag, modifiers, repeat / scatter, booleans from selected objects, and a
materials panel with color, gloss, glow and textures — procedural ones with live thumbnails,
ready-made looks (brick wall, floorboards, roof tiles …), relief and the mapping. Undo / redo,
**Build** exports `.glb` / `.obj` / `.stl`. It does not re-implement anything: every change is
written into the text (only the touched part — comments and layout stay), the real `studio-3d`
engine builds it, and the view shows exactly the model the export will be — also shapes of plugins
Claude wrote a minute ago, which appear in the **Add** list with their parameters. A `.glb` built
by the Studio offers **Edit scene**; any other model can be put into a scene with one click.

### studio-stickman — animation from text

```yaml
scene: { title: Duel, background: dojo, bpm: 120 }
figures:
  red:  { color: "#c0392b", x: 420, hat: headband }
  blue: { color: blue, x: 860, face: left }
timeline:
  red:
    - { t: 1.0, do: walk, to: blue }
    - { do: combo, target: blue, moves: [jab, jab, punch], word: "POW!" }
    - { t: "5:1", do: highkick, target: blue, ko: true }     # on bar 5, beat 1
  blue:
    - { t: 0, pose: guard }
camera:
  - { t: "5:1", follow: blue, zoom: 1.4, ease: snap }
```

`studio-stickman render duel.stick.yaml --preview` → `exports/duel.mp4` (H.264 + AAC, sound effects
synthesized and mixed, optional soundtrack from studio-daw) and a **contact sheet** of the key
moments that the AI reads to see its own animation. Figures are ten joint angles: 50 poses, 40
actions (walk, jump, punch/kick/combo with hit reactions and knock-outs, gestures, dance on the
beat), speech bubbles, props (also in hands), nine backdrops, camera moves, particles, GIF/WebM
and transparent **sprite sheets** for games. Like the other tools it is extended in Python:
`studio-stickman plugin new backflip --kind action|pose|prop|fx|backdrop|sound`.
Reference: [tools/studio-stickman/README.md](../tools/studio-stickman/README.md).

### studio-image — pictures from text

```yaml
image: { size: [1280, 720], background: { gradient: ["#1b2140", "#0b0d18"], angle: 90 }, palette: { warm: "#ffd166" } }
layers:
  - { texture: stars, colors: ["#00000000", "#ffffff"], count: 260, opacity: 0.8 }
  - { circle: [980, 210, 150], fill: { gradient: [warm, "#ff7b54"] }, glow: { radius: 60, color: "#ff9a5c" } }
  - { text: "NIGHT DRIVE", at: [90, 300], anchor: left, size: 110, font: bold, fill: "#fff", shadow: { dy: 8, blur: 18 } }
export:
  - { format: png }
  - { format: jpg, width: 640 }
filters:
  - { vignette: 0.35 }
```

`studio-image render cover.image.yaml --preview` → the files of `export:` and a preview the AI
reads, with a report (brightness, contrast, main colors, warnings like “the text is wider than
the picture”). Layers of shapes, SVG path data, text with gradients and outlines, pictures,
14 procedural textures (seamless for games and 3D), **pixel art** as character grids, groups,
repeat and scatter; masks, 11 blend modes, 23 filters; exports in several sizes and ICO for app
icons and favicons. It also analyses, converts and packs existing images (`info`, `palette`,
`convert`, `sheet`). Plugins: shapes, filters, textures.
Reference: [tools/studio-image/README.md](../tools/studio-image/README.md).

### studio-video — videos from text timelines

```yaml
video: { size: [1280, 720], fps: 30 }
clips:
  - { name: opening, title: "NIGHT DRIVE", sub: "a tiny racing game", dur: 3, fade_in: 0.5 }
  - { name: gameplay, file: assets/gameplay.mp4, from: 3, to: 9, volume: 0.6, transition: crossfade }
  - { image: assets/shot.png, dur: 4, zoom: [1.0, 1.15], pan: [left, right], transition: { type: slide-left, dur: 0.6 } }
  - { scene: src/fight.stick.yaml, from: 2, to: 6 }          # rendered with studio-stickman
  - { picture: src/cover.image.yaml, dur: 3 }                # rendered with studio-image
overlays:
  - { text: "Drift!", clip: gameplay, t: 1.5, dur: 2, at: [640, 120], size: 72, in: rise }
subtitles:
  - { t: 1.0, dur: 2.5, text: "Night falls." }
audio:
  - { song: src/theme.song.yaml, gain: -8, duck: 8, fade_out: 2 }    # rendered with studio-daw
  - { sfx: explosion, clip: gameplay, t: 4.0 }
```

`studio-video render trailer.video.yaml --preview` → `exports/trailer.mp4` (+ `.srt`) and a contact
sheet of the key moments. It is the tool that puts the others together: clips can be video files,
pictures with slow zoom and pan, title cards, computed backgrounds — and stick scenes, studio-image
pictures and studio-daw songs, which are rendered on demand and cached. 18 transitions, text /
picture overlays tied to clips, subtitles, a soundtrack with ducking. `studio-video probe` and
`studio-video frames` show the AI what any media file contains before it cuts.
Reference: [tools/studio-video/README.md](../tools/studio-video/README.md).

On the website, song, scene, stick, picture and video files get **Check** and **Render/Build**
buttons (stick scenes and videos also a fast **Draft**; the result shows right there), so people
can edit the text by hand too.

### Packs

Built-in: `gm-instruments` (128 General MIDI instruments + drum kits), `studio-drums` (one-shots,
kits), `studio-synths` (presets + acid plugin), `basic-3d` (materials, tree/pine/rock/bush shapes,
props, campfire prefab). Users and Claude make more (`studio packs new`, Install as pack), publish
them to the Global Space; code in shared packs runs only after an admin review. Format:
[packs/README.md](../packs/README.md).

## Connecting Claude

Each person uses **their own** Claude account (Account & AI):

- **Sign in to Claude Code** (Claude Pro / Max / Team): Claude Code's own sign-in runs in a browser
  terminal (`claude auth login`). You approve on Anthropic's site; Claude Code keeps the login in
  your private sandbox account and refreshes it by itself.
- **API key** from the Anthropic Console (billed to you), stored AES-encrypted.

The Studio itself never collects, stores or uses Claude subscription credentials: it does not take
pasted subscription (`setup-token`) tokens, and it never calls Anthropic with your login — usage
numbers come from Claude Code itself (see below).

**Usage** (Account → Usage, and a small meter in the sidebar): how much of your plan's 5-hour
and weekly limits is used, how much is left and when each window resets — from Claude Code's own
usage report (`claude -p /usage`, a local command: no model request, no cost) and from the
rate-limit status Claude Code reports during every run. Below that, your Studio usage per
day/week/month, per project and — once you also use other AIs — per AI (messages, tokens, API
value). Admins see everybody's usage.

By default Claude runs in the Studio with the **Studio tools only**: plugins, claude.ai connectors
and MCP servers of your Claude account are not loaded (they add dozens of tools and slow every
start). Switch them on under Account → "Use my account's plugins, connectors and MCP servers".

## More AI providers — OpenAI Codex, Google Gemini, OpenCode and any ACP agent

Claude Code stays the built-in AI (its integration is unchanged). Admins can switch on more AIs
under **Admin → AI providers**; each user connects their own accounts under **Account & AI**:

| AI | Connect with | Notes |
|----|--------------|-------|
| **OpenAI Codex** | “Sign in with ChatGPT” (Plus, Pro, Business … — device-code sign-in in a browser terminal) or an OpenAI API key | official `@openai/codex` + `@zed-industries/codex-acp` (Apache-2.0) |
| **Google Gemini** | “Sign in with Google” (free daily quota with a personal account, or a Gemini plan) or a Gemini API key | official `@google/gemini-cli` (Apache-2.0) |
| **OpenCode** | API keys of OpenAI, Google, OpenRouter, Groq, Mistral, DeepSeek, xAI, Anthropic — or its own provider sign-ins; local models through its config | `opencode-ai` (MIT); a few free models without an account, within OpenCode's (tight) limits |
| **any ACP agent** | whatever the agent supports | admins add a command (+ npm package), e.g. Qwen Code |

- **Same experience as Claude**: chats stream text, thinking, tool calls (commands with live
  output, file writes and edits with diffs, searches, plans as to-do lists) and results into the
  same chat view; the permission modes work the same — *Ask* modes show the same Allow/Deny cards.
  A version is saved after every turn, the Studio tools (asset library, packs, headless browser)
  are available as MCP servers, conversations resume after restarts.
- **Choose per chat**: a project has an AI for its new chats (project settings), every user has a
  default; the chat header can start a new chat with any connected AI. Each chat keeps its AI.
  The terminal tab opens the project AI's own interactive UI (`codex`, `gemini`, `opencode`).
- **How it works**: every AI besides Claude is driven over the open
  [Agent Client Protocol](https://agentclientprotocol.com) (ACP) — one client in the Studio for all
  of them. Like Claude Code, none is in the image: the official npm packages are downloaded into
  the data volume when an admin switches an AI on (one at a time — they are large) and updated daily.
- **What stays Claude-only**: the plan-limit meters (5-hour / weekly windows) and the
  "use my account's plugins" switch are Claude Code features; other AIs report tokens and, where
  they know it, cost.

Settings: `AGENTS` (switched on at first start, e.g. `codex,gemini,opencode`), `AGENTS_AUTO_UPDATE`,
`AGENT_IDLE_MINUTES` (an AI process stays up between messages of a chat).

## Working in a project

Chat (live text, tool calls, approvals, versions) · Claude terminal · Shell · Files (editor,
previews for images/audio/video/3D) · Preview/Play for web and games · History. Modes:
*Autonomous*, *Ask for commands*, *Ask for everything*, *Plan only*.

In the Files tab, **New song / 3D scene / stick animation / picture / video** (right-click a folder) start a
file from one of the tool's templates — it opens ready to Check and Render; songs open in the DAW,
3D scenes in the 3D editor (both keep a **Code** view of the same text). Typing `/` in the chat
lists your skills.

**Finding projects.** The area pages and **Projects** list your projects as cards or as a
**list with details** (version, website/servers, chats, opened, created). Search, sort (last
opened, last changed, name, newest, oldest, version), **pin** the ones you work on to the top and
**archive** the ones that are done; right-click a project to rename or delete it.

**Versions.** Every project keeps its step-by-step history (a checkpoint after each AI turn —
*History → Every change*). **Versioning** adds version numbers on top: switch it on when you
create a project (preselected for apps, games, websites and WordPress) or later in the History
tab. The project then carries a `VERSION` file and a `CHANGELOG.md`; **New release** (or “release
version 1.2” in the chat, `studio release minor`) gives the current state the next number —
patch, minor, major or your own — with notes, a git tag, and a copy of `exports/` (the APK, the
.exe, the song …). Each release can be downloaded (files as they were, the kept exports) or
restored later; the version shows in the project's title bar and in the project lists.

While Claude works the chat shows what happens right now — "Writing src/fish.scene.yaml · 6.1 KB"
with the last lines being written, thinking, commands being prepared, API retries — with a timer,
so a long step never looks like a hang.

## Skills and instructions — teach the AI how you work

- **Skills** are know-how for recurring tasks: a name, one sentence on *when to use it* and the
  instructions (a `SKILL.md`). The AI sees names and descriptions and reads a skill when a task
  matches; you call one yourself by starting a message with `/name` (type `/` in a chat for the
  list). Fifteen are built in — song production, mixing, picture design, video editing, stick
  animation, music videos, game polish and assets, 3D models, publishing a website, code review,
  bug fixing, handover, and
  `make-skill`, which turns what you just did into a new skill (“remember how to do this”).
- On the **Skills & instructions** page you write, import/export, switch off and **publish** skills
  to the Global Space; other people add the ones they want (admins mark them as reviewed).
- **Instructions** are rules that always apply — for everything or per area (language, tone,
  preferences, things never to do). Admins can set house rules for everyone under
  Admin → Instructions for every AI.
- Both are plain text in the prompt, so they work the same with Claude Code, Codex, Gemini and
  every other provider. Format and folder: [skills/README.md](../skills/README.md).

## Servers for your apps — multiplayer, saves, leaderboards, APIs

Android apps, Windows programs, games and web apps often need a backend. Claude writes it in the
chat as a **Node.js server** in the project (`server/`), and the Studio runs it — no other hosting:

- **Deploy** from the chat (`studio service deploy`) or the project's **Server** tab: the folder is
  copied into a new release, `npm install` runs, and the server starts as the owner's sandbox
  user. Crashes restart it automatically (with backoff; after 5 crashes in 5 minutes it stops).
- **Reachable at `<Studio address>/srv/<name>/`** — HTTP and WebSocket through the Studio's own
  port, so nothing extra is published. Apps keep this address in one config constant; web games
  served by the Studio use `location.host`.
- **Data** in `DATA_DIR` survives redeploys (SQLite via `node:sqlite`, or JSON files); download it
  as a zip. **Environment variables** (API keys) are stored encrypted. The last three **releases**
  can be rolled back.
- **Templates**: `multiplayer` (WebSocket rooms with player state and chat), `storage` (cloud
  saves + leaderboards in SQLite), `basic` (JSON API) — each with Kotlin/Android, C# and JS
  client examples.
- **Control**: the **Servers** page lists all of yours (status, address, start/stop/restart);
  the project's Server tab has live logs, environment, settings and releases; Claude uses
  `studio service status|logs|restart|env`. Admins see every server and can stop any.

Servers are public at their address (apps must reach them) — protect write endpoints with a key
(the storage template supports `API_KEY`). Phones on your network need `STUDIO_BIND=0.0.0.0`;
for the internet use HTTPS (`--profile https`) with `PUBLIC_URL`. Settings: `SERVICES_ENABLED`,
`MAX_SERVICES_PER_USER` (3), `SERVICE_MEMORY_MB` (512).

## Websites — publish web apps and games on your own domains

Web apps and browser games can go online directly from the Studio. A **second port** (container
port 8081 — port **80** on a web server) serves the published websites and picks the website by
the **domain** of the request; the Studio's own website keeps its port.

- **Publish** in the project's **Website** tab, or let Claude do it (`studio site publish`, “put it
  online”). The finished files — `dist/`, `build/` or `out/` when they hold an `index.html`, else
  the project folder without hidden files, server code, `exports/`, chat uploads and `CLAUDE.md` —
  become a new **release**; the live website only changes on the next publish. Optional build
  command (`npm ci && npm run build`), single-page-app fallback, a site's own `404.html`, and
  rollback to the last three releases.
- **Domains**: add `example.com`, `www.example.com`, … to a website; at the domain provider create
  an **A record** (AAAA for IPv6) → the server's public IP. **Check** tests DNS and that the
  domain really reaches this Studio. Every website is also at `http://<name>.localhost:8081` on
  the Studio's computer, and — with `SITES_BASE_DOMAIN=apps.example.net` plus a wildcard DNS
  record — at `<name>.apps.example.net` automatically.
- **Backends on the same origin**: on a website, `/srv/<server>/` reaches the owner's Node.js
  servers (HTTP + WebSocket), so a game and its multiplayer server need no CORS and no second
  address. A website can also *be* a server of its project (a Node.js web app answering everything).
- **Control**: the **Websites** page lists yours (status, addresses, online/offline); admins see
  every website and can take any offline.
- **HTTPS — one certificate per domain, built in.** A third port (container 8443 — **443** on a
  web server) serves the same websites with TLS; the certificate is chosen by the domain (SNI).
  Per domain, in the Website tab: **automatic** (Let's Encrypt or another ACME authority — requested
  once the domain points here, renewed 30 days before it expires, retried with growing pauses
  and a readable error when DNS or port 80 is not ready), **your own** (paste or upload the PEM
  certificate + key; checked against the domain, the key stored encrypted), **self-signed**, or
  **off**; plus *redirect HTTP → HTTPS* and *HSTS* per domain. Claude sees and repairs it with
  `studio site cert`. Admins switch automatic certificates on once under **Admin → HTTPS**
  (contact e-mail, accepting the authority's terms), see every certificate, upload **wildcard**
  certificates (`*.apps.example.net` for the base domain) and can give the **Studio itself** a host
  name served on the same port with its own certificate.
- **Or a proxy in front**: `docker compose --profile https up -d` puts Caddy on ports 80/443; it
  gets certificates for the Studio (`DOMAIN`) and every bound website domain itself. Set
  `SITES_HTTPS=true` then — the built-in HTTPS switches itself off.

On a web server: `SITES_BIND=0.0.0.0`, `SITES_PORT=80` and `SITES_HTTPS_PORT=443`. Settings:
`SITES_ENABLED`, `SITES_TLS`, `ACME_EMAIL`, `ACME_AGREE_TOS`, `ACME_DIRECTORY_URL`, `STUDIO_DOMAIN`,
`SITES_BASE_DOMAIN`, `MAX_SITES_PER_USER` (10), `SITE_MAX_MB` (500).
Use a domain of its own for websites (not a subdomain of the Studio's domain).

## WordPress — sites, plugins, themes and blocks

A project of the **WordPress** area is a real WordPress site, hosted by the Studio.

- **Set up with a click** in the project's **WordPress** tab: title, admin account, language.
  The current WordPress is downloaded from wordpress.org, gets its **own database** (in the
  built-in database, with an account that sees nothing else) and its **own address** —
  `<name>.localhost:8081` on the Studio's computer, `<name>.<SITES_BASE_DOMAIN>` and your own
  domains with HTTPS (the **Website** tab), exactly like published websites.
- **Manage it there**: open the site, **Open admin** (signs you in — no password needed), switch
  it off/on, install, activate, update and remove plugins and themes (with a search of
  wordpress.org), update WordPress, read the PHP error log, debug mode, a new admin password,
  export the database, remove the site.
- **Build for it.** Your own plugins, themes and blocks live in the project's `plugins/<name>/`
  and `themes/<name>/` — versioned with the project, linked into the site, live at once. **New
  plugin / New theme** starts from a working starter (basic, settings page, Gutenberg block,
  custom post type + REST API; block theme, classic theme) — or just tell the AI what you need:
  it writes the code, activates it, looks at the result in the headless browser, reads the PHP
  log, and exports an **installable zip** (`exports/<name>-<version>.zip`) for any WordPress.
  WP-CLI is there for you and the AI (`cd wordpress && wp …`).
- **How it runs**: each site has its own PHP-FPM that starts with the first visitor and stops
  when nobody visits (`WORDPRESS_IDLE_MINUTES`); requests arrive on the website ports and are
  handed to PHP over FastCGI, static files are sent by the Studio. Scheduled tasks (wp-cron)
  are run by the Studio. E-mail needs an SMTP plugin (there is no mail server in the image).

Settings: `WORDPRESS_ENABLED`, `MAX_WORDPRESS_PER_USER` (5), `WORDPRESS_MEMORY_MB` (256),
`WORDPRESS_MAX_WORKERS` (6), `WORDPRESS_UPLOAD_MB` (64), `WORDPRESS_PHP_HARDENING`. PHP and WP-CLI
are part of the image (`INSTALL_WORDPRESS=true`); WordPress itself is not — it is downloaded when
a site is set up. With an external database server (`MYSQL_HOST`) WordPress needs an account that
may create databases (`WORDPRESS_DB_ADMIN_USER`, `WORDPRESS_DB_ADMIN_PASSWORD`).

## Android SDK — newest version, license accepted by you

The SDK is **not** in the image: its license forbids redistribution and installing it means
accepting Google's terms. Admin → Android SDK shows the terms, the exact packages (newest stable
platforms + build-tools, picked from Google's repository index), and installs them with the new
Android CLI into the data volume (`/data/sdk`) after you tick "I accept". Unattended:
`ANDROID_SDK_ACCEPT_LICENSE=yes` + `ANDROID_SDK_AUTO_INSTALL=true`. Claude then also gets the
Android CLI (`android create`, `android build`, `android preview render` for Compose screenshots).

## Running on a public server

Everything needed is in the image: the websites on ports 80/443, one certificate per domain from
Let's Encrypt, and the Studio itself under its own domain over HTTPS.

1. **DNS**: an A record (and AAAA if the server has IPv6) for the Studio — `studio.example.com` →
   the server. For the websites and WordPress sites of your users, a wildcard record on a
   *separate* domain is the comfortable way: `*.apps.example.com` → the server.
2. **Firewall**: ports 80 and 443 open (TCP). Nothing else — the Studio's own port stays on the
   server.
3. **Configure and start**:
   ```bash
   cp .env.server.example .env       # then edit: STUDIO_DOMAIN, PUBLIC_URL, ACME_EMAIL, ADMIN_*
   docker compose up -d --build      # COMPOSE_FILE in .env adds docker-compose.server.yml
   docker compose logs -f studio     # wait for "certificate for studio.example.com issued"
   ```
   Open `https://studio.example.com` and log in with the admin account.

`docker-compose.server.yml` publishes 80 and 443 on every address of the server (IPv4 **and**
IPv6 — a certificate authority checks a domain that has an AAAA record over IPv6) and keeps port
8080 on `127.0.0.1` (maintenance: `ssh -L 8080:127.0.0.1:8080 you@server`). Good to know:

- **Certificates** are requested when a host is live and its DNS points here, renewed when a
  third of their lifetime (at most 30 days) is left, and retried with growing pauses; the reason
  of a failure is shown per domain (Website tab, Admin → HTTPS, `studio site cert`). Orders are
  budgeted (`ACME_ORDERS_PER_HOUR`, 40) so no user can use up Let's Encrypt's limits for
  everybody. With many sites under one base domain upload a **wildcard** certificate for
  `*.apps.example.com` in Admin → HTTPS (Let's Encrypt allows 50 certificates per domain and week).
- **The first account**: set `ADMIN_EMAIL` / `ADMIN_PASSWORD`. Without them the first visitor
  creates the admin account — from outside the server's private network only with the **setup
  code** from the log (`docker compose logs studio | grep "setup code"`).
- **Accounts**: `REGISTRATION=closed` (default) — admins create users. Logins are rate-limited
  per address.
- **Backups**: `./scripts/backup.sh` (the database including the WordPress sites' databases,
  and the data volume). Keep the data volume's `home/.studio/app-secret` — or set `APP_SECRET`
  — or stored keys and certificates cannot be read after a restore.
- **Resources**: the container is limited to `STUDIO_PIDS_LIMIT` processes/threads and its log to
  100 MB; AI runs, servers, sites and WordPress installations per user have limits in `.env`.
  4 GB RAM is the minimum for a few users; builds (Android, .NET) want more.
- **Behind your own proxy** instead: `TRUST_PROXY=true`, `PUBLIC_URL`, `SITES_HTTPS=true` and
  forward the websites' host names to port 8081 (the Caddy profile does exactly this). The proxy
  must pass `Host`, `X-Forwarded-Proto` and WebSocket upgrades on **every path** (project servers
  use `/srv/<name>/…`), with long timeouts. Ready configurations for nginx and Apache:
  [Server & HTTPS](https://bugfishtm.github.io/ai-everything/server.html#behind-apache).

## Updating

```powershell
.\scripts\update.ps1          # Windows: rebuild with your changes, then restart
.\scripts\update.ps1 -Full    # also newest base image / OS packages
```
```bash
./scripts/update.sh [--full]  # Linux / macOS
```

Claude Code updates itself: with `CLAUDE_CODE_VERSION=latest` (default) the Studio installs the
newest release at start and checks daily; an exact version pins it. Admin → Claude Code shows the
version and has an update button.

## Security model

- Every website user is an own Linux account inside the container; Claude, terminals, the Studio
  software, git and all file access run as that account (`setpriv`, no new privileges).
- Server secrets never reach user processes; previews run in a sandboxed opaque origin.
- Plugin code of Global Space packs runs only after an admin review.
- Project servers run as their owner's sandbox account without Studio secrets; their responses
  are sandboxed (opaque origin) and never receive the Studio's session cookie, and their cookies
  are confined to their own `/srv/<name>/` path.
- Published websites are copied as their owner (only files the owner can read) and written by
  the Studio through a strict extractor (plain files and folders, no links, size limits) into
  releases nobody can change afterwards; they are served on their own port and origin, separate
  from the Studio. On a website only the owner's servers are reachable under `/srv/`. A domain
  can belong to one website only, never to the Studio's own address; several session cookies
  of different accounts (planted from a sibling domain) are rejected.
- Other AIs (ACP agents) run exactly like Claude: as the user's sandbox account in the project,
  without Studio secrets; each gets only that user's keys it can use. Their own sandboxes are off
  (containers lack the kernel features) — the Linux account is the boundary, as for Claude.
- WordPress sites: the PHP of a site runs as its owner's sandbox account, started by a
  root-owned PHP-FPM master on a socket only the Studio can reach; it is confined to the project
  folder (`open_basedir`) and has no shell functions, uploads and caches never execute PHP, and
  hidden files, `wp-config.php`, logs and dumps are not served. Each site's database account sees
  only its own database. The one-click sign-in uses a short-lived, single-use signed link.
  Keep WordPress, plugins and themes updated — a site is public software like any other.
- Programs the Studio starts on behalf of a user (`setpriv`, `git`, `tar` …) are resolved with the
  server's own PATH, never with the user's; files of users reach Studio-owned folders (packs,
  library, websites) only through the strict extractor; the file tree never follows a link out of
  the project.
- `<name>.localhost` addresses answer only on the server and its private network.
- Registration is closed by default; the first account from outside the private network needs the
  setup code from the server log. Use HTTPS on the internet (see *Running on a public server*).

## Legal: Claude Code, Android SDK and publishing

**Claude Code** is Anthropic's proprietary software (*All rights reserved*, use subject to
[Anthropic's terms](https://code.claude.com/docs/en/legal-and-compliance)). ai-everything follows
Anthropic's rules for products that host Claude Code:

| Rule | How ai-everything handles it |
|------|------------------------------|
| Don't redistribute Claude Code | not in the repository, not in the image — downloaded from npm on first start (`INSTALL_CLAUDE_CODE=true` bakes it in only for private, self-built images) |
| Binary unmodified, all sign-in methods kept | the official npm package is installed and run as published; users sign in with a Claude account, the Console or their own API key |
| Each end user uses their own account; nobody pays for or resells usage on their behalf | every user connects their own account; there is no shared key |
| Third parties must not collect, store or route Claude subscription credentials | sign-in happens in Claude Code itself; the Studio stores only users' own API keys, never subscription tokens, and never calls Anthropic with a user's login |
| No Anthropic/Claude names or logos in product names or logos, no implied endorsement | the product is *ai-everything* / *Everything Studio*; it says in plain text that it runs Claude Code |

**Other AI providers** (OpenAI Codex, Google Gemini CLI, OpenCode, codex-acp) are open source
(Apache-2.0 / MIT) and could be redistributed, but they are handled like Claude Code anyway: not
in the image, downloaded unmodified from npm when an admin switches them on. Each user signs in
with their own account in the agent's own sign-in flow (the login stays in their sandbox home) or
stores their own API key (encrypted, given only to their own sessions). Their use is subject to
each vendor's terms — e.g. OpenAI's terms for ChatGPT sign-ins in Codex, Google's terms for Gemini
CLI, and the terms of the model providers configured in OpenCode. Claude subscriptions are only
used through Claude Code itself — OpenCode gets Anthropic **API keys** only.

**If you run ai-everything for other people** (anyone besides yourself), you offer Claude Code
in a service: Anthropic's Commercial Terms of Service and the conditions above apply to you as the
operator. Using it for yourself, each user is bound by their own Anthropic terms.

**Android SDK**: not in the image either — an admin accepts Google's license on the website and
the Studio downloads it (see above).

**Open-source components**: the image contains Debian packages (GPL/LGPL and others), MariaDB
(GPL-2.0), Python and Node packages under their licenses — see [docs/LICENSES.md](LICENSES.md),
which also explains where the corresponding source code is.

## Publishing on Docker Hub

The default build is the publishable one — it contains neither Claude Code nor the Android SDK:

```bash
docker build -t <your-account>/ai-everything:latest .
docker run --rm <your-account>/ai-everything:latest bash -c '! command -v claude' && echo "ok: no Claude Code inside"
docker push <your-account>/ai-everything:latest
```

Do **not** publish an image built with `INSTALL_CLAUDE_CODE=true`. Users then run it with the
`docker run` line from the quick start (or a compose file with `image: <your-account>/ai-everything`).

## For developers

- Architecture: [docs/ARCHITECTURE.md](ARCHITECTURE.md)
- How to build Studio software (the contract the DAW and 3D tool follow): [docs/SOFTWARE.md](SOFTWARE.md)
- Tools: [tools/README.md](../tools/README.md) · Packs: [packs/README.md](../packs/README.md)
- Third-party software and licenses: [docs/LICENSES.md](LICENSES.md)
- CI: `.github/workflows/ci.yml` (type checks, website build, image build smoke test, "no Claude Code in the image" check)

```bash
cd server && npm install && npm run build      # API server (TypeScript)
cd web && npm install && npm run dev           # website on :5173, proxies to a Studio on :8080
```

## Roadmap

- a visual editor for pictures and video timelines on the website (like the DAW for songs and the 3D editor for scenes)
- automation lanes and loops/audio clips in the website DAW, DNS-01 for automatic wildcard certificates
- hand-painted UV unwrapping and a point editor in the view for studio-3d, walk cycles on slopes and lip-sync in studio-stickman
- per-user disk quotas, collaboration on projects

## License

GNU General Public License v3.0 — see [LICENSE.md](../LICENSE.md). It covers the Studio itself, not what
you create with it; the project templates and starter files copied into your projects are CC0-1.0
(the WordPress starters: GPL-2.0-or-later). The built-in packs are CC0-1.0 (`gm-instruments`: MIT, from the
FluidR3 SoundFont), so whatever people make with them is theirs. Third-party software in the image
(Chromium, .NET, MariaDB, …) and software downloaded at runtime (Claude Code, Android SDK) keep
their own licenses — see [docs/LICENSES.md](LICENSES.md).
