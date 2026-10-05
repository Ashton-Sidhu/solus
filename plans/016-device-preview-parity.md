# Plan 016: Add native device previews at T3 parity and complete the Solus device workflow

> Status: IN PROGRESS (2026-10-03). Server domain, agent tools and the device pane are implemented with unit evidence; no runtime gate has passed. See §10. Follow the stages in order, including 1A and 6A–6D. Every T3 parity row, Solus product requirement and client gate must pass before marking it done.

## 1. Outcome and baseline

Users can build a native app with an agent, open an iOS Simulator or Android Emulator beside the conversation, interact with it, and watch the agent test it. They can select devices on the Solus host or on an SSH device host. Desktop, web, and mobile clients expose the same device state and product capability.

- Priority: P1. Effort: L, split into ten numbered stages and five required product stages. Risk: HIGH at native helper, transport, provider environment, and device access boundaries.
- Planned on: 2026-10-02.
- Solus baseline: `d1ae9bc436b8baba6caa0919a80b4cbc6fd783c2`, plus the existing uncommitted working tree. Do not discard, stash, or overwrite that work.
- T3 baseline: `pingdotgg/t3code` commit `43bd6677392b80cd12742f865c277c9939239543`.
- Required T3 tool versions at that commit: `expo-device-hub@0.12.0` and `agent-device@0.21.12`. These are the initial compatibility targets, not a statement that they are the latest releases.
- Dependency: current host connections, RPC admission, agent adapters, and pane routing. Reuse the implemented organization and actor model; this plan does not create a second organization or identity system.

**Parity means equivalent user and agent capability at this fixed T3 commit.** It does not require copying React components, Effect services, T3 branding, or its network protocol. New upstream features do not silently expand this plan. Any change to the baseline needs a new parity comparison.

Scope extension approved on 2026-10-02: add control ownership, Run on device, native annotations, native recording with task/review evidence, and saved test conditions. These are Solus product requirements beyond the reviewed T3 integration. They do not change the pinned T3 parity baseline.

Run on device will execute configured project build commands, install the resulting app, launch it and show the preview. It is a project workflow, not a general build scheduler. Signing, app-store distribution and cloud Mac provisioning remain outside this plan. Xcode and an installed runtime are required on the machine running an iOS simulator. A Linux Solus host can use an SSH Mac. The workflow must state where the build and Metro run and how the device reaches them; the viewing client does not need Xcode.

## 2. Source record

All T3 links below use the reviewed commit. Use implementation and tests when comments disagree: its device contracts still contain comments saying SSH is future work, but `SshDeviceHost.ts` and the shipped settings implement it.

