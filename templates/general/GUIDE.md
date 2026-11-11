### Anything else

A blank workspace with every toolchain of the image available (Node.js, Python with
numpy/pillow/…, ffmpeg, ImageMagick, .NET, Java, mingw-w64, headless Chromium).

- Put code in `src/`, inputs in `assets/`, results the user should download in `exports/`.
- Write a short README in the project root describing how to run what you built.
- Prefer scripts and text formats the user can inspect and re-run.

**Online features** (multiplayer, cloud saves, leaderboards, accounts, an API): write a Node.js
server in `server/` and let the Studio run it — `studio service new --template multiplayer|storage|basic`,
then `studio service deploy` after every change (prints the public URL + log), `studio service logs`.
The server listens on `$PORT` and keeps data in `$DATA_DIR`; clients use its URL (`…/srv/<name>/`).
The user controls it in the project's **Server** tab.

**Publish as a website** — `studio site publish` puts the game/app online as a real website on the
user's domains (`--root dist --build "npm run build"` for build tools, `--spa` for single-page apps).
On the website the project's servers share the origin: `fetch("/srv/<server>/…")`. The user adds
domains and takes it online/offline in the project's **Website** tab; `studio site status` shows the addresses.
