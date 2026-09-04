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
bun run electron-vite dev 2>&1 | tee dev-console.log &
wait
