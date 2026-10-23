# Linux desktop support

Status: IMPLEMENTED — Omarchy verification passed; cross-distribution release acceptance remains. See `linux-desktop-results.md`.

Written on 2026-10-09 against commit `2f9e187`. This plan covers the Electron desktop app. It does not replace the Linux standalone server plan.

## Outcome and scope decisions

Ship a Linux desktop app that can run Claude and Codex locally, connect to remote hosts, and host connections from web and native mobile clients.

The user approved disabling **desktop design mode on Linux** for now. Keep ordinary screenshots. Keep macOS design mode. This exception does not disable browser-page annotations or the shared annotation data model.

Planning defaults:

- Start with Linux x64 and glibc distributions. Produce AppImage and Debian packages through the existing electron-builder path. ARM64, RPM, Flatpak, Snap, and musl packages are later work.
- Verify Ubuntu GNOME, KDE Plasma, and Arch/Hyprland, with X11 and Wayland where available. Record the exact distribution and desktop versions tested; do not claim support for every Linux installation.
- Use the desktop screenshot portal. Its installed backend controls the available selection UI. Do not promise a custom region-selection overlay or restore design mode to obtain one.
- Keep AppImage automatic updates. Use explicit package installation for the first Debian release, with a clear download/update action. Do not silently request administrator access on application exit.
- Native shell differences stay in the desktop shell. Durable state, provider behavior, and remote attachment handling continue through shared contracts and host APIs.

These package and update defaults are recommendations for the first release, not a claim that those targets were separately selected by the user. Revisit them before publishing if the release requirements differ.

## Execution order

| Stage | Work | Priority | Effort | Change risk | Depends on | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | Establish a Linux verification baseline | P1 | Small | Low | None | Verified on Omarchy |
| 1 | Fix package contents and native runtime checks | P1 | Medium | Medium | 0 | Built and runtime probe passed |
| 2 | Make startup, window restoration, and shortcuts portable | P1 | Medium | Medium | 0; packaged proof needs 1 | Verified on X11 and Wayland |
| 3 | Separate screenshots from design mode and implement Linux capture | P1 | Large | Medium | 0, 2; packaged proof needs 1 | Real portal flow verified |
| 4 | Fix terminal detection, launch, and handoff | P1 | Medium | Medium | 0 | Native Ghostty handoff verified |
| 5 | Enforce secure credential storage and correct platform labels | P1 | Medium | Medium | 0 | Focused tests passed; sign-in untested |
| 6 | Add Linux release jobs and package-aware updates | P1 | Medium | Medium | 1, 2, 5 | Configured; CI and update installation pending |
| 7 | Complete packaged and cross-client verification; publish support docs | P1 | Medium | Low | 1–6 | Omarchy verified; other desktop environments pending |

Effort is relative: Small is hours, Medium is about a day, Large is several days including platform checks. This is not a delivery estimate. Portal integration and desktop behavior need real-device evidence.

## Executor rules and baseline

Read the repository operating manual and Codebase Map first. Read each changed module's exports, callers, types, and tests. Compare these findings with the current source before editing:

```sh
git diff --stat 2f9e187..HEAD -- apps/desktop packages/contracts packages/client-core packages/workspace-ui packages/server/src/platform packages/server/src/cli-env.ts scripts/afterPack.js package.json .github/workflows tests/unit
git status --short
```

A changed file is a reason to re-check the finding, not to revert someone else's work. Never stash or discard work. Use a Solus-managed worktree if isolation is needed. Do not commit, push, open a PR, or publish releases unless asked.

Keep implementation changes limited to the files and direct callers listed in each stage. New helpers must own real validation or platform behavior. Do not introduce a general desktop abstraction framework. Use exact domain types; do not add broad unknown records. Keep algorithms out of Svelte markup.

The original source review did not build or run Electron. Implementation has since installed dependencies, run focused tests, built packages, and used an isolated native verification harness. Results and pre-existing check failures are in `linux-desktop-results.md`.

