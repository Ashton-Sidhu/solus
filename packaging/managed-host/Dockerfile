# syntax=docker/dockerfile:1.7
#
# The Linux image for a managed host (docs/plans/managed-hosts.md §1–§3, §5, §6).
# The server and every agent run as the one non-root user `solus` (§5).
# Build it from the repository root: `bun scripts/managed-image.ts` or
#   docker build --platform linux/amd64 -f packaging/managed-host/Dockerfile -t registry.fly.io/solus-managed:<version> .
#
# Stage 1 runs natively on the build machine and produces the same standalone
# server tarball a personal host installs (scripts/package-server.ts), for
# linux-x64. Stage 2 is the runtime: Node, git, the pinned agent CLIs, the pinned
# `cloudflared` and `litestream`, and that tarball under /opt/solus. The image is
# replaceable; everything that must survive a restart lives on the volume at /data.

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
RUN bun run package:server --platform linux --arch x64

FROM node:24.18.0-bookworm-slim

ARG CLOUDFLARED_VERSION=2026.5.2
# apps/cli/src/lib/cloudflared.ts pins the same release and checksum for linux-x64.
ARG CLOUDFLARED_SHA256=5286698547f03df745adb2355f04c12dde52ef425491e81f433642d695521886
ARG LITESTREAM_VERSION=0.5.17
ARG LITESTREAM_SHA256=cfb371176d164437ae869f8351cfde49bd1804ae71c61923f75c9cba9c9c006d
ARG CLAUDE_CODE_VERSION=2.1.258
ARG CODEX_VERSION=0.148.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client procps ripgrep \
  && rm -rf /var/lib/apt/lists/*

# The agents, pinned. The image does not run `solus update`; a new agent version is a new image.
RUN npm install -g --no-fund --no-audit "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
  && npm cache clean --force

# Pinned binaries live in the image, never on the volume (§3). The connector reads
# SOLUS_CLOUDFLARED before it looks under the data directory or on PATH, so it
# finds this one without ever downloading.
RUN mkdir -p /opt/solus/bin \
  && curl -fsSL -o /opt/solus/bin/cloudflared "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64" \
  && echo "${CLOUDFLARED_SHA256}  /opt/solus/bin/cloudflared" | sha256sum -c - \
  && chmod 0755 /opt/solus/bin/cloudflared \
  && curl -fsSL -o /tmp/litestream.tar.gz "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION}-linux-x86_64.tar.gz" \
  && echo "${LITESTREAM_SHA256}  /tmp/litestream.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/litestream.tar.gz -C /usr/local/bin litestream \
  && chmod 0755 /usr/local/bin/litestream \
  && rm /tmp/litestream.tar.gz

# The server tarball, extracted where SOLUS_INSTALL_DIR points. Its bundled Node
# is replaced by the image's own so there is one runtime for the server and the agents.
COPY --from=build /src/release/solus-server-linux-x64.tar.gz /tmp/solus-server.tar.gz
RUN tar -xzf /tmp/solus-server.tar.gz -C /opt/solus \
  && rm /tmp/solus-server.tar.gz \
  && ln -sf /usr/local/bin/node /opt/solus/bin/node

# The one user the server and every agent run as (§5). Its home is on the volume,
# so nothing is created here; the entrypoint lays the volume out and drops to it.
RUN useradd --system --no-create-home --home-dir /data/home --shell /usr/sbin/nologin solus

COPY packaging/managed-host/entrypoint.sh /opt/solus/entrypoint.sh
COPY packaging/managed-host/litestream.yml /etc/litestream.yml
RUN chmod 0755 /opt/solus/entrypoint.sh

ENV HOME=/data/home \
  SOLUS_DATA_DIR=/data/state \
  SOLUS_INSTALL_DIR=/opt/solus \
  SOLUS_NO_LAN_DISCOVERY=1 \
  SOLUS_MANAGED=1 \
  SOLUS_TUNNEL_PORT=34118 \
  SOLUS_PROJECTS_ROOT=/data/projects \
  SOLUS_CLOUDFLARED=/opt/solus/bin/cloudflared

VOLUME ["/data"]
ENTRYPOINT ["/opt/solus/entrypoint.sh"]
