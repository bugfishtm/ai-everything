### JS games

- `index.html` in the project root is what the **Preview / Play** tab opens (a
  sandboxed iframe). Use **relative** URLs everywhere.
- No build step needed: ES modules (`<script type="module" src="src/main.js">`) and
  libraries from a CDN via an import map (three.js, Phaser, …) work. If you use Vite,
  set `base: './'` and change the preview path to `dist/index.html` (project settings).
- `localStorage` / `IndexedDB` are blocked in the sandboxed preview — wrap them in
  try/catch and fall back to memory.
- Audio may only start after a user gesture — show a start screen.
- Structure: `src/main.js` (bootstrap + loop), `src/scenes/`, `src/entities/`,
  `assets/` (sprites, sounds, models). Keep levels and tuning values in JSON/text.
- Make it feel finished: start screen, pause, HUD/score, game over + restart,
  keyboard and touch controls, scales with the window, steady 60 fps.

**Check your work** — `studio-browser shot index.html --wait 2000 --out .studio/shot.png`
(add `--press "Space"` to get past the start screen) and read the screenshot;
`studio-browser console index.html` must show no errors.

**Assets** — search the library for models, sprites, sounds and music first
(`studio lib search … --kind model3d|image|audio|music`).
Make what is missing with the Studio tools: music with `studio-daw`, sound effects with
`studio-daw sfx jump,coin,hit --out assets/sfx` (`studio-daw sfx list`), 3D models
with `studio-3d`, animated characters with `studio-stickman` (`studio-stickman sprite <scene>
--figure NAME --from T --to T --frames 8` → a transparent sprite sheet + atlas JSON in `exports/`),
sprites, pixel art, tiling textures, UI art and icons with `studio-image` (`studio-image new
src/x.image.yaml --template pixel|texture|icon`), a trailer with `studio-video`.

**Deliverables** — when the user wants to ship: `exports/<game>.zip` with the playable build.

**Online features** (multiplayer, cloud saves, leaderboards, accounts, an API): write a Node.js
server in `server/` and let the Studio run it — `studio service new --template multiplayer|storage|basic`,
then `studio service deploy` after every change (prints the public URL + log), `studio service logs`.
The server listens on `$PORT` and keeps data in `$DATA_DIR`; clients use its URL (`…/srv/<name>/`).
The user controls it in the project's **Server** tab.

**Publish as a website** — `studio site publish` puts the game/app online as a real website on the
user's domains (`--root dist --build "npm run build"` for build tools, `--spa` for single-page apps).
On the website the project's servers share the origin: `fetch("/srv/<server>/…")`. The user adds
domains and takes it online/offline in the project's **Website** tab; `studio site status` shows the addresses.