The user explicitly authorized serial builds and interactive desktop verification on 2026-10-09. This overrides the build and interactive-run restrictions for this task. Serial local builds and native desktop verification are authorized for this task. Unit tests must use temporary data. A native smoke run must isolate **both Electron userData and SOLUS_DATA_DIR**; setting only the latter does not isolate account and window settings.

## Stage 0 — Establish the verification baseline

### Evidence and scope

- `.github/workflows/test.yml` and `.github/workflows/release.yml` use `macos-latest` for the desktop app.
- `tests/unit/desktop-package-files.test.ts` explicitly expects Linux ONNX libraries to be excluded.
- `tests/unit/terminal-launcher.test.ts` mocks process launch. It does not prove that a long-lived terminal stays running.
- `scripts/test-unit.ts` runs each test file in a separate process. Use its filters when tests mock modules.

### Steps

1. Install dependencies with `bun install --frozen-lockfile` only in the implementation environment. Record Bun, locked Electron, electron-builder, OS, architecture, display session, and portal backend versions. Confirm that the frozen install succeeds on Linux; do not hand-edit generated provider code.
2. Run the existing focused tests below. Record pass/fail results before making source changes.
3. Prepare a small native verification harness under `scripts/` with tests under `tests/unit/`. It must set a fresh userData directory before Electron readiness and use a fresh server data directory. Prefer an existing supported harness after checking it. It must record only its own child PID and clean up only its own temporary resources.
4. Make the harness select an existing packaged artifact. It must not build, launch against live settings, disable the Chromium sandbox, or start another Solus instance as an incidental part of a unit test.

Baseline command:

```sh
bun scripts/test-unit.ts desktop-package-files terminal-launcher cli-env account-store desktop-update-status desktop-updates-store desktop-notifications-core prompt-attachment-host-path
```

Expected: all selected tests pass, or pre-existing failures are recorded with reproduction details. Do not call Linux supported from these mocked tests.

Stage done: baseline and isolated harness behavior are recorded; unit tests prove the harness cannot select a live data directory by default.

## Stage 1 — Fix packaging and native libraries

### Current state

`package.json:25` runs `electron-builder --mac`. Its shared file filters include:

```json
"!node_modules/onnxruntime-node/bin/napi-v6/!(darwin)/**/*"
```

`scripts/afterPack.js:133` constructs `${productFilename}.app` for every platform, then traverses that path. `probePackagedRuntime()` also assumes `Contents/Resources` and `Contents/MacOS`. A Linux package cannot pass this hook as written.

`forge.config.js` has Debian/RPM makers, but its explicit production dependency allowlist omits current external runtime dependencies such as ONNX and fff. Use electron-builder, which the release workflow already uses. Do not repair two release paths for this task.

### Scope

`package.json`, `bun.lock` if a required dependency changes, `scripts/afterPack.js`, a focused helper beside it if needed, packaging icon resources, `tests/unit/desktop-package-files.test.ts`, and new `tests/unit/desktop-package-layout.test.ts`.

### Steps

1. Add Linux x64 AppImage and Debian targets, executable name, icon, package metadata, and a stable desktop application identity. Use the existing `com.solus.app` identity consistently in the installed desktop entry and Electron. Confirm exact options against the locked builder version.
2. Move macOS-only native exclusions into the macOS configuration. Add Linux/architecture-specific filters. Preserve the app file allowlist: a platform override must not accidentally include the repository, logs, settings, or secrets.
3. Resolve package resource and executable paths by target platform. Use the Linux executable for fuse changes and runtime probing; preserve the existing macOS layout and size limit. Check which fuses are supported by the locked Electron release on Linux instead of assuming macOS-only integrity features apply.
4. Keep fff/FFI shared libraries and ONNX binding/dependent libraries available outside ASAR where required. Extend the packaged probe to run file search and real ONNX inference on Linux, and load the Claude SDK. Preserve the existing exclusion of bundled provider CLI executable packages; provider setup still owns those installations.
5. Test package layout and file filters for both macOS ARM64 and Linux x64. A native runtime probe may skip only when the build host cannot execute the target; the Linux release job must not skip it.

