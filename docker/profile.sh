# Everything Studio — keep the toolchain on PATH in login shells.
# (Debian's /etc/profile resets PATH; Claude Code's Bash tool and the web shell use login shells.)
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.dotnet/tools:/data/sdk/claude-code/bin:/opt/venv/bin:/data/sdk/android/cmdline-tools/latest/bin:/data/sdk/android/platform-tools:/opt/gradle/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
# Headless browser for the Studio tools (also when a shell starts with an empty environment)
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/ms-playwright}"
export CHROMIUM_PATH="${CHROMIUM_PATH:-/usr/local/bin/chromium}"
export NODE_PATH="${NODE_PATH:-/usr/local/lib/node_modules}"
