# Windows: parity with T3 Code, the server first, then the desktop app

Status: steps 1 and 2 done; step 3 in progress (§13), 2026-10-26. Decisions in §10 wait for the maintainers.

Reference: T3 Code (`pingdotgg/t3code`) runs natively on Windows and can also
run its server inside a WSL distro from the desktop app. This plan reaches the
same place for Solus. §3 is the parity table: every Windows behavior T3 Code
has, what Solus has today, and which step closes the gap. Steps are in §7.

## 1. Goal

Solus runs on a Windows machine with the same capability T3 Code offers there:

1. The headless server runs on native Windows from source, and a Mac desktop
   app pairs with it over the LAN. Sessions on that host run Claude Code and
   Codex. This is the first proof.
2. The server is a packaged Windows release with a `solus` command, an
   `install.ps1`, self-update, the uplink, and Tailscale detection.
3. The desktop app runs on Windows against its own in-process server, as an
   NSIS installer with auto-update, winget, and scoop.
4. The desktop app on Windows can run its server inside a WSL distro instead,
   with repositories and provider CLIs in Linux.

Each step is usable on its own.

## 2. Vocabulary

- **Windows host**: a Solus server that runs on Windows. It is a `self-hosted`
  host when it is the standalone server, and a `personal` host when the desktop
  app runs it.
- **WSL distro (as a machine)**: a distro of a Windows host, added as a
  machine that host forwards to (§5.13). The desktop app and its own server
  stay on Windows; the distro runs its own Solus server, with its data folder,
  repositories, and provider CLIs.
- **shim**: the `.cmd` file that npm, bun, Volta, or scoop puts on PATH in
  place of a program. `codex.cmd` and `npm.cmd` are shims. Node refuses to
  spawn a shim without a shell (CVE-2024-27980), and a `cmd.exe` line breaks on
  quotes and line breaks in arguments.
- **PATHEXT**: the Windows list of executable extensions (`.COM;.EXE;.BAT;.CMD`).
  A bare command name on Windows means "one of these files".
- **junction**: a directory link that needs no privilege on Windows. A symlink
  needs Developer Mode or administrator rights.
- **logon task**: a Task Scheduler task that starts at user logon. It is the
  Windows counterpart of the systemd user unit and the LaunchAgent.
- **command folder**: the folder that holds the `solus` launcher and is on the
  user's PATH: `%USERPROFILE%\.local\bin`.

Do not use "Win", "PC", "shell wrapper", "bat file", or "WSL mode" for these.

## 3. Parity table

"T3" is what T3 Code does, from its docs and source. "Solus today" is from the
audits of 2026-10-23 (§4 has the file lines). "Step" is the section of §7 that
closes the gap. "n/a" means Solus has no such feature on any platform, so there
is nothing to bring to Windows.

### 3.1 Server and CLI

| T3 Code on Windows | Solus today | Step |
| --- | --- | --- |
| Prebuilt `win32-x64` and `win32-arm64` zips on GitHub Releases with `SHA256SUMS`; no Node or compiler needed on the machine. Solus ships x64 only (§6) | Server package is `darwin-arm64`, `linux-x64`, `linux-arm64` tarballs with a bundled Node | 7.2 |
| `irm https://t3.codes/install.ps1 \| iex`: detects arch, picks the channel, verifies, unpacks to `~\.t3\runtime\versions\<v>`, runs `t3.exe --version`, writes `~\.local\bin\t3.cmd`, prints the PATH line | `install.sh` for Linux and macOS only | 7.2 |
| `T3CODE_HOME` defaults to `~\.t3` | `SOLUS_DATA_DIR` defaults to `~/.solus`; works unchanged on Windows | have |
| `t3 serve`, `t3 pair`, `t3 update`, `t3 --help` work on Windows | `solus logs` runs `tail`; `solus connect` opens the browser with `open`/`xdg-open`; self-update asks for a `.tar.gz` that is not built; `current` is a file symlink renamed over a link | 7.2 |
| No background service on Windows; users keep a terminal open | `solus setup` throws off Linux and macOS | 7.2 (a logon task, which is more than T3) |
| PATH: no login-shell probe; the process PATH plus known CLI folders (`%APPDATA%\npm`, Node, Volta, pnpm, `~\.local\bin`, `~\.bun\bin`, scoop shims); one PowerShell probe with the profile only if `node` is still missing; one `PATH` spelling | Splits PATH on `:`, probes `/bin/zsh` and `/bin/bash`, appends POSIX folders; writes `PATH` beside the inherited `Path` | 7.1 |
| Command lookup with PATHEXT, quotes stripped, case-insensitive dedupe, directory listings cached by mtime | `findOnPath` joins `dir/bin` and tests `X_OK` | 7.1 |
| `.exe` spawned directly; an npm shim for a native binary unwrapped to the `.exe`; any other `.cmd` run through one hand-built `cmd.exe` line with dangerous arguments refused | Shims spawned without a shell (Codex app-server, npm, provider `--version`, CLI login) | 7.1 |
| Claude Code: the shim is replaced by `claude.exe` or `cli.js` so the Agent SDK can spawn it | `findOnPath('claude')` only | 7.1 |
| Provider settings have a **Binary path** override for when the CLI is not on PATH | None | 7.1 |
| Git for Windows: the `cmd\git.exe` launcher is replaced by the real binary in `mingw64`/`ucrt64` (each launcher start leaks a kernel token); `GIT_CONFIG_COUNT` matched case-insensitively; `index.lock` regex accepts both separators | `isGitUsable()` is false on Windows because of `findOnPath`; `git` spawned by bare name | 7.1 |
| Atomic writes retry `rename` on `EBUSY`/`EPERM`/`EACCES` (20 × 100 ms), stop if the target changed or is read-only | 14 sites write temp + `rename` with no retry | 7.1 |
| Codex managed install: `x86_64-pc-windows-msvc` asset, a `tar` that is not MSYS tar, `rename` retried for antivirus | Codex is installed with `npm install -g` only; no managed install on any platform | n/a (keep npm; fix the shim) |
| Claude install on Windows uses the PowerShell installer | `curl … install.sh \| bash` | 7.1 |
| Tailscale: `tailscale.exe`; a longer status timeout because `taskkill` is slow | Looks in three POSIX folders only | 7.2 |
| cloudflared on Windows (for T3 Connect) | No win32 asset in `cloudflared.ts` | 7.2 |
| SSH askpass: a `.cmd` plus `.ps1` helper, no `DISPLAY`, no `chmod` | A `#!/bin/sh` askpass script | 7.2 |
| Terminal: node-pty on ConPTY, `TERM` default, kill without a signal | Solus has no terminal feature; providers talk over stdio | n/a |
| Resource monitor `.exe` | No resource monitor | n/a |
| Open a URL, reveal in Explorer (`explorer /select,` or the registry default), move to Recycle Bin through PowerShell | `opener.ts`, `file-manager.ts`, `trash.ts` already have win32 branches | have |
| Windows CI (`windows-tests.yml`) runs the native checks on `windows-2025` and `windows-11-arm` | No Windows job. Solus adds an x64 job only | 7.2 |
| Secrets: Electron `safeStorage` (DPAPI) in the desktop app; file store in the CLI server | Same split; the standalone file store is plaintext with `0o600`, which Windows ignores | 7.2 (DPAPI through PowerShell) |

### 3.2 Pairing and reach

| T3 Code on Windows | Solus today | Step |
| --- | --- | --- |
| Direct pairing: `t3 serve --host <ip>`, `t3 pair` for a link, QR or paste into Add environment; one-time per device | `/pair` with a token or a code, pair link printed at boot, `solus pair`, Add server dialog with Link and Manual tabs | have |
| Network access toggle restarts the app and binds the LAN | `remoteAccess` rebinds to `0.0.0.0` without a restart | have |
| Tailscale HTTPS (`tailscale serve`) | Tailnet detection only; no serve | not in this plan |
| T3 Connect relay | Cloudflared uplink and Solus Cloud | have, once cloudflared has a win32 asset (7.2) |
| Desktop-managed SSH: the remote host must be Linux or Apple Silicon macOS | `ssh-bootstrap.ts` targets `sh` hosts | same limit; keep |
| Remote browser tabs download a headless Chrome | Standalone server uses Playwright's Chromium; the installer prints the command | have |
| Desktop as remote-only: turn off Local environment | The desktop always boots its own server | 7.3 (see §10) |

### 3.3 Desktop app