Verify:

```sh
bun scripts/test-unit.ts desktop-package-files desktop-package-layout
```

Expected: Linux native libraries survive, non-target libraries do not ship, both platform layouts resolve, and source/live-data files remain excluded. The maintainer/CI packaged probe must also pass before stage 7.

## Stage 2 — Make startup and window behavior portable

### Current state

- `apps/desktop/src/main/index.ts:5` unconditionally supplies the macOS-oriented `/etc/ssl/cert.pem` default.
- `workAreaBoundsForCursor()` uses `screen.getCursorScreenPoint()`; Electron documents this as unsupported on Wayland.
- `createMainWindow()` supplies `icon.icns`. Close hides the window. `hideUntilTrayShow()` makes the tray the only intended recovery route.
- Global shortcut registration failures are logged, but the initial return value is not used. The default is Alt+Space.
- No single-instance/second-launch restoration handler was found in the inspected main entry.
- `packages/server/src/cli-env.ts` tries zsh and then bash, and already includes Linux CLI locations. Do not treat all shell handling as macOS-only.

### Scope

`apps/desktop/src/main/index.ts`, `boot.ts`, focused sibling window/shortcut helpers, `apps/desktop/src/renderer/shell/desktop-window.svelte.ts`, existing shortcut settings/store consumers, `packages/server/src/cli-env.ts` only for verified discovery failures, and new `tests/unit/desktop-linux-window.test.ts` and `desktop-startup-platform.test.ts`.

### Steps

1. Stop imposing the macOS CA path on Linux. Preserve explicit user CA settings. Verify actual HTTPS requests and provider child environments; assigning a Node environment variable after process startup is not proof that Node reloaded its trust store.
2. Use a supported display fallback on Wayland. Do not require absolute cursor or global window coordinates for startup. Preserve native Linux window controls and use a Linux-compatible icon.
3. Configure and test portal-compatible global shortcuts for the pinned Electron version. Report denied, unavailable, or conflicting bindings truthfully. Preserve focus in the active composer when the desktop permits activation.
4. Ensure the window is recoverable when the tray is absent or shortcuts fail. Define close, minimize, tray Show, and relaunch behavior. A second application launch should restore the existing window rather than start a competing server. Keep headless and `pair-url` command paths working when adding single-instance handling.
5. Avoid relying on `app.on('activate')` as the sole Linux recovery mechanism. Test minimize/show, failed activation, shutdown with active sessions, and the explicit hide-until-tray action. Disable or adapt that action when no supported recovery path exists.
6. Verify menu/dock launch discovers Claude, Codex, git, tmux, and the selected editor. Fix observed shell discovery failures without importing unrestricted shell secrets or replacing the acting-user environment policy.

Verify:

```sh
bun scripts/test-unit.ts desktop-linux-window desktop-startup-platform cli-env desktop-server-port
```

Expected: no unsupported cursor API is needed on the Wayland path; failed shortcuts and a missing tray do not strand the window; second-launch behavior preserves one host; explicit CA settings survive. A native X11/Wayland run is still required.

## Stage 3 — Keep screenshots and disable Linux design mode

### Current state and ownership

- `apps/desktop/src/main/server/handlers/file-handlers.ts:80` calls `/usr/sbin/screencapture`. `takeScreenshot` and `enterDesignMode` both use it.
- `apps/desktop/src/renderer/App.svelte:305` gates screenshot and design mode with the same `desktopHandlersAvailable` boolean.
- `shell/desktop-keybindings.svelte.ts:225` separately registers `global.design-mode`; hiding the menu alone is insufficient.
- `shell/desktop-attachments.svelte.ts` calls `serverConnections.localHostApi()` for capture. Keep capture on the client machine, even when a session runs remotely.
- `packages/workspace-ui/src/contexts/connections/connections.store.svelte.ts:154` derives the current broad gate from the default machine's capabilities. This does not correctly describe local capture when the default is a remote headless host.
- `handleScreenshot()` adds the returned attachment directly. The adjacent `handleAttachFile()` has an explicit upload path for remote sessions. Trace the complete send path before choosing whether to reuse that upload path; prevent duplicate uploads.

