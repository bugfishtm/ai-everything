# syntax=docker/dockerfile:1.7
#
# ai-everything — one image that contains:
#   * the Studio website + API (Node.js), served on port 8080
#   * creative + app-development toolchains Claude Code uses inside projects
#     (Python libs, ffmpeg, ImageMagick, FluidSynth, .NET, mingw-w64, JDK + Gradle,
#      Playwright/Chromium headless browser, ...)
#   * /opt/studio/tools — our own text-file based creative software (DAW, 3D, …)
#   * /opt/studio/packs — expansion packs those tools and Claude can use
#   * its own database (MariaDB, MySQL compatible) — one container, no extra services
#   * PHP (FPM) + WP-CLI for the WordPress area (WordPress itself is downloaded at runtime)
#
# Persistent data: two volumes, /data (projects, library, packs, homes, SDKs)
# and /var/lib/mysql (the database). See docker-compose.yml.
#
# NOT inside the image (third-party software that must not be redistributed):
#   * Claude Code — Anthropic's proprietary CLI. The Studio downloads the official
#     npm package on first start into the data volume (server/src/claudecli.ts).
#     INSTALL_CLAUDE_CODE=true bakes it in for PRIVATE images only — never publish those.
#   * the Android SDK — the Studio downloads it at runtime after an admin accepted
#     Google's license (Admin → Android SDK).
#
# Build:   docker compose build                (build args come from .env)
# Update:  scripts/update.ps1  |  scripts/update.sh
#
ARG NODE_VERSION=24
ARG DEBIAN_RELEASE=bookworm

# =============================================================================
# Stage 1 — toolchain: heavy system software. Changes rarely, so it stays cached.
# =============================================================================
FROM node:${NODE_VERSION}-${DEBIAN_RELEASE} AS toolchain

# Build args are declared right before the step that uses them: changing one
# (e.g. INSTALL_WINE) only rebuilds that step, not the whole toolchain.

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=UTC \
    VIRTUAL_ENV=/opt/venv \
    NODE_PATH=/usr/local/lib/node_modules \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    CHROMIUM_PATH=/usr/local/bin/chromium \
    ANDROID_HOME=/data/sdk/android \
    ANDROID_SDK_ROOT=/data/sdk/android \
    JAVA_HOME=/usr/lib/jvm/default-java \
    GRADLE_HOME=/opt/gradle \
    DOTNET_ROOT=/usr/share/dotnet \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1 \
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    SOUNDFONT=/usr/share/sounds/sf2/FluidR3_GM.sf2
ENV PATH=/opt/venv/bin:/data/sdk/android/cmdline-tools/latest/bin:/data/sdk/android/platform-tools:/opt/gradle/bin:${PATH}

