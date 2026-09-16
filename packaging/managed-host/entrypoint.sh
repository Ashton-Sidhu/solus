#!/bin/sh
# The managed host's process 1 (docs/plans/managed-hosts.md §3, §5, §6).
#
# Runs as root only long enough to lay out the volume, then drops to the `solus`
# user and hands the process over to the server — or to `litestream replicate
# -exec`, which forwards SIGTERM to the server and exits when it does, so the
# machine's stop signal reaches Node either way.
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

SERVER="node /opt/solus/libexec/server/standalone.js --data-dir /data/state"

if [ -n "${LITESTREAM_REPLICA_URL:-}" ]; then
  # Continuous replication of the SQLite file to the per-host object-storage
  # prefix (§6). The server runs as litestream's child; signals pass through.
  exec setpriv --reuid=solus --regid=solus --init-groups \
    litestream replicate -config /etc/litestream.yml -exec "$SERVER"
fi

exec setpriv --reuid=solus --regid=solus --init-groups $SERVER