### Scope

The desktop main file handlers; new `apps/desktop/src/main/capture/` modules; desktop attachment, keybinding, window and palette modules; desktop `App.svelte`; shared `ComposerAddMenu.svelte`; keybinding availability/settings consumers; the existing local bridge contract/preload only if runtime capability data must cross that boundary; attachment upload helpers; new `tests/unit/desktop-capture.test.ts`, `desktop-capture-availability.test.ts`, and `desktop-screenshot-attachments.test.ts`.

### Steps

1. Define separate local screenshot and design-mode availability. Derive it from the desktop client's OS/native support, not the selected remote host. Linux design mode is false, macOS remains enabled. Reuse the existing local platform API where sufficient; add only narrow typed bridge data if portal availability needs asynchronous reporting.
2. Apply the gate to both composer locations, keybindings, handler functions, any palette entries, and shortcut configuration. Preserve saved bindings so macOS settings do not get erased. Enforce the Linux design-mode restriction in the native handlers before any window opacity/bounds changes. Cleanup calls must remain safe. Do not remove browser annotation capabilities.
3. Prove the Screenshot portal integration before committing to a D-Bus library/helper. Check its packaging, request lifetime, parent-window identification, and availability on the supported desktop matrix. Record the chosen dependency and exact portal version support. Do not implement a shell-command fallback per desktop environment unless evidence shows the portal cannot meet the requirement.
4. Implement asynchronous screenshot requests with the supported interactive option. The portal returns a request handle, then a response; subscribe in time to avoid missing an immediate response. Handle success, cancellation, denial, absent service, timeout, disconnect, and shutdown. Close outstanding requests and remove listeners. Prevent overlapping capture prompts.
5. Do not assume every backend supports area selection. Detect version/features where available. If a required target is unavailable, explain the limitation. Keep annotation/overlay work outside this implementation.
6. Read the returned file URI through a proper URI parser. Validate image type and size with existing attachment limits. Copy bytes into app-owned temporary storage if needed; do not delete a portal-owned source file. Define cleanup after upload/send/discard. Never treat a remote path as readable on the client.
7. Hide and restore the workspace only as needed by the capture flow. Restore it on success, cancellation, failure, and timeout; restore input focus when the window manager permits. Return `null` for user cancellation and a useful error for failure rather than silently treating all outcomes as cancellation.
8. Snapshot the target tab and host before opening capture. Attach to that target even if focus changes. For remote targets, ensure bytes reach the correct host and the resulting attachment has host-owned path metadata. If the target closes or access is revoked, stop cleanly instead of attaching to a different conversation.
9. Audit web and native mobile attachment entry points. They must retain their existing local file/image selection and remote upload behavior. Connecting to a Linux desktop must not expose its screen as the web/mobile client's local screen. Shared capability changes must use the typed RPC/bridge contract, stores, and both transports as applicable.

Verify:

```sh
bun scripts/test-unit.ts desktop-capture desktop-screenshot-attachments attachment-upload prompt-attachment-host-path native-mobile-attachments keybinding-manifest
bun run check
bun run --cwd packages/workspace-ui check
bun run --cwd apps/mobile check
```

Expected: Linux design entry points cannot invoke capture/overlay handlers; screenshot remains available independently; macOS design mode still works; portal lifecycle cases clean up deterministically; remote attachments use destination-host paths. Use mocked portal signals, not timeout sleeps, for unit tests.

## Stage 4 — Fix terminal detection, launch, and handoff

### Current state

