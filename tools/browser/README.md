# studio-browser — headless Chromium for Claude

Claude cannot see the user's screen. To check a game or page it built, it
renders it in headless Chromium and looks at the screenshot.

```bash
studio-browser shot index.html --out .studio/shot.png          # local file (served over http)
studio-browser shot dist/ --width 390 --height 844             # folder → dist/index.html, phone size
studio-browser shot index.html --wait 3000 --press "Space,ArrowRight" --out after-input.png
studio-browser console index.html                               # errors, warnings, logs
studio-browser html https://example.com
```

* Local paths are served by a temporary http server rooted at the folder, so
  relative URLs, ES modules and `fetch()` behave like in the real preview.
* WebGL/WebGL2 work through SwiftShader (software rendering): fine for checks,
  not for benchmarks.
* `--press` sends comma separated key presses after the wait (Playwright key
  names: `ArrowLeft`, `Space`, `Enter`, `KeyW` …), then waits 500 ms again.

For interactive browsing (click, type, navigate step by step) Claude also has
the Playwright MCP tools `mcp__playwright__*`.
