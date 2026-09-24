# syntax=docker/dockerfile:1.7
#
# The Linux image the workspace service runs (packaging/workspace-service). Managed
# hosts no longer use it: they run on Sprites and boot with sprite-boot.sh, which is
# why there is no cloudflared and no Litestream here. The server runs as the one
# non-root user `solus`.
# Build it from the repository root: `bun scripts/managed-image.ts` or
#   docker build --platform linux/amd64 -f packaging/managed-host/Dockerfile -t registry.fly.io/solus-managed:<version> .
#
# Stage 1 runs natively on the build machine and produces the same standalone
# server tarball a personal host installs (scripts/package-server.ts), for
# linux-x64. Stage 2 is the runtime: Node, git, the latest agent CLIs, and that
# tarball under /opt/solus. The image is replaceable; the workspace service keeps
# every durable record in Postgres.

FROM --platform=$BUILDPLATFORM oven/bun:1.3.14 AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
# No Electron binary and no native rebuilds: the standalone server needs neither,
# and the desktop bundle's optional native modules are externalized from it.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN bun install --frozen-lockfile --ignore-scripts
# The two Vite builds one after the other: side by side (`bun run build`) they
# exceed the memory of a typical Docker VM.
RUN bun run build:desktop && bun run build:client
# The OAuth clients scripts/package-server.ts bakes into the bundle. `.env` is
# ignored by the build context, so they arrive only as build args; empty means the
# workspace service answers "not configured" for GitHub, Google, and Atlassian.
# The Google client must be the web one registered to the service callback, not
# the desktop one (packaging/workspace-service/README.md).
ARG SOLUS_GITHUB_CLIENT_ID
ARG SOLUS_GOOGLE_CLIENT_ID
ARG SOLUS_GOOGLE_CLIENT_SECRET
ARG SOLUS_ATLASSIAN_CLIENT_ID
ARG SOLUS_ATLASSIAN_CLIENT_SECRET
RUN bun run package:server --platform linux --arch x64

FROM node:24.18.0-bookworm-slim

# scripts/managed-image.ts passes the exact latest versions, so a new release
# changes the arg and invalidates the cached install layer below.
ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client procps ripgrep \
  && rm -rf /var/lib/apt/lists/*

# The agents, at the latest release when the image is built. The image does not
# run `solus update`; a new agent version is a new image.
RUN npm install -g --no-fund --no-audit "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
  && npm cache clean --force

# The server tarball, extracted where SOLUS_INSTALL_DIR points. Its bundled Node
# is replaced by the image's own so there is one runtime for the server and the agents.
COPY --from=build /src/release/solus-server-linux-x64.tar.gz /tmp/solus-server.tar.gz
RUN mkdir -p /opt/solus \
  && tar -xzf /tmp/solus-server.tar.gz -C /opt/solus \
  && rm /tmp/solus-server.tar.gz \
  && ln -sf /usr/local/bin/node /opt/solus/bin/node

# Use the browser revision required by the packaged driver. A shared image path
# lets the non-root server find it even though installation runs as root.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/solus/browsers
RUN node /opt/solus/libexec/server/node_modules/playwright-core/cli.js install --with-deps chromium \
  && chmod -R a+rX /opt/solus/browsers \
  && rm -rf /var/lib/apt/lists/*

# The one user the server runs as. Its home is under /data, so nothing is created
# here; the entrypoint lays /data out and drops to it.
RUN useradd --system --no-create-home --home-dir /data/home --shell /usr/sbin/nologin solus

COPY packaging/managed-host/entrypoint.sh /opt/solus/entrypoint.sh
RUN chmod 0755 /opt/solus/entrypoint.sh

ENV HOME=/data/home \
  SOLUS_DATA_DIR=/data/state \
  SOLUS_INSTALL_DIR=/opt/solus \
  SOLUS_NO_LAN_DISCOVERY=1 \
  SOLUS_PROJECTS_ROOT=/data/projects

VOLUME ["/data"]
ENTRYPOINT ["/opt/solus/entrypoint.sh"]