`apps/desktop/src/main/terminal-launcher.ts:183` uses:

```ts
execFileSync(app.linuxBin, app.linuxArgs(ATTACH_COMMAND), { timeout: 5000, env: hostCliEnv() })
```

This waits for the terminal process to exit. A long-lived process can block Electron and be terminated at the timeout. `terminal-apps.ts` maps Default Terminal to `x-terminal-emulator`; `detectEditors` always reports that entry as installed. `useAttachedTerminal()` returns success on Linux without an activation path. File-handler callers hide Solus even after failure. `openWorktreeTerminal` falls back to `/bin/zsh` when `SHELL` is absent.

### Scope

`terminal-launcher.ts`, `terminal-apps.ts`, `server/handlers/file-handlers.ts`, direct terminal-action consumers, existing terminal result types only if needed to express the outcome, `tests/unit/terminal-launcher.test.ts`, and new `tests/unit/desktop-terminal-actions.test.ts`.

### Steps

1. Probe installed Linux terminals. Preserve explicit selections; explain when an explicitly selected app is missing. Default Terminal should choose an available supported terminal instead of claiming a nonexistent executable is installed.
2. Start terminal GUI processes asynchronously. Resolve success on the spawn event, handle spawn errors, detach/unref where appropriate, and do not kill the terminal after a fixed period. Keep the shared tmux session behavior.
3. When reusing an attached terminal, distinguish command delivery from successful window activation. On a desktop that prohibits activation, keep Solus visible and tell the user to switch to the attached terminal. Do not open a second tmux client merely to force focus.
4. Hide Solus only when a successful handoff warrants it. Keep the input usable on launch failure. Apply this to session terminal, worktree terminal, and terminal-editor actions.
5. Validate the chosen shell, use an available Linux fallback, and resolve every working directory with the existing home-path helper before process launch. Preserve spaces and non-ASCII paths. Verify both Claude and Codex resume commands.
6. Check GUI editor launch with the same discovered CLI environment; change only demonstrated Linux failures. Existing platform-neutral file dialogs and external URL opening do not need replacement.

Verify:

```sh
bun scripts/test-unit.ts terminal-launcher desktop-terminal-actions cli-env
```

Expected: a terminal may stay alive indefinitely after a successful spawn; missing executables do not hide Solus; attached clients are not duplicated; Linux works without zsh or `x-terminal-emulator`; macOS launch tests pass.

## Stage 5 — Enforce secure storage and correct platform labels

### Current state

`apps/desktop/src/main/account/account-store.ts:38` returns only `isEncryptionAvailable()`. The injected account cipher is Electron `safeStorage`. `packages/server/src/platform/secrets.ts` uses the same limited availability check for host secrets. Electron documents a Linux `basic_text` backend that does not provide meaningful secret protection.

`apps/desktop/src/main/account/ipc.ts:85` labels every device `Solus for Mac`.

### Scope

Account store/session/IPC files, `packages/server/src/platform/services.ts` and `secrets.ts`, their direct credential-store callers, the desktop account error consumer, `tests/unit/account-store.test.ts`, and new `tests/unit/desktop-secret-storage.test.ts`. Add focused tests to the existing account flow test region as needed.

### Steps

1. At the Electron boundary, define secure availability to require a usable keyring and reject `basic_text` on Linux. Expose this through an exact narrow interface that both account and host-secret stores can use. Preserve macOS behavior and standalone server storage policy.
2. Ensure no call path writes sensitive data through the rejected backend. Define behavior for missing, locked, and temporarily unavailable keyrings. Do not overwrite or delete existing encrypted state when reading fails.
3. Show a useful keyring-required error for sign-in/persistence failure. Local work that does not require cloud sign-in must still work. Retry after keyring recovery must not require clearing user data.
4. Derive device labels from the actual desktop OS. Inspect directly related native account copy for other Mac-only claims.

Verify:

```sh
bun scripts/test-unit.ts account-store desktop-secret-storage
```

