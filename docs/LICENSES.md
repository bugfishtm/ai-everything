# Third-party software, legal notes and publishing

This repository contains only our own code plus build instructions, under the **GNU General Public
License v3.0** ([LICENSE.md](../LICENSE.md)) — see *Our own code* below. Its built-in packs are CC0-1.0, except `gm-instruments` (MIT, from the
FluidR3 SoundFont), so songs, models and games made with them are free to use.

ai-everything is independent software. It is **not affiliated with or endorsed by Anthropic**;
Claude and Claude Code are trademarks of Anthropic, PBC. (This is not legal advice — for a binding
answer about your own use case, ask Anthropic.)

## Our own code: GPL-3.0

Everything Studio — the server, the website, the Studio tools, the skills and the build files — is
free software under the GNU General Public License, version 3 (`LICENSE.md`).

- **Using it** — also for other people, also commercially — needs nothing from you.
- **Passing it on** (a changed copy of the source, or an image built from it): give the recipients
  the corresponding source under the same license. For an unchanged image a link to this
  repository at the version you built from does that.
- **What people make with the Studio is theirs.** The license covers the program, not its output.
  The starter content the Studio puts into a user's project — `templates/*/files`,
  `tools/studio/templates/service`, the starters of the Studio tools (`studio-daw new` …),
  `studio skill new`, `studio packs new` — is dedicated to the public domain (CC0-1.0), so projects
  carry no obligation from it. The WordPress starters (`tools/studio/templates/wordpress`) are
  GPL-2.0-or-later, as is customary for WordPress plugins and themes.
- **Dependencies** of the server and the website are under MIT, ISC, BSD, Apache-2.0 and MPL-2.0
  licenses, all of which may be combined with GPL-3.0 code. The other programs in the image
  (MariaDB, ffmpeg, PHP …) and the ones downloaded at runtime (Claude Code, the Android SDK,
  WordPress, other AI agents) are separate programs that the Studio starts; they keep their own
  licenses and are not affected by this one.
- Versions published before the repository moved to GPL-3.0 (images up to tag 1.4) were released
  under the MIT license and stay available under it.

## What is in the image — and what is not

