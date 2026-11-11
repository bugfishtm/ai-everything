### Windows software

Everything is cross-compiled on Linux; finished `.exe` files go to `exports/`.

**.NET (recommended for GUI apps)** — `dotnet --version`
- Console: `dotnet new console -o src/App`
- WinForms / WPF: `dotnet new winforms -o src/App` (or `wpf`), then add
  `<EnableWindowsTargeting>true</EnableWindowsTargeting>` to the `.csproj` — required
  to build Windows desktop apps on Linux.
- One-file exe: `dotnet publish src/App -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o exports/App`
  (small framework-dependent build: `--self-contained false`).

**C / C++** — mingw-w64:
`x86_64-w64-mingw32-gcc src/main.c -o exports/app.exe -mwindows -static`
(C++: `x86_64-w64-mingw32-g++ … -static-libstdc++ -static-libgcc`).

**Installers** — NSIS: write `installer.nsi`, build with `makensis installer.nsi`.

**Check your work** — Windows programs cannot run here (no Windows, no display).
Build without warnings, put logic in a separate library and test it with
`dotnet test` (target `net10.0`), and check the result with `file exports/*.exe`.
If the image was built with Wine, console programs can be smoke-tested with `wine`.

**Online features** (multiplayer, cloud saves, leaderboards, accounts, an API): write a Node.js
server in `server/` and let the Studio run it — `studio service new --template multiplayer|storage|basic`,
then `studio service deploy` after every change (prints the public URL + log), `studio service logs`.
The server listens on `$PORT` and keeps data in `$DATA_DIR`; clients use its URL (`…/srv/<name>/`).
The user controls it in the project's **Server** tab.