Expected: a cipher with encryption available but backend `basic_text` cannot persist account or host secrets; supported secure backends round-trip; a locked keyring does not erase state; Linux labels do not say Mac. Add the exact account-flow test command to the implementation record when that consumer is identified.

## Stage 6 — Release Linux packages and make updates accurate

### Current state and scope

`.github/workflows/release.yml` builds macOS and uploads DMG/ZIP manifests. `apps/desktop/src/main/updates/ipc.ts` enables install-on-quit for every packaged app and calls `quitAndInstall(true, true)`. The renderer's update union has no explicit externally managed package state.

Scope: release/test workflows, package scripts/configuration, update IPC/status logic and direct update UI/store consumers, `packages/contracts/src/desktop-update-types.ts` if required, and desktop update tests. Site/download documentation changes belong in stage 7.

### Steps

1. Add a Linux x64 CI job with required system libraries and a declared build baseline. Run focused Linux unit checks before packaging. Build artifacts sequentially on CI as needed; retain the prohibition on agent-run local builds.
2. Run the stage 1 native probe against the packaged Linux app. Add a clean-data Electron smoke test on an X11 display. A virtual X11 run does not replace real Wayland portal checks.
3. Publish the selected packages and the exact updater metadata generated by the locked builder. Prevent concurrent platform jobs from overwriting each other's manifests, release notes, or download aliases. Preserve the existing Mac release and Homebrew update steps.
4. Make update behavior depend on package type. AppImage must check, download, restart, and survive a failed or unwritable update. Debian must show the selected manual package-update path and must not claim an automatic installation is ready when it cannot perform one. Keep status accurate in Settings and tray entries.
5. Prove an update from packaged version N to N+1 on isolated settings. Check cancellation/failure and active-session shutdown. Do not validate this against the live release feed or live account.

Verify:

```sh
bun scripts/test-unit.ts desktop-update-status desktop-updates-store desktop-package-files desktop-package-layout
bun run check
```

Expected: package-specific update transitions pass and shared contracts compile. CI artifact/probe evidence and a real update exercise are separate required results. Adding workflow files does not authorize a release or deployment.

## Stage 7 — Verify the product and document the support boundary

### Scope

Focused tests/harness from earlier stages, a new `docs/linux-desktop.md`, relevant README/install/download copy, and an evidence record beside this plan. Use the existing site download entry after a narrow search in `apps/site`; do not redesign the site. Desktop main `index.ts` already exceeds the repository size limit: extract touched window/capture responsibilities into focused modules as needed, without an unrelated runtime refactor.

### Required evidence

| Area | Pass condition |
| --- | --- |
| Installation | AppImage and Debian package launch from the desktop menu as a normal user; dependencies and sandbox requirements are documented; no blanket `--no-sandbox` workaround |
| Providers | Claude and Codex each complete start, stream, permission/question, stop, resume, and restart recovery using disposable sessions |
| Local data | Settings and sessions survive restart; uninstall/update checks do not delete working data |
| Native libraries | Packaged fff search and ONNX inference pass; microphone recording and local transcription work |
| Browser | Desktop browser pane opens, accepts input, and captures a browser-page screenshot using its existing browser host |
| Desktop shell | X11 and Wayland launch, minimize, close/reopen, second launch, tray/no-tray, denied/conflicting shortcut, display scaling, and two-monitor cases have recorded outcomes |
| Capture | Screenshot success/cancel/deny/timeout works on tested portal backends; Linux design mode is absent/disabled in menus and shortcuts and rejected natively; macOS design mode still works |
| Remote work | Linux desktop attached to a remote host uploads a screenshot to its original target; changing tabs/default host during capture cannot move it elsewhere |
| Hosting | Web and native mobile can connect to the Linux desktop host, exchange messages and attachments, and reconnect without state disagreement |
| Credentials | Secure-keyring and missing/locked-keyring cases behave as documented; no secret values appear in evidence |
| Updates | AppImage N-to-N+1 succeeds; Debian has an accurate manual path; failed updates preserve a usable app |
| UI | Relevant controls work with keyboard navigation and both themes; focus returns to the composer where the window manager allows it |

