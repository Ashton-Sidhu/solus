#!/usr/bin/env bash
# Build the desktop bundles (main/preload/renderer) and the web client at the
# same time. They share no inputs and write to different `dist/` subtrees, so
# running them back to back only serialized two ~15s Rollup passes on an
# otherwise idle machine.
#
# Any arguments are forwarded to the electron-vite build (for example --mode
# production). Output from each build is buffered and printed as a block so the
# two logs do not interleave into noise.
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
desktop_log="$(mktemp)"
client_log="$(mktemp)"
trap 'rm -f "$desktop_log" "$client_log"' EXIT

bun run electron-vite build --logLevel warn "$@" >"$desktop_log" 2>&1 &
desktop_pid=$!

(cd "$repo_root/apps/client" && bun run vite build --logLevel warn) >"$client_log" 2>&1 &
client_pid=$!

wait "$desktop_pid"
desktop_status=$?
wait "$client_pid"
client_status=$?

echo "--- desktop ---"
cat "$desktop_log"
echo "--- client ---"
cat "$client_log"

if [ "$desktop_status" -ne 0 ] || [ "$client_status" -ne 0 ]; then
  echo "build failed (desktop=$desktop_status client=$client_status)" >&2
  exit 1
fi
