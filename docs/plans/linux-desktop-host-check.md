# Linux desktop host check — 2026-10-09

The user installed Bun and explicitly authorized builds. This permission supersedes the default local-build restriction for this work.

## Confirmed

- Bun 1.4.2 is available. `bun install --frozen-lockfile` passed, including the Electron native dependency setup.
- A desktop test build passed with `BUILD_TARGET=test NODE_OPTIONS=--max-old-space-size=3072 bun run electron-vite build --logLevel warn`. Existing Svelte and bundler warnings remain. The web client build was not run.
- Electron 42.11.3 launched and closed successfully on XWayland and native Wayland on this Omarchy/Hyprland host.
- Playwright found the workspace, clicked the composer, typed a draft, cleared it, evaluated the native process, and captured an image on both backends.
- Each run used fresh Electron userData, Solus data, configuration, and cache directories. No real provider turn was started. All test app processes closed and their disposable data directories were removed.
- The hidden-window test worked on XWayland. Native Wayland loaded the UI but did not complete Playwright's stability check while hidden. Showing the disposable window allowed the same interaction and screenshot checks to pass.

## Reuse

The ignored local harness is `.solus-local/linux-host-check/smoke.mjs`:

```sh
node .solus-local/linux-host-check/smoke.mjs x11
node .solus-local/linux-host-check/smoke.mjs wayland
```

This harness is specific to the checked host. It supplies the discovered display and session-bus environment to the child. It selects a temporary port and separate app data, records the launched PID, and closes the app. Native Wayland briefly shows a window. It is not a portable CI fixture.

The result JSON, logs, and window images are in `.solus-local/linux-host-check/`. The desktop build log is `/tmp/solus-linux-desktop-build.log`. These files are local evidence, not committed release artifacts.

## Still unverified

Packaged AppImage/Debian output, real Claude/Codex turns, native screenshot portals, tray/global shortcut behavior, credential persistence, updates, GNOME/KDE, and connections from mobile/web still require the plan's checks. Test mode deliberately skips some native behavior. A screenshot captured through Playwright proves automation, not the app's Take screenshot feature.

The host is ready for iterative desktop implementation and automation. Build one target at a time and run one Electron test instance at a time on this 8 GB host. Stage 0 of the plan is not complete until its focused baseline tests and durable harness requirements are also addressed.
