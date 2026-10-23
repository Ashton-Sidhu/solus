# Linux desktop implementation and verification

Date: 2026-10-09. The user authorized serial builds, native desktop control, and screenshots. No release, commit, push, or pull request was requested.

## Implemented

- Linux x64 AppImage and Debian targets, a stable desktop identity, Linux icons, platform file filters, native ASAR unpacking, platform package paths, and Linux-compatible fuses.
- A packaged runtime probe that checks real fff file search, ONNX CPU inference, and Claude SDK loading. Linux fff uses the `-gnu` package suffix. Non-target ONNX libraries and musl alternatives are excluded.
- Linux window startup without a global pointer query on Wayland. Minimized windows restore before show. A second launch restores the existing app. macOS CA defaults are confined to macOS. Portal global shortcuts are enabled, and failed registration no longer promises that a restart will fix it.
- Linux desktop design mode disabled in both composer menus, keyboard handlers, shortcut settings, attachment handlers, and the native entry point. macOS design mode and browser annotations remain.
- Screenshot portal integration using `@homebridge/dbus-native`. The request subscribes before capture, handles cancellation/error/abort/deadline, closes requests, validates file URIs and PNG size, and removes app-owned temporary storage. The renderer uploads inline bytes to the destination host and checks that the original target still exists.
- Linux terminal detection and default selection. GUI terminals spawn asynchronously, without a lifetime timeout. Linux keeps Solus visible after command delivery. Launch failures produce an error. Working directories resolve home paths, and Linux uses an available shell rather than assuming zsh.
- Both account and host-secret storage use a cipher that rejects Linux `basic_text`. Sign-in explains the keyring requirement and permits retry after recovery. Cloud onboarding catches the same error. Device labels use Linux/Mac/Windows; the local host display label is “This computer.” The historical internal local-device authorization label is unchanged.
- Package-aware updates: AppImage uses the existing updater; Debian/unpacked distributions offer a manual download action and cannot become “ready to install” from an updater event. Linux CI test, package, native probe, smoke, screenshot-artifact, and release jobs are configured.
- A real-provider startup error path now handles Codex stdin pipe failure and an unobserved error event. A focused test proves this does not crash the desktop when the provider exits early.

## Verification

The host is Omarchy x64, kernel 7.2.5, glibc 2.44, Hyprland, Bun 1.4.2, Electron 42.11.3, electron-builder 26.15.3, and Playwright 1.63.0. The Screenshot portal reports version 2. The host has the Hyprland and GTK portal backends and a secrets service.

Focused unit checks passed in **20 test files**. They cover package layout/filters, Wayland bounds, secure storage, screenshot availability and portal lifecycle, package update mode/state, terminal spawn/fallback/failure, CLI environment, account persistence, upload routing, prompt host paths, mobile attachments, keybindings, server ports, and Codex startup/pipe errors. The original CLI environment fixture assumed zsh. It now supplies Bash and zsh login profiles and removes its temporary directory.

Final serial desktop and web builds passed (`/tmp/solus-linux-build-final.log` and `/tmp/solus-linux-client-final.log`). The final packaging log is `/tmp/solus-linux-package-reviewed.log`; the final unit log is `/tmp/solus-linux-tests-reviewed.log`. Both test and real provider desktop builds were used. Final packages use the real provider build. Native runtime probes passed. AppImage and `.deb` files were generated under `release/`. The Omarchy packaging tool needed `libcrypt.so.1` for electron-builder's bundled Ruby; it was extracted into a task-owned build directory and supplied only through the builder's library path. No system package or desktop configuration was changed.

The durable smoke script is `scripts/verify-linux-desktop.mjs`. It launches an existing bundle/package with Chromium sandboxing enabled. It gives Electron, the server, and provider configuration separate temporary directories. It closes only processes it starts. Early disposable Playwright Electron probes used that tool's default launch flags; the durable proof uses a native launch and Chromium CDP instead.

Real XWayland and Wayland runs passed startup, composer typing, screenshot-menu availability, absence of design mode, native close-to-hide, and second-launch recovery. Wayland also passed real region capture through the portal, host upload, and composer restoration with the image attached. The region driver used the compositor's virtual-pointer protocol. Native close verification uses the window manager; the shared browser `isVisible` API does not represent native visibility during CDP automation.

