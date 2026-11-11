#!/bin/bash
# Run the Electron/Vite development environment as one process group.
#
# Ctrl+C reaches every process in the terminal's foreground group, but a kill by
# pid (`kill <pid>`, a task runner's stop button) only reaches this launcher.
# Bash defers traps while a foreground pipeline runs, so the pipeline runs in
# the background and `wait` returns as soon as a signal arrives. The trap then
# forwards the signal to the whole group, so electron-vite and Electron stop
# with the terminal instead of outliving it.
trap 'trap - INT TERM HUP; kill 0' INT TERM HUP
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Appended, not replaced: after a crash, the output before the restart is the
# evidence.
bun run electron-vite dev 2>&1 | tee -a dev-console.log &
# The host serves the web client to other devices from `dist/client`, a built
# artifact: a guest link or a browser on the LAN gets that bundle, not the dev
# server's renderer. Build it once at start so it matches the code the dev host
# runs; it finishes in the background while Electron comes up. Edits to the web
# client after that need another `bun run build:client`.
(cd "$repo_root/apps/client" && bun run vite build --logLevel warn 2>&1 | sed 's/^/[client] /' | tee -a "$repo_root/dev-console.log") &
wait