Run the focused stage tests and applicable package checks. Use `bun run check`, `bun run --cwd packages/server check`, `bun run --cwd packages/workspace-ui check`, and `bun run --cwd apps/mobile check` for changed shared areas. Use the root TypeScript check (`bun run tsc --noEmit -p tsconfig.json`) for desktop TypeScript, with pre-existing failures recorded. Run `bun run oxlint` on the exact changed source files. Do not cite nonexistent `lint:hosts` or `lint:types` scripts as successful checks; they are named in the manual but are absent from this checkout's root scripts.

Unit tests must assert behavior, not source strings or timing sleeps. Use existing `account-store`, `terminal-launcher`, `desktop-package-files`, `attachment-upload`, and update tests as patterns. Save screenshots/short recordings for native UI changes during an authorized integrated pass. Do not substitute a web browser run for native Electron verification.

Done means every required result above has evidence, the package checks pass or have explicitly recorded baseline failures, and the support documentation lists tested versions, installation prerequisites, update behavior, keyring/portal requirements, and the Linux design-mode exception. Source complete and release verified are separate statuses.

## Boundaries and stop conditions

- Do not rewrite provider adapters, session ownership, the shared layout, or native mobile navigation for this port.
- Do not add a phone layout to the web client or workspace UI.
- Do not change OS configuration, install desktop services, use production credentials, or modify a user's portal/keyring setup as a test side effect.
- If the supported portal backend cannot provide screenshots, report the exact failed desktop/version and required alternative. Do not silently drop screenshots or claim every portal offers region selection.
- If Wayland prevents a promised native interaction, propose a narrow visible fallback; do not silently switch the whole release to X11.
- If a package cannot preserve Electron sandboxing or native dependencies on the chosen baseline, stop release qualification and report it. A development launch is not proof of a distributable app.
- If source has changed, update the plan against current ownership before implementing. If a fix requires unrelated architecture work, report that dependency rather than expanding the port.

## Reviewed findings that do not need a separate rewrite

- File dialogs, external URL opening, and basic editor CLI detection already use portable APIs.
- macOS permission and application-bundle helpers have platform guards. Their filenames alone are not Linux blockers.
- The server CLI environment already has bash fallbacks. Verify menu-launch behavior; do not replace it without evidence.
- Desktop and web share workspace components, but the actual desktop app entry is now `apps/desktop/src/renderer/App.svelte`. The Codebase Map's shared `App.svelte` location is stale.
- Linux server browser support already has separate guidance in `docs/linux-browser.md`; desktop uses its bundled Electron browser and must not download another browser solely for this port.

## Reference material

Check documentation against the locked dependency versions before implementation. The reviewed latest Electron docs can describe behavior newer than this checkout's Electron 42.

- [Electron screen API](https://www.electronjs.org/docs/latest/api/screen): global cursor position is not supported on Wayland.
- [Electron window API](https://www.electronjs.org/docs/latest/api/browser-window): Wayland limits placement and activation.
- [Electron global shortcuts](https://www.electronjs.org/docs/latest/api/global-shortcut/): portal identity and platform-specific shortcut behavior.
- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage): Linux keyring backends and `basic_text`.
- [XDG Screenshot portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Screenshot.html): asynchronous capture request, response URI, and version-dependent options.
- [electron-builder v26 Linux targets](https://www.electron.build/v26/docs/linux/): package targets and desktop integration.
- [electron-builder v26 updates](https://www.electron.build/v26/docs/features/auto-update/): package-specific update requirements.

## Implementation record

No implementation or runtime verification has been performed for this plan. Update each stage row with work completed, exact test commands/results, evidence locations, remaining limitations, and the reviewed commit. Do not mark the plan complete while packaged or native platform checks remain outstanding.