| Ref | Source                                                                                                                                                                                                                                                                                                                                                                                                                           | Role                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| T1  | [Device internals](https://github.com/pingdotgg/t3code/blob/43bd6677392b80cd12742f865c277c9939239543/docs/internals/devices.md)                                                                                                                                                                                                                                                                                                  | Ownership, helpers, transport, agent access |
| T2  | [Device user guide](https://github.com/pingdotgg/t3code/blob/43bd6677392b80cd12742f865c277c9939239543/docs/user/devices.md)                                                                                                                                                                                                                                                                                                      | Product behavior and setup                  |
| T3  | [Device contracts](https://github.com/pingdotgg/t3code/blob/43bd6677392b80cd12742f865c277c9939239543/packages/contracts/src/device.ts)                                                                                                                                                                                                                                                                                           | State, settings, action and tool schemas    |
| T4  | [DeviceService](https://github.com/pingdotgg/t3code/blob/43bd6677392b80cd12742f865c277c9939239543/apps/server/src/device/DeviceService.ts)                                                                                                                                                                                                                                                                                       | Discovery, boot, thread bindings, revisions |
| T5  | [DeviceHost](https://github.com/pingdotgg/t3code/blob/43bd6677392b80cd12742f865c277c9939239543/apps/server/src/device/DeviceHost.ts), [LocalDeviceHost](https://github.com/pingdotgg/t3code/blob/43bd6677392b80cd12742f865c277c9939239543/apps/server/src/device/LocalDeviceHost.ts), [SshDeviceHost](https://github.com/pingdotgg/t3code/blob/43bd6677392b80cd12742f865c277c9939239543/apps/server/src/device/SshDeviceHost.ts) | Local and SSH execution                     |
| T6  | [DeviceToolchain](https://github.com/pingdotgg/t3code/blob/43bd6677392b80cd12742f865c277c9939239543/apps/server/src/device/DeviceToolchain.ts), [maintenance](https://github.com/pingdotgg/t3code/blob/43bd6677392b80cd12742f865c277c9939239543/apps/server/src/device/deviceToolMaintenance.ts)                                                                                                                                 | Pinned installs, inspection, updates        |
| T7  | [DeviceHubProxy](https://github.com/pingdotgg/t3code/blob/43bd6677392b80cd12742f865c277c9939239543/apps/server/src/device/DeviceHubProxy.ts)                                                                                                                                                                                                                                                                                     | Allowed routes and read/control admission   |
| T8  | [DeviceActions](https://github.com/pingdotgg/t3code/blob/43bd6677392b80cd12742f865c277c9939239543/apps/server/src/device/DeviceActions.ts)                                                                                                                                                                                                                                                                                       | Actual platform support and readback        |
| T9  | [Stream client](https://github.com/pingdotgg/t3code/blob/43bd6677392b80cd12742f865c277c9939239543/packages/client-runtime/src/device/stream.ts), [DeviceStreamView](https://github.com/pingdotgg/t3code/blob/43bd6677392b80cd12742f865c277c9939239543/apps/web/src/components/device/DeviceStreamView.tsx)                                                                                                                       | Video, input, decoder fallback, visibility  |
| T10 | [DeviceWorkspace](https://github.com/pingdotgg/t3code/blob/43bd6677392b80cd12742f865c277c9939239543/apps/web/src/components/device/DeviceWorkspace.tsx), [Tools panel](https://github.com/pingdotgg/t3code/blob/43bd6677392b80cd12742f865c277c9939239543/apps/web/src/components/device/DeviceToolsPanel.tsx)                                                                                                                    | Controls, screenshot, settings UI           |
| T11 | [Device tools](https://github.com/pingdotgg/t3code/blob/43bd6677392b80cd12742f865c277c9939239543/apps/server/src/mcp/toolkits/device/tools.ts), [CLI shim](https://github.com/pingdotgg/t3code/blob/43bd6677392b80cd12742f865c277c9939239543/apps/server/src/device/AgentDeviceShim.ts)                                                                                                                                          | Agent lifecycle and bound CLI               |
| T12 | [Mobile screen](https://github.com/pingdotgg/t3code/blob/43bd6677392b80cd12742f865c277c9939239543/apps/mobile/src/features/devices/DevicePreviewRouteScreen.tsx), [mobile stream](https://github.com/pingdotgg/t3code/blob/43bd6677392b80cd12742f865c277c9939239543/apps/mobile/src/features/devices/DeviceStreamWebView.tsx)                                                                                                    | Mobile access, input, reload and controls   |
| T13 | [Model manifest](https://github.com/pingdotgg/t3code/blob/43bd6677392b80cd12742f865c277c9939239543/apps/web/src/components/device/models/sources.json), [model catalog](https://github.com/pingdotgg/t3code/blob/43bd6677392b80cd12742f865c277c9939239543/apps/web/src/components/device/deviceModels.ts)                                                                                                                        | 3D model support and asset provenance       |

T3's root source license is MIT. Keep its copyright and license notice for any adapted source. Do not infer asset rights from that license: T13 explicitly says no open-source or redistribution license has been established for its Apple models. Use original procedural models or assets with documented rights. Preserve the interactive 3D functions. Exact Apple mesh reproduction is not a parity requirement. Verify dependency and vendored-helper notices before release.

## 3. Current Solus state and architecture decision

Read these files before coding:

| File                                                                     | Existing responsibility                           |
| ------------------------------------------------------------------------ | ------------------------------------------------- |
| `packages/contracts/src/browser-types.ts`                                | Browser targets, viewports and snapshot shapes    |
| `packages/server/src/browser/surface-driver.ts`                          | Browser-only host interface                       |
| `packages/server/src/browser/browser-registry.ts`                        | Browser lifetime, watch counts, agent activity    |
| `packages/server/src/browser/browser-frame-channel.ts`                   | Binary frames sent only to subscribed clients     |
| `packages/client-core/src/browser-frame-subscriber.ts`                   | Host-specific binary frame delivery               |
| `packages/workspace-ui/src/contexts/browser/browser.store.svelte.ts`     | Host-keyed cache, stale guards, subscriptions     |
| `packages/workspace-ui/src/components/browser/StreamedSurface.svelte`    | Visible-only JPEG painting and input              |
| `packages/workspace-ui/src/contexts/workspace/routing/route-registry.ts` | Typed routes and pane placement                   |
| `packages/workspace-ui/src/contexts/workspace/routing/location.ts`       | Two-pane model, base and overlay content          |
| `packages/server/src/admission/access-policy.ts`                         | Exhaustive method access classes                  |
| `packages/server/src/execution/agents/tools/agent-tool.ts`               | Neutral tools, configuration checks, result shape |
| `packages/server/src/execution/agents/tools/solus-toolbox.ts`            | Shared tool catalog                               |
| `packages/workspace-ui/src/components/connections/HostDetail.svelte`     | Host environment settings entry                   |

Current excerpts to check for drift:

```ts
// packages/contracts/src/browser-types.ts:323
export type BrowserTarget =
  | { kind: 'url'; url: string; worktreePath?: string; branch?: string; projectRoot?: string }
  | { kind: 'device'; deviceId: string; platform: 'ios' | 'android' }

// packages/server/src/browser/surface-driver.ts, BrowserSurfaceDriver
evaluate(expression: string): Promise<string>
openDevTools(onClosed: () => void): Promise<void>

// packages/server/src/execution/agents/tools/agent-tool.ts
export interface AgentToolResult {
  ok: boolean
  text: string
}
```

The reserved device target is not an implemented simulator adapter. The current driver assumes DOM evaluation, navigation, DevTools, console and network logs. The current frame channel assumes JPEG. These interfaces cannot receive native H.264 and accessibility actions unchanged.

**Proposed decision D1:** add a focused `devices` domain and `devices` pane route. Reuse pane chrome, host addressing, subscription patterns, focus helpers and asset storage. Keep one authoritative device manager. Do not put device lifetime in `SessionRuntime`, and do not maintain duplicate device records in BrowserStore. Use the four T3-style device tools; preserve the current browser tools.

This replaces the old comment's intent to put all native actions behind browser verbs. Record the decision in `docs/plans/native-devices.md` during implementation. Keep the reserved wire variant for compatibility during this work, but reject native targets in browser handlers with a clear instruction to use Devices. Do not create a fake page or silently launch Chromium for a native target. Do not remove the wire variant as an unrelated compatibility cleanup.

**Proposed decision D2:** carry device video as binary packets over the existing authenticated host connection. Translate the hub's protocols inside the host. Use typed RPC for input and settings. Do not give clients the hub's private URL or a general-purpose HTTP proxy. Prove this path in stage 0 before committing to its implementation. This preserves T3's capability while matching Solus's IPC/WebSocket architecture. A new external stream route is a plan revision if the existing transport cannot meet the proof; it is not an implicit fallback.

**Proposed decision D3:** device administration is host-admin. Viewing and manual control require existing host-wide authority, plus access to the session when an operation names one. Shared-session guests receive no host device access. The stream is the whole simulator screen; opening it in a session does not make it private to that session. Show when other sessions use the device. Only already-admitted users can receive state, screen bytes or input access. Keep actor attribution on commands and evidence. Do not change organization scope or existing member admission to implement Devices.

These are explicit design choices for review before source implementation. This document does not authorize a departure from the repository's product rules.

## 4. Full parity checklist

All rows are required. Each stage must add evidence to the last column. Until then every row is TODO. An unsupported platform action must match T8; it must not be presented as a successful no-op.

| ID  | Required behavior                                                                                                                                | T3 reference | Stage  | Evidence |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | ------ | -------- |
| P01 | Setup explains hub, platform dependencies and separate agent access; merely opening setup installs and starts nothing                            | T2, T6       | 1, 4   | PARTIAL — setup reads/installs nothing until enabled (device-manager.test "nothing starts before setup"); DeviceSetup + HostDevices UI. Runtime unverified. |
| P02 | Discover iOS/iPadOS simulators and Android AVDs; show device name, OS, host, boot state and missing-tool reason                                  | T3–T5        | 1      | PARTIAL — hub list + AVD merge + per-host reasons (device-manager.test, device-local-host.test probes). No real simulator on build Mac. |
| P03 | Boot stopped devices, attach externally booted simulators, show boot progress and disk/timeout failures; retry safely                            | T4           | 1      | PARTIAL — boot, external iOS attach, AVD→serial reconcile, typed boot failures (device-manager.test). Runtime unverified. |
| P04 | Multiple device tabs per session; add, rename, select, close; closed tabs stay closed after client reload                                        | T2, T10      | 4      | PARTIAL — tabs from host previews, add/close/rename/select; closed stays closed (device-pane.test). Visual check not run. |
| P05 | Live iOS and Android streams with taps, drag/swipe, scroll, text and keyboard control                                                            | T9           | 2, 4   | PARTIAL — host relay + typed input for both platforms (device-stream.test, device-protocol.test, device-streamed-input.test). No live device. |
| P06 | Home and app switcher; Android Back/Recents; iOS rotation; reload stream; separate close and power off                                           | T2, T12      | 4, 5   | PARTIAL — Home/Back/Recents/app switcher, iOS rotate, separate close vs power off. Stream reload = remount only. |
| P07 | Only visible surfaces decode; multiple authorized clients share the device; last watcher closes stream resources without shutting down device    | T1, T9       | 2      | PARTIAL — subscriber-only delivery, one upstream, last watcher stops upstream (device-stream.test). Hidden pane unsubscribes in DeviceStream. |
| P08 | H.264 configuration/keyframe handling and decode recovery; iOS MJPEG fallback; explicit Android unsupported-decoder state                        | T9           | 2      | PARTIAL — config/keyframe join, slow-client keyframe skip, iOS MJPEG fallback, explicit Android unsupported (device-stream.test, device-streamed-input.test). |
| P09 | Screenshot download for user and image result for agent; same device identity and orientation                                                    | T10, T11     | 4, 6   | PARTIAL — user download via asset URL; agent image result for Claude and Codex (claude/codex-tool-adapter tests, device-manager.test). |
| P10 | Foreground app details, light/dark mode, four text-size levels, accessibility element overlay                                                    | T3, T8, T10  | 5      | PARTIAL — appearance, text size, foreground app read-back (device-actions.test). Accessibility element overlay NOT DONE. |
| P11 | iOS reduce motion, increase contrast, reduce transparency, borders, VoiceOver, Liquid Glass clear/tinted and color filters                       | T8, T10      | 5      | PARTIAL — all listed iOS toggles, Liquid Glass, colour filters with read-back (device-actions.test). Runtime unverified. |
| P12 | Android reduce motion, network toggle and four orientation choices                                                                               | T8, T10      | 5      | PARTIAL — Android reduce motion, network, four orientations (device-actions.test). |
| P13 | Set/clear location; supported app permissions; open URL; launch/terminate app; iOS test push                                                     | T3, T8       | 5      | PARTIAL — location, permissions (partial-failure reporting), open URL, launch/terminate, iOS push via stdin (device-actions.test). Android clear location refused as unsupported. |
| P14 | Float preview over conversation; drag, resize, close and restore to pane; agent auto-show preference                                             | T2           | 4      | NOT DONE — no floating preview; pane only. Auto-show preference done. |
| P15 | Flat/3D view, live screen on model, input mapped to screen, reset view, supported tablet keyboard accessory                                      | T9, T13      | 7      | NOT DONE — no 3D. |
| P16 | Supported iOS folding device pose, hinge and stance controls; active panel follows visible display; Android fold/unfold changes emulator posture | T2, T9, T13  | 7      | NOT DONE — no folding-device controls. |
| P17 | `device_list`, `device_open`, `device_screenshot`, `device_close`; open returns exact bound agent-device command guidance                        | T11          | 6      | PARTIAL — four tools, bound CLI command returned on open (device-tools.test). |
| P18 | Agent setup for Claude and Codex, pinned CLI, remote endpoint binding, first-run readiness, revocation and restart guidance                      | T1, T11      | 6      | PARTIAL — same tools for Claude/Codex/subagents, pinned CLI, absolute bound command (no PATH or restart needed), revocation via bridge. First-run readiness unverified. |
| P19 | Device activity in conversation, user can open agent's device, agent and user act on the same device                                             | T2, T12      | 4, 6   | PARTIAL — agent opens reveal beside the same conversation; same device for agent and user. No dedicated activity card (tool cards only). |
| P20 | SSH host add/edit/remove, alias/identity/port, read-only connection test, forwarded hub/agent endpoints, retry and recovery                      | T2, T5       | 3      | PARTIAL — add/remove, alias/identity/port, read-only test, forwarded endpoints, retry (device-ssh-host.test). No real SSH Mac. |
| P21 | Device IDs scoped by host, skip SSH aliases resolving to local machine, stale host edits cannot reopen old sessions                              | T4, T5       | 3      | PARTIAL — ids scoped by host, self-alias skipped, host edits drop old previews (device-manager.test, device-ssh-host.test). |
| P22 | Required/installed/running tool versions, inspect without installing, pinned updates, per-host failure and retry; no silent old-version fallback | T6           | 1, 3   | PARTIAL — required/installed/running versions, inspect-only, pinned install, no fallback (device-toolchain.test). SSH update = restart. |
| P23 | Disable agent access without stopping manual previews; disable hub stops owned helpers but leaves devices running                                | T2, T5       | 1, 6   | PARTIAL — agent access off keeps previews; hub off stops helpers not devices (device-manager.test). |
| P24 | Desktop, web and mobile access, mobile keyboard and device selector, reconnect and host-offline state                                            | T2, T12      | 4, 8   | PARTIAL — same store/pane on desktop and web shells; touch text bridge. Mobile and reconnect unverified on real clients. |
| P25 | Authorized remote streaming and control; no hub shell-exec exposure, client localhost assumptions or exposed daemon credentials                  | T1, T7       | 0–3, 8 | PARTIAL — no hub URL, exec route or daemon token reaches clients; guests refused (access-policy test, handlers, event audience). Runtime unverified. |

## 5. Ownership, contracts and runtime rules

### Required Solus product additions

All five rows are required for completion, separately from T3 parity. Implement them in this order; 3D remains required but follows these workflow stages.

| ID | Product outcome | Stage | Evidence |
| --- | --- | --- | --- |
| S01 | One active controller per device; show owner; Take control pauses agent input; explicit release/resume; concurrent work can select a separate available simulator | 1A, 2, 3, 6 | PARTIAL — leases, generations, takeover waits for in-flight, explicit resume, guarded agent bridge (device-control.test, device-control-bridge.test). Cross-Solus-host SSH arbitration NOT DONE. |
| S02 | Run the selected branch/worktree: configured build → install → launch → preview; visible build identity and accurate outdated/unknown state | 6A | NOT DONE. |
| S03 | Freeze the displayed frame, select an accessibility element or draw a region, add a note and send the image plus device/build context to the agent | 6B | NOT DONE. |
| S04 | Record native interactions, file evidence on a task or PR, and compare before/after captures with immutable build/device details | 6C | NOT DONE. |
| S05 | Save named test conditions and run a saved flow sequentially across selected devices; report passed, failed, blocked, cancelled and not-tested results with evidence | 6D | NOT DONE. |

Additional source locations to read before implementation:

- `packages/server/src/project-config/project-config.ts`: `.solus/config.json` resolves Solus worktrees to shared project config. Load profiles there but build in the explicitly selected worktree.
- `packages/contracts/src/types.ts`, `ProjectConfig`: currently contains task settings, not native build settings. Add exact optional profile and condition types.
- `packages/server/src/browser/browser-evidence.ts`: asset and task/PR filing with actor attribution. Share only the filing operation needed by a second importer.
- `packages/server/src/browser/browser-recorder.ts`: host-owned lifecycle, bounded output and idempotent stop. Its Chromium encoder is not automatically suitable for native streams.
- `packages/workspace-ui/src/components/browser/lib/annotation-attachment.ts`: stable draft attachment and capture context. Native references are not DOM selectors.
- `docs/browser-recordings.md`: Record/Stop, limits, task/PR filing and retention behavior to preserve for native recordings.

### Identity and storage

- `serverId`: the Solus host connection. Never reuse this name for an SSH device host.
- `deviceHostId`: `local` or a configured SSH device host on that Solus host.
- `deviceId`: simulator UDID or Android device identity. An unbooted AVD name can become a running serial; reconcile it without opening a duplicate tab.
- `devicePreviewId`: stable binding of a Solus session to a device target.
- Every key includes `(serverId, deviceHostId, platform, deviceId)` as applicable. A session binding also names `sessionId`. Do not assume an ID is globally unique.
- Host settings own enabled state, agent access, onboarding and SSH host configs. Secret daemon credentials stay in host-owned restricted files. Do not sync private key contents, remote paths or daemon secrets into transcript records.
- The device manager owns inventory, helper status, active bindings and revision. Actual process and stream handles remain in memory and are never restored as live.
- Client view state owns tab order, custom names, selected tab, floating geometry, tools drawer and 3D pose. Persist through the workspace's existing view-state mechanism, keyed by host and session. Hidden conversation mounts retain this state.
- Closing a binding updates all clients of that session. A client reload must reconcile the server snapshot; cached state cannot recreate a closed binding. A host restart invalidates active handles. Saved presentation can offer Reopen, but must not silently boot a device or claim that a stream is still connected.

### Proposed contract surface

The manager also owns control leases, build/run status and recordings. A preview subscription is not a control lease. Many clients can watch; only the current controller can mutate the device through Solus. The actual device host must arbitrate cooperating Solus connections, including SSH aliases reaching the same simulator. Reuse proven upstream coordination or add a small device-host lease service; client-local locks are insufficient. Lease generations reject delayed commands.

Project config owns named run profiles and test conditions. Host settings own machine paths and credentials. A build receipt records source host, worktree, commit, dirty-source fingerprint, profile revision, artifact digest, app ID, device target and completion time. Unknown provenance stays unknown. Captures copy the available receipt and observed device/OS/orientation settings. Logs and build outputs stay on the execution host; retained evidence uses existing asset and task/PR ownership.

Create `packages/contracts/src/device-types.ts` with exact domain types and runtime validation. Keep metadata bounded. Use discriminated unions and optional unsupported/unread setting values. Do not copy T3's broad unknown records.

| Method group    | Proposed methods                                                                                                 | Admission                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Setup and hosts | `deviceConfigure`, `deviceHostSave`, `deviceHostRemove`, `deviceHostTest`, `deviceToolUpdate`, `deviceHostRetry` | host-admin                                              |
| Read state      | `deviceList`, `deviceDetail`, `deviceToolInspect`                                                                | host-wide; inspection has no install/start side effects |
| Lifetime        | `deviceOpen`, `deviceClose`, `deviceShutdown`                                                                    | host-wide; validate named session access                |
| Manual control  | `deviceInput`, `deviceAction`                                                                                    | host-wide; validate target and current capability       |
| Stream          | `deviceSubscribeFrames`, `deviceUnsubscribeFrames`                                                               | host-wide; bind subscription to authenticated client    |
| Evidence        | `deviceScreenshot`                                                                                               | host-wide; validate binding/session and asset ownership |

`device.stateChanged` carries a bounded revisioned snapshot/delta with an explicit recovery path. `device.surfaceRequested` names the session and preview to show. The event audience must enforce the same access as list/read. Neither event contains frame data or credentials. Agent activity uses the existing transcript event model, not a second independent history database.

Add typed product methods: `deviceControlAcquire/Release/Resume`, `deviceRunStart/Cancel/Get`, `deviceAnnotationCapture`, `deviceRecordingStart/Stop`, `deviceEvidenceAttach`, `deviceConditionsSave/Apply`, and `deviceCheckStart/Cancel/Get` (each slash-separated suffix is a separate method). Control requires current device/session authority and a controller generation. Run requires project execution authority and an explicit profile/worktree; installation needs a control lease. Saving profiles/conditions requires project settings authority. Capture/recording needs read authority; filing needs destination write authority and explicit external publishing intent. Replay and condition application need control. Use operation IDs to prevent duplicate builds, recordings and checks on retry.

Add neutral agent commands for run, recording start/stop, condition application and check start/status/cancel when those stages land. Both providers use the same implementations and current access checks. Keep status/cancel reachable during long operations. Send bounded summaries in state events; fetch logs and evidence separately.

Use a dedicated binary `device-frame` channel. Header fields must name the preview/target, stream generation, sequence, codec, packet kind, dimensions, panel, and timebase where required. Treat config, keyframe, delta and JPEG as different packet kinds. New subscribers need codec config and a decodable frame; they must never begin with an arbitrary H.264 delta. Limit packet and queue size. Do not base64 video into typed host events or transcript messages.

Input has typed pointer down/move/up/cancel, text, key, scroll and hardware-button operations. Map coordinates against the current screen/panel generation, not CSS device presets. Reject obsolete orientation/panel input. Coalesce motion, but never drop the final pointer-up/cancel event. Cancel held input on disconnect.

Gate all native mutations, including agent CLI actions, settings, installation and replay, through the control lease. A PATH shim alone cannot enforce this: the Solus bridge validates the generation before forwarding each mutation. Reads do not need exclusive control. This coordinates Solus operations; it does not sandbox arbitrary shell commands or external Xcode interaction.

An explicit host recording holds its own bounded stream subscription. Hidden clients stop decoding and rendering, but recording can continue without a visible client. Stop upstream frames when no viewers or recorder remain. Show recording state to all authorized viewers and apply duration/size limits after client disconnect.

### Helper lifetime and remote hosts

Run the hub as a supervised child, never as an in-process native import. CoreSimulator native failures must not crash Solus. Bind hub and agent daemon to loopback. Only the server's validated adapters reach them. No client-supplied upstream path, arbitrary origin, shell text or general exec operation is allowed.

One install/start job per tool and device host is shared by concurrent requests. Host config edits advance a generation: a late old job cannot replace the new host, publish old devices or reopen a removed preview. Capture owned process handles/PIDs and stop only those. Turning off helpers never powers off devices.

SSH uses noninteractive public-key authentication and normal host-key checks. Resolve aliases and identity paths on the Solus server. Do not disable host-key verification or open password prompts. Test SSH, Node 22+, npm, platform tools, and noninteractive PATH without installing anything. Install pinned tools only after feature setup permits it. Forward both endpoints to loopback on the Solus server. Close tunnels and owned helper processes on removal when reachable; report an unreachable host without claiming its remote process was stopped.

The SSH host editor can apply a configuration to selected Solus hosts, matching T3's selected-environment workflow. Run connection tests and saves independently on each selected host. Report partial results by host; retry failures without repeating successful writes. An SSH device host remains owned by each Solus host's settings, not a new global registry.

Streams and agent commands must name the same remote target. Explain that Metro on a different machine needs a reachable address or forwarding. Do not silently rewrite client `localhost` to the remote device host.

## 6. Files and scope

New files below are proposed, not existing APIs. Split feature modules by role; flag files above 600 lines and split before exceeding 1000 lines.

| Region                                                                                                  | Allowed work                                                                                                                         |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/contracts/src/device-types.ts`                                                                | New device state, input, action, stream and error contracts                                                                          |
| `packages/contracts/src/{rpc,host-api,host-events,agent-tools,types}.ts`                                | Method/topic declarations, tool names, host capability/config fields only                                                            |
| `packages/server/src/devices/`                                                                          | New manager, toolchain, local/SSH hosts, protocol adapters, frame channel, actions, agent bridge, screenshots and config persistence |
| `packages/server/src/transport/handlers/device-handlers.ts`                                             | New thin validated domain handlers                                                                                                   |
| `packages/server/src/{boot-server,transport/server,transport/websocket}.ts`                             | Composition, binary stream wiring and disconnect cleanup                                                                             |
| `packages/server/src/admission/access-policy.ts`, `packages/server/src/sharing/event-audience.ts`       | Device admission and state-event audience                                                                                            |
| `packages/server/src/host/settings.ts`                                                                  | Device host settings persistence and validation                                                                                      |
| `packages/server/src/execution/agents/`                                                                 | Shared tools, device environment preparation, Claude/Codex adapters and subagent tool lists; no generated provider edits             |
| `packages/client-core/src/`                                                                             | Device frame subscriber/decoder, host capability, host-connection and transport integration                                          |
| `apps/desktop/src/preload/index.ts` and existing desktop IPC wiring                                     | Typed control and binary stream bridge; no device business logic                                                                     |
| `packages/workspace-ui/src/contexts/devices/`                                                           | New host-keyed device store and view state                                                                                           |
| `packages/workspace-ui/src/components/devices/`                                                         | Setup, picker, pane, tabs, tools, stream, floating surface and 3D controls; logic under `lib/`                                       |
| `packages/workspace-ui/src/components/connections/`                                                     | Host device setup and SSH host management                                                                                            |
| `packages/workspace-ui/src/contexts/workspace/routing/`, layout, input, command palette and keybindings | Device route and entry points; limited integration only                                                                              |
| `packages/workspace-ui/src/components/conversation/`                                                    | Device activity/screenshot cards and reopen action                                                                                   |
| `packages/server/src/browser/`, browser contracts/UI                                                    | Explicit rejection of reserved native target; share a primitive only when the second importer justifies it                           |
| `resources/` and dependency manifests/lockfile                                                          | Licensed/original model assets, notices and justified 3D runtime dependency                                                          |
| `tests/unit/device-*.test.ts`, `tests/e2e/` device-only fixtures/specs                                  | New focused behavior tests and later approved UI verification                                                                        |
| `docs/plans/native-devices.md`, `docs/native-devices.md`, `docs/solus-tools.md`                         | Canonical terms, setup, ownership, capability and agent docs                                                                         |

Do not modify cloud deployment, managed VM provisioning, existing DB ownership, provider generated code, unrelated browser behavior or visual styles. Do not introduce React or Effect merely to copy T3. Do not broaden a shared API by cast.

Additional allowed scope for S01–S05: the project-config module and `ProjectConfig`; focused control, run, annotation, recording, evidence and check modules under the device feature; project settings UI; asset/attachment and task/PR filing integration; focused tests and docs. A narrow shared evidence-filing extraction is allowed. BrowserRegistry and SessionRuntime must not become owners of these operations.

## 7. Execution stages

### Stage 0 — Prove dependencies and transport; freeze decisions

1. Compare live code with section 3 and record pre-existing worktree changes.
2. Confirm D1–D3 in review. Inventory all call sites of the reserved device target within the mapped browser region before adding its explicit refusal.
3. Record the pinned packages' runtime engines, entry paths, helper binaries, platform requirements, and source/asset notices. Use T6 as the initial source.
4. Add small fixture protocols for iOS AVCC, iOS MJPEG and Android SEMU. Prove chunk boundaries, binary frame delivery, reconnect generation and input round trips through the Solus connection. Include desktop-local IPC and WebSocket paths, not only a browser directly connected to the hub.
5. Before adopting the decoder, prove WebCodecs support probing and the iOS fallback. The Android no-decoder state must be explicit. Prove a new client joins mid-stream with config/keyframe recovery.
6. After approved isolated runtime verification, record first frame, sustained frame delivery, input delay, CPU and memory for one stream and two clients. Compare against T3 with the same device, codec, resolution and network. Set regression budgets from these measurements before stage 2; no claimed numbers are supplied by this source-only plan.

**Verify:** `bun test tests/unit/device-protocol.test.ts tests/unit/device-transport.test.ts` → all pass with fixture bytes. The runtime proof is a separate gate, not replaced by these tests. If the transport needs an unsafe proxy or unbounded buffering, stop and revise D2. Use disposable data; do not start a simulator or server without the required interactive verification approval.

### Stage 1 — Add contracts, local hosts, setup and tool maintenance

Implement exact contracts and the manager in `packages/server/src/devices/`. Compose it in `boot-server.ts`; register handlers and admission together. Add capability discovery so older hosts produce a clear unavailable state.

Implement the three setup steps and independent hub/agent enabled states. Read-only inspection must not install, boot or start helpers. Install pinned versions atomically in host-owned version directories; handle failed/partial installs, shared concurrent requests and process crashes. Resolve all process working directories with `resolveHomePath`.

Probe Xcode rather than interpreting missing `simctl` as missing Xcode. Explain when the selected developer directory is Command Line Tools and full Xcode is present. Inspect installed runtimes. For Android, inspect standard SDK paths and `ANDROID_HOME`, plus emulator, adb and command-line tools. Report an empty AVD list separately from an unavailable platform.

Add boot/open/close/shutdown, externally booted iOS attachment, Android identity reconciliation, operation timeouts and typed failures. Read back actual state. Disabling the hub clears active bindings and stops helpers, not simulators. Expose required/installed/running versions and inspection errors independently. Do not fall back to an incompatible cached version after an update failure.

**Verify:** `bun test tests/unit/device-contracts.test.ts tests/unit/device-manager.test.ts tests/unit/device-toolchain.test.ts tests/unit/device-local-host.test.ts tests/unit/access-policy.test.ts tests/unit/server-module-boundaries.test.ts` → all pass. Tests use injected process runners and temporary directories, not the machine's simulators, installed tools or live Solus data.

### Stage 1A — Establish control ownership before adding input (S01)

Create `device-control.ts` in the server device feature and exact control-state contracts. A lease names the device, controlling person or agent/session, generation and expiry. Acquire is atomic. Two simultaneous requests cannot both succeed. Watching never takes control. Commands from old generations are refused, including queued settings, installs and replay steps.

Show the current controller and Take control in every device surface. Take control stops accepting agent mutations, cancels pending pointer gestures and waits for in-flight mutation to finish or be cancelled before granting manual input. A command that cannot be safely interrupted is shown as completing; do not claim the user has control early. Pause only device actions, not unrelated agent work. Release and Resume agent are separate explicit actions; do not silently resume on a typing timeout. Disconnect/expiry clears held input and releases control without granting another agent control automatically.

Return a clear busy/paused result to agents. Give waiting work a retry path. Offer another installed, available simulator for concurrent work rather than changing the active user's device. Missing spare devices remain visible as a capacity limit; automatic simulator creation is not required. A host restart invalidates leases. SSH connections and duplicate aliases must share arbitration on the machine that owns the device.

Stage 3 adds remote arbitration and stage 6 adds the guarded CLI bridge. Raw daemon credentials that permit bypassing the bridge must not reach agents. If the pinned tool cannot support guarded dispatch or safe takeover, resolve that in the bridge before claiming S01; an advisory UI label does not pass.

**Verify:** `bun test tests/unit/device-control.test.ts tests/unit/device-control-bridge.test.ts` → all pass for concurrent acquire, two agents, two clients, stale generation, delayed command, takeover during a gesture or long mutation, expiry, explicit resume and restart. Extend `device-multi-host.test.ts` in stage 3 for two Solus gateways reaching one simulator. No unrelated process or agent turn is stopped.

### Stage 2 — Add authenticated streaming and native input

Prerequisite: stage 1A. Validate its controller generation on every mutation. Last-watcher teardown below means no viewers **and no active recorder**; a recording is an explicit server-side subscriber. Device removal or feature disable finalizes recording and releases its subscription.

Implement the upstream iOS/Android protocol adapters, bounded frame channel and client decoder. Follow `BrowserFrameChannel`'s subscriber-only delivery pattern; do not copy its JPEG-only header. Start upstream resources on demand. Release them on last unsubscribe, client expiry, host disable and device removal.

Send video bytes without decoding/re-encoding on the host. Decode in the client. Support concurrent H.264 and iOS MJPEG clients without allowing the fallback of one client to break another. Share upstream resources where the format matches. Bound slow-client queues; on H.264 loss, discard until a decodable keyframe or restart/request a keyframe. Never drop arbitrary deltas and continue as if valid.

Probe the exact codec configuration with `VideoDecoder.isConfigSupported`. Close VideoFrames and release buffers, sockets and decoders. An inactive pane must have no decode loop or animation loop. A still frame can remain visible with a reconnecting label but cannot accept stale input.

Validate input packets and target generations before converting to the hub's protocol. Apply read/control admission to subscriptions and commands. Recheck access on reconnect and revoke subscriptions when authority is removed. Refuse hub exec, arbitrary path forwarding and cross-host device substitutions.

**Verify:** `bun test tests/unit/device-stream.test.ts tests/unit/device-frame-channel.test.ts tests/unit/device-input.test.ts tests/unit/device-access.test.ts tests/unit/device-transport.test.ts` → all pass, including arbitrary chunk splits, malformed/oversized packets, mid-stream joins, mixed clients, disconnect during touch, revocation and zero frames after the final viewer and recorder unsubscribe. Repeat the stage-0 measurements after the full path exists; results must meet the recorded budgets.

### Stage 3 — Add SSH device hosts

Implement `ssh-device-host.ts` against the same host contract as the local implementation. Add typed host configuration and connection-test results. Test connection has no install or launch side effect. Resolve SSH targets from the Solus server, skip local aliases and handle unavailable platform tools.

Use safe argument handling and validate options before constructing remote commands. Preserve the SSH trust model. Forward hub and agent endpoints, report the active host on every device and bind per-host generations to pending work. Allow retry for one failed host without restarting healthy hosts. Changes to a host must close its old bindings and tunnels. Preserve the simulator itself. Use captured helper identities for cleanup; never kill processes by pattern.

**Verify:** `bun test tests/unit/device-ssh-host.test.ts tests/unit/device-multi-host.test.ts tests/unit/device-toolchain.test.ts` → all pass. Cover duplicate device IDs across hosts, shell metacharacters in paths, self-alias detection, interrupted install, tunnel loss, offline removal, host edits during boot and one host failing while another remains usable.

### Stage 4 — Add setup, device tabs, floating preview and all client entry points

Create the devices store, route and feature components. Every durable external read goes through the store. Use SvelteMap/SvelteSet and mutate individual state fields. Reconcile a revisioned snapshot after reconnect; an old list response cannot restore removed hosts or closed previews.

Add the Devices action beside the conversation, a command-palette action and host settings entry under Connections → host → Environment → Devices. The setup flow has hub enablement, platform checks and optional agent access. Expose disable, re-enable, version inspection, update and retry through the same store.

Implement the tab picker, rename, close, add and power-off commands. A rename changes the view label, not the simulator's OS name. Show the device host, OS, live/booting/offline state and other active session use. Device selection uses installed device identities, not browser viewport presets.

Use the existing pane model for the full surface. Floating mode is a feature overlay with one stream subscription owner, not another workspace pane model. It supports drag, bounded resize, keyboard move/resize/reset, close and restore. Remember geometry without continuously storing pointer-move events. Switching between float and pane must not duplicate watchers or reset the simulator. Keep the active prompt focused after opening or closing when typing is next; focus inside the device only after an explicit interaction.

Add an auto-show preference. An agent open can reveal the matching session's device without switching an unrelated conversation or stealing input focus. On touch, provide an accessible device selector, reachable tools drawer and a text input bridge to the native keyboard. Full-screen presentation is allowed; it must retain restore/close and the same product controls. Light and dark mode and reduced motion apply to the full and floating surfaces.

Add user screenshot download through host asset delivery; remote clients never read a host file path. No screenshot bytes go into a general state broadcast.

**Verify:** `bun test tests/unit/device-store.test.ts tests/unit/device-view-state.test.ts tests/unit/device-pane.test.ts tests/unit/device-streamed-input.test.ts tests/unit/device-screenshot.test.ts tests/unit/routing-codec.test.ts tests/unit/routing-router.test.ts` → all pass. Cover close/reload, stale replies, host removal, multiple mounted conversations, float/restore, keyboard focus and touch coordinate mapping. Visual checks are required in stage 8; these unit checks do not prove layout.

### Stage 5 — Add the complete device Tools controls

Port T8's supported-action matrix into a small pure module shared by validators and the UI. Advertise runtime/helper capability as well as platform support. An unavailable helper returns a specific error; it must not leave a successful toggle or permanently spinning control.

Implement P10–P13. Use typed commands that invoke `simctl`, `adb` or the pinned helper through DeviceHost. Do not forward the hub's general shell-exec channel. Read settings after mutation and publish confirmed values; retain a separate pending state. Cancel or ignore detail reads for an old target. Poll foreground app and accessibility overlays only while needed and visible.

Match the four text-size levels and five iOS color-filter choices in T3. Distinguish unknown/unread from false. Grant/revoke/reset permissions only where the platform helper supports them; the catalog is not proof of support. iOS notification permissions use the pinned helper, not an invented simctl privacy verb. Android permission groups must handle permissions not declared by an app. Reflect partial failure rather than claiming all permissions changed.

Use a bounded JSON text field for arbitrary test-push payloads, validate it at the boundary and pass it as data on stdin. Define domain types for normalized push fields; do not introduce `Record<string, unknown>` or a renamed broad alias. Plain push text becomes an alert body. Launch, terminate and open URL address the selected device and app explicitly. iOS rotate belongs to input control; do not assume T8's unsupported iOS orientation settings action works.

**Verify:** `bun test tests/unit/device-actions.test.ts tests/unit/device-capabilities.test.ts tests/unit/device-detail.test.ts` → all pass. Each supported platform action must have command/argument and readback assertions; unsupported actions must fail before executing a process. Include invalid coordinates, injection strings, invalid push JSON, missing helpers, app changes mid-read and stale mutation results.

### Stage 6 — Add agent parity for Claude, Codex and delegated sessions

Add four provider-neutral tools to `solus-toolbox.ts` and the declared tool catalog: `device_list`, `device_open`, `device_screenshot`, `device_close`. Keep normal tool approval semantics explicit. Execution must recheck feature and agent access, not only hide a catalog entry when the provider starts.

Open resolves a unique target, boots if requested, creates a session binding, requests the surface and returns the exact pinned `agent-device` invocation. It must include the host-specific config and a session bound to that device. Return detailed CLI guidance only on open. Do not place a long manual in every agent prompt. A Linux Solus host with an SSH Mac still needs the local CLI shim.

Prepare the CLI environment before provider spawn. Preserve existing Git and provider-seat environment variables. Codex app-server reuse must include the device environment revision, so it does not retain a removed config forever. Claude's environment must receive the same shim. Cover headless sessions, automations and authorized subagents, not only the foreground conversation. Tell existing sessions when a restart is needed after enabling access; do not kill an active turn merely to inject PATH. Turning access off revokes the bridge and future calls while leaving manual viewing available.

The current AgentToolResult is text-only. Add a narrowly typed optional image content result and implement it in both neutral adapters so screenshot parity does not depend on an agent interpreting a local file path. Keep the existing text contract compatible. Bound image size and store the screenshot through the existing asset service for the user-facing card. Do not paste base64 into transcript prose. Do not change generated Codex protocol files by hand.

Add activity and screenshot cards with device name, host, action, result and reopen control. Closing a preview does not imply shutdown; an explicit shutdown must account for all sessions using the device. A tool may not name another session to gain access. Local CLI config files are restricted to the host user, excluded from logs and removed/revoked when no longer valid.

**Verify:** `bun test tests/unit/device-tools.test.ts tests/unit/device-agent-environment.test.ts tests/unit/device-agent-images.test.ts tests/unit/agent-toolbox.test.ts tests/unit/claude-tool-adapter.test.ts tests/unit/codex-tool-adapter.test.ts` → all pass. Cover feature off, revoked access, ambiguous device, SSH target, both provider environment paths, reused Codex process, subagent catalogs, structured PNG results and open/close activity. The bound CLI is a routing aid; do not claim it sandboxes an agent that already has shell access on the host.

### Stage 6A — Run the selected branch on a device (S02)

Add project run profiles and `device-run.ts`. Each profile names platform, app identifier, command executable/argument list, relative working directory, output artifact rule and optional launch/Metro configuration. Validate profiles through the existing project-config path. Shared configuration never changes the selected execution worktree to the repository root. Execution commands are reviewed configuration, not arbitrary shell strings accepted by the device-input API.

Add Run on device in the device pane, project settings and command palette. The first run offers profile setup; later runs remember the profile and device choice. The shared operation is preflight → build → validate artifact → acquire control → install → launch → show preview. Keep a valid prior preview if the build fails. Report each stage, bounded logs, cancellation and an actionable failure. Cancellation stops only processes owned by this run; a duplicate request attaches to the same operation. Never retry a build or install merely because the client lost the reply.

Preflight checks toolchain, selected checkout, target platform/architecture, app ID, artifact path and device reachability. A source host and device host can differ: record the build host explicitly, transfer only the validated output over an authenticated host/SSH path, and check its digest before install. A Linux host cannot locally build an iOS app. Require an explicit reachable Mac checkout/build profile or report setup needed; never silently sync source or build another branch. Explain the required reachable Metro address/forwarding. No signing, distribution or automatic cloud Mac provisioning is added.

Store an immutable build receipt and show branch/commit, app and last successful install. Fingerprint relevant source and profile state at start and finish; a mid-build change produces an outdated or uncertain receipt, never a false current label. Reuse existing checkout change signals; do not add continuous repository-wide hashing. After source changes, mark the running app as Built from an earlier version. Externally installed apps show Unknown build. For hot reload, distinguish installed native build from the current development bundle and show verification as stale when relevant source changes.

Expose the same run/status/cancel commands to both agents. Complete stage 6A before annotation/recording metadata depends on it. Validate this on disposable fixture projects; the Solus repository build remains prohibited by AGENTS.md.

**Verify:** `bun test tests/unit/device-run-profile.test.ts tests/unit/device-run.test.ts tests/unit/device-build-receipt.test.ts` → all pass. Cover worktree selection, failure at each stage, wrong artifact/app/architecture, dirty edits during build, source-to-device host mismatch, remote digest validation, cancellation, reconnect deduplication and stale/unknown/hot-reload labels. Stage 8 proves real iOS and Android runs.

### Stage 6B — Point at a problem and send it to the agent (S03)

Add `device-annotation.ts` and native annotation UI. Freeze the displayed screen into an immutable capture; this freezes the preview, not the simulator process. Annotation mode sends no taps or gestures to the app. Support element selection from an accessibility snapshot, rectangle/freehand marks, a text note, undo/remove, cancel and Return to live. Both pointer and keyboard/touch users must be able to use the flow.

Match accessibility data to the capture's device, panel, orientation and generation. The image and tree are not necessarily atomic: if matching cannot be established, label the element context unavailable and allow region annotation. Never attach a live element reference to an older image as if they were the same state. Store selected label, role, identifier and bounds as historical context; agents must inspect again before acting on an old reference.

Prepare one draft attachment containing the original screenshot, marks, note, timestamp, device model, OS, orientation, host, app and available build receipt. Reuse stable attachment/update behavior from browser annotations. Sending is an explicit composer action, so the user can edit the prompt. Clear the draft only after delivery succeeds; reconnect/retry must not duplicate it. Keep mark coordinates in capture pixels, independent of screen zoom or 3D pose. Restore focus to the active input when the next step is writing.

**Verify:** `bun test tests/unit/device-annotation.test.ts tests/unit/device-annotation-attachment.test.ts` → all pass for mismatched tree/frame, missing accessibility data, rotated/3D capture mapping, undo/cancel, draft replacement and send retry. Assert no native input is emitted in annotation mode and metadata retains the captured build identity after a later install.

### Stage 6C — Record bugs and retain before/after evidence (S04)

Add `device-recording.ts` and `device-evidence.ts`. Start/Stop is available in every client, the palette and both agent providers. Record the native screen on the host, including the SSH device case; do not record the user's client window. Input markers come from accepted device actions and must not alter the native app. Reuse the browser product's five-minute/50 MB limits and retention rules. Limit updates to bounded status events.

Prove the pinned native capture/encoding path for iOS and Android in isolation. Prefer its native recorder or compatible encoded stream; do not assume the browser Chromium encoder accepts AVCC packets. Return a playable MP4 with orientation changes handled deliberately. Unsupported encoding must produce a clear setup/error state and leave this requirement incomplete. Explicit recording may keep a host stream active while the pane is hidden; it must not keep client decoding or 3D rendering active.

Stop is idempotent. Show Recording, Saving and Saved/Failed consistently on all clients. Limits, device shutdown and feature disable finalize what can be saved and state why capture ended. A disconnect must not create an unlimited orphan recording. Store the asset once. Attach to the prompt or requested task/PR through existing evidence filing, with destination access checks. An external PR upload requires the user's or agent request's publishing intent. Upload failure preserves the local recording and offers retry; it must not create duplicate comments after an uncertain reply.

Every capture carries device/OS/settings, observed app identity, build receipt and timestamp. Allow users to pair Before and After recordings or screenshots on a task, then view them together with clear labels. Pairing is a small link between existing evidence items, not a second artifact store. Different device, settings or unknown build identity must be visible. Do not claim synchronized playback or automatic visual regression detection. Sent/filed assets are retained; unused recordings follow existing expiry.

**Verify:** `bun test tests/unit/device-recorder.test.ts tests/unit/device-evidence.test.ts tests/unit/device-evidence-comparison.test.ts` → all pass for hidden-pane recording, limits, two-client Stop, shutdown, interruption, immutable metadata, retention, partial upload and filing retry. Extend both tool-adapter tests for the new recording tools. Stage 8 verifies video playback and before/after review on all clients.

### Stage 6D — Save test conditions and check selected devices (S05)

Add exact project condition profiles and `device-check.ts`. A condition can name appearance, text size, orientation, network state, location and supported permissions for an explicit app. Let users save, edit, duplicate, apply and delete a named condition. Inspect capability before application. Show unsupported fields and partial failure; never silently omit a requested condition and mark the run passed.

Read the prior values and apply the profile under a control lease. Confirm actual readback. After a check, restore captured settings where supported and report any setting that could not be read/restored. Never reset or erase app data without an explicit fixture reset step. If a person takes control, stop scheduling actions and defer restoration until it can safely reacquire control; cleanup must not change settings under the user's hands.

Assess the pinned agent-device workflow format before adopting saved replay. Prefer supported semantic scripts with fresh accessibility references, named assertions and a defined fixture/start state. Save flows in the project and show their revision. If pinned `0.21.12` cannot run the required flow, specify and prove a dependency update or a small explicit assertion runner. Do not assume current upstream features exist in that pin or silently change its version. Free-form AI exploration may produce findings, but it is not a deterministic pass without assertions.

The user selects a saved flow, condition profiles and installed devices. Run one case at a time by default. Show pending/running and terminal passed, failed, blocked, cancelled or not-tested results. A pass requires the intended build, confirmed conditions, completed assertions and evidence. Record device/runtime, build identity, condition/flow revision, executed steps, failed assertion and screenshot/video links for each case. A stopped run keeps completed results; remaining cases are cancelled/not tested, not passed. Retry selected cases without replacing the earlier result.

Present a compact comparison on the task: each device/condition, result and evidence. Support before/after review by selecting prior and current runs. Persist receipts with the existing task/asset ownership rules and keep one live runner on the host. Add start/status/cancel for both providers and all clients; test resources must have bounded lifetime. A general CI service, scheduled device farm and parallel matrix scheduler remain out of scope.

**Verify:** `bun test tests/unit/device-conditions.test.ts tests/unit/device-check.test.ts tests/unit/device-check-results.test.ts` → all pass for capability gaps, readback failure, restoration, takeover during cleanup, one-at-a-time execution, assertion failure, unknown build, stale flow refs, cancellation, reconnect and result preservation. Stage 8 runs the same fixture flow across an iPhone, iPad and Android device under at least two saved conditions.

### Stage 7 — Add 3D presentation and folding-device parity

Implement flat/3D switching with an on-demand renderer loaded only when needed. Use original procedural or licensed phone/tablet/folding models and record their provenance. Match the supported model categories in T13, including the tablet keyboard accessory. Unknown devices retain a correct flat view with an honest 3D-unavailable state. Do not pretend that every simulator has an exact model.

Paint the live screen on the model. Convert ray hits to the correct screen/panel coordinates; ignore hits on the case and inactive displays. Separate model rotation gestures from app gestures. Add Reset 3D view and keyboard-accessible controls. Draw on frame arrivals, camera changes and finite transitions only; stop rendering while hidden and release GPU resources on disposal.

For supported iOS folding devices, implement hinge, fold and stance controls, including supported book/open/laptop/tent poses. Synchronize device panel state, video source and input destination. Turning to the other display switches the actual target panel. For supported Android devices, fold/unfold changes the emulator posture. A decorative hinge animation alone does not pass P16. Capabilities come from the runtime and helpers, not just a model name.

Make the functions reachable on mobile as required by Solus's surface rule; T3's simpler mobile presentation does not justify omitting Solus controls. Use a flat fallback after WebGL loss and retain app state. Restore must not restart the simulator or leave an invisible render loop running.

**Verify:** `bun test tests/unit/device-model.test.ts tests/unit/device-model-input.test.ts tests/unit/device-fold.test.ts tests/unit/device-render-scheduler.test.ts` → all pass. Cover geometry transforms, panel changes during input, hinge limits, posture readback, texture disposal, zero hidden rendering and WebGL failure. Use recordings in stage 8 to prove moving-screen and input behavior.

### Stage 8 — Verify full client, connection and provider coverage

Run one approved integrated verification pass using disposable Solus data and purpose-built native test apps. Do not use personal simulator data as fixtures. Use at least one iPhone, one iPad and one Android AVD; add supported folding devices for P16. Use the pinned runtime/helper matrix recorded in stage 0.

| Dimension    | Required cases                                                                                                                |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Clients      | Electron desktop, desktop web, iOS mobile web, Android mobile web                                                             |
| Host paths   | Desktop-local, desktop-hosted remote, standalone remote, cloud tunnel, Linux Solus host → SSH Mac                             |
| Providers    | Claude and Codex; user view with agent access off; headless agent then client attach                                          |
| Transport    | Secure origin; iOS no-WebCodecs fallback; Android no-WebCodecs error; lost input connection while video remains               |
| State        | First setup, cached install, update failure, empty inventory, boot failure, helper crash, reconnect, revocation, host removal |
| Input        | Mouse, touch drag, mobile keyboard, hardware keys, rotated screen, 3D ray mapping, fold panel switch                          |
| Presentation | Light/dark, reduced motion, narrow and wide containers, float/restore, hidden tabs, app background/foreground                 |

Exercise a real build/install/open/tap/type/screenshot flow for both native platforms. Use a small SwiftUI iOS fixture and an Android fixture; a React Native or Expo development build can additionally prove Metro connectivity. Include a remote Metro address case. Do not infer native correctness from a responsive website shown in Chromium.

Use Run on device for that flow, including a non-default worktree and a code change that makes the installed build stale. Verify two agents contesting one simulator, user takeover and explicit resume, plus independent control on separate devices. Complete an annotation-to-prompt flow, file a native bug recording, capture its after-fix evidence and review the pair. Run one saved flow across the three fixture devices and two conditions, including an intentional failure and unsupported setting. Every client must show the same controller, build, recording and check state. Add these cases to `tests/e2e/devices.spec.ts`; actual mobile and native evidence is still required.

Run the targeted device Playwright specs only after approval. Browser emulation alone is not evidence for iOS Safari decoding or mobile text input: include actual mobile browser checks. Record which matrix cells pass, fail or remain unverified. Attach before/after screenshots and recordings to the implementation review. Include measured resource usage and input delay against stage-0 budgets.

**Verify:** after approval, `bunx playwright test tests/e2e/devices.spec.ts` → the device-only suite passes against the approved running fixture. Manual matrix rows require recorded evidence. A skipped native/client row leaves this stage incomplete; it is not counted as parity.

### Stage 9 — Document, package and close the parity record

Write `docs/native-devices.md` and the architecture decision. Include Xcode selection, runtimes, Android SDK paths, first-use runner preparation, Node/npm on SSH hosts, pinned versions, restart guidance, credential ownership, remote Metro, codec fallbacks, screenshots and every disable/close/shutdown distinction. Add the four tools to the agent docs and keep tool descriptions consistent.

Verify the shipped desktop and standalone layouts can launch the helper with a real Node runtime and can find the pinned CLI entry and notices. Do not run the repository build. The developer supplies packaged artifacts for the final gate. Test those artifacts against disposable data with explicit permission; a source test alone does not prove Electron packaging or installed-server paths.

Document S01–S05 as well: Take control/Resume, run profile setup and build provenance, frozen annotation behavior, native recording/retention, and saved conditions/replay/results. Document all product tools in addition to the four parity tools. Package proof must include recording support and any pinned replay dependency.

**Verify:** run the focused device unit suites and the applicable checks below. Every P and S row has a passing test/evidence reference, each runtime/package gate has a recorded result, and no unsupported state is described as complete. Update this plan's status and `plans/README.md` only then.

## 8. Commands and verification rules

These commands are verified from the repository manifests. They are future implementation gates; no test or typecheck run is claimed by this plan.

| Purpose                     | Command                                                                                                                                                                                                                                                                                        | Expected result                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Drift                       | `git diff --stat d1ae9bc436b8baba6caa0919a80b4cbc6fd783c2..HEAD -- packages/contracts/src packages/server/src/devices packages/server/src/browser packages/server/src/execution/agents packages/client-core/src packages/workspace-ui/src apps/desktop/src plans/016-device-preview-parity.md` | Read changed files and compare excerpts before edits                   |
| Uncommitted work            | `git status --short` and targeted `git diff -- <files being edited>`                                                                                                                                                                                                                           | Record and preserve existing edits; HEAD alone is not the baseline     |
| Contracts/client types      | `bun run check`                                                                                                                                                                                                                                                                                | Exit 0, or record unrelated existing errors separately; no new errors  |
| Server types                | `bun run --cwd packages/server check`                                                                                                                                                                                                                                                          | Same                                                                   |
| UI TypeScript               | `bun run --cwd packages/workspace-ui check`                                                                                                                                                                                                                                                    | Same; this tsc command is not proof that Svelte templates render       |
| Focused lint                | `bunx oxlint <changed TypeScript files>`                                                                                                                                                                                                                                                       | Exit 0; include the configured host-access, cwd and broad-record rules |
| Surface boundaries          | `bun run lint:surfaces`                                                                                                                                                                                                                                                                        | Exit 0                                                                 |
| Layout rules                | `bun run lint:layout`                                                                                                                                                                                                                                                                          | Exit 0                                                                 |
| Domain boundary             | `bun test tests/unit/server-module-boundaries.test.ts`                                                                                                                                                                                                                                         | All pass; no new Data→Execution dependency                             |
| Transport/access regression | `bun test tests/unit/access-policy.test.ts tests/unit/browser-frame-channel.test.ts tests/unit/browser-frame-subscriber.test.ts tests/unit/browser-registry.test.ts`                                                                                                                           | All pass; browser behavior preserved                                   |

The instructions mention `lint:hosts` and `lint:types`, but these scripts are not in the inspected package manifest. Do not report running them. The corresponding rules are configured in `.oxlintrc.json`; run the focused lint command above. Do not use `bun test` without a focused path or `bun run test`: the latter invokes the prohibited build. Never run `bun run build`, its aliases, or direct Vite builds.

New tests named in stages are to be created with the implementation. Use `tests/unit/browser-frame-channel.test.ts` for delivery intent and `tests/unit/browser-store.test.ts` for stale/reconnect cases. Prefer dependency injection for new tests; do not copy old module-mocking patterns that conflict with current lint rules. Every backend mutation must have focused behavior tests. Use deterministic receipts/events and fake process handles, not timeout sleeps.

## 9. Acceptance and stop conditions

All must hold before completion:

- [ ] P01–P25 have evidence, including Android, SSH, floating and 3D behavior.
- [ ] S01–S05 have evidence on all clients and both providers where applicable.
- [ ] The guarded agent bridge and manual input obey one controller generation, including SSH aliases and takeover of in-flight work.
- [ ] Run on device proves the selected worktree and artifact; stale or unknown builds are never labelled current.
- [ ] Native annotations retain the captured frame/context and cannot send app input.
- [ ] Native recordings survive hidden panes within limits, retain source metadata and support task/PR filing and before/after review.
- [ ] Saved conditions are confirmed and restored where possible; check results distinguish failures, unsupported cases and untested cases.
- [ ] D1–D3 are recorded as accepted implementation decisions.
- [ ] Every device method/topic is in contracts, admission, server, transports

  and client recovery paths; every new tool reaches both providers.
- [ ] The desktop-local frame path is proven, not assumed from remote streaming.
- [ ] Unauthorized/guest clients receive no device state, pixels or control.
- [ ] No general hub exec route, daemon token, host-local URL or secret appears

  in client state, routine logs or transcript text.
- [ ] Device close, shutdown, disable agent access, disable hub and SSH removal

  each have distinct tested effects and reverse paths where applicable.
- [ ] Hidden surfaces perform no video decoding or continuous GPU rendering.
- [ ] Both image-result adapters work; native snapshots are not text-only paths.
- [ ] Mobile input and decoding have actual-client evidence.
- [ ] Focused tests, checks and packaged-artifact gates have recorded results.
- [ ] Original/licensed 3D models and all required notices are included.
- [ ] Existing work remains intact; no unrelated refactor, commit, PR or deploy.

Stop the affected stage and report the exact issue if the pinned helper cannot provide a required capability, codec delivery exceeds the measured budgets, the native adapter needs general shell proxy access, asset rights cannot be documented, or an access-model change outside D3 is needed. Complete independent stages where possible, but do not remove a parity row to make the plan pass.

Reconcile code drift before editing. If a required file is now owned by another change, coordinate the boundary. Do not fix this by rewriting another person's work. Implementation can use an isolated worktree if needed, but the source baseline must include the required uncommitted dependencies deliberately.

## 10. Execution record

| Stage | Status | Evidence |
| --- | --- | --- |
| 0 Dependency and transport proof | DONE (iOS) | 2026-10-03, Xcode 26.6, iOS 26.5, disposable simulator, temporary data dir, real `DeviceManager`/`DeviceStreams` code. Hub ready 0.76 s (2.3 s on first install). Boot + capture attach 46 s (first boot). First H.264 frame 3.8 s after subscribe; codec `avc1.640033` (High 5.1). Input to next frame 50 ms. ~8 fps while swiping (H.264 sends only changed frames). 703 KB over ~20 s. Hub 8.4% CPU, 100 MB RSS; proof process 58 MB. Mid-stream joiner started config,key,delta. JPEG client got 71 frames alongside. Screenshot 1206×2622. Settings read back; appearance set to dark and confirmed. Zero frames after last unsubscribe; link closed. **Found and fixed:** the hub hides never-booted simulators, so discovery now adds `simctl list devices available`. **Not measured:** Android (no SDK), two real browser clients, WebCodecs decode cost, T3 side-by-side comparison. |
| 1 Contracts, local hosts and maintenance | DONE (unit) | `device-types.ts`, manager, toolchain, local host, probes, handlers, admission, planes, events. `device-manager`, `device-toolchain`, `device-local-host`, `access-policy`, `rpc-planes`, `server-module-boundaries` tests pass. |
| 1A Control ownership (S01) | PARTIAL | `device-control.ts`, `device-agent-bridge.ts`; `device-control.test.ts`, `device-control-bridge.test.ts` pass. Arbitration across two Solus hosts sharing an SSH Mac not built. |
| 2 Streams and input | DONE (unit) | `device-link.ts`, `device-streams.ts`, `device-frame-channel.ts`, websocket `device-frame`, client subscriber and WebCodecs/JPEG decoder. `device-stream`, `device-frame-subscriber`, `device-streamed-input` tests pass. Budgets unmeasured. |
| 3 SSH device hosts | DONE (unit) | `ssh-device-host.ts`, `ssh-device-script.ts`; `device-ssh-host.test.ts`, manager SSH cases pass. No real SSH host exercised. |
| 4 Device workspace and client entry points | PARTIAL | `devices` route, store, pane, stream, tools, setup, picker, Environment → Devices, palette (desktop and web), agent surface reveal. svelte-check: no errors in device files. Floating preview not built; no visual or mobile check run. |
| 5 Tools controls | DONE (unit) | `device-actions.ts` + shared support matrix in contracts; `device-actions.test.ts` (24 cases). Accessibility element overlay not built. |
| 6 Agent integration | PARTIAL | Four tools in the `devices` group for Claude, Codex and both subagent tools; bridge; image results in both adapters. `device-tools`, adapter tests pass. Dedicated conversation device card not built. |
| 6A Run on device (S02) | PARTIAL | Install half only, 2026-10-03: `device-builds.ts` (build records, APK kept as an asset, install and launch on simulators, emulators and connected devices), `device-physical.ts` (`devicectl` and `adb` discovery with a reason per device), `deviceInstall` RPC under the control lease, `device_install` agent tool, Builds view in the Devices pane, mobile **App builds** screen with Android "Install here". `device-builds.test.ts` passes. Not built: run profiles, Solus-run builds, build receipts and stale labels, SSH-host installs. No real phone exercised. |
| 6B Native annotations (S03) | NOT STARTED | — |
| 6C Recordings and evidence (S04) | NOT STARTED | — (`expo-device-hub` has `--android-recording-directory`; iOS path unexplored) |
| 6D Saved conditions and checks (S05) | NOT STARTED | — |
| 7 3D and folding devices | NOT STARTED | — |
| 8 Integrated coverage | NOT STARTED | Needs a Mac with Xcode, an Android SDK, real mobile clients and approval. |
| 9 Docs and packaged proof | PARTIAL | `docs/plans/native-devices.md` (D1–D3 accepted), `docs/native-devices.md`, `docs/solus-tools.md`. Packaged-artifact gate not run. |

Verification commands run on 2026-10-03: the focused `device-*` suites plus access-policy, rpc-planes, module-boundaries, browser frame/registry, routing, tool-adapter and toolbox tests (270 pass); `packages/server` tsc (no new errors against the pre-existing 149); contracts/client-core tsc (no device errors; unrelated errors in untracked notification files); `packages/workspace-ui` tsc and svelte-check (no errors in device files); oxlint on all device files (clean); `lint:surfaces` clean; `lint:layout` failures are in TaskPage and MarkdownImage only. `jev-tool.test.ts` has one failure unrelated to this change.

Maintenance owner: the devices feature. A helper-version update must rerun protocol, action, CLI, licensing and native smoke gates as one compatibility change. Review stream teardown, access revocation, host generations and pane visibility closely: these are the main sources of stale control and resource leaks. Keep T3 reference comparisons pinned so changes remain reviewable.