The real Ghostty GUI handoff passed. The tmux client attached in the selected folder, including spaces and Unicode characters. Evidence is in `terminal/terminal.png` and `terminal/result.json`.

Final packaged X11 and Wayland runs passed. Both showed the manual Linux update action and hid automatic-download controls. Packaged Wayland also passed real portal region capture, local-host upload, cancellation without an extra attachment, focus restoration, close-to-hide, and second-launch recovery.

The actual AppImage passed the same Wayland capture, cancellation, focus, and window-recovery checks and showed automatic-update controls. This host has no FUSE 2 library, so verification used `APPIMAGE_EXTRACT_AND_RUN=1`. FUSE mounting was not tested. The harness terminated the verified Electron child; the extract-and-run launcher returned 127 during cleanup. This was not a natural Quit or updater-install test. Final X11 and Wayland packaged cleanup returned 0. The screenshot portal is closed, and all verification app processes have stopped.

An early final-package test omitted the display environment for the native region driver. Its selection prompt was cancelled and the failed processes were stopped before the passing runs. The final harness bounds failure screenshots and process cleanup.

Screenshots and machine-readable results are under `.solus-local/linux-verification/`:

- `wayland/workspace.png`, `capture-menu.png`, `screenshot-attached.png`, `restored.png`, and `result.json`.
- `x11/workspace.png`, `capture-menu.png`, `restored.png`, and `result.json`.
- `packaged-x11/workspace.png`, `capture-menu.png`, `manual-updates.png`, `restored.png`, and `result.json`.
- `packaged-wayland/workspace.png`, `capture-menu.png`, `screenshot-attached.png`, `manual-updates.png`, `restored.png`, and `result.json`.
- `appimage-wayland/workspace.png`, `capture-menu.png`, `screenshot-attached.png`, `appimage-updates.png`, `restored.png`, and `result.json`.
- `terminal/terminal.png` and `terminal/result.json`.

These screenshots are local verification evidence and are not committed package assets. The Omarchy capture skill was used: `/home/sidhu/.codex/skills/omarchy/SKILL.md` and its `capture.md` guide. No screenshot was sent to another person or service.

## Checks that remain outside this proof

- GNOME, KDE, and an actual Debian package installation are not available on this host. Ubuntu 22.04 CI is configured but has not run in this session.
- An AppImage update from version N to N+1, including an unwritable destination and active-session shutdown, is not yet proven. Unit checks cover the package-mode decision; generating updater metadata does not prove installation.
- Authenticated Claude/Codex turns, cloud sign-in, remote-host screenshot upload through a second live host, and physical mobile UI runs were not performed. No live credentials or user database were used. Upload routing and mobile attachment behavior have focused tests.

- `bun run check`, the workspace UI type check, the root TypeScript check, and the mobile type check have existing unrelated failures. These include missing `window.solus` declarations, code-intelligence and transcript helpers, stale shared types, and mobile media request types. No new errors were found in the new platform, capture, package-mode, or terminal modules. Logs are under `/tmp/solus-linux-*.log`.
- The operating manual names `lint:types` and `lint:hosts`, but this checkout has neither script. Focused oxlint, verification-script syntax, workflow YAML parsing, and `git diff --check` passed. Main `index.ts` remains above the 600-line review threshold (969 lines), below the 1,000-line limit after extracting its existing context menu.

## Applicable surfaces

Native shell behavior applies to Linux desktop. The macOS package filters and design mode are retained. Shared web UI hides native design shortcuts on web and keeps its existing attachment uploads. Native mobile retains its file/image upload capability; no host screen is presented as a mobile screen. Screenshot upload uses the existing typed RPC contract, so no new cross-process API or provider event shape was added. Claude and Codex terminal resume commands remain distinct. Update state is a client-shell contract and is not sent to hosts. Existing user edits to session lineage and provider handoffs were left intact.

The code is implemented and verified on the Omarchy host. The untested cases above remain release acceptance work; this report does not claim that the complete desktop matrix has passed.
