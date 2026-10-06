# Native devices — architecture decisions and vocabulary

Status: accepted 2026-10-02 (plans/016-device-preview-parity.md, D1–D3).
Partly implemented. The execution record in plan 016 §10 states what is done,
what has only unit evidence, and what is not started.

`docs/plans/devices.md` is the earlier proposal. Where the two differ, this
file is the implemented decision.

## Vocabulary

| Term | Meaning |
| --- | --- |
| Solus host (`serverId`) | The Solus server a client is connected to. Never an SSH device host. |
| Device host (`deviceHostId`) | `local`, or an SSH device host configured on one Solus host. |
| Device (`deviceId`) | A simulator UDID, an emulator serial, or an AVD name while it is stopped. Unique only inside its device host. |
| Preview (`devicePreviewId`) | One session showing one device. A device can have previews in several sessions. |
| Control lease | The right to change a device through Solus. One holder at a time. |
| Device hub | `expo-device-hub`, the pinned helper that streams screens. |
| Agent tools | `agent-device`, the pinned CLI agents drive devices with. |
| Bridge | The Solus loopback proxy between an agent's CLI and the agent-device daemon. |

## D1 — A separate devices domain

Devices are a feature domain beside the browser, not a browser target.

- Server: `packages/server/src/devices/`. `DeviceManager` is the only owner of
  inventory, helper status, previews, control and revision. `SessionRuntime`
  and `BrowserRegistry` own none of it.
- Contracts: `packages/contracts/src/device-types.ts`.
- Handlers: `transport/handlers/device-handlers.ts`.
- Client: `contexts/devices/devices.store.svelte.ts` and
  `components/devices/`. The `devices` route opens beside the conversation.
- The browser contract keeps its reserved `{ kind: 'device' }` target for wire
  compatibility. `browserOpen` refuses it and names the Devices pane.

## D2 — Clients reach the hub through a signed pass-through proxy

Changed 2026-10-05. The first implementation relayed video: the host demuxed
one hub stream per device and fanned packets out over the Socket.IO
connection, and input went as typed RPC mapped on the host. That relay
needed keyframe-group replay, per-client congestion control, a screen
generation on every input and its own frame channel, and each difference
from T3 Code's client caused bugs T3 Code did not have. Solus now does what
T3 Code does (`apps/server/src/device/DeviceHubProxy.ts`): each client speaks
the hub protocols itself, through a proxy that passes bytes through.

- A client asks `deviceStreamUrl` for one device. The host answers with a
  short-lived signed path, `/api/device-hub/<token>`, naming the device host,
  the device and the client. Guests get no URL (D3).
- The proxy (`device-hub-proxy.ts`) serves only that device's stream routes:
  `helper/<device>/stream.avcc` and `stream.mjpeg` over HTTP, and the iOS
  `helper/ws` and Android `ws` sockets. Anything else is refused, so the hub's
  exec and action routes stay unreachable. The token is checked when a
  request or socket opens.
- Hub to client, bytes pass unchanged. Client to hub, the proxy drops input
  unless that client holds the control lease when the message arrives; a
  keyframe request and the iOS hardware-keyboard setting always pass, because
  a viewer needs them.
- The client (`client-core/src/devices/device-hub-stream.ts`) demuxes iOS AVCC
  and MJPEG and Android SEMU itself, and maps each touch against the newest
  screen the helper reported. A screen change ends a held touch.
- Each viewer opens its own hub stream. The hub never receives Solus
  credentials, and clients never receive the hub origin or its tokens.
- The route exists on the tunnel listener too, so remote clients use it
  unchanged. A client's proxied sockets close when its Solus connection
  expires.

**Not done:** releasing a touch held by a client whose proxied socket drops
mid-gesture. The helper decides what happens then, as in T3 Code.

## D3 — Admission

- Setup (`deviceConfigure`, `deviceHost*`, `deviceToolUpdate`) is host-admin.
- Viewing, input and actions are host-wide. `deviceOpen` and `deviceClose`
  also need editor access to the named session.
- A guest admitted through a session share gets no device state, video or
  input: the handlers refuse guests, and `device.stateChanged` and
  `device.surfaceRequested` are not delivered to guests.
- The stream is the whole simulator screen. Opening it in one session does not
  make it private; the pane shows other sessions that use the device.

## Control (S01)

`device-control.ts` holds one lease per device. Watching never takes control.
A mutation is allowed only for the current holder; commands do not name a
lease. A person's first touch or action takes a free device, or one another
person holds. The lease generation only tells a client which lease is its own.

A person taking control from an agent pauses agent device actions and gets
control at once. The agent stays paused until someone selects Resume agent.
Releasing, expiry and disconnect never resume an agent or grant it control.

Agents reach the daemon only through the bridge (`device-agent-bridge.ts`).
The CLI config written for an agent holds the bridge URL and a per-binding
bridge token. The bridge pins the daemon session, refuses commands aimed at
another device, and takes the agent's lease before every mutating command.
Unknown commands count as mutations. This routes Solus operations; it does
not sandbox an agent that has a shell.

**Not done:** arbitration across two Solus hosts that reach the same simulator
over SSH. Each Solus host arbitrates only its own clients and agents.

## Helpers

- The hub and the agent daemon run as supervised child processes on loopback,
  never as in-process imports. A crash restarts with doubling backoff.
- Pinned installs live in `<data dir>/devices/tools/<package>/<version>` with
  a sentinel written after npm exits 0. Inspection never installs. A failed
  update never falls back to another version.
- Only PIDs Solus started are signalled. A hub left by a crashed Solus process
  is stopped only when its recorded PID still runs our entry path.
- Turning device support off stops helpers and clears previews; simulators
  keep running. Turning agent access off stops the daemon and revokes bridge
  bindings; manual previews keep working.

## SSH device hosts

A Node program goes to the SSH host on stdin (`ssh-device-script.ts`), so no
path or argument becomes shell text. SSH runs with `BatchMode=yes` and the
user's normal host-key checks. Test connection is read-only. Hub and daemon
ports are forwarded to this machine's loopback by `ssh -N -L` processes whose
PIDs Solus captured. An alias that resolves to this machine is skipped.
Changing a host closes its previews, links and tunnels; the simulator keeps
running.

## Agent tools

`device_list`, `device_open`, `device_screenshot` and `device_close` are
provider-neutral tools in the `devices` group. Every call rechecks that device
support and agent access are on. `device_open` returns the absolute path of
the bound `agent-device` launcher and its flags, so a running session needs no
restart and no PATH change. `device_screenshot` returns the PNG as an image
result to Claude (MCP image block) and Codex (`inputImage` data URL), and
stores it as a host asset.

## Source and licences

Protocol handling, actions, toolchain, local and SSH host logic and the agent
guidance are adapted from T3 Code at `pingdotgg/t3code@43bd667` (MIT). Each
adapted file names its source. The 3D device view ports T3's procedural body,
motion, framing and input (`components/devices/lib/phone-viewer/`, from
`pingdotgg/t3code@77823bd102`), with three.js 0.180.0. No T3 or Apple 3D model
assets are included: T3's `.glb` files are converted from Apple's AR assets and
are not under T3's licence, so Solus draws only the body built in code.
`expo-device-hub` (MIT) vendors serve-sim and serve-emu (Apache-2.0); they are
installed on the host at runtime, not bundled with Solus.