| Component | How it gets in | License / terms | Notes |
|-----------|----------------|-----------------|-------|
| Debian packages (ffmpeg, ImageMagick, SoX, FluidSynth, mingw-w64, NSIS, OpenJDK, git …) | apt at build | various open-source (GPL/LGPL/MIT/BSD …) | see *Source code* below |
| MariaDB server + client (the built-in database) | apt at build (Debian) | GPL-2.0 | runs as its own process; the Studio talks to it over a socket |
| FluidR3 GM SoundFont | apt (`fluid-soundfont-gm`) | MIT | used by the `gm-instruments` pack |
| Node.js base image | `node:24-bookworm` | MIT + bundled licenses | |
| Python packages (numpy, scipy, pillow, opencv-headless, trimesh, manifold3d, shapely, scikit-image, …) | pip at build | BSD / MIT / Apache-2.0 / HPND | `docker/requirements.txt`, tools' `install.sh` |
| three.js | npm at build (studio-3d preview) | MIT | |
| yaml (eemeli/yaml) | npm at build (website DAW: edits song files without touching comments) | ISC | |
| acme-client, @peculiar/x509 (+ reflect-metadata) | npm at build (server: automatic and self-signed HTTPS certificates) | MIT / MIT / Apache-2.0 | certificates come from the ACME authority the admin chooses (Let's Encrypt by default) under that authority's subscriber agreement, which the admin accepts in Admin → HTTPS |
| Playwright + Chromium, Playwright MCP | npm at build | Apache-2.0 / BSD + Chromium's bundled licenses | |
| .NET SDK | Microsoft install script at build | MIT | |
| Gradle | download at build | Apache-2.0 | |
| **Claude Code** | **runtime**: the Studio downloads the official npm package on first start into the data volume | proprietary — *All rights reserved*, [Anthropic's terms](https://code.claude.com/docs/en/legal-and-compliance) | **not in the image**; each user signs in with their own account |
| **Android SDK + Android CLI** | **runtime**, after an admin accepts Google's license | [Android SDK License Agreement](https://developer.android.com/studio/terms) | **not in the image** |
| **Other AI agents**: OpenAI Codex CLI + codex-acp, Google Gemini CLI, OpenCode, custom ACP agents | **runtime**, only when an admin switches one on: the official npm packages into the data volume | Apache-2.0 (Codex, codex-acp, Gemini CLI), MIT (OpenCode); using them is subject to each vendor's terms (OpenAI, Google, the model providers configured in OpenCode) | **not in the image**; users sign in with their own accounts or use their own keys |

## Claude Code

Claude Code's package says *© Anthropic PBC. All rights reserved* and points to Anthropic's legal
agreements. Anthropic's page for products that preinstall or run Claude Code
(<https://code.claude.com/docs/en/legal-and-compliance>, "Can customers offer Claude Code in their
products?" and "Authentication and credential use") sets the rules this project follows:

1. **No redistribution by us.** Neither this repository nor the published image contains Claude
   Code. The Studio downloads the official, unmodified npm package `@anthropic-ai/claude-code`
   from npm on first start (`server/src/claudecli.ts`). The build arg `INSTALL_CLAUDE_CODE=true`
   bakes it in for private, self-built images — never publish such an image. CI fails if the
   image contains Claude Code.
2. **Unmodified, all sign-in methods available.** Claude Code is installed and run as published.
   Users can sign in with a Claude account, the Anthropic Console, or their own API key.
3. **Each user, their own account.** Every person connects their own Claude account or API key;
   usage is billed to them under their own agreement with Anthropic. There is no shared key, and
   nobody pays for, resells or intermediates usage on their behalf.
4. **No collecting, storing or routing of subscription credentials.** Sign-in completes in Claude
   Code's own flow; Claude Code keeps the login in the user's sandbox home. The Studio does not
   accept or store pasted subscription (`claude setup-token`) tokens (database migration 3 deletes
   any stored by older versions), and it never calls Anthropic with a user's login. Plan-usage
   numbers come from Claude Code itself (`claude -p /usage`, a local command without a model request,
   and the rate-limit status Claude Code reports while it works). The only credential the Studio
   stores is a user's **own API key** (encrypted), for that user's own sessions.
5. **Names and logos.** The product is called *ai-everything* / *Everything Studio*. It states in
   plain text that it runs Claude Code and uses no Anthropic or Claude logos.

**Operators:** if you run ai-everything for other people, you offer Claude Code in a service —
Anthropic's Commercial Terms of Service and the conditions above apply to you. For yourself (or
your own team with their own accounts) each person is bound by their own Anthropic terms. Users
must not share accounts; ordinary, individual use only (Anthropic Usage Policy).

## Other AI providers

OpenAI Codex (with the codex-acp adapter), Google's Gemini CLI and OpenCode are open source and
could be redistributed, but they are handled like Claude Code: not in the image, downloaded
unmodified from npm when an admin switches them on, and updated from there. Each user signs in
with their own account in the agent's own sign-in flow (ChatGPT, Google, OpenCode's provider
logins — kept by the agent in the user's sandbox home) or stores their own API keys (encrypted,
handed only to that user's own sessions). Claude subscriptions are used only through Claude Code
itself; OpenCode gets Anthropic API keys only. OpenAI, ChatGPT and Codex are trademarks of OpenAI;
Google and Gemini are trademarks of Google LLC; ai-everything is not affiliated with or endorsed by
them.

## Why the Android SDK is installed at runtime

The Android SDK License Agreement does not allow redistributing the SDK, and installing it means
accepting that agreement. So:

- the image contains only JDK + Gradle (freely redistributable);
- an admin installs the **newest stable** SDK from the website (Admin → Android SDK) after ticking
  "I accept" — or sets `ANDROID_SDK_ACCEPT_LICENSE=yes` + `ANDROID_SDK_AUTO_INSTALL=true` for
  unattended deployments (setting the variable *is* the acceptance);
- the SDK lands in `/data/sdk/android` (the data volume), the acceptance (who/when) is stored in the database;
- updates re-check Google's repository index and install newer platforms/build-tools.

## Source code of open-source components (GPL/LGPL)

The image is built from Debian bookworm packages and public package registries; nothing is
modified. The source code of every Debian package is available from Debian
(<https://sources.debian.org>, or `apt-get source <package>`; exact versions:
<https://snapshot.debian.org>). The installed package list is inside the image
(`dpkg -l`). If you publish an image and someone asks for the corresponding source of a GPL
component in it, point them to those archives or provide it for at least three years.

## Publishing checklist

- The repository is licensed under the GNU GPL v3.0 (`LICENSE.md`). If you publish a changed
  version, or an image built from one, publish its source under the same license.
- Do not commit `.env`, `data/` or `backups/` (see `.gitignore`).
- Publish images built with the default build args (no Claude Code inside); the CI check
  "The image must not contain Claude Code" must pass.
- Don't use "Claude" or "Anthropic" (or other vendors' names like OpenAI, Codex, Gemini) in your
  image/repository name, and no vendor logos.
- Publish images without any AI agent inside: they are downloaded at runtime when an admin
  switches them on (nothing to do — the Dockerfile installs none).
- Packs you publish must only contain content you may share; put the license into `pack.json`.
