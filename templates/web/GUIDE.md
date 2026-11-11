### Web apps

- `index.html` in the project root is what the **Preview** tab opens (sandboxed
  iframe). Use relative URLs.
- Small sites: plain HTML/CSS/JS with ES modules — no build step.
- Bigger apps: Vite (`npm create vite@latest`), with `base: './'` in
  `vite.config`, build to `dist/` and set the preview path to `dist/index.html`
  in the project settings.
- `localStorage` / `IndexedDB` / cookies are blocked in the sandboxed preview — wrap
  them in try/catch. Network calls to other sites work if those sites allow CORS.
- Accessible, responsive, fast: semantic HTML, keyboard navigation, mobile first.

**Check your work** — `studio-browser shot index.html --out .studio/shot.png`
(and `--width 390 --height 844` for mobile) then read the screenshot;
`studio-browser console index.html` must show no errors.

**Deliverables** — `exports/site.zip` of the deployable files when asked.

**Online features** (multiplayer, cloud saves, leaderboards, accounts, an API): write a Node.js
server in `server/` and let the Studio run it — `studio service new --template multiplayer|storage|basic`,
then `studio service deploy` after every change (prints the public URL + log), `studio service logs`.
The server listens on `$PORT` and keeps data in `$DATA_DIR`; clients use its URL (`…/srv/<name>/`).
The user controls it in the project's **Server** tab.

**Publish as a website** — `studio site publish` puts the game/app online as a real website on the
user's domains (`--root dist --build "npm run build"` for build tools, `--spa` for single-page apps).
On the website the project's servers share the origin: `fetch("/srv/<server>/…")`. The user adds
domains and takes it online/offline in the project's **Website** tab; `studio site status` shows the addresses.