| T3 Code on Windows | Solus today | Step |
| --- | --- | --- |
| NSIS installers for x64 and arm64, built and signed on Linux, native checks on Windows runners, updater manifests merged into one `latest.yml`. Solus ships x64 only (§6) | `mac` target only; `afterPack.js` reads the `.app` bundle; `release.yml` has one macOS job; the feed has `latest-mac.yml` only | 7.3 |
| winget (`T3Tools.T3Code`) and scoop (`extras/t3code`) | Homebrew cask only | 7.5 |
| `t3` command from Settings → About → Install: writes `bin\t3.cmd` under the app folder (`ELECTRON_RUN_AS_NODE=1`, `chcp 65001` for non-ASCII paths, refuses to overwrite a file without its marker) and adds the folder to the user PATH; Remove undoes it | `electron . pair-url` exists; no installed command on any platform | 7.3 |
| PATH for the bundled server: two PowerShell probes once (no-profile, and profile for `FNM_DIR`), merged with known CLI folders, written into `process.env`; the server child skips its own probe (`shellEnvironmentPrepared`) | `importLoginShellEnv()` runs `/bin/zsh`; the in-process server probes again | 7.3 |
| Notification badge: `setOverlayIcon` on Windows, `setBadgeCount` elsewhere; cleared when a window has focus | `app.setBadgeCount` on every platform (no-op on Windows) | 7.3 |
| Reveal and focus: Windows blocks focus stealing, so a Win32 foreground activation (`ffi-rs`) and a focus worker bring the window up after the summon shortcut | `app.focus({ steal: true })` on macOS only; nothing on Windows | 7.3 (start with `app.focus()` + `moveTop()`; `ffi-rs` only if that is not enough) |
| Per-version Chromium profile; `Local State` (the `safeStorage` keys) copied forward | One `userData` folder | n/a (one version per machine) |
| Chrome cookie import refused on Windows (DPAPI, app-bound encryption) | Same refusal (ADR 0026) | have |
| Keybindings: Ctrl for `mod`, platform labels | `mod` maps to Ctrl; labels print `⌘`/`⌥` everywhere; `Ctrl+C` is both interrupt and copy; `Alt+Space` summon is the window menu | 7.3 |
| Global modifier-only shortcut worker (for its screenshot feature) | Solus has no such feature | n/a |
| Open in editor: VS Code `.cmd` under `%LOCALAPPDATA%\Programs\Microsoft VS Code\bin`, Zed `.exe`, JetBrains `bin\<ide>64.exe`, Program Files roots, PATH first | `findOnPath` and `open -a` | 7.3 |
| Open in terminal: PowerShell or Windows Terminal | `tmux`, `open`, `osascript`, `x-terminal-emulator` | 7.3 |
| Screenshots | `/usr/sbin/screencapture` | 7.3 (`desktopCapturer`) |

### 3.4 WSL (Solus adds a distro as a machine; see §5.13)

| T3 Code on Windows | Solus today | Step |
| --- | --- | --- |
| Settings → Connections: pick a WSL distro; `wsl.exe --list --verbose` with an 8 s bound; `null` distro means the user's default | Nothing | 7.4 |
| The packaged server tree is copied out of the asar to `<stateDir>\wsl-server-tree\<version>` (a marker file names the version; stale versions swept) because `wsl.exe -- node` cannot read an asar | n/a: Solus already builds a plain `libexec/server` tree for the headless package | 7.4 |
| The server runs with the distro's `node` through `wsl.exe -d <distro> -- bash -l`; the login-shell PATH is read first so `codex` and `claude` resolve by name; Node, node-pty, and build tools are checked (`ensureNodePty`, 5 min) | n/a for node-pty; Solus needs only Node 24 in the distro, or the Linux server package with its bundled Node | 7.4 |
| Binds `0.0.0.0` in the distro; the renderer connects to the distro IP from `hostname -I`, or `127.0.0.1` when the IP is also a Windows address (mirrored networking); localhost forwarding is avoided because `wslhost` can take 30 s | Pairing over a URL already works; the desktop needs a second local target | 7.4 |
| Env: the parent env minus `T3CODE_HOME`, a whitelist of secrets and OTEL vars appended to `WSLENV`; the bootstrap token over stdin (`--bootstrap-fd 0`) | The desktop boots the server in-process with no child; `SOLUS_UPDATE_SUPERVISED` IPC exists for the CLI | 7.4 |
| Data folder is the Linux home, not `/mnt/c` | Same choice | 7.4 |
| Distro pre-warm (30 s), `wslpath -u` with backslashes normalized, per-distro user-home cache | Nothing | 7.4 |
| Reveal and open from WSL: `explorer.exe` and `powershell.exe` from PATH, `\\wsl.localhost\<distro>` paths | `file-manager.ts` detects WSL and uses `explorer.exe` | partly have |

### 3.5 Performance

T3 Code's merged `perf` commits for Windows, with their measurements where
the pull request gave them.

