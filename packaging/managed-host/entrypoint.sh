#!/bin/sh
# The image's process 1 (the workspace service; a managed host boots with
# sprite-boot.sh instead).
#
# Runs as root only long enough to lay out /data, then drops to the `solus` user
# and hands the process over to the server, so the machine's stop signal reaches
# Node directly.
set -eu

# Gives one directory and its immediate children to `solus`, without walking the
# whole volume: a boot must stay fast however many transcripts and repositories
# have accumulated. Everything below is created by `solus` itself from here on.
own() {
  chown solus:solus "$1"
  find "$1" -mindepth 1 -maxdepth 1 -exec chown -h solus:solus {} +
}

# The server's own state: the database, works, settings, the link record and the
# secret store. Private to the one user (§5).
mkdir -p /data/state
own /data/state
chmod 0700 /data/state

# Member seats live beside the data directory (provider-seats.md §3.1); made here
# so /data itself can stay root's.
mkdir -p /data/state-seats
own /data/state-seats
chmod 0700 /data/state-seats

# HOME, with the host's provider homes: the transcript roots the session index reads.
mkdir -p /data/home/.claude /data/home/.codex
own /data/home
chmod 0755 /data/home

# Repositories and worktrees.
mkdir -p /data/projects
own /data/projects
chmod 0755 /data/projects

exec setpriv --reuid=solus --regid=solus --init-groups \
  node /opt/solus/libexec/server/standalone.js --data-dir /data/state
