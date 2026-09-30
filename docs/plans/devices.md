# Devices — agents build, run, and prove iOS apps on simulators

Status: proposed, 2026-09-25. Not implemented. §13 lists the open decisions.

## 1. Why

A user who builds an iOS app with Solus must leave Solus to see the result. The
agent can edit Swift or React Native code, but it cannot build the app, run it,
look at it, tap it, read its crash, or prove to a reviewer that a flow works.
The user does these steps by hand in Xcode and the Simulator app, and then
types what they saw back into the prompt.

We want one loop inside Solus:

1. The agent builds the app for a simulator.
2. The agent installs and launches it, then drives it.
3. The agent reads logs and crashes, and fixes the code.
4. The agent records the flow and files the recording on the task or pull
   request.
5. The user watches and taps the same simulator from desktop, web, or phone.

T3 Code shipped a Device panel for steps 2 and 5 (pingdotgg/t3code #10677 and
follow-ups, most by Julius Marminge). This plan takes what works there, fixes
what it lacks (§3), and fits it to the Solus host model.

## 2. What the code does today

**Solus.** There is no device support. The nearest domain is the browser:

- `packages/server/src/browser/browser-registry.ts` owns pages. A
  `BrowserSurfaceDriver` (`surface-driver.ts`) hides the host that paints them.
- `browser-frame-channel.ts` sends JPEG frames to only the clients that watch a
  page, as Socket.IO binary data on the existing socket
  (`transports/websocket.ts`). `StreamedSurface.svelte` paints the frames, and
  `lib/streamed-input.ts` sends input back.
- `browser-tools.ts` defines the `browser_*` agent tools. Claude gets them
  through the in-process SDK MCP server (`claude-tool-adapter.ts`). Codex gets
  them as app-server dynamic tools (`codex-tool-adapter.ts`). Both are selected
  on every run (`execution/session-runtime.ts` `selectAgentTools`), so a new tool group
  needs no session restart.
- `browser-evidence.ts` and `browser-recorder.ts` file screenshots and
  recordings on tasks and pull requests. `recording-retention.ts` deletes
  unfiled recordings.
- `server/uplink/connector.ts` resolves a pinned `cloudflared` from
  `dataDir()/bin`. That is the pattern for a pinned external tool.

**T3 Code** (studied at `main`, 2026-09-25):

- The server owns devices. Two pinned MIT npm tools are installed under the T3
  home only after the user consents:
  - `expo-device-hub` streams the simulator screen and takes input.
  - `agent-device` (Callstack) drives the device.
- The hub binds loopback. An authenticated HTTP proxy with a list of allowed
  paths is the only way in. The hub has an unauthenticated shell-exec route,
  so the proxy must never expose it.
- Agents get four tools (`device_list`, `device_open`, `device_screenshot`,
  `device_close`) and the `agent-device` CLI on `PATH`. The CLI comes through
  a shim that pins `--session` and `--config` for each device.
- The user gets a Tools drawer (appearance, text size, accessibility, location,
  permissions, test push). It runs typed `device.action` RPCs.
- A `DeviceHost` interface has `local` and `ssh` hosts.

## 3. What T3 Code lacks

These gaps are the reason this plan is more than a port. The evidence is from
T3 Code source, docs, and issues on 2026-09-25.