| T3 Code on Windows | Solus today | Step |
| --- | --- | --- |
| Run Git for Windows' real `git.exe`, not the `cmd\git.exe` launcher (#17707): 28% fewer processes, 16% less CPU; the launcher leaks one kernel token per run, and at three million leaked tokens process creation went from 2.9 ms to 9.4 ms | `git` spawned by bare name | 7.1 (§5.1) |
| PATH probes: both PowerShell probes run concurrently (#5878) under one shared 5 s budget (#19467), asynchronously so the window is not blocked (#21720); the desktop runs them once and the server child skips them (#19966) | `warmCliPath` is already off the main thread; no budget, and the desktop and server both probe | 7.1, 7.3 (§5.2, §5.12) |
| Port scanning with `netstat -ano` and one `tasklist` call per new PID instead of PowerShell `Get-NetTCPConnection` (#18524): polls went from up to 22 s to about 50 ms, and an idle poll spawns nothing | `target-scanner.ts` uses `lsof`; on Windows it returns nothing | 7.3 (§5.14) |
| Checkpoint flushes batched with `core.fsyncMethod=batch` on macOS and Windows (#21291), with `fsync` set first so Git 2.36 keeps full flushing | Session snapshots leave Git's defaults | 7.1, measure first (§5.14) |
| Windows installer writes 1,192 files instead of 14,687 (#5877), and the server sits in a `server.asar` sidecar (#6169): cold server boot 9 s → 3.7 s, module load 6.2 s → 0.7 s | Solus bundles the main process with electron-vite and unpacks only two native packages, so the loose-file count should already be small; NSIS `differentialPackage` is not set | 7.3, confirm with the first build |
| Tolerate the missing directory fsync on Windows (#9569); `.cmd` spawns without DEP0190 (#19385); node-pty startup and PTY helper fixes | Solus calls no `fsync`, spawns no shim through `cmd.exe`, and has no terminal | n/a |

## 4. What the code does today

Lines are from the checkout of 2026-10-23.

### 4.1 Blockers for step 1 (server from source)

1. **PATH is POSIX-only.** `packages/server/src/cli-env.ts` splits and joins
   PATH on `:` (lines 21, 47, 178), appends a POSIX fallback list (line 46),
   and probes `/bin/zsh` and `/bin/bash` (lines 13–16, 100–103). On Windows
   the drive letter in `C:\…` is split too. `findOnPath` (line 177) probes
   `join(dir, bin)` with `X_OK` and no PATHEXT, so `claude`, `codex`, `git`,
   and `cloudflared` are never found. `hostCliEnv` (line 196) then writes this
   PATH into every child beside the inherited `Path`.
2. **Shims are spawned without a shell.** `codex-agent.ts:148–158` spawns
   `codex`; `setup-commands.ts:148–151` spawns `npm`; `provider-versions.ts:11`
   runs `claude --version`; `apps/cli/src/index.ts:168` spawns `claude` and
   `codex` for login.
3. **Git is reported missing.** `git-availability.ts:35` asks `findOnPath`, so
   `isGitUsable()` is false and every git call throws.
4. **`which` has no Windows counterpart.** `setup-commands.ts:36,171`,
   `setup-handlers.ts:182`, `session-handlers.ts:105`,
   `providers/github/git-credential.ts:25`.
5. **Path markers use `/`.** `SOLUS_WORKTREE_PATH_MARKER` is
   `/.git/solus/worktrees/` and `isSolusWorktreePath` is `includes(marker)`
   (`contracts/src/types.ts:3214,3230`); `dispatch-checkouts.ts:53–56` does the
   same. `resolveHomePath` (`platform/paths.ts:30`) expands `~/` but not `~\`,
   while `files/host-path.ts` accepts both.
6. **Claude project folders.** `encodePathAsFolder` (`types.ts:3225`) replaces
   every non-alphanumeric with `-`. Claude Code on Windows is expected to name
   `C:\Users\me\repo` as `C--Users-me-repo`, which this gives; confirm it on
   the machine in step 1 by reading `~\.claude\projects`. The "already
   encoded" test in `claude-session-helpers.ts:34–37` assumes a POSIX path
   starts with `/`; it must accept a drive letter.
7. **Shutdown.** `apps/standalone-server/src/index.ts:220–221` waits for
   `SIGTERM`, which Windows never delivers. `server-supervisor.ts:83` stops the
   server with `child.kill('SIGTERM')`, which is `TerminateProcess` on
   Windows, so `core.shutdown()` does not run and the lock file stays. The IPC
   `disconnect` path (lines 108, 190) is the only graceful stop.
8. **Process groups.** `seat-connect.ts:64,221–229` and `agent-auth.ts:232`
   kill `-pid` off Windows only; on Windows the grandchildren stay.
9. **Atomic writes.** Fourteen sites write a temp file and `rename` it over
   the target (`attention-service.ts:208`, `live-activity-relay.ts:155`,
   `assets.ts:147`, `session-permission-store.ts:27`, `review-store.ts:55`,
   `model-downloader.ts:120`, `update-journal.ts:23`, and others). On Windows
   a target held open by a scanner or indexer fails with `EPERM`/`EBUSY`.
10. **Install from source.** `postinstall` runs `bash scripts/patch-dev-icon.sh`
    (root `package.json:28`). On Windows `bash` is absent, or it is the WSL
    launcher in `System32`, which is wrong. `bun install` fails before the
    first build.

### 4.2 Blockers for step 2 (packaged server and `solus` command)

1. `scripts/package-server.ts:10,77–82` accepts only three targets. It
   downloads Node as a `.tar.gz` with `bin/node` (lines 99–115); Windows Node
   is a `.zip` with `node.exe` at the root. The launchers are
   `#!/usr/bin/env sh` (lines 246–279). The archive is a tarball (line 53).
   `spawn('npm')` (line 230) is a shim.
2. `scripts/install.sh` handles Linux and Darwin only. There is no
   `install.ps1`.
3. `apps/cli/src/lib/runtime.ts:32–43` puts the runtime in
   `~/.local/share/solus` and the launcher in `~/.local/bin`. Line 62 names
   `bin/node`, not `node.exe`.
4. `version-store.ts:45–52` makes `current` a file symlink to a directory and
   renames it over the old link. Both fail on Windows without privileges.
5. `service.ts:106` throws for any platform but Linux and macOS. There is no
   logon task.
6. `apps/cli/src/index.ts:260` runs `tail -n -f` for `solus logs`.
   `connect.ts:233` opens a browser with `open` or `xdg-open`.
7. `cloudflared.ts:120–128` has no win32 release asset. `server-release.ts:53`
   asks for `solus-server-win32-x64.tar.gz`, which is not built.
8. `.github/workflows/release-server.yml` builds darwin and linux only.
   `test.yml` has no Windows job.
9. `platform/secrets.ts:43–75`: the standalone server stores secrets as JSON
   files protected by `0o600`, which Windows ignores.
10. `transport/endpoints.ts:10` looks for Tailscale in three POSIX folders.
11. `transport/ssh-bootstrap.ts:22–29` writes a `#!/bin/sh` askpass script.
12. There is no provider binary-path setting.

### 4.3 Blockers for step 3 (desktop app on Windows)

1. **No Windows build.** The electron-builder config (root `package.json`
   `build`) has `mac` only. `resources/` has no `.ico`.
   `scripts/afterPack.js:93–154` reads `<name>.app/Contents/...` and flips
   fuses on the bundle. `release.yml` has one `macos-latest` job.
   `build.files` strips the win32 `onnxruntime-node` binaries (lines
   109–111), and only the darwin `fff-bin` and `ffi-rs` packages are
   installed. `forge.config.js` is a leftover with a squirrel maker; it is
   not on the release path.
2. **Missing Windows Electron setup.** No `app.setAppUserModelId`, no
   `requestSingleInstanceLock` and `second-instance` (a second launch boots a
   second server, sees `server.lock`, and shows an error window), no
   `Menu.setApplicationMenu(null)` (the default menu bar appears and catches
   `Alt+F`, `Alt+E`, `Alt+V`, `Alt+W`, `Alt+H`).
3. **The in-process server** has every blocker in §4.1, because
   `apps/desktop/src/main/index.ts:857` calls `importLoginShellEnv()` and then
   `bootCore` in the same process.
4. **Shortcuts.** The global summon is `Alt+Space` (`index.ts:181–183`), the
   window menu on Windows. `conversation.interrupt` is `Ctrl+C`
   (`manifest.ts:102`), which becomes copy. `pr-review.copy-link` is
   `mod+ctrl+C`, which is plain `Ctrl+C`. `global.focus-sidebar-task-search`
   and `global.show-shortcuts` both become `Ctrl+/`. `formatCombo`
   (`match.ts:83–91`) and about 70 components print `⌘` and `⌥` on every
   platform. `comboToAccelerator` emits `Command` for `meta` off Mac.
5. **Tray.** `trayTemplate.png` with `setTemplateImage(true)`
   (`index.ts:983–988`) is near-invisible on a dark Windows taskbar.
6. **Shell integration.** `terminal-launcher.ts` needs `tmux`, `open`, and
   `osascript`; `terminal-apps.ts` knows no Windows Terminal or PowerShell.
   `file-handlers.ts:72` runs `/usr/sbin/screencapture`; lines 333–342 launch
   editors with `findOnPath` (no PATHEXT) and `open -a`. `app.setBadgeCount`
   does nothing on Windows.
7. **Paths in the client.** `client-core/src/project-identity.ts:50–60`
   recognises a project key only as `<serverId>:/…` or `<serverId>:~…`, so a
   key for `C:\repo` has no project parts. `desktop-palette.svelte.ts:603,619`
   splits paths on `/`. `server-connection.ts:73` and
   `OpenProjectDialog.svelte:387` call the local host "This Mac".
8. **Auto-update.** The feed holds only `latest-mac.yml`.
9. `index.ts:5–6` sets `NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem` on every
   platform.

### 4.4 What is already in place

`platform/opener.ts`, `trash.ts`, `file-manager.ts` (with WSL detection),
`host-operating-system.ts`, and `files/host-path.ts` have win32 branches. The
browser pane is driven over CDP with no platform gate. The OAuth sign-in is a
loopback server, not a custom protocol. SQLite is `node:sqlite`, so there is
no native build. The uplink already names `cloudflared.exe`.
`scripts/test-unit.ts` is Windows-aware. The desktop never needs a deep-link
handler. The pairing model, LAN discovery, and the socket.io transport need no
Windows change.

## 5. Target model

### 5.1 One command resolver

`packages/server/src/cli-env.ts` answers "where is program X, and how do I
start it" (`findOnPath`, `startableCommand`, and `launchedProcess`, which every
launch goes through). It is not a separate module: `cli-env.ts` must load on its
own under Node, and the tsconfig allows no `.ts` import extension.

```ts
interface ResolvedCommand {
  file: string          // what to pass to spawn
  args: string[]        // arguments to put before the caller's
  kind: 'executable' | 'node-script'
}
resolveCommand(name: string, env: NodeJS.ProcessEnv): ResolvedCommand | null
```

- POSIX: split on `path.delimiter`, probe `X_OK`. Unchanged behavior.
- Windows: split on `;`, strip wrapping quotes, read PATHEXT (default
  `.COM;.EXE;.BAT;.CMD`), probe `<dir>\<name><ext>`. Read `PATH` under any
  spelling. Compare directories case-insensitively. Cache each directory
  listing by mtime, as T3 Code does, so a miss costs no stat.
- A `.cmd` result is never returned as `file`. The resolver opens it and
  reads the npm template. For a native binary it returns the `.exe` the
  template names. For a JavaScript entry it returns
  `{ file: process.execPath, args: [cliJs], kind: 'node-script' }`. A `.cmd`
  it cannot read is a miss, and the error names the file so the user can set
  the binary path.
- Git: a `git.exe` under `Git\cmd` is replaced by the one under `mingw64\bin`
  or `ucrt64\bin` when present. This is T3 Code's fix for the launcher's
  kernel token leak. Git for Windows 2.56 has `ucrt64` only.
- A bun install (`~\.bun\bin\codex.exe`) is a real `.exe` and starts as it is.
- An absolute `.cmd` or `.bat` path (a project's `node_modules\.bin\x.cmd`) is
  resolved like a bare name.
- `hostCliEnv` and `launchedProcess` spawn `resolved.file` with
  `[...resolved.args, ...callerArgs]`. No call site uses `shell: true`.

Difference from T3 Code: a non-native shim runs through Node directly, never
through `cmd.exe`, so no argument needs escaping and the child is never a
grandchild of `cmd.exe`.

### 5.2 PATH on Windows

`computeCliPathSync` returns the process PATH on Windows with the known CLI
folders appended (`%APPDATA%\npm`, `%ProgramFiles%\nodejs`,
`%LOCALAPPDATA%\Programs`, `~\.local\bin`, `~\.bun\bin`, `~\scoop\shims`,
`%LOCALAPPDATA%\Volta\bin`, `%LOCALAPPDATA%\pnpm`). No shell probe runs.
`hostCliEnv` writes one `PATH` and deletes the other spellings.

When `node` is still not on that PATH, one PowerShell probe runs with the
profile loaded (`pwsh.exe`, then `powershell.exe`; `-NoLogo -NonInteractive
-Command`) and reads `PATH`, `FNM_DIR`, and `FNM_MULTISHELL_PATH`. The two
executables share one 5 s budget on a monotonic clock, so a hanging profile
costs 5 s, not 10. The probe runs in `warmCliPath`, off the request path, and
a request that arrives first uses the process PATH rather than blocking.
This is T3 Code's rule, and it is what makes a server started from a logon
task or the Start menu see a CLI installed after logon.

### 5.3 Provider binary path

A host setting per provider, `claudeBinaryPath` and `codexBinaryPath`, in
`host/settings.ts`. When set, the agent uses it instead of the resolver. The
Tools settings page shows the field under each provider with the resolved path
as the placeholder, on every client. This is the parity item that turns a
PATH miss into a one-field fix.

### 5.4 Paths

One module, `packages/contracts/src/host-path.ts`, answers every question about
a host path: is it absolute, its names, its last name, whether two spellings
are one path, whether it is inside a root, the rest from that root, and how to
join a name to it. The server and all three clients use it, because a client
on a Mac reads paths from a Windows host. `solus/host-path-separators` rejects
a `'/'` written against a value whose name says it is a host path.

- **The wire rule.** A project-relative path crosses the wire with `/`, as git
  and `toRootRelativePath` write it (`relativeHostPath` gives that). An
  absolute path keeps its host's form (`C:\code\x`).
- **Git's output.** Git for Windows prints `C:/x` where Node has `C:\x`.
  Every path read from git's stdout goes through `gitOutputPath` in
  `git/exec.ts`. Without it the main checkout read as a linked worktree, and
  New worktree did nothing for a Windows project.
- A path marker test uses `hostPathKey`; the marker constants do not change.
- `resolveHomePath`, `expandHome`, and the file preview share one `~` rule,
  `startsAtHome` in `files/host-path.ts`.
- `client-core` reads a project key as `<serverId>:` followed by a path that
  starts with `/`, `~`, a drive letter, or `\\`.
- The local host is "This computer" on every platform.

### 5.5 Atomic writes

One helper, `platform/atomic-write.ts`, writes the temp file and renames it.
On win32 it retries `EBUSY`, `EPERM`, and `EACCES` twenty times at 100 ms, and
stops early when the target is read-only or changed under it. The fourteen
sites in §4.1 item 9 call it.

### 5.6 Process lifetime

- The supervisor stops the server with an IPC `solus:stop` message, then
  waits, then kills. The server already handles `disconnect`; `solus:stop` is
  the explicit form, and it works on every platform.
- On Windows a process tree ends with `taskkill /T /F /PID`. The helper that
  kills `-pid` on POSIX does this on win32.
- `process.on('SIGINT')` stays for Ctrl+C in a console.

### 5.7 Version store and links

`current` is a junction on Windows (`symlinkSync(target, link, 'junction')`).
A junction is replaced by removing the old one and making the new one.
`currentVersionDir` resolves it with `realpathSync` as today. Seat links in
`seat-manager.ts` use `'junction'` too.

### 5.8 Folders on Windows

| Purpose | Today | Windows |
| --- | --- | --- |
| data | `~/.solus` | `%USERPROFILE%\.solus` (same; `homedir()` gives it) |
| runtime (versions) | `~/.local/share/solus` | `%LOCALAPPDATA%\solus\runtime` |
| launcher | `~/.local/bin/solus` | `%USERPROFILE%\.local\bin\solus.cmd` |
| logs | `<data>/logs` | same |

The command folder matches Claude Code's and T3 Code's Windows installs, so a
machine with Claude Code already has it on PATH. The installer adds it to the
user PATH when it is absent (`[Environment]::SetEnvironmentVariable` with
`User` scope) and says so. T3 Code only prints the line; Solus adds it,
because "run `solus` in a new terminal" is the whole first-run story.

### 5.9 The logon task

`solus setup` on Windows registers a Task Scheduler task `Solus server` that
runs `solus.cmd start` at logon as the current user, hidden, with restart on
failure. `solus service status|stop|uninstall` map to `schtasks /query`,
`schtasks /end`, and `schtasks /delete`. No administrator rights are needed
for a per-user logon task. T3 Code has no service on Windows; Solus's
update-then-restart contract in `server-supervisor.ts` needs a supervisor that
restarts, and a logon task is the cheapest one.

### 5.10 Packaging and install

- `package-server.ts` gains `win32-x64`. It downloads
  `node-v<ver>-win-x64.zip`, takes `node.exe`, writes `bin\solus.cmd` and
  `bin\solus-server.cmd`, installs `fff-bin-win32-x64` and
  `ffi-rs-win32-x64-msvc`, and writes a `.zip` with `SHA256SUMS`. The
  release asset is `solus-server-win32-x64.zip`, and `server-release.ts`
  asks for `.zip` on win32.
- `scripts/install.ps1` mirrors `install.sh` and T3 Code's `install.ps1`:
  check the machine is x64 (`PROCESSOR_ARCHITEW6432` first, so 32-bit
  PowerShell on a 64-bit machine reports the real one; ARM64 is refused with
  a message), pick the version, download,
  verify with `Get-FileHash`, unpack to `runtime\versions\<version>`, run
  `node.exe libexec\cli\solus.js --version`, point `current`, write
  `solus.cmd`, add the command folder to the user PATH, print next steps. It
  needs PowerShell 5.1 and nothing else. `SOLUS_INSTALL_ARCHIVE` and
  `SOLUS_INSTALL_SHA256SUMS` work as in `install.sh`.
- `release-server.yml` adds `windows-latest` entries. `test.yml` adds a
  `windows-latest` job that runs the unit tests in §8.

### 5.11 Secrets on the standalone server

POSIX keeps the secrets folder to its user with `0o700`. On Windows the
`FileSecretStore` gives a new secrets folder the same protection with one
`icacls` call: the folder stops inheriting its parent's access and grants it to
this user and SYSTEM only. A folder inside the user profile already has that
access, but a data folder outside it (`C:\solus-data`) inherits write access
for every user.

DPAPI through PowerShell was built first and dropped: each call started
PowerShell for one to two seconds and stopped the server while it ran, and it
protects more than `0o600` does on POSIX.

### 5.12 Desktop app

- electron-builder `win` target: `nsis`, `x64` only, `resources/icon.png` (electron-builder makes the `.ico`),
  `publish` unchanged so `latest.yml` lands beside `latest-mac.yml`.
  `afterPack.js` branches on `context.electronPlatformName`: the fuse flip
  targets `Solus.exe`, and the size check reads `appOutDir`.
- `main/index.ts`: `app.setAppUserModelId('com.solus.app')`,
  `requestSingleInstanceLock` with a `second-instance` handler that shows the
  window, `Menu.setApplicationMenu(null)` off macOS, the `.ico` for the
  window, a colour tray PNG off macOS, `NODE_EXTRA_CA_CERTS` only when the
  file exists, and `app.focus()` plus `moveTop()` after the summon shortcut.
  If Windows still refuses the foreground, add T3 Code's Win32 activation
  through `ffi-rs`, which is already a dependency.
- The in-process server gets its PATH from `importLoginShellEnv()`, which on
  win32 runs the §5.2 probe once and writes `process.env`. The server does
  not probe again.
- The `solus` command on Windows: as VS Code ships `code`, a launcher in the
  app's `bin` folder that the installer puts on the user PATH; as built, see
  §13.5. It does not use the command folder, which the standalone install
  owns. macOS keeps the `RunAsNode` fuse off and does not offer it.
- The default summon shortcut is `Alt+Shift+Space` on Windows and Linux.
  `Alt+Space` stays on macOS.
- Keybindings: `conversation.interrupt` is `Ctrl+Shift+C` off macOS;
  `pr-review.copy-link` and `global.focus-sidebar-task-search` get free
  combos; `formatCombo` prints `Ctrl`, `Alt`, `Shift`, `Win` off macOS, and
  the components that print `⌘` read the formatter instead.
  `comboToAccelerator` emits `Super` for `meta` off macOS.
- Badge: `setOverlayIcon` on Windows with a rendered count; cleared when a
  window has focus.
- Shell integration: `platform/win32-terminal.ts` for Windows
  Terminal (`wt.exe -d <cwd>`) and PowerShell, with no `tmux`; editors found
  on PATH first, then under `%LOCALAPPDATA%\Programs` and the Program Files
  roots (VS Code `Code.exe` and Cursor `Cursor.exe`, not their `bin\*.cmd`; Zed `.exe`, JetBrains
  `bin\<ide>64.exe`); screenshots use `desktopCapturer`.
- `build.files` keeps the `win32` `onnxruntime-node` binaries in a Windows
  build.
- `release.yml` adds a `build-windows` job that runs the two vite builds and
  `electron-builder --win --publish never`, uploads the `.exe`, `latest.yml`,
  and blockmap to R2, and attaches the `.exe` to the release. T3 Code builds
  its NSIS installers on Linux and runs only native checks on Windows
  runners; Solus can start on `windows-latest` and move later.

### 5.13 WSL distros

Decided 2026-10-27, replacing the first design, in which the desktop app ran
its own server inside a distro instead of on Windows ("one at a time"). That
design had two faults. The Windows app carries only Windows native modules,
so its server tree cannot load in Linux. And the desktop-only features
(screenshots, Open in editor and terminal, voice, the browser pane) are
handlers of the app's own Windows server, so moving the server would have
meant moving each of them.

A WSL distro is instead **a machine you add**, through the path that already
adds a machine over SSH (docs/plans/host-routes.md D6, D7):

- **Choice.** Add a WSL distro, in the Run on menu (desktop and web) and in a
  Windows host's settings (mobile), lists the distros of the Windows host
  (`hostsListWslDistros`: `wsl.exe --list --verbose`, 8 s bound). A failure
  says why: no WSL, no distro, or WSL did not answer.
- **Install.** The host runs the provisioner's steps in the distro through
  `wsl.exe -d <distro> --exec sh -c`, with each script on stdin, as it does
  over SSH. The published installer puts the Linux release of the host's own
  version there (`SOLUS_VERSION`), with its own Node and Linux native
  modules, so the distro needs nothing installed. `solus setup` starts it,
  and `solus auth session create` gives the host its session.
- **Reach.** `hostsAddWsl` saves the distro as a forwarded host, labelled
  `<distro> (WSL)` because a distro takes the computer's name. The forward
  is a loopback port on Windows; each connection is bridged into the distro
  by one `wsl.exe` process running the release's Node, which connects to the
  server's loopback port there. This works under NAT and mirrored networking
  alike, and no Windows port is shared with the distro's.
- **Lifetime.** WSL stops a distro when no process from Windows runs in it, so
  the forward holds one (`sleep infinity`) while it is open. The forward
  reconnects with backoff and opens again at boot, like an SSH forward.
- **Paths and files.** The repositories live in the distro's own file system;
  a session there works in Linux paths. Nothing is read through `/mnt/c`.
- **Not in a distro.** The desktop features stay on the Windows server.

### 5.14 Performance on Windows

The items from §3.5 that are not already part of §5.1 and §5.2.

- **Port scanning.** `browser/target-scanner.ts` gains a win32 branch. It
  returns an empty list at once when no session is running and no URL is
  configured, so an idle poll spawns nothing. Otherwise it runs
  `netstat.exe -ano -p tcp` and `netstat.exe -ano -p tcpv6` concurrently and
  reads listening sockets by the foreign address `:0`, which is the same on
  every Windows locale (the state column is translated). `netstat` gives only
  PIDs, so each new PID gets one `tasklist.exe /FI "PID eq <pid>"` call, cached
  per PID. Windows has no cheap way to read another process's working
  directory, so a Windows offer names the port and the process, not the
  project; the client already handles an offer without a project.
- **Snapshot flushing.** The `git` commands in `git/session-snapshots.ts` that
  write objects (`hash-object -w`, `write-tree`, `commit-tree`, `update-ref`)
  run with `-c core.fsync=committed -c core.fsyncMethod=fsync
  -c core.fsyncMethod=batch` on macOS and Windows. Git 2.37+ batches the
  object flushes; Git 2.36 ignores the unknown second value and keeps full
  flushing. Linux keeps the defaults, because Git documents batch equivalence
  only for APFS and NTFS/ReFS. Measure a long turn on both platforms before
  and after; keep it only if the capture time drops.
- **Installer.** The first Windows build records the installer's file count
  and cold boot time (`solus_boot_phase` in `dev.log`). The target is under
  2,000 files and a server listening within 4 s on a cold cache. NSIS
  `differentialPackage: true` is on so updates download blocks, not the whole
  installer.
- **Event-loop stalls.** `spawn()` creates the process on the main thread, so
  a slow process creation is a stall. The host already logs
  `event_loop_stalled`; the Windows runs in §8 read it and count git launches
  per hour, so a leak like the launcher's is visible before users report it.

## 6. What is not in this plan

- Tailscale HTTPS (`tailscale serve`). Solus has no serve on any platform.
- A terminal feature. Solus has none; node-pty parity does not apply.
- T3 Code's screenshot feature and its modifier-only shortcut worker.
- Member seats (Linux user switching) on Windows.
- Desktop-managed SSH to a Windows host. T3 Code has the same limit.
- Windows on ARM, for the server and the desktop app. Solus builds and
  tests `win32-x64` only. `install.ps1` and `parseTarget` refuse an ARM64
  machine with a message that names the limit. The x64 build runs under
  emulation on Windows on ARM, but it is not tested or supported there.

## 7. Order of work

Each step is one pull request or a small set. A step ends with its proof (§8).

### 7.1 Step 1: the server runs on native Windows from source

1. **Install from source on Windows.** Replace `bash scripts/patch-dev-icon.sh`
   in `postinstall` with `bun scripts/patch-dev-icon.ts`, which returns at once
   off darwin. Check that `bun install` and `bun scripts/build-headless.ts`
   finish on Windows; the headless build is esbuild only. Confirm
   `fff-bin-win32-x64` and `ffi-rs-win32-x64-msvc` install as optional
   dependencies, or make the file finder optional on a miss.
2. **The command resolver** (§5.1) and **PATH on Windows** (§5.2) in
   `cli-env.ts` and the new `command-path.ts`. Move `findOnPath`'s callers to
   it: `claude-agent.ts`, `codex-agent.ts`, `git-availability.ts`,
   `provider-versions.ts`, `uplink/connector.ts`, `code-intel`, and the four
   `which` call sites. Keep `probeGit`'s darwin stub check.
3. **Shims.** `codex-agent.ts`, `setup-commands.ts` (`npm`), and
   `apps/cli/src/index.ts` (login) spawn the resolved command. The Claude
   agent passes the resolved `.exe` or `cli.js` to the SDK as
   `pathToClaudeCodeExecutable`. The Claude installer command on Windows is
   `irm https://claude.ai/install.ps1 | iex`; `setup-commands.ts` returns it
   on win32 and skips the `sudo` and ownership checks.
4. **Provider binary path** (§5.3): the setting, the agents, the Tools page
   on desktop, web, and mobile.
5. **Paths** (§5.4): the marker tests, `resolveHomePath`, and the
   "already encoded" check.
6. **Atomic writes** (§5.5).
7. **Lifetime** (§5.6): `solus:stop` in the supervisor and the standalone
   entry; `taskkill` in the tree-kill helper.
8. **Snapshot flushing** (§5.14): measure, then keep or drop.
9. **Run it.** On the Windows machine: `bun install`,
   `bun scripts/build-headless.ts`, then
   `node dist\headless\libexec\server\standalone.js --data-dir %USERPROFILE%\.solus-dev`.
   Allow the Windows Firewall prompt for Node on private networks, or set
   `remoteAccess` in the host settings.
10. **Pair the Mac.** On the Mac desktop app open Add server, paste the pair
   link the server printed, or type `http://<windows-ip>:3000` and the code.
   Pick the Windows host in Run on. Start a Claude Code session and a Codex
   session in a repository on the Windows host. Make a worktree. Open the
   diff. Run `git` actions. Read `~\.claude\projects` to confirm the folder
   encoding.

The known gaps after this step: no `solus` command, no logon task, plaintext
secrets, no uplink, no Tailscale detection.

### 7.2 Step 2: the Windows server package and the `solus` command

1. `runtime.ts` folders (§5.8) and `node.exe`.
2. `version-store.ts` junctions (§5.7).
3. `package-server.ts` win32 targets, `.cmd` launchers, and the `.zip`
   (§5.10). `server-release.ts` asks for `.zip` on win32.
4. `scripts/install.ps1` (§5.10). Add it to the site beside `install.sh`.
5. `cloudflared.ts` win32 asset (`cloudflared-windows-amd64.exe`).
   `endpoints.ts` adds
   `%ProgramFiles%\Tailscale\tailscale.exe` and a longer status bound.
6. `solus logs` reads the file with Node instead of `tail`. `connect.ts` opens
   a browser through `platform/opener.ts`.
7. The SSH askpass helper as `.cmd` plus `.ps1` on win32, with no `chmod`
   and no `DISPLAY`.
8. The logon task (§5.9) in `service.ts`, `setup.ts`, and `status.ts`.
9. DPAPI secrets (§5.11).
10. `release-server.yml` and `test.yml` Windows jobs.

### 7.3 Step 3: the desktop app on native Windows

1. Electron setup and build (§5.12): `app.setAppUserModelId`, single
   instance, no menu bar, icons, tray, `NODE_EXTRA_CA_CERTS`, `afterPack.js`,
   the `win` target, `.ico` generation, and the CI job. Build locally first
   with `electron-builder --win --dir`; the developer runs the build.
2. PATH for the in-process server: `importLoginShellEnv()` runs the §5.2
   probe once on win32.
3. Shortcuts and labels: the summon default, the four conflicting combos,
   `formatCombo`, `comboToAccelerator`, "This computer".
4. Client paths: `project-identity.ts`, `desktop-palette.svelte.ts`.
5. Badge, focus after summon, and shell integration: `setOverlayIcon`,
   `app.focus()` and `moveTop()`, Windows Terminal, editors through the
   resolver and the install roots, `desktopCapturer`.
6. Port scanning with `netstat` and the installer measurements (§5.14).
7. The `solus` command from Settings (§5.12), on Windows and macOS.
8. Auto-update: confirm `latest.yml` on the feed and `quitAndInstall` with
   the NSIS installer.
9. Run the Windows desktop app against its own server, then pair it with the
   Mac host as a second host.

### 7.4 Step 4: WSL distros

1. `packages/server/src/remote-machines/wsl.ts`: the distro list, the
   `wsl:<distro>` target, `WslClient` (`run` and `forward`), and the router
   that sends a `wsl:` target to WSL and every other target to SSH.
2. The provisioner and the forwards take that router; the WSL provisioner
   installs the host's own version.
3. `hostsListWslDistros` and `hostsAddWsl`, on every client: the Run on menu
   and a dialog on desktop and web, and a screen from a Windows host's
   settings on mobile.
4. Run it: install a distro, add it, start a Claude Code session in
   `~/code/<repo>` there, open the diff, and restart the app to see the
   forward open again.

### 7.5 Step 5: distribution

Winget and scoop manifests and code signing.

## 8. Proofs

Unit tests run on macOS and on the Windows CI job. A test that needs a real
Windows file system says so and skips elsewhere.

- `tests/unit/command-path.test.ts`: on a fake win32 PATH with PATHEXT, a bare
  name finds `.exe` before `.cmd`; an npm `.cmd` for a JavaScript entry
  resolves to Node plus the script; an npm `.cmd` for a native binary resolves
  to the `.exe`; a hand-written `.cmd` is a miss with a message that names it;
  PATH under `Path` is read; a drive letter is not split; `Git\cmd\git.exe`
  becomes `mingw64\bin\git.exe` when present; the POSIX path is unchanged.
- `tests/unit/cli-env.test.ts`: on win32 no shell probe runs when `node` is
  on PATH; the PowerShell probe runs once when it is not; the known folders
  are appended once; `hostCliEnv` writes one `PATH` spelling.
- `tests/unit/provider-binary-path.test.ts`: a set path wins over the
  resolver, and a missing file at that path is the error the user sees.
- `tests/unit/worktree-path.test.ts`: `isSolusWorktreePath` accepts a
  backslash path; `encodePathAsFolder` gives `C--Users-me-repo`; the
  "already encoded" check accepts a drive letter.
- `tests/unit/atomic-write.test.ts`: on win32 an `EBUSY` that clears is
  retried; a read-only target is not; a changed target stops the retry.
- `tests/unit/server-supervisor.test.ts`: `solus:stop` runs `shutdown` and the
  lock file is removed before the child exits.
- `tests/unit/version-store.test.ts`: on win32 `current` is a junction and
  `setCurrent` replaces it; on POSIX the symlink behavior is unchanged.
- `tests/unit/runtime-paths.test.ts`: the Windows folders in §5.8.
- `tests/unit/service.test.ts`: the `schtasks` arguments for install, status,
  and uninstall.
- `tests/unit/project-identity.test.ts`: a project key with `C:\` has parts and
  a label.
- `tests/unit/keybindings-match.test.ts`: `formatCombo` off macOS prints
  `Ctrl` and `Alt`; `comboToAccelerator` emits `Super` for `meta`.
- `tests/unit/package-server.test.ts`: `parseTarget` accepts `win32-x64` and
  refuses `win32-arm64`; the
  launcher content for win32 is a `.cmd` that calls `node.exe`.
- `tests/unit/cli-shim.test.ts`: the `solus.cmd` content, the marker check,
  and the PATH edit are what §5.12 says.
- `tests/unit/target-scanner.test.ts`: on win32 an idle poll spawns nothing;
  a German-locale `netstat` output yields the listening ports; `tasklist`
  runs once per PID across polls.
- `tests/unit/session-snapshots.test.ts`: the object-writing git commands
  carry the fsync settings on darwin and win32 and not on linux.
- `tests/unit/wsl-environment.test.ts`: the distro list parser, the
  mirrored-networking rule for the target URL, the `WSLENV` list, and the
  backslash normalization before `wslpath`.
- A manual run on the Windows machine for each step, as in §7.1 items 9–10,
  §7.3 item 9, and §7.4 item 6, with the result written into this file.

## 9. Known limits

- Step 1 stores standalone-server secrets as plaintext files on Windows. Keep
  the data folder on a BitLocker drive until §5.11 ships.
- Step 1 has no uplink and no Tailscale detection on Windows. Pair over the
  LAN.
- `remoteAccess` binds `0.0.0.0` and the LAN discovery socket binds UDP 34117.
  Each triggers one Windows Firewall prompt the first time.
- Chrome cookie import stays refused on Windows (ADR 0026), as in T3 Code.
- `core.longpaths` is off by default in Git for Windows. A deep repository
  under `.git\solus\worktrees\<slug>` can pass `MAX_PATH`. The setup page tells
  the user to run `git config --global core.longpaths true` on Windows.
- The browser pane on a standalone Windows server needs Playwright's Chromium;
  the installer prints the command as it does on Linux.
- A WSL distro needs network access to download the Linux release the first
  time it is added, and systemd for `solus setup` (on by default in current
  Ubuntu WSL images).
- Member seats (Linux user switching) stay unsupported on Windows and in the
  WSL distros.

## 10. Decisions for the maintainers

1. **Command folder.** `%USERPROFILE%\.local\bin` (matches Claude Code and
   T3 Code; the installer adds it to the user PATH), or
   `%LOCALAPPDATA%\Programs\solus\bin`. The plan assumes the first.
2. **Archive format.** `.zip` for the Windows server package (the plan
   assumes it, as T3 Code), or keep `.tar.gz`.
3. **Logon task.** Ship `solus setup` as a Task Scheduler task in step 2, or
   do what T3 Code does and tell Windows users to keep a terminal open. The
   plan assumes the task.
4. **Remote-only desktop.** T3 Code can turn off the local server. Solus
   always boots one. Add the switch in step 3, or leave it. The plan leaves
   it; adding a WSL distro as a machine covers the common reason for it.
5. **Code signing for the desktop app.** An unsigned NSIS installer shows the
   SmartScreen warning. The plan ships unsigned in step 3 and signs in step 5.
6. **Summon shortcut.** `Alt+Shift+Space` on Windows, or another.
7. **WSL step order.** Step 4 after step 3 (the plan), or before it, since a
   Windows machine with WSL could run Solus with fewer native fixes. Step 1
   is needed either way for the desktop's own server.

## 11. Step 1 results (2026-10-23)

Run on a Windows 11 x64 machine (build 26200) from source, paired with the Mac
desktop app over the LAN.

### 11.1 What works

- `bun install` and `bun scripts/build-headless.ts` (the icon script is Bun,
  the build finds `esbuild.exe`).
- The server boots in about 200 ms and pairs with a code. Claude Code 2.1.309
  (`claude.exe`) and Codex 0.164.0 (a bun `.exe`) run sessions.
- Worktrees, the diff, and `@` file mentions in a worktree, after the path
  fixes in §5.4.
- Git: the real `ucrt64\bin\git.exe` runs hooks that need `sh`, `worktree add`,
  and SSH fetches.
- The manual run of §7.1 item 10 passed from the Mac desktop app with the
  Windows host in Run on: a Claude session, a Codex session, a new worktree,
  the diff, a commit from the UI, and reopening a session. Claude names the
  worktree's project folder `C--code-scratch--git-solus-worktrees-<slug>`, as
  `encodePathAsFolder` gives.

### 11.2 Corrections to §4

- `update-data.ts` and `update-journal.ts` call `fsync` on a directory, which
  Windows refuses (`EPERM`). This is step 2 work with the junctions (§5.7).
- The "already encoded" Claude folder check needs no change:
  `encodePathAsFolder` gives the same result when it runs twice.
- Git for Windows turns `core.autocrlf` on. A clone for tests needs
  `core.autocrlf false`, or tests that read source text see `\r\n`.

### 11.3 Not done in step 1

These came from the T3 Code parity list, not from a fault seen on Windows. They
wait until someone sees the fault, and each names what to look for:

- Atomic-write retries (§5.5): a write that fails with `EPERM` or `EBUSY` on
  rename in `dev.log`. None was seen.
- The provider binary path (§5.3): a CLI that is installed but not found. The
  PATH lookup found Claude Code and Codex every time.
- The PowerShell PATH probe (§5.2): a server started at logon that cannot find
  `node` or a CLI installed after logon.
- `solus` CLI login spawns `claude` and `codex` by name; with an npm `.cmd`
  install this fails. It moves to step 2 with the `solus` command.
- SSH connect from Add server runs a `sh` script that calls `solus`, so it
  cannot connect to Windows. It now says so. A PowerShell bootstrap belongs in
  step 2, once `solus.cmd` exists.

### 11.4 The unit suite on Windows

With LF line endings and only this branch, 53 test files fail on Windows that
pass on macOS. The Windows CI job (§5.10) needs each one fixed or skipped with
its reason:

- **POSIX fixtures (about 30).** A `#!/bin/sh` fake tool (`claude-executable`,
  `claude-steering`, `claude-usage-read`, `cli-path-lookup`,
  `code-intel-manager`, `runtime-instructions`, `git-availability`,
  `install-script`, `ssh-bootstrap`, `cli-env`), POSIX paths written in the
  test (`bundled-plugins`, `claude-seat-env`, `desktop-compile-cache`,
  `managed-host`, `worktree-move`, `git-watcher`, `attachment-upload`,
  `managed-pr-checkout`, `git-bare-guard-callers`, `git-bare-discovery-guard`,
  `device-local-host`, `device-project`, `service`), a bare `claude` where the
  resolver now gives `claude.exe` (`seat-login`, `seat-connect`), the
  executable bit or file modes (`registry-skill-cache`, `agent-profile`,
  `account-store`, `seat-manager`), a symlink (`write-file-destination`),
  signals (`uplink-connector`), and `cli-cloudflared`.
- **Step 2 and 3 work (about 12).** `version-store` and `server-supervisor`
  (junctions, `fsync`), `headless-build` and `desktop-package-layout`
  (win32 targets), `desktop-capture`, `file-manager`, keybindings (`match`,
  `browser-guest-shortcuts`), and members (`launch-point`, `acting-identity`).
- **Test setup.** Four files keep their own SQLite handle open
  (`browser-open-tool`, `browser-recording-tools`,
  `metrics-statement-columns`, `observability`). Four boundary checks read
  file paths with `/` (`server-module-boundaries`, `native-mobile-boundaries`,
  `startup-import-graph`, `native-mobile-navigation-destinations`).

The other 120 files that failed on Windows deleted a SQLite file that Bun had
not closed. `tests/unit/helpers/bun-sqlite.ts` is now the one `node:sqlite`
mock; its `close()` releases the file.

## 12. Step 2 results (2026-10-23)

### 12.1 What works on the Windows machine

- `bun scripts/package-server.ts --headless` builds
  `solus-server-headless-win32-x64.zip` (47 MB) and its `SHA256SUMS` line on
  Windows. The package with the web client needs the client build, which the
  release workflow runs on its Windows runner.
- `install.ps1` with `SOLUS_INSTALL_ARCHIVE` installs to
  `%LOCALAPPDATA%\solus\runtime\versions\<version>`, makes `current` a
  junction, and writes `%USERPROFILE%\.local\bin\solus.cmd`. In a new session
  `solus --version` answers.
- `solus setup` registers the `Solus server` logon task, starts the server,
  and prints the pair link. The server runs after the SSH session ends.
- `solus service stop`, `restart`, and `uninstall`, `solus status`.
- A server that crashes is started again by its supervisor.
- SSH connect from a Mac to the Windows host returns a session credential in
  about 3 s.

### 12.2 What the machine showed that the tests did not

- **The account name.** Under SSH, `USERDOMAIN` is `WORKGROUP`, which names no
  account. The task names its user by SID (`whoami /user`); the secrets folder
  uses the plain user name.
- **`schtasks /end` ends only the task's own processes.** The server that the
  supervisor started kept the port, and the next start failed. Stop, restart,
  and uninstall also end the server from `server.lock`, and only when that PID
  is still this install's `standalone.js`. It is not a clean shutdown: SQLite
  recovers from its WAL, and the next start replaces a dead lock.
- **Task Scheduler does not restart a program that exits with an error.**
  `RestartOnFailure` covers a task that fails to start. Under the logon task
  (`SOLUS_SUPERVISOR_RESTARTS=1`) the supervisor starts a crashed server again
  after 2 s, doubling to 60 s, and starts over when the server reports ready.
  `solus start` in a terminal still ends on a crash.
- **Codex runs commands through PowerShell.** It reports each one as
  `"C:\…\powershell.exe" -Command '<script>'`. `worktreeAddPaths` read POSIX
  shells only and named the program with a POSIX basename, so a worktree Codex
  made was never offered for a move. It now names the program with
  `hostPathBaseName` (without `.exe`) and reads `powershell` and `pwsh` with
  `-Command` or `-c`.
- **cmd.exe exits 0 when `sh` is missing.** It prints the error and echoes the
  piped script. The SSH bootstrap reads the error, not the exit code, before it
  asks PowerShell.

### 12.3 Not proven on Windows

- `solus update` from a GitHub release: it needs a published `win32-x64`
  release.
- The full package with the web client, and the Windows CI jobs: they run on
  GitHub's runners.
- A host that links to Solus Cloud, where the first secret is written.

### 12.4 Known gaps

- **`cloud-build-boundaries.test.ts`** took more than 30 s in a full Windows run
  under load; alone it passes in 2 s.


## 13. Step 3 results (2026-10-26)

Run on the same Windows 11 x64 machine (build 26200) from source. The desktop
app ran with its own data folder, port, and Electron `userData` under
`.solus-local/`; the standalone server's `~/.solus` was not touched.

### 13.1 What works on the Windows machine

- `bun install` (330 s, 1,759 packages) and `electron-vite build`.
- The desktop app starts, boots its in-process server, and shows the
  workspace: sidebar, composer, Run on, model picker.
- `electron-builder --win --x64` builds `release\Solus-0.37.0-x64.exe`
  (151 MB), its blockmap, and `latest.yml`. The afterPack probe passes inside
  the package: fff loads `fff_c.dll` from `app.asar.unpacked`, ONNX runs on
  the CPU, and the Claude SDK loads. The fuses are flipped on `Solus.exe`.
- The package has 104 files (target: under 2,000). It is 618 MB unpacked;
  `Solus.exe` (Electron) is 225 MB and ONNX is 64 MB. Only the `win32\x64`
  ONNX binaries ship.

### 13.2 What the machine showed that the tests did not

- **Antivirus holds new copies open.** The packaged plugin sync copies
  `resources/plugins` to `plugins.incoming` and renames it; the rename failed
  with `EPERM`, so agents ran without the bundled plugins. The server now has
  `platform/rename-retry.ts` (the CLI's rule, §5.5), and the plugin sync uses it.
  electron-builder's own rename of a freshly extracted Electron fails the same
  way on this machine; a local build passes
  `-c.electronDist=node_modules/electron/dist`, which copies instead.
- **Electron cannot decode an SVG native image.** A data-URL SVG gives an
  empty image, so the taskbar count is drawn as pixels (`platform/win32-badge.ts`).
- **The desktop server binds `0.0.0.0`.** The first start shows the Windows
  Firewall prompt for Electron (§9). A dev run shows it for `electron.exe`; an
  installed app shows it once for `Solus.exe`.
- **Two servers ran on one data folder.** The installed desktop app started
  while the standalone server held `~/.solus`. Both default to that folder.
  The lock was taken only after the database was open, and a lock held by a
  live server only logged `lock_acquisition_failed`, so the app served a
  second server on port 3001 against the same database. This was not
  Windows-specific. `bootCore` now refuses first (`host/server-lock.ts`): a
  lock whose process is alive and whose port answers names the other server,
  and boot stops with a message that says to stop it or set `SOLUS_DATA_DIR`.
  The port check is there because Windows reuses process ids. The packaged
  app was checked against a copy of the live lock: it refused before creating
  a database.
- **An interactive run on a machine in use is disruptive.** The window takes
  the foreground when it is ready and the Firewall prompt appears over other
  apps. Run the manual pass when the machine is free.

### 13.3 Changes in this step

- **Platform adapters.** The desktop main process no longer reads
  `process.platform`. `apps/desktop/src/main/platform/desktop-platform.ts`
  declares `DesktopPlatform`: setup before and after ready, single instance,
  window options, focus, hide, tray icon, badge, Open in terminal, Open in
  editor, and screen capture. `darwin.ts`, `linux.ts`, and `win32.ts` implement
  it, and `desktopPlatformFor(platform)` picks one. Windows-only code sits
  beside its adapter (`win32-terminal.ts`, `win32-editors.ts`,
  `win32-badge.ts`). macOS and Linux share the tmux launcher
  (`terminal-launcher.ts`), which still separates the two inside it.
  The key facts are a second adapter in the shared UI,
  `packages/workspace-ui/src/lib/keybindings/key-platform.ts`: `MAC_KEYS`,
  `WINDOWS_KEYS`, and `LINUX_KEYS` hold the primary modifier, labels,
  separator, meta accelerator, and summon default. The renderer picks one from
  `navigator.platform`; the main process takes `DesktopPlatform.keys`. Each
  function in `match.ts` takes the keys as its last argument, so the tests run
  all three platforms on any machine.
- Electron: `setAppUserModelId('com.solus.app')`, the single-instance lock on
  every platform but macOS, no application menu on Windows, `app.focus()` and
  `moveTop()` before focus, a tray icon drawn at 16 px per display scale and
  opened by a left click, and the count as an overlay icon.
- Build: the `win` NSIS target (x64, one-click, per user, differential
  updates) with `resources/icon.png` (electron-builder makes the `.ico`), the
  Windows file filters, the win32 package layout for afterPack, `dist:win`,
  and the `build-windows` and `publish-windows` release jobs. The updater is
  automatic on Windows; `latest.yml` lands beside `latest-mac.yml`.
- `importLoginShellEnv()` does nothing on Windows: a Start-menu launch already
  has the user's environment.
- Shortcuts: `nonMac` defaults in the manifest for `conversation.interrupt`
  (`Ctrl+Shift+C`), `pr-review.copy-link` (`Ctrl+Shift+C`), and
  `global.focus-sidebar-task-search` (`Ctrl+Shift+/`). The summon default is
  `Alt+Shift+Space` off macOS. `formatCombo` prints key names and
  `formatComboText` joins them with `+`; `comboToAccelerator` emits `Super`.
  Components that printed `⌘` read the formatter.
- Open in terminal: `platform/win32-terminal.ts` opens a Windows Terminal tab
  (`wt.exe -d <cwd> powershell -NoExit -Command <command>`, with `;` escaped)
  or a PowerShell console. Windows has no tmux, so each request is its own
  window, and the one terminal choice is named for what it opens.
- Open in editor: GUI editors start their program from the install roots
  (`%LOCALAPPDATA%\Programs`, Program Files): `Code.exe`, `Cursor.exe`,
  `Zed.exe`, `subl.exe`, and the newest `JetBrains\<IDE> <version>\bin\<ide>64.exe`.
  The PATH `code.cmd` is not used, because Node cannot start a `.cmd`.
- Screenshots: `desktopCapturer` takes the display under the pointer. Windows
  gives an app no region picker to wait on.
- "This computer" in the Open project dialog and the cloud sign-in row.
- Port scanning (§5.14): `browser/target-scanner.ts` reads `netstat -ano` for
  `tcp` and `tcpv6` at the same time. A listener is the row whose foreign
  address is `0.0.0.0:0` or `[::]:0`, because the state column is translated.
  No `tasklist` call: the scanner never used the process name. A Windows offer
  has no project, because Windows gives no cheap read of another process's
  working directory. A scan on the machine found six HTML ports. The scanner
  answers when the pane asks, through a 4 s cache, so there is no idle poll to
  keep quiet.

### 13.4 Not proven on Windows

- The manual pass in §7.3 item 9: a Claude and a Codex session from the
  Windows desktop app, the summon shortcut over another app, the tray, the
  overlay count, Open in terminal and editor, a screenshot, a second launch,
  and pairing the Mac host. It waits for a time when the machine is free.
- `quitAndInstall` from a real update feed: it needs a published newer
  `latest.yml`. The installer itself was run (13.5).
- `actor-name.ts` and the label changes were checked by tests, not on screen.
  The `AutomationsPage` "New automation" hint now reads its binding.
- The `solus` command on macOS and Linux (see 13.5).
- Windows code signing (§10 decision 5).

### 13.5 The `solus` command

Shipped as VS Code ships `code` on Windows. An earlier version wrote a
launcher at runtime and had Install and Remove in Settings, after T3 Code; it
was replaced because the installer can do the same with no code in the app.

- **Launcher.** `packaging/windows/bin/solus.cmd` is a fixed file. The
  installer puts it in `<install>in` (`build.win.extraFiles`). It runs
  `"%~dp0..Solus.exe" "%~dp0..esourcesapp.asardistmaincli.js" %*` with
  `ELECTRON_RUN_AS_NODE=1` and `SOLUS_DESKTOP_CLI=1`, so it moves and updates
  with the app. The CLI is bundled as `dist/main/cli.js`
  (`electron.vite.config.ts`). Its data folder is the CLI's default,
  `~.solus`, the same as the app's, or `SOLUS_DATA_DIR` when the terminal
  sets one.
- **PATH.** `packaging/windows/installer.nsh` (`build.nsis.include`) runs
  `resourcespath-entry.ps1`: install adds `<install>in` to the user PATH,
  and uninstall removes it, except during an update, which uninstalls the old
  version first. The script reads the value as written, changes only that
  entry, writes it back with the same kind, and tells Explorer. It is not
  done in NSIS, because NSIS string functions cut a long PATH at 1024
  characters, and `[Environment]::SetEnvironmentVariable` rewrites the PATH
  as a plain string, so `%VAR%` entries stop expanding. `install.ps1` had
  that bug, and now follows the same rule.
- **Commands.** The desktop's `solus` runs `pair` and `connect`
  (`apps/cli/src/lib/desktop-commands.ts`). `setup`, `start`, `service`,
  `update`, `status`, and `logs` manage a standalone server, so they explain
  that and point to the install script.
- **Order on the PATH.** A standalone install's `~.localinsolus.cmd`
  comes first, because the installer appends its folder. A terminal then runs
  the standalone `solus`; the app's is still reachable by its full path.
- **The fuse.** `RunAsNode` is on in the Windows build only. On macOS any
  script could then borrow the Microphone, Screen Recording, and keychain
  grants given to Solus, so the fuse stays off there. Linux waits for the
  AppImage case: the image must mount itself before its CLI can run. Measured
  start of the paths on the Windows machine: Node 74 ms,
  `ELECTRON_RUN_AS_NODE` 78 ms, an Electron app that exits at once 93 ms, and
  one that waits for `ready` 122 ms.
- **Proof on the machine.** With the user PATH backed up:
  - A silent install (`/S`) added `%LOCALAPPDATA%Programssolusin` once,
    at the end, and kept the value's kind (`REG_SZ` there) and the other four
    entries. The app did not start.
  - From a PATH read from the registry, as a new terminal has it, `where solus`
    found the standalone launcher first and the app's second. The app's
    `solus --version` printed the version, `solus setup` was refused with
    exit 1, and `solus pair` read the data folder it was given.
  - A silent uninstall removed the app folder and left the PATH identical to
    the backup.
  - An install and then a second run with `--updated`, as the updater does,
    left the entry on the PATH once.

### 13.6 WSL distros (step 4)

Built as §5.13 describes, and checked without WSL so far:

- The distro list reads the default, the state, and the version by position,
  so a translated header, a translated state of several words ("Wird
  ausgeführt"), and UTF-16 output all parse.
- The forward was run with its real bridge script against a local server, in
  place of a distro: an HTTP request through the loopback port reached the
  server, and closing the forward stopped the process that holds the distro.
- `hostsAddWsl` refuses a distro that WSL does not list, installs with the
  host's own version, and saves the host as `<distro> (WSL)`.
- The clients preselect the default distro; the desktop saves the forwarded
  host, and another client is told only the Windows host reaches it.

Then on a real Ubuntu 26.04 distro (WSL 2, systemd on by default), from an
isolated test server on the Windows host:

- The add took about ten seconds: the check found no Solus, `install.sh`
  installed 0.37.0 (the host's own version, not the latest), `solus setup`
  started the user service with linger on, and the session and the forward
  followed. `/health` through the loopback port answered with the distro's
  installation.
- One `wsl.exe -d Ubuntu --exec sleep infinity` holds the distro while the
  forward is open, and it ends with the server.
- After a server restart the forward reopened on the same loopback port.
- Solus's own onboarding installed Claude Code in the distro
  (`setupInstallAgentCli`), as on any Linux host.

Found and fixed on the way:

- A distro reports the computer's name, so the progress read "Installing Solus
  on sidhu". The add now passes `<distro> (WSL)` as the machine's label, and
  every step names it.
- "Add a WSL distro" lived only in the Run-on picker, which shows only once a
  remote is connected: a Windows user with one host could not reach it. It is
  now also beside "Add machine over SSH" in the host directory and in a
  Windows host's forwarded machines, and in the palette, each shown only for
  a Windows host.

The Linux server release serves no web client, so the distro is driven from
the Windows host's client, as a saved host. Still to run: a Claude Code
session in a repository in the distro, and its diff.