# --- Base system, media + general dev tools ---------------------------------
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      tini ca-certificates curl wget gnupg git git-lfs openssh-client \
      build-essential cmake pkg-config \
      python3 python3-dev python3-venv python3-pip \
      jq ripgrep tree file less nano vim-tiny procps psmisc lsof \
      zip unzip p7zip-full xz-utils rsync \
      ffmpeg imagemagick sox libsox-fmt-all libsndfile1 fluidsynth fluid-soundfont-gm \
      fonts-dejavu-core fonts-liberation fonts-noto-color-emoji \
      libicu-dev; \
    rm -rf /var/lib/apt/lists/*; \
    git lfs install --system

# --- Python libraries for creative coding (shared, read-only venv) ----------
COPY docker/requirements.txt /tmp/requirements.txt
RUN set -eux; \
    python3 -m venv /opt/venv; \
    /opt/venv/bin/pip install --no-cache-dir --upgrade pip wheel setuptools; \
    /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt; \
    rm /tmp/requirements.txt

ARG INSTALL_DOTNET=true
ARG DOTNET_CHANNEL=10.0
# --- .NET SDK (Windows software: console, WinForms/WPF with EnableWindowsTargeting) ---
RUN set -eux; \
    if [ "$INSTALL_DOTNET" = "true" ]; then \
      curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh; \
      bash /tmp/dotnet-install.sh --channel "$DOTNET_CHANNEL" --install-dir /usr/share/dotnet --no-path; \
      ln -sf /usr/share/dotnet/dotnet /usr/local/bin/dotnet; \
      rm /tmp/dotnet-install.sh; \
      dotnet --list-sdks; \
    fi

ARG INSTALL_WINDOWS_CROSS=true
ARG INSTALL_WINE=false
# --- Windows cross compilers (C/C++ -> .exe) + NSIS installers (+ optional Wine) ---
RUN set -eux; \
    pkgs=""; \
    if [ "$INSTALL_WINDOWS_CROSS" = "true" ]; then pkgs="$pkgs gcc-mingw-w64-x86-64 g++-mingw-w64-x86-64 mingw-w64-x86-64-dev nsis"; fi; \
    if [ "$INSTALL_WINE" = "true" ]; then pkgs="$pkgs wine wine64"; fi; \
    if [ -n "$pkgs" ]; then \
      apt-get update; apt-get install -y --no-install-recommends $pkgs; rm -rf /var/lib/apt/lists/*; \
    fi

ARG INSTALL_BROWSERS=true
ARG PLAYWRIGHT_VERSION=1.65.0
ARG PLAYWRIGHT_MCP_VERSION=0.0.84
# --- Headless browser for the AI: Playwright + Chromium + Playwright MCP -----
# /usr/local/bin/chromium is a wrapper that enables software WebGL (SwiftShader),
# so Claude can screenshot WebGL / three.js games without a GPU.
RUN set -eux; \
    if [ "$INSTALL_BROWSERS" = "true" ]; then \
      npm install -g --no-audit --no-fund "playwright@${PLAYWRIGHT_VERSION}" "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}"; \
      playwright install --with-deps chromium; \
      CHROME="$(node -e "process.stdout.write(require('playwright').chromium.executablePath())")"; \
      test -x "$CHROME"; \
      printf '#!/bin/sh\nexec "%s" --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist "$@"\n' "$CHROME" > /usr/local/bin/chromium; \
      chmod 755 /usr/local/bin/chromium; \
      chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH"; \
      rm -rf /var/lib/apt/lists/*; \
      npm cache clean --force; \
    fi

ARG INSTALL_ANDROID=true
ARG GRADLE_VERSION=9.9.0
# --- Android toolchain prerequisites: JDK 17 + Gradle ------------------------
# (the SDK itself is installed at runtime, see the header of this file)
RUN set -eux; \
    if [ "$INSTALL_ANDROID" = "true" ]; then \
      apt-get update; \
      apt-get install -y --no-install-recommends default-jdk-headless; \
      rm -rf /var/lib/apt/lists/*; \
      curl -fsSL "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" -o /tmp/gradle.zip; \
      unzip -q /tmp/gradle.zip -d /opt; \
      ln -s "/opt/gradle-${GRADLE_VERSION}" /opt/gradle; \
      rm /tmp/gradle.zip; \
      chmod -R a+rX "/opt/gradle-${GRADLE_VERSION}"; \
    fi

# --- Built-in database: MariaDB (MySQL compatible) ---------------------------
# The data directory starts empty and is initialised on the first container start
# (docker/db.sh), so a fresh volume always gets a fresh database.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends mariadb-server mariadb-client; \
    rm -rf /var/lib/apt/lists/* /var/lib/mysql/*; \
    install -d -o mysql -g mysql -m 0750 /var/lib/mysql /run/mysqld

ARG INSTALL_WORDPRESS=true
ARG WP_CLI_VERSION=2.12.0
# --- WordPress hosting: PHP-FPM + PHP extensions WordPress uses + WP-CLI -------
# WordPress itself (GPL) is downloaded from wordpress.org when a user sets a site up, so every
# site starts with the current release. Each site runs its own PHP-FPM as the owner's sandbox
# user (server/src/wordpress.ts) — the distribution's www pool is never started.
RUN set -eux; \
    if [ "$INSTALL_WORDPRESS" = "true" ]; then \
      apt-get update; \
      apt-get install -y --no-install-recommends \
        php-cli php-fpm php-mysql php-curl php-gd php-intl php-mbstring php-xml php-zip \
        php-bcmath php-imagick php-opcache php-soap; \
      rm -rf /var/lib/apt/lists/*; \
      curl -fsSL "https://github.com/wp-cli/wp-cli/releases/download/v${WP_CLI_VERSION}/wp-cli-${WP_CLI_VERSION}.phar" -o /usr/local/bin/wp; \
      curl -fsSL "https://github.com/wp-cli/wp-cli/releases/download/v${WP_CLI_VERSION}/wp-cli-${WP_CLI_VERSION}.phar.sha512" -o /tmp/wp.sha512; \
      echo "$(cat /tmp/wp.sha512)  /usr/local/bin/wp" | sha512sum -c -; \
      rm /tmp/wp.sha512; \
      chmod 755 /usr/local/bin/wp; \
      php --version; \
      wp --allow-root --version; \
    fi

# =============================================================================
# Stage 2 — build the website (React) and the API server (TypeScript)
# =============================================================================
FROM node:${NODE_VERSION}-${DEBIAN_RELEASE} AS app-build
WORKDIR /build
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --no-audit --no-fund
COPY web/package.json web/package-lock.json web/
RUN cd web && npm ci --no-audit --no-fund
COPY server/ server/
COPY web/ web/
RUN cd server && npm run build && npm prune --omit=dev
RUN cd web && npm run build

# =============================================================================
# Stage 3 — runtime image
# =============================================================================
FROM toolchain AS runtime

# Claude Code is Anthropic's proprietary software ("All rights reserved"): a published
# image must not contain it. By default it is NOT installed here — the Studio downloads
# the official package at runtime. INSTALL_CLAUDE_CODE=true is for private images only.
ARG INSTALL_CLAUDE_CODE=false
ARG CLAUDE_CODE_VERSION=latest
RUN set -eux; \
    if [ "$INSTALL_CLAUDE_CODE" = "true" ]; then \
      npm install -g --no-audit --no-fund "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"; \
      claude --version; \
      npm cache clean --force; \
    fi
# The Studio manages Claude Code updates (claudecli.ts): no self-update inside sessions.
ENV DISABLE_AUTOUPDATER=1

# Studio tools (our own creative software lives here — see tools/README.md).
# Every tools/<name>/bin/* is linked into /usr/local/bin; an optional
# tools/<name>/install.sh runs at build time (e.g. to install dependencies).
COPY tools /opt/studio/tools
RUN set -eux; \
    for d in /opt/studio/tools/*/; do \
      if [ -f "${d}install.sh" ]; then bash "${d}install.sh"; fi; \
      if [ -d "${d}bin" ]; then \
        for f in "${d}"bin/*; do chmod 755 "$f"; ln -sf "$f" /usr/local/bin/; done; \
      fi; \
    done; \
    chmod -R a+rX /opt/studio/tools

# System packs (see packs/README.md). An optional packs/<id>/install.sh runs at
# build time, e.g. to generate content or link files that already are in the image.
COPY packs /opt/studio/packs
RUN set -eux; \
    for d in /opt/studio/packs/*/; do \
      if [ -f "${d}install.sh" ]; then (cd "$d" && bash ./install.sh); fi; \
    done; \
    studio packs validate /opt/studio/packs/*/; \
    chmod -R a+rX /opt/studio/packs

# Built-in skills (know-how the AI loads on demand — see skills/README.md)
COPY skills /opt/studio/skills
COPY templates /opt/studio/templates
COPY --from=app-build /build/server/package.json /opt/studio/server/package.json
COPY --from=app-build /build/server/node_modules /opt/studio/server/node_modules
COPY --from=app-build /build/server/dist /opt/studio/server/dist
COPY --from=app-build /build/web/dist /opt/studio/web
COPY docker/entrypoint.sh /usr/local/bin/studio-entrypoint
COPY docker/studio-db /usr/local/bin/studio-db
COPY docker/db.sh /usr/local/lib/studio/db.sh
COPY docker/mariadb.cnf /etc/mysql/mariadb.conf.d/99-studio.cnf
COPY docker/profile.sh /etc/profile.d/zz-studio.sh
RUN chmod 755 /usr/local/bin/studio-entrypoint /usr/local/bin/studio-db \
 && chmod 644 /usr/local/lib/studio/db.sh /etc/mysql/mariadb.conf.d/99-studio.cnf /etc/profile.d/zz-studio.sh \
 && chmod -R a+rX /opt/studio/templates /opt/studio/skills

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    STUDIO_HOME=/opt/studio \
    STUDIO_SYSTEM_PACKS=/opt/studio/packs

ARG STUDIO_VERSION=1.4.0
LABEL org.opencontainers.image.title="ai-everything" \
      org.opencontainers.image.description="Self-hosted creative studio (music, 3D, images, video, games, apps, WordPress) that runs Claude Code with each user's own account. Claude Code, the Android SDK and WordPress are not included: they are downloaded at runtime from their official sources." \
      org.opencontainers.image.version="${STUDIO_VERSION}" \
      org.opencontainers.image.licenses="GPL-3.0-only"

WORKDIR /opt/studio
# 8080 the Studio website · 8081 published websites of projects (by domain) · 8443 the same over HTTPS
EXPOSE 8080 8081 8443
# Persistent data — mount named volumes here (docker run -v studio-data:/data -v studio-db:/var/lib/mysql …)
VOLUME ["/data", "/var/lib/mysql"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/api/health || exit 1
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/studio-entrypoint"]