| Gap in T3 Code | Evidence | Solus answer |
|---|---|---|
| No build step | `docs/user/devices.md`: "Arrange app builds, installation, and connectivity to development servers such as Metro separately." | `device_build` (§7.3) |
| Install exists only as a CLI hint; the user cannot see what is installed | `device.action` has `launchApp`/`terminateApp`, no install | Typed install; the pane shows the installed build (§7.3) |
| Metro is unreachable from a remote device host | Same doc: a remote simulator "cannot reach Metro through your environment's localhost" | No separate device host: the Solus host that owns the worktree owns the simulator (§5.1) |
| No isolation between agents; two threads share one simulator | Contract comment: "the same device may be open in several threads" | One lease per simulator; a clone per worktree (§5.3) |
| No limit on booted simulators; no orphan cleanup; sessions live only in memory | No cap code; `close` defaults to no shutdown; no persistence in `DeviceService.ts` | Persistent leases, a boot cap, and a sweep (§5.4) |
| Logs and crashes are not in the product | No log or crash code in `apps/server/src/device` | Log capture and crash cards (§7.4) |
| No recording as evidence | The device toolkit has no record tool | Recordings filed like browser recordings (§7.5) |
| No test runs or visual diffs | agent-device `test`/`replay`/`diff screenshot` are unused | `device_test` in phase 3 (§11) |
| Agents cannot use the Tools drawer controls | `device.action` is RPC-only | One typed action surface for user and agent (§7.2) |
| Granting agent access needs a session restart | `docs/user/devices.md`: "Restart an existing agent session after granting access" | Tools are selected each run; the shim is always on `PATH` and checks access when it runs (§6) |
| The shim ran the wrong binary and damaged live sessions | Issue #12926, open fix #13093 | The shim runs the host's Node by absolute path, never `process.execPath` (§6) |
| Linux works only as far as "watch and tap": the Mac is reached over SSH, and builds, app delivery, and Metro are left to the user | `DeviceHostSummary.kind` is `local \| ssh`; #10856: "EAS, app delivery, and Metro forwarding are outside this milestone" | A device host link with worktree sync, remote build, and port forwarding; managed Macs so the user needs none (§5.5) |
| No physical iOS devices | Physical Android is an open PR (#12765); nothing for iOS | Phase 4 (§11) |
| No signing or TestFlight | Nothing in the repo | Out of scope (§12) |

## 4. Vocabulary

Use these words in code, UI, and docs. Do not coin synonyms.

- **device** — one iOS Simulator (later: an Android Emulator or a physical
  device) on a host. The UI says "device"; code says `device`.
- **device pane** — the pane that shows one device's screen. Not "viewer",
  "device panel", or "simulator window".
- **device lease** — the right of one session to drive one device. A device
  has at most one lease. The user can always watch and tap a leased device.
- **device clone** — a simulator that Solus created from a base device for one
  worktree. It lives in the Solus device set.
- **Solus device set** — the simulator set that Solus owns
  (`dataDir()/devices/set`). Solus creates, boots, shuts down, and deletes only
  devices in this set. The user's own simulators stay outside it, and Solus
  never deletes them.
- **device tools** — the pinned `expo-device-hub` and `agent-device`
  packages.
- **device action** — one typed control, such as `setAppearance` or
  `install`. The user and the agent use the same list.
- **build** — one `device_build` run. It produces an app bundle for a
  simulator.
- **device host** — a Mac Solus host that lends its devices and its Xcode to
  another machine. It can be the user's own Mac (a personal host) or a Mac
  that Solus Cloud runs (a managed device host).
- **device host link** — the connection from a machine to a device host. It
  carries device RPCs, frames, worktree sync, and forwarded ports.

## 5. Model

### 5.1 The host owns its devices

A device belongs to a Solus host, as a page belongs to the host's browser.
When the machine that runs the session is a Mac, it owns its own devices. The
worktree, the Xcode build, Metro, and the simulator are then on one machine,
so `localhost` works for all of them.

A Linux machine cannot run the iOS Simulator or `xcodebuild`. Both need macOS,
and Apple's license allows macOS only on Apple hardware, with at most two
macOS virtual machines per Mac. So a Linux machine borrows a Mac through a
**device host link** (§5.5). The session and its agent stay on Linux. The
build and the simulator run on the Mac.

A host reports `deviceSupport` in its capabilities:

```ts
type DeviceSupport =
  | { state: 'unsupported'; reason: 'not-macos' | 'no-xcode' | 'command-line-tools-only' }
  | { state: 'available'; xcodeVersion: string; runtimes: SimulatorRuntime[] }
```

`command-line-tools-only` covers T3 issue #11713: `xcode-select` points at the
Command Line Tools, not at Xcode.

### 5.2 Device state

```ts
interface DeviceSummary {
  deviceId: string            // simctl UDID
  name: string                // "iPhone 17 Pro"
  runtime: string             // "iOS 26.5"
  state: 'shutdown' | 'booting' | 'booted' | 'shutting-down'
  ownership: 'user' | 'solus' // outside or inside the Solus device set
  cloneOf: string | null      // base deviceId for a device clone
  lease: DeviceLease | null
  installedBuild: InstalledBuild | null
}

interface DeviceLease {
  sessionId: string
  worktreePath: string
  acquiredAt: number
  lastUsedAt: number
}
```

The server stores leases and clones in SQLite (a new `device_leases` table in
`db/migrations.ts`). A restart does not lose them. `DeviceSummary` is rebuilt
from `xcrun simctl list -j` and the table, and the table is the authority for
ownership.

### 5.3 Leases and clones

- `device_open` without a device id gives the session the **device clone for
  its worktree**. If none exists, Solus clones the project's base device
  (default: the newest iPhone on the newest runtime) into the Solus device set.
  Two agents in two worktrees never share app data, keychain, or an installed
  build.
- `device_open` with a user device id leases that device. If another session
  holds the lease, the tool fails with the holder's session title and a hint to
  use a clone. It does not wait silently.
- The user's pane never needs a lease. User taps and agent actions can mix;
  the transcript shows the agent's actions so the user can see why the screen
  moved.
- A lease ends when the session closes, is archived, or its worktree is
  removed. It also ends after 30 minutes with no device tool use.

### 5.4 Limits and cleanup

- **Boot cap.** At most `devices.maxBooted` Solus devices boot at once
  (default 3). A simulator uses about 1–2 GB. When the cap is reached,
  `device_open` shuts down the least recently used device that has no lease.
  If every booted device has a lease, the tool fails and names the holders.
- **Sweep.** At startup and every 10 minutes, the server:
  - shuts down Solus devices that are booted with no lease for 30 minutes;
  - deletes device clones whose worktree no longer exists;
  - deletes table rows for devices that `simctl` no longer lists.
- The sweep never touches devices with `ownership: 'user'`.

### 5.5 Device hosts for Linux machines

A machine without macOS links to one device host. The agent sees the same
tools as on a Mac. The link decides where each step runs:

| Step | Runs on | How |
|---|---|---|
| Agent, worktree, edits | Linux machine | Unchanged |
| Worktree sync | Linux → Mac | Before a build, the machine sends the worktree's changes since the last sync (tracked and untracked, not ignored files) as a tar stream over the link. The device host keeps one mirror per (machine, worktree) under `dataDir()/devices/mirrors`. |
| Native build | Mac | `device_build` runs `xcodebuild` or `expo run:ios` in the mirror, with DerivedData kept per mirror. Structured errors come back with paths rewritten to the machine's worktree. |
| Expo JS changes | Linux | Metro runs next to the code. The link forwards the Metro port to the device host's loopback, so the simulator reaches `localhost:<port>`. No native build is needed while the Expo fingerprint is unchanged (§7.3). |
| App backend (API server) | Linux | The same port forward. `device_open { forwardPorts: [3000] }` |
| Simulator, stream, input | Mac | The device host publishes frames to the machine, and the machine relays them to its clients on the existing frame channel. Clients never connect to the device host directly. |
| Logs, crashes, recordings | Mac → Linux | Returned over the link and filed by the machine. |

The link is a Solus connection, not SSH:

- The machine dials the device host with the same client code it uses for any
  host (`client-core` transport).
- A personal device host is paired once, from Settings → Tools → Devices
  → Device host.
- A managed device host is reached with a grant from Solus Cloud, like other
  managed hosts.
- The device host serves only the `device*` methods, the frame stream, and a
  port-forward stream to a linked machine. It never runs that machine's agents
  or shell commands. The build command comes from a fixed list: `xcodebuild`
  with the detected scheme, or `expo run:ios`.

A managed device host (Solus Cloud) is a Mac that Solus operates:

- Each tenant gets a macOS virtual machine (Tart on Apple silicon; two per Mac
  under Apple's license). The image has Xcode and simulator runtimes
  installed.
- The directory assigns the VM to a machine for the session's life, and a
  warm pool keeps start time low.
- When the lease ends, the VM is reset to its base image. No tenant data stays
  on it.
- Bare-metal Mac minis give the base capacity. AWS EC2 Mac is the overflow,
  since it has a 24-hour minimum allocation per host.

## 6. Tools install and agent access

- **Install.** `DeviceToolsInstaller` follows `BrowserRuntimeInstaller`
  (`status()`, `install()`). It installs pinned `expo-device-hub` and
  `agent-device` with `npm install --prefix dataDir()/tools/<name>/<version>`,
  then writes a `.install-complete` marker. Pinned versions live in one file.
  A version change installs the new version next to the old one; the sweep
  deletes the old one.
- **Consent.** Settings → Tools → Devices has two switches:
  - **Devices** installs the tools and starts the hub.
  - **Agent device access** adds the device tool group.

  Opening the device pane for the first time shows the same two steps inline.
- **Hub process.** The hub is a supervised child that listens only on
  loopback, with restart backoff. Only the server talks to it. No hub route is
  exposed to a client, so its exec route is never reachable.
- **CLI shim.** `dataDir()/bin/agent-device` is always on `PATH` for both
  providers (`cli-env.ts` `getCliPath`; Claude's `claudeEnv` gets the same
  path).

  When the shim runs, it asks the server over the local control socket for the
  caller's lease, identified by `SOLUS_SESSION_ID`. Then it runs agent-device
  with the host's Node, found by absolute path, and adds these arguments:
  - `--session`
  - `--udid`
  - `--ios-simulator-device-set`

  If access is off or the session has no lease, the shim exits with a one-line
  reason. So granting access needs no restart, and the shim never starts an
  Electron binary (T3 #12926).
- **Prompt.** `runtime-instructions.ts` adds a short `SOLUS_DEVICE_TOOL_INSTRUCTIONS`
  block when the device group is selected. It points at the tools and forbids
  raw `simctl` in the Solus device set. `device_open` returns the detailed CLI
  guidance, as in T3, so sessions that never open a device pay no prompt cost.

## 7. Behavior

### 7.1 Stream and input

The server reads the hub's MJPEG stream for a device and publishes each JPEG
to the watching clients through a `DeviceFrameChannel`. It uses the same binary
socket path as `BrowserFrameChannel` and the same header shape
(`{ deviceId, seq }`, latest frame wins).

Reasons to use the socket, not an HTTP proxy as T3 does:

- The Uplink tunnel exposes only a short list of routes (`server/http.ts`). A
  proxied stream route would not work for a remote phone.
- The frames arrive on a socket the client has already authenticated. There is
  no second ticket.
- `StreamedSurface.svelte`, `frame-painter.ts`, and `streamed-input.ts`
  already paint frames and map input. The device pane reuses them.

A device nobody watches produces no frames: the server closes the hub stream
when the last watcher leaves. Input (touch, drag, keys, Home) goes through the
`deviceInput` RPC to the hub's input socket. H.264 with WebCodecs is a later
optimization (§11).

### 7.2 Device actions

One discriminated union in `packages/contracts/src/device-types.ts`, used by
the `deviceAction` RPC and by the `device_action` agent tool:

- `setAppearance`, `setTextSize`, `setAccessibility` (reduce motion, increase
  contrast, reduce transparency, bold text, VoiceOver)
- `setLocation`, `clearLocation`
- `setPermission` (grant, revoke, reset)
- `openUrl` (deep links and universal links)
- `launchApp`, `terminateApp`, `uninstallApp`, `resetAppData`, `resetKeychain`
- `sendPush` (payload JSON, via `simctl push`)
- `setStatusBar` (fixed time and full signal for clean screenshots)
- `rotate`

Every action returns the value it reads back from the device. The pane shows
that value, not the requested one. An action that the platform does not
support is left out of `deviceActions(deviceId)`, not shown and then failed.

### 7.3 Build and install

`device_build` removes the biggest manual step. Input:
`{ project?, scheme?, configuration? }`. Solus detects the project kind in the
session's cwd:

- **Xcode:** a `.xcworkspace` or `.xcodeproj`. Solus runs `xcodebuild -scheme
  <scheme> -destination 'id=<leased udid>' -derivedDataPath
  <worktree>/.solus/DerivedData build`. With several schemes and no `scheme`
  argument, the tool fails and lists them.
- **Expo / React Native:** `app.json` or `app.config.*` with an `ios/`
  directory, or with `expo` in `package.json`. Solus runs `npx expo run:ios
  --device <udid> --no-bundler`, and starts Metro as a watched process on a
  free port.

The result is structured:
`{ ok, appPath, bundleId, durationMs, errors: [{ file, line, message }] }`.
The errors come from the `.xcresult` bundle (`xcrun xcresulttool`), not from
parsing the log. The full log is stored and linked, never put inline. On
success Solus installs and launches the app, and `DeviceSummary.installedBuild`
records `{ bundleId, appPath, builtAt, gitSha }`.

For Expo projects, a native build is only needed when native inputs change.
Solus computes the Expo fingerprint (`expo/fingerprint`) and keeps the last dev
client per fingerprint under `dataDir()/devices/builds`. If the fingerprint
matches, `device_build` reinstalls the cached build and reloads Metro in
seconds. It does not run `xcodebuild`. T3 Code does the same in a repository
script (`scripts/mobile-native-client.ts ensure`), not in the product.

`device_install { appPath }` installs a bundle that the agent built another
way.

### 7.4 Logs and crashes

- When an app launches, the server starts `xcrun simctl spawn <udid> log
  stream` with a predicate on the bundle's process. Lines go to a ring buffer
  (last 2,000 lines, per device).
- `device_logs { since?, level?, grep? }` returns a bounded slice.
- The server watches `~/Library/Logs/DiagnosticReports` for `.ips` files that
  name the bundle and a leased device. A new crash adds a **crash card** to the
  session's transcript, with the exception type and the symbolicated top
  frames. The agent sees the crash in its next tool result without having to
  ask.

### 7.5 Screenshots and recordings

- `device_screenshot` returns a PNG to the agent. It applies `setStatusBar`
  first when the agent passes `clean: true`.
- `device_record_start` / `device_record_stop` use `agent-device record`
  (MP4). Recordings go into the same retention and filing path as browser
  recordings (`browser-evidence.ts`: `captureEvidence`, `stopAndFileRecording`).
  Rename the shared parts to `evidence/` when the second importer lands, as
  the renderer rules require. The 5-minute cap applies.
- The pane's capture control files a screenshot or recording on the task or
  pull request, the same as the browser capture control.

## 8. Agent tools

Group id `device`, in `solusToolbox.device`, gated by
`isSolusToolEnabled`. Both providers get the same group.

| Tool | Does |
|---|---|
| `device_status` | Host support, tools state, booted count and cap, the session's lease |
| `device_list` | Devices, their lease holders, and runtimes available for clones |
| `device_open` | Leases a device (default: the worktree clone), boots it, shows it in the user's device pane, and returns CLI guidance |
| `device_close` | Ends the lease; `shutdown: true` also powers it off |
| `device_build` | Builds, installs, and launches (§7.3) |
| `device_install` | Installs a given app bundle |
| `device_action` | One device action (§7.2) |
| `device_screenshot` | PNG of the screen |
| `device_logs` | A bounded log slice (§7.4) |
| `device_record_start`, `device_record_stop` | Recording evidence (§7.5) |

Taps, typing, scrolling, and accessibility snapshots stay in the
`agent-device` CLI (`snapshot -i`, `press @e3`, `fill`). Its snapshot model is
better than anything we would wrap, and it updates on its own releases.
`device_open` pins the CLI to the lease, so the agent never passes a UDID.

## 9. RPC and events

Add to `RPC_INVOKE_METHODS` (`rpc.ts`), with plane `execution` in
`rpc-planes.ts`, and typed in `host-api.ts`:

- Status and install: `deviceStatus`, `deviceToolsInstall`
- Devices: `deviceList`, `deviceOpen`, `deviceClose`, `deviceShutdown`,
  `deviceCreateClone`, `deviceDeleteClone`
- Control: `deviceAction`, `deviceActions`, `deviceInput`
- Frames: `deviceSubscribeFrames`, `deviceUnsubscribeFrames`
- Evidence: `deviceCaptureEvidence`, `deviceRecordingStart`,
  `deviceRecordingStop`
- Build: `deviceBuild`, `deviceBuildLog`

Topics in `host-events.ts`:

- `device.changed` — delta: one `DeviceSummary`.
- `device.removed` — delta.
- `device.buildProgress` — targeted to the session: phase and last line.
- `device.surfaceRequested` — an agent opened a device; clients that show the
  session open the pane, as `browser.surfaceRequested` does.

On reconnect, a client calls `deviceList` for a snapshot and then applies
deltas. Frames go only on the `device-frame` socket event (§7.1).

The server handler is `transport/handlers/device-handlers.ts`, registered in
`boot-server.ts` beside the browser handlers. The domain lives in
`packages/server/src/devices/`: `device-registry.ts`, `simctl.ts`,
`device-leases.ts`, `device-hub.ts`, `device-frame-channel.ts`,
`device-build.ts`, `device-logs.ts`, `device-tools.ts`,
`device-tools-installer.ts`.

## 10. UI (mobile, desktop, web)

All three clients use the same store,
`contexts/devices/devices.store.svelte.ts`. It is keyed by
`serverId:deviceId`, like the browser store.

- **Desktop and web.** There is a `device` route in `route-registry.ts`
  (placement `aside`, as for `browser`). `components/devices/`:
  - `DevicePane.svelte` — toolbar, stage, and actions drawer.
  - `DeviceStage.svelte` — uses `StreamedSurface`.
  - `DeviceActionsDrawer.svelte`
  - `DevicePicker.svelte`
  - `DeviceBuildCard.svelte`, `DeviceCrashCard.svelte`, `DeviceRecordingCard.svelte`
    — transcript cards.

  Keybinding: `opt+shift+d` opens or focuses the device pane. After a click
  on the stage, focus stays on the stage for typing into the app. `Esc`
  returns focus to the input bar.
- **Mobile.** A "Device" row in `MobilePlusMenu.svelte`, as for Browser. A
  session can hold leases on several devices at once (for example an iPhone
  and an iPad). When it holds one or more, a device button shows the count:
  above the composer when the session is idle, and beside the working timer
  during a turn. The button opens a full-screen sheet:
  - The header has Close, the device name, Home, and a menu. The menu switches
    between the session's devices and has Reload stream, App switcher, Rotate,
    the actions drawer, and Shut down.
  - The stage is `StreamedSurface`, with touch mapped to taps and drags.
  - The sheet stops its frame subscription when it is hidden or the app goes
    to the background. It shows "Reconnecting…" while the socket reconnects.

  T3 Code shipped this as #12531. The sheet must work over the Uplink tunnel,
  so a user away from their desk can test a build on the phone.
- **States.** Unsupported host (with the reason), tools not installed,
  installing, booting, streaming, reconnecting, lease held by another session,
  and boot cap reached. Each state has its own words and a next step.
- **Settings.** Settings → Tools → Devices: the two switches, installed tool
  versions, boot cap, base device per project, and "Delete all device clones".

## 11. Phases

Each phase ships on its own and is useful alone.

1. **Watch and drive.** Host support detection, tools install, hub supervision,
   frame channel, device pane on all three clients, `device_status`/`list`/
   `open`/`close`/`screenshot`, the CLI shim, persistent leases, boot cap, and
   sweep. User devices only; no clones yet.
2. **Build loop.** `device_build`, `device_install`, `device_action`, logs,
   crash cards, recordings, and evidence filing. Device clones per worktree.
3. **Verification.** `device_test`, which runs XCUITest (`xcodebuild test`,
   with results from `.xcresult`) or an agent-device `.ad` / Maestro flow.
   Screenshot baselines with `diff screenshot`. A device-size matrix
   (`device_open { profile: 'small' | 'large' | 'ipad' }`).
4. **Linux with the user's Mac.** The device host link (§5.5): pairing,
   device RPC and frame relay, worktree sync, remote build, and port
   forwarding. A Linux machine then has the full loop with the user's own Mac
   mini.
5. **Linux with no Mac.** Managed device hosts in Solus Cloud: the macOS VM
   image, the pool and scheduler, per-tenant reset, quotas, and billing. This
   is the same link as phase 4; only the Mac's owner changes.
6. **Reach.** Android Emulators (the hub and agent-device already support
   them). Android also runs on Linux machines directly, with no device host.
   Physical iOS devices through agent-device's CoreDevice support. H.264
   streaming with WebCodecs where a secure context allows it, with MJPEG as
   the fallback.

## 12. Not in scope

- Code signing, TestFlight, and App Store Connect. They need account secrets
  and are a separate product decision.
- Third-party device clouds (Appetize, BrowserStack, Limrun). They can run an
  app but not build it, and they need the user's vendor account. Reconsider
  if the managed device hosts cost too much to run.
- Instruments profiling UI. The agent can run `agent-device perf` through the
  CLI; Solus adds no UI for it.

## 13. Open decisions

1. **Stream transport.** The plan uses MJPEG frames on the existing socket
   (§7.1), because it works through the tunnel and reuses `StreamedSurface`.
   The cost is higher bandwidth than H.264. Accept?
2. **Clones by default.** The plan gives each worktree its own device clone
   (§5.3). This uses disk (about 1–3 GB per clone after an app install) but
   stops agents from colliding. Accept, or default to shared devices?
3. **Build ownership.** The plan makes Solus run `xcodebuild` / `expo run:ios`
   with structured errors (§7.3). The alternative is the T3 approach, where
   the agent runs the build itself. Accept?
4. **Android timing.** The plan puts Android in phase 6. Should it move to
   phase 1, as in T3? Android is the only mobile platform a Linux machine can
   run with no Mac.
5. **Managed Macs.** Phase 5 makes Solus Cloud operate Mac hardware. It is the
   only way to meet "a Linux user needs no Mac" for iOS. It has a real cost
   per Mac and needs a pricing decision. Commit to it, or stop at phase 4?
