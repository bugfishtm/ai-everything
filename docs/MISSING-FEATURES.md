# Missing functions — what Everything Studio should add next

A survey of the code (server, website, creative tools, Docker setup and docs) for functions a
self-hosted, multi-user creative platform of this kind is expected to have but this one lacks.
Every gap was checked twice: once when it was found (by searching the code for it under any name)
and once more by a separate review that tried to prove it already exists. Nothing listed here
exists yet; partial pieces are named in *Already there*. Overlapping findings from different
areas are merged into one row.

**Priority** — **P1**: protects data or the service, or is a frequent daily pain; do soon.
**P2**: clear value for many users. **P3**: nice to have, or for larger installations.
**Effort** — **S**: a day or two · **M**: about a week · **L**: several weeks.

Done with this change (so not listed): optional two-step sign-in with an authenticator app (TOTP),
recovery codes, a persistent lock after 10 wrong codes, admin reset and `studio-db reset-2fa`.

## Suggested order

Cheap insurance first, then the gaps that let one user hurt everyone, then the daily-use wins:

1. **Global error boundary + stale-chunk reload** (#41, S) — a crash or an image update currently blanks the whole app and loses unsaved text.
2. **Safe updates: database dump before migrations** (#31, S) — a failed upgrade can leave a half-migrated database with no way back.
3. **Security audit log** (#1, M) — today nothing records logins, failed logins or admin actions; also needed for fail2ban.
4. **Active sessions list + revoke** (#2, S) — the session table already stores address and browser.
5. **Per-user disk quotas** (#22, M) and **CPU/RAM limits** (#23, M) — one user can fill the volume or starve every other user and the database.
6. **Notifications for AI runs** (#12, M) — approvals time out unseen after 15 minutes, long runs finish unnoticed.
7. **Unsaved-work protection** (#42, M) — a save can silently overwrite the AI's newer edit of the same file.
8. **Admin-enforced 2FA policy** (#4, M) — builds directly on the new two-step sign-in; admins on public servers should be required to use it.
9. **Visual stick-scene editor** (#33, L) — the biggest single improvement for the Stickman tool after this change.
10. **Scheduled backups with retention** (#28, M) — today backups depend on a host cron the admin has to set up.

## Accounts and security

| # | Missing function | Why it matters | Already there | Prio | Effort |
|---|---|---|---|---|---|
| 1 | Security audit log (logins, failed logins, password/role/status changes, account create/delete, 2FA changes) with an admin viewer and fail2ban-friendly log lines | A compromise cannot be investigated afterwards; failed logins are not even logged, so fail2ban/CrowdSec cannot ban brute-forcers | A few unstructured console lines (2FA on/off, wrong 2FA codes, recovery sign-in, account deletion) without IP | P1 | M |
| 2 | Active sessions: list devices, revoke one, sign out everywhere; admin force-logout | A lost or stolen device cannot be signed out without changing the password | Address and browser are stored per session; "end all sessions" runs only as a side effect of password change, 2FA on, disable | P2 | S |
| 3 | Brute-force hardening for passwords: per-account throttle across addresses, limit on the change-password check, persistent counters | Credential stuffing from many addresses against one account is never slowed; a hijacked session can guess the password at `/account/password` | Per-address login limits (in memory); the 2FA code step now has a persistent per-account cap | P2 | S |
| 4 | Admin-enforced 2FA policy (off / admins / everyone, with grace period) | Opt-in protects only those who opt in; admins of a server that runs code should be required to use it | Opt-in TOTP, recovery codes, admin reset, `twoFactor` flag per user | P2 | M |
| 5 | Step-up re-authentication for admin actions + session idle timeout | A stolen admin cookie stays valid 30 days and can delete users or change roles without any re-check | Password re-check for the account's own 2FA changes; absolute session lifetime (`SESSION_DAYS`) | P2 | M |
| 6 | One-time invite / set-password links (no e-mail needed) + "must change password at next login" | Admins type passwords for users and must pass them on; admin-chosen passwords are never forced to change | Signed single-use token helpers (used for 2FA tickets) | P2 | M |
| 7 | GDPR self-service: export all personal data, delete own account; privacy/imprint links on the login page | The operator must deliver and delete a user's data on request (PRIVACY.md); today only per-item exports and admin deletion exist | Project, asset, skill, service-data, release and WordPress-DB exports | P2 | M |
| 8 | Change e-mail address / username (self-service with password, and by admins) | A typo in the e-mail can never be fixed except by deleting the account | — | P3 | S |
| 9 | Password policy: reject common/breached passwords, strength meter | `password1` is accepted for an admin of an internet-facing server that executes code | Minimum length 8 | P3 | S |
| 10 | Single sign-on via OIDC (Authentik, Keycloak, Entra, Google) with group→role mapping | Teams use an identity provider; offboarding there does not lock the Studio account | — | P3 | L |
| 11 | Passkeys / WebAuthn (second factor and passwordless) | Phishing-resistant, the natural next step after TOTP | TOTP two-step sign-in | P3 | L |

## Projects, AI and collaboration

| # | Missing function | Why it matters | Already there | Prio | Effort |
|---|---|---|---|---|---|
| 12 | Notifications: AI run finished/failed, approval waiting, limit reached — in-app bell, browser notification, optional e-mail/webhook | Approvals are shown only inside that chat and are denied by themselves after 15 min; a user on another page silently loses the run | A "working" pill on project cards; `sendToUser()` over the WebSocket could carry the events | P1 | M |
| 13 | Share a project with other users (viewer/editor roles, "Shared with me") | The Studio is built for several people, yet only the owner can open a project; admins cannot help inside one | Read-only sharing of finished library assets and packs | P2 | L |
| 14 | Diff view per file, view a file at a version, restore a single file, compare versions, history beyond the newest 200 | Work is kept as text so it can be compared, but History shows only "N files changed"; restoring one file means rolling back everything | `--stat` summaries, whole-project restore, release restore, per-edit diffs in the chat | P2 | M |
| 15 | Global search and command palette: projects, files (quick open), file contents, chat history (Ctrl+K / Ctrl+P) | "The prompt that made the good drum loop" or a string in the files cannot be found without a terminal | Page-local search boxes; Ctrl+F inside one open file; server-side library search | P2 | M |
| 16 | Restore deleted projects from the trash | The delete dialog promises a trash, but nothing brings a project back; chats, settings, sites and servers are deleted at once | The folder (with git history) is kept in `.trash/` for `TRASH_DAYS` | P2 | M |
| 17 | Duplicate/fork a project; custom project templates (save as template, choose one on create) | Users cannot branch an idea or start from a finished skeleton; admins cannot offer house templates | One built-in scaffold per area; file-level starters | P2 | M |
| 18 | Git remote sync (push/pull to GitHub/GitLab/Gitea with stored, encrypted credentials) | Code of apps, games and plugins usually also lives on a forge; today only by hand in the shell with unmanaged credentials | git, git-lfs and ssh in the image; a persistent sandbox home | P2 | M |
| 19 | Continue a chat with another AI (provider hand-over with a recap) | When the Claude limit is reached the only way out is a new chat without the conversation | `recapOf()` already builds a transcript for ACP sessions | P2 | S |
| 20 | Project import (zip with history or a git URL) and a complete export bundle (chats, releases, settings) | Moving between Studio instances or starting from an existing repo is impossible; the download zip is one-way | Zip download with `.git`; release zips; folder upload | P3 | M |
| 21 | Chat ergonomics: queue a follow-up while the AI works, edit/retry the last message, fork a chat at a turn | "Also make it blue" cannot be added during a 20-minute run (409); a poor turn cannot be retried | Stop button | P3 | M |

## Hosting, operations and limits

| # | Missing function | Why it matters | Already there | Prio | Effort |
|---|---|---|---|---|---|
| 22 | Per-user disk quotas and storage accounting (admin sees who uses how much) | All users share one volume; one user's renders, caches or uploads can fill it and break the database for everyone | Per-item caps (upload, pack, site, release, WordPress upload sizes); trash purge | P1 | M |
| 23 | Enforced CPU/RAM limits per user process (AI runs, builds, servers, PHP pools) — e.g. cgroups v2 or `prlimit` | One runaway Gradle build, AI run or Node server starves every other user and MariaDB | Container `pids_limit`; PHP memory/worker limits; V8 heap flag for servers (the owner can raise it) | P1 | M |
| 24 | Per-user limit overrides and feature permissions (more runs for one user, no websites for a guest …) | Every limit is one global environment value | Global `MAX_*_PER_USER` values and global feature switches | P2 | M |
| 25 | Outgoing e-mail (SMTP) for the Studio, WordPress sites and project servers: forgot password, e-mail verification, security and crash notices | WordPress cannot send mail at all (contact forms, password resets, shop orders fail silently); the Studio has no forgot-password flow | Documented workaround: an SMTP plugin in WordPress | P2 | M |
| 26 | Monitoring and alerts: CPU/RAM/disk view, Prometheus `/api/metrics`, notices for crashed servers and expiring certificates | Crashes and failing renewals are only seen if someone opens the page; Let's Encrypt no longer e-mails expiry warnings | Docker health check; service crash backoff with a "crashed" state; certificate expiry shown in Admin → HTTPS | P2 | M |
| 27 | Rate limiting for public sites (`wp-login.php`, `xmlrpc.php`, `/srv` APIs) | Every hosted WordPress is open to credential stuffing; each login POST occupies one of 6 PHP workers, so a small flood takes it down | Users can install a WordPress plugin (still costs PHP workers) | P2 | S |
| 28 | Scheduled backups in the app: retention, off-site target (S3/rclone), one-command restore | The only backup is a host-side script the admin must schedule; old backups are never pruned; restore is four manual commands | `scripts/backup.sh`, `studio-db dump/import`, documented restore | P2 | M |
| 29 | WordPress backup/restore, import of an existing site, automatic snapshot before updates | Core/plugin updates run without a snapshot; a broken update cannot be undone | Database export to `exports/`; WP-CLI | P2 | M |
| 30 | Compression (gzip/brotli) and cache headers for published websites | Multi-megabyte game bundles are served uncompressed and revalidated on every visit | Compression only behind the optional Caddy profile; ETag/Last-Modified | P2 | S |
| 31 | Safe Studio updates: automatic database dump before migrations, new-version notice for admins | A failed upgrade can leave a half-migrated database; admins never learn about security releases | Docs advise a manual backup first | P2 | S |
| 32 | Per-site access protection and routing rules (password, www↔apex redirect, custom redirects and headers) | Private client previews are impossible; `example.com` and `www.example.com` serve duplicate content | Own auth possible in server mode | P2 | M |
| — | User-defined scheduled jobs (cron) per project or server | Nightly leaderboard resets, cleanups or rebuilds need a hack with `setInterval` in an always-on server | wp-cron for WordPress sites | P2 | M |
| — | Website access/error logs and traffic counters | 404s, 5xx errors and bot floods on a published site are invisible | Live log for Node servers; PHP error log for WordPress | P3 | M |
| — | Snapshots of server data on deploy; restore an uploaded `data.zip` | Code rollback cannot undo a bad data migration; a downloaded data zip cannot be put back | Data download; code rollback of the last 3 releases | P3 | S |
| — | Automatic wildcard certificates via ACME DNS-01 | Uploaded wildcard certificates are never renewed and expire silently after 90 days | Manual wildcard upload; automatic HTTP-01 per host | P3 | M |

## Creative tools and library

| # | Missing function | Why it matters | Already there | Prio | Effort |
|---|---|---|---|---|---|
| 33 | Visual editor for stick scenes (`.stick.yaml`): timeline, draggable pose rig, scrubbable live preview | Stickman is the hardest format to write by hand (joint angles, timing, camera); people can only edit YAML and render | Check / Draft / Render buttons; `sheet`, `still`, `at` (new) in the CLI | P1 | L |
| 34 | Visual timeline editor for videos (`.video.yaml`) | A track view with trim, overlays and a scrubbable preview is what people expect from a video tool; on the roadmap | Check / Draft / Render buttons; `still`, `sheet` | P2 | L |
| 35 | Visual canvas editor for pictures (`.image.yaml`) | Moving a text block means guessing pixel numbers and re-rendering; on the roadmap | Check / Render with a preview | P2 | L |
| 36 | Render job queue: progress, cancel, server-wide concurrency limit | Web renders hold one request open for up to 20 min with no progress or cancel; several users' renders starve the container | Per-project lock, 20-min kill timeout | P2 | M |
| 37 | Web DAW: automation lanes, audio clips/tracks, microphone recording | The engine automates fades and filters but the editor cannot show it; songs cannot hold vocals | Automation as a text field in the mixer; one-shot `sample` instrument | P2 | L |
| 38 | Voice: text-to-speech narration, and mouths that follow a voice track in stickman | Explainers and dialogues need spoken lines; today `say` shows a bubble without any voice | Speech bubbles with a pop sound; speakers gesture and their mouths move with the text; recorded files as video audio | P2 | M |
| 39 | Compositing: transparent stickman renders, photo/video backdrops, picture-in-picture and chroma key in studio-video | "Stick figures over real footage" and green-screen are standard formats; the two tools cannot be layered | Image prop with transparency; RGBA sprite sheets; PNG overlays in studio-video | P2 | M |
| 40 | Studio source formats as real library assets (right kind, rendered thumbnail, open in the DAW/3D editor) | A saved song or scene gets kind "other" and no thumbnail, so searches miss it | Kind can be picked by hand; thumbnail upload | P2 | M |
| — | `studio-browser record`: capture gameplay/page video | The video tool is pitched for game trailers but nothing can record a game | Playwright + Chromium with scripted key presses | P2 | S |
| — | Library asset versioning (update files of an asset, keep its id and import count) | Improving a published asset means a duplicate and stale copies | Metadata and thumbnail edits | P3 | M |
| — | Install packs from an uploaded zip or a URL | Packs download as a zip but a zip cannot be installed | Install from a folder in a project | P3 | S |
| — | Vector and layered export for pictures (SVG/PDF, ORA/PSD) | Logos need SVG/PDF; designers need layers for Krita/GIMP/Photoshop | Raster exports; SVG input | P3 | M |
| — | Audio visualizer generator for music videos | The standard way to publish a song as a video | Static waveform/spectrogram PNG from `studio-daw analyze` | P3 | S |
| — | 3D turntable videos and keyframe animation (animated `.glb`, scene clips in studio-video) | No product-shot turntable, no animated models for games | Camera JSON for previews | P3 | L |

## Website and usability

| # | Missing function | Why it matters | Already there | Prio | Effort |
|---|---|---|---|---|---|
| 41 | Global error boundary + automatic reload on stale chunks after an update | Any render error or a missing lazy chunk after an image update blanks the whole app and loses unsaved editor text | The DAW and 3D editor show their own parse errors inline | P1 | S |
| 42 | Unsaved-work protection: leave guard, "file changed on disk" banner, save conflict check (409) | Closing the tab or a 401 drops dirty buffers; a save overwrites the AI's newer edit of the same file | Discard confirm per tab; "unsaved" badge; `mtime` already returned by the API | P1 | M |
| 43 | Split workspace: chat beside preview/files/DAW, resizable, layout remembered | The core loop is "ask the AI, watch the result", but chat and preview are exclusive tabs | Panels keep their state while hidden | P2 | M |
| 44 | Connection-lost / "Studio was updated — reload" banner | Live streams and approvals stop silently when the WebSocket drops; old JS keeps running against a new API | WebSocket reconnects with backoff | P2 | S |
| 45 | Accessibility baseline: keyboard file tree, ARIA tabs, focus trap in dialogs, live regions for toasts/streams, contrast of secondary text | Several parts cannot be used with a keyboard or screen reader; small grey text fails WCAG AA | Dialog role and focus rings | P2 | M |
| 46 | More file viewers: PDF, CSV table, font specimen, archive/APK listing | AI-made PDFs, data files, fonts and zips show as "Binary file" | Download button; CSV as plain text; a `pdf` view kind without renderer | P2 | M |
| 47 | Safer file management: trash/undo for deletes, overwrite prompt on upload, cancel upload, multi-select and drag-to-move | Manual deletes are permanent and uploads overwrite silently | Delete confirm; move via context menu; upload progress | P2 | M |
| 48 | Light / system theme and appearance preferences | The UI is dark only | Colours are mostly CSS variables | P3 | M |
| 49 | First-run checklist for admins (domain, HTTPS, registration, limits, backups) and users (connect AI → first project → publish) | New installs and users get little guidance; unconfigured public installs can be unsafe | "Connect Claude" banner; external docs | P3 | S |
| 50 | Translations of the UI | Every string is hard-coded English | Dates and numbers follow the browser locale | P3 | L |
| 51 | Installable app (web manifest, icons, offline page) | No standalone window or proper home-screen icon | SVG favicon | P3 | S |

Rows marked **—** are smaller or narrower gaps of the same area that did not get a number.
