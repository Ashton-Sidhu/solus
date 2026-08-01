# Solus Remote Server — Implementation Plan

Scope: (A) harden the server for remote exposure, (B) make the control plane truly multi-client,
(C) let the Electron app connect to remote servers, (D) ship a standalone installable server daemon
with a claim-based onboarding flow, (E) distribute the CLI via Homebrew, (F) the product layer:
attention model + push notifications.

Model: **single-user, device-based identity.** The server is the machine with the repos and agent
CLIs; every paired device is the same person. No accounts, no multi-tenancy.

Each task lists files, design, and acceptance criteria. `bun run build` must pass after every
workstream. Follow CLAUDE.md renderer rules (feature folders, stores for durable state, no
TabState spreading, `$derived` over `$effect`).

---

## Current state (verified, with file refs)

Already built — do not rebuild:

- **Transport-agnostic RPC core**: `SolusServer` (`src/main/server/server.ts`) — handler map,
  topic pub/sub, per-topic seq + replay ring buffer (`replayFrom` :100, `getSeqWatermark` :111),
  `HandlerCtx` carries `clientId`/`deviceId`/`deviceLabel` (:118).
- **HTTP server** (`src/main/server/http.ts`): binds `0.0.0.0` by default (:13), routes
  `/health`, `/endpoints`, `/pair`, `/upload`, `/auth/pair-token`, `/auth/revoke`; serves the
  built web client (SPA fallback, `serveStatic` :202). CORS is `*` (:130).
- **Boot orchestrator** (`src/main/server/index.ts`): `bootServer()` registers ~20 handler
  groups; skips window/file groups when `windowDeps`/`fileDeps` absent (:132, :145); port
  auto-increment (:194); `~/.solus/server.lock` single-instance lock (:39).
- **Auth** (`src/main/server/auth.ts`): server keys at `~/.solus/server-keys.json`; pair tokens
  (24-byte + 6-digit code, 5-min TTL, one-time); HMAC session tokens
  `<deviceId>.<issuedAt>.<labelB64>.<hmac>` with `timingSafeEqual` verify; `revokeDevice` (:138)
  — but revocations are **in-memory only** (:35) and **expiry is never enforced** (:116).
- **WS transport** (`src/main/transports/websocket.ts`): multi-client, bearer/`?token=` auth on
  upgrade, presence, 15s heartbeat, resume protocol (`handleResume` :217), frame-serialization
  dedup (:195).
- **Web client** (`client/`): reuses `src/renderer` verbatim via Vite aliases; `WsTransport`
  (`client/src/transport/ws-transport.ts`) rebuilds the `window.solus` surface from
  `RPC_INVOKE_METHODS`/`RPC_SEND_METHODS`; pairing UI (`ConnectFlow.svelte`), localStorage server
  registry, mobile layouts.
- **Headless flag**: `--headless` (`src/main/index.ts:29`) boots server-only; Electron IPC
  transport not attached (:823). `requireAuth` wired to `SOLUS_REQUIRE_AUTH === '1'` (:819) —
  **default off**.
- **Endpoint discovery** (`src/main/server/endpoints.ts`): loopback + LAN interfaces + Tailscale
  IP via `tailscale status --json` (:60).
- **Connections surface**: `src/main/server/handlers/connections-handlers.ts`
  (`connectionsGetServerInfo`, `connectionsListEndpoints`, `connectionsGeneratePairToken`,
  `connectionsListSessions`, `connectionsBootstrapDiscoveredServer`, `connectionsRevokeDevice`) + renderer
  `connections.store.svelte.ts` + `ConnectionsPanel.svelte` (pair link format
  `http://host:port/pair#token=…`, :35).
- **Multi-client session observation works**: control plane fans events to every tab with a
  matching `sessionId` (`control-plane.ts` `_findTabsBySession` :273); late joiners replay
  in-flight turn text + pending permission events (`bindRuntimeSession` :489/:517).
- **Sessions run without tabs** (automations, MCP `create_session`) — no UI client required.
- **Pending-permission behavior**: unanswered `canUseTool` promises park in
  `pendingPermissions` (`claude-permissions.ts:266`) and survive until a client binds — but
  nothing notifies anyone (no OS/native notifications exist anywhere in `src/main`).

Electron coupling in server-path code is exactly:

| API | Files |
|---|---|
| `net` | `google/oauth.ts`, `google/drive.ts`, `providers/github/auth.ts`, `model-downloader.ts` |
| `app.getPath` | `logger.ts`, `server/handlers/session-handlers.ts`, `google/oauth.ts`, `providers/github/token-store.ts` |
| `safeStorage` | `google/oauth.ts`, `providers/github/token-store.ts` |
| `shell.openExternal` | `google/oauth.ts` |
| `nativeTheme` | `server/handlers/theme-handlers.ts` |

---

## Workstream A — Server hardening

> Blocks everything: nothing ships publicly until exposure is safe.

### A1. Safe-by-default bind + auth coupling
- `src/main/index.ts` (Electron boot) and `src/main/server/index.ts` (`bootServer` opts).
- Default bind `127.0.0.1`. Add a persisted server setting `remoteAccess: boolean` (extend
  project-config/settings storage under `~/.solus/`); when enabled, bind `0.0.0.0` **and force
  `requireAuth = true`** — non-loopback + no-auth must be unrepresentable in code, not a config
  combination. Keep `SOLUS_PORT`; add `SOLUS_HOST` env override (loopback-only override allowed;
  remote override still forces auth).
- Surface the toggle in the Connections panel ("Allow remote connections") with copy explaining
  devices must pair.
- Acceptance: fresh boot listens on loopback only; enabling remote access flips bind + auth
  without restart (rebind or restart listener); WS upgrade without a valid token on a
  non-loopback bind is rejected 401 (add a unit test around `attachWebSocketTransport` opts and
  the bind/auth coupling logic).

### A2. Token expiry, refresh, persisted revocation
- `src/main/server/auth.ts`.
- Enforce `issuedAt` in `verifySessionToken`: reject tokens older than 30 days. Add a
  `authRefreshToken` RPC (or HTTP `POST /auth/refresh`) that exchanges a valid, non-revoked
  token for a fresh one; clients refresh when a token is >7 days old.
- Persist `_revokedDevices` to `~/.solus/revoked-devices.json` (load at boot, append on revoke).
- Client side: the shared `WsTransport` (all clients after C1) handles a 401/expired close code
  by attempting refresh, falling back to re-pair UI (local desktop windows re-mint via the C1
  bootstrap channel instead).
- Acceptance: unit tests — expired token rejected, refreshed token accepted, revoked device
  rejected across a simulated restart (re-read from disk).

### A3. HTTP surface tightening
- `src/main/server/http.ts`.
- CORS: replace `*` with reflecting the request `Origin` only for known-safe cases (the served
  web client is same-origin so needs nothing; keep `*` only on `/health` + `/pair` if the
  ConnectFlow requires cross-origin pairing — verify by reading `ConnectFlow.svelte` fetch
  usage). Rate-limit `/pair` and `/auth/pair-token` (in-memory token bucket, e.g. 10/min/IP).
  `/upload` requires a valid session token.
- Acceptance: unit tests for the rate limiter; manual: web client pairing still works from a
  different origin (dev server on :5174 → server on :3000).

### A4. Capabilities handshake
- New RPC `getServerCapabilities` in `src/shared/rpc.ts` + a small handler registered in
  `bootServer` (`src/main/server/index.ts`), returning
  `{ headless: boolean, desktopHandlers: boolean, agents: {claude: boolean, codex: boolean},
  dictation: boolean, platform: string, version: string, projectCount: number,
  agentAuth: {claude: boolean}, gitAuth: {github: boolean} }`.
  (Superset used later by D7 setup checklist.)
- Renderer: store it per-connection (extend `connections.store.svelte.ts` or the workspace
  context bootstrap); gate desktop-only affordances (open-in-editor/terminal, screenshot, design
  mode, native dialogs) on `desktopHandlers`. Grep call sites of those `window.solus` methods to
  find the buttons to hide/disable.
- Acceptance: web client against a `--headless` server shows no desktop-only buttons and no
  console errors from missing handlers.

---

## Workstream B — Multi-client control plane

### B1. Device-scoped tabs ("watches")
- `src/main/control-plane.ts`.
- Add `deviceId` to `TabRegistryEntry`. Tab-registering RPC handlers
  (`src/main/server/handlers/session-handlers.ts`) already receive `HandlerCtx.deviceId` — thread
  it into `registerTab`/`bindRuntimeSession`.
- Do this **after C1**: desktop windows are ordinary WS clients (shared "This Mac" deviceId,
  one socket each), so no special-casing of `clientId: 'electron'` remains — desktop and remote
  clients go through one uniform path. Because a device can hold several connections, **watches
  are scoped per-connection (`clientId`) with the `deviceId` attached**: closing the pill must
  not GC the editor's watches; revoking a device closes all of its connections.
- Session-scoped events keep fanning to **all** tabs on a session (that is the feature); what
  becomes device-scoped is tab lifecycle: tab create/close/status bookkeeping must not leak
  across devices, and `_findTabsBySession` fan-out stays as-is. On WS connection close
  (`presence` topic already fires), garbage-collect that **connection's** tab registrations
  after a grace period (e.g. 5 min — long enough to survive reconnect/resume); other
  connections of the same device are untouched.
- Acceptance: two clients (Electron + web) watch the same session and both stream events; closing
  a tab on one device does not disturb the other; a dropped connection eventually clears only its
  own tab entries — closing the pill window leaves the editor's watches intact (unit-test the GC
  logic with injected clock).

> Descoped: durable pending state (formerly B2). Live session status, pending
> permission/question prompts, and queues are in-memory only — a server restart loses them
> (transcripts survive via the agent CLIs' own session logs). Accepted for now; revisit if
> unattended daemon restarts (`brew upgrade`, reboots) prove painful in practice.

### B3. Headless Google OAuth
- `src/main/google/oauth.ts` (`runOAuthFlow` :106 — currently loopback server +
  `shell.openExternal`).
- Replace with: register the redirect URI as `http://<server-host>:<port>/oauth/google/callback`
  on the existing HTTP server (`http.ts` route); the RPC that starts the flow returns the consent
  URL to the **client**, which opens it in the client's browser (`window.open` on web,
  `shell.openExternal` on desktop Electron). Callback lands on the server, which completes the
  exchange and broadcasts a `connections-changed`-style event.
- Keep the current desktop flow as a fallback when `windowDeps` exist and the client is local, or
  just use the new flow everywhere (preferred — one path).
- Acceptance: complete a Google connect from the web client against a `--headless` server.

---

## Workstream C — Electron app as remote client

### C1. WS-first: the desktop renderer becomes a WebSocket client
- **Decision: no partial IPC/WS split.** The entire RPC surface rides WS for every client,
  including the Electron renderer's own windows; IPC shrinks to a native-shell bootstrap. One
  wire protocol, one resume/seq behavior, one code path to test. (A split would leave two
  load-bearing transports with divergent semantics — IPC has no seq/resume/per-client identity.)
- Move `WsTransport` (+ `server-registry`, `shouldAcceptSequencedEvent`) from
  `client/src/transport/` to a shared client core (`src/client-core/`) imported by both the web
  client and the Electron renderer — do not fork it.
- Preload (`src/preload/index.ts`) shrinks to the native-shell residue:
  1. `getLocalConnection()` — one IPC channel returning `{ port, token }`; main mints the app's
     own windows a device token directly (no pairing flow for local windows) and reports the
     bound port;
  2. `getPathForFile` (needs `webUtils` — physically impossible over WS);
  3. quote-selection / quote-context window-level events;
  4. any window-control/platform queries that are genuinely preload-bound today.
  The ~180-method RPC surface and the `solus:event` fan-out are removed from preload (deleted in
  C3).
- Renderer boot: always construct a `WsTransport` — `ws://127.0.0.1:<port>?token=…` for
  "This Mac", `wss://…` for remotes; server switching is a URL change, not a transport change.
  Add an explicit "connecting" boot state (needed for the remote case anyway). **Both windows
  (pill, editor) share ONE device identity**: main mints a single local device token
  ("This Mac", one stable deviceId); each window opens its own WS connection with it. The
  transport already distinguishes per-socket `clientId` from `deviceId` — connections are the
  unit of delivery/liveness, the device is the unit of identity/trust. Presence and the
  Connections panel must aggregate by deviceId (one "This Mac" row, never two).
- Accepted tradeoff: WS pays `JSON.stringify` where IPC used structured clone on large payloads
  (big diffs/file reads). The web client already lives with this; payload paging is a follow-up
  only if profiling shows pain.
- Per-server renderer state: tab persistence (`tab-persistence.ts`) must key its snapshot by
  server (`installationId`), so switching servers doesn't cross-pollinate tab layouts.
- Acceptance: desktop app fully functional with RPC no longer riding IPC — pill and editor
  connect as two sockets but `connectionsListSessions`/presence show a single "This Mac"
  device; full session lifecycle against a
  remote `--headless` instance (create, stream, approve permission, diff view); switching back
  to "This Mac" restores local state; no perceptible regression on large-diff views locally.

### C2. Server switcher + pairing UI in Electron
- `src/renderer/components/servers/`: switcher UI (command-palette action + a control in the
  layout — follow existing TabStrip/ActionOrb patterns), "Add server" flow reusing the web
  client's ConnectFlow logic (paste pair link / 6-digit code; QR display comes from D8).
  Persist paired servers via the shared server-registry (localStorage equivalent: use the
  existing settings/persistence path the renderer already has).
- Reconnect UX: port the web client's backoff + offline banner behavior; queue RPCs while
  disconnected (WsTransport already does).
- Acceptance: pair, disconnect network, observe banner + auto-reconnect + seq resume (no
  duplicate/missing events — replay path already server-side).

### C3. Retire the IPC RPC transport
- Once both windows run on WS (C1): delete `src/main/transports/electron-ipc.ts`, its attach
  call in `src/main/index.ts`, and the preload RPC/event plumbing it served. Grep
  `solus:rpc`/`solus:rpc-send`/`solus:event` — all gone except the C1 bootstrap channel.
- Update the D1 electron-import allowlist test: `transports/electron-ipc.ts` is removed from the
  allowed list.
- Acceptance: `bun run build` green; Playwright suite passes with the desktop app running
  entirely over local WS; no dead IPC channels remain.

---

## Workstream D — Standalone daemon + install/claim flow

### D1. Sever the five Electron couplings (mechanical, do first)
- `net` → global `fetch` in `google/oauth.ts`, `google/drive.ts`, `providers/github/auth.ts`,
  `model-downloader.ts` (Node ≥18; check streaming download in `model-downloader` — use
  `response.body` web stream or `Readable.fromWeb`).
- `app.getPath` → new `src/main/platform/paths.ts` exporting `dataDir()` / `logsDir()`:
  in Electron pass-through to `app.getPath` when available, else `~/.solus/…`. Update `logger.ts`,
  `session-handlers.ts`, `google/oauth.ts`, `github/token-store.ts`.
- `safeStorage` → new `src/main/platform/secrets.ts` with two impls behind one interface:
  Electron `safeStorage` (desktop) and `0600` JSON file under `~/.solus/secrets/` (daemon).
  Include a one-time migration: if desktop-encrypted tokens exist, leave them; daemon uses its
  own store.
- `shell.openExternal` in `google/oauth.ts` → deleted by B3 (client opens the URL).
- `nativeTheme` in `theme-handlers.ts` → register only when `windowDeps` present (same guard
  pattern as file handlers in `bootServer`).
- Import rule: after this task, `grep "from 'electron'" src/main` must list **only**
  `index.ts`, `transports/electron-ipc.ts`, `updater.ts`, `server/handlers/file-handlers.ts`,
  `server/handlers/theme-handlers.ts`, `logger.ts`-free etc. Enforce with a unit test that greps
  the server-path files.
- Acceptance: `bun run build` green; desktop app behavior unchanged (Google/GitHub connect,
  model download, logging).

### D2. Standalone entrypoint
- New `src/main/standalone.ts`: parse env/flags (`SOLUS_PORT`, `SOLUS_HOST`, `--data-dir`),
  construct ControlPlane + managers exactly as the headless branch of `src/main/index.ts` does
  (extract that construction into a shared `src/main/boot-core.ts` used by both entrypoints —
  surgical: move, don't rewrite), call `bootServer()` with no `windowDeps`/`fileDeps`, install
  SIGINT/SIGTERM handlers calling `shutdown()`.
- Replace `solus-artifact://` for remote clients: authenticated HTTP route
  `GET /artifact?p=<path>` on `http.ts` (session-token required, path-jailed to known project
  roots) and have the renderer resolve artifact URLs via the active transport (desktop keeps the
  protocol; the shared client core rewrites to the HTTP route when remote).
- Acceptance: `node dist/server/index.js` (no Electron) boots, serves the web client, runs a full
  Claude session driven from a browser.

### D3. Server bundle + release artifacts
- New build config (esbuild or tsup — pick one, config at `scripts/build-server.ts`): entry
  `src/main/standalone.ts`, platform `node`, target `node20`, output `dist/server/`. Externalize
  native modules (`@ff-labs/fff-node`, `onnxruntime-node`) and lazy-import them at use sites with
  graceful degradation (file-finder → fall back to fs walk or disable; dictation → capability
  flag off in A4 handshake).
- CI (`.github/workflows/release-server.yml`): build `dist/server` + `dist/client`, assemble
  per-arch tarballs `solus-server-{darwin-arm64,linux-x64,linux-arm64}.tar.gz` containing
  `{bin/node (pinned runtime), server/, client/, bin/solus (CLI from D5)}`; publish to GitHub
  Releases with checksums.
- Acceptance: tarball extracted on a clean Linux container (no Node installed) runs
  `bin/solus start` successfully.

### D4. Claim state machine
- `src/main/server/auth.ts` + `http.ts`.
- Server ownership state persisted in `server-keys.json`: `unclaimed | owned(ownerDeviceId)`.
  While unclaimed **and** within a claim window (opened at first boot or via `solus claim`,
  TTL 10 min), `POST /claim` with the printed one-time code issues the **owner** device token and
  transitions to `owned`. Once owned: `/claim` returns 403; new devices join only via pair tokens
  minted by an existing device (existing flow). `GET /health` includes
  `{ claimable: boolean, name, installationId }`.
- Trust display: claim response includes the server fingerprint (short hash of `installationId`);
  client shows it for confirmation against the terminal output.
- Acceptance: unit tests — claim within window succeeds once, second claim 403, expired window
  403, `/pair` unaffected after ownership.

### D5. `solus` CLI
- New `src/cli/` (bundled into the tarball as `bin/solus`; thin argv dispatch, no framework):
  - `solus start|stop|status` — foreground start, or control the service (detect
    launchd/systemd; when installed via brew, defer to `brew services` and print the right
    command instead of duplicating it).
  - `solus claim` — (re)open the claim window and print the claim block: URL, 6-digit code, and
    an ASCII QR (add dependency `qrcode-terminal` or generate with a small vendored impl) for
    `http://<best-endpoint>:<port>/pair#claim=<code>`; pick best endpoint via existing
    `listReachableEndpoints()` (prefer tailnet > LAN).
  - `solus logs` — tail the daemon log file from `logsDir()`.
  - `solus update` — download + swap the latest tarball (skip when brew-managed; print
    `brew upgrade solus` instead).
- Acceptance: each verb works against a running daemon; `claim` QR scans from a phone and opens
  the pair route.

### D6. Client-side server discovery
- Extend the shared client core (C1) with a discovery module: probe Tailscale peers
  (`tailscale status --json` — desktop Electron only; the main process runs it via an RPC on the
  *local* server) and mDNS later (defer mDNS — Tailscale first). For each peer, `GET /health`
  with short timeout; surface `claimable` servers.
- Renderer: toast/card "New Solus server found: <name>. Connect?" → resolve a likely SSH target
  from local SSH config/known hosts → run batch-mode SSH first → if SSH needs a password or key
  passphrase, prompt locally and retry through `SSH_ASKPASS` → mint a scoped Solus session
  credential with `solus auth session create --json` on the remote host and save it in the server
  registry. Keep the one-time code as a fallback only for web/mobile or non-SSH environments.
  Discovery packets never carry an authorization secret.
- Acceptance: fresh `--headless` instance on a tailnet machine appears in the desktop app within
  ~30s of boot; connect completes without typing a URL or Solus code when SSH keys/agent work;
  password/passphrase auth uses only the local Solus prompt.

### D7. First-run setup checklist (server home)
- New feature folder `src/renderer/components/server-setup/` + colocated store; shown for a
  connected server whose A4 capabilities report gaps (no agent binary, no agent auth, no GitHub,
  zero projects). Steps, each an RPC + streamed output:
  1. Name the server (`connectionsGetServerInfo` already returns name; add `setServerName`).
  2. Install agent CLI — new RPC `installAgentCli(agent)` that runs the official installer
     server-side, streaming output over a topic (reuse the run-log streaming pattern from
     `run-manager`).
  3. Agent sign-in — run the agent CLI's device-auth/token flow server-side and surface the
     URL/code as a card (agent-specific; for Claude use `claude setup-token`-style flow).
  4. Connect GitHub — existing device flow, surfaced here.
  5. First project — new RPC `cloneProject(repoUrl)` (GitHub provider lists repos via existing
     Octokit integration; server runs `git clone` into a configurable projects root, registers in
     the manifest via `recordProject`).
- Checklist disappears once all capabilities are green; steps are re-runnable from settings.
- Acceptance: from a bare Linux container with only the tarball: claim → checklist → install
  claude → sign in → clone repo → run first session, all without SSH.
- **Superseded.** The standalone checklist was never mounted and has been deleted
  (`src/renderer/components/server-setup/**`). Its intent now lives in the *New project on a host*
  flow: the readiness rail in `servers/NewProjectDialog.svelte` probes git, commit identity, GitHub
  and the agent CLI on the **selected** host and repairs each in place, and the same dialog owns
  repo listing and cloning. The gap is fixed where the user hits it — while starting work on that
  host — rather than as a one-time gate on a server home the user may never open.

### D8. "Take it with you" QR handoff
- Connections panel (`ConnectionsPanel.svelte`): render the existing pair link as a QR (small
  QR-SVG lib or canvas; keep it dependency-light). Shown at the end of the D7 checklist and
  permanently in Connections.
- Acceptance: phone scans → web client pairing completes.

---

## Workstream G — Dispatch & host onboarding UX

Vocabulary is locked in `CONTEXT.md` (host, Solus server, host readiness, host onboarding, base
checkout, session worktree, dispatch). Use those words in UI copy — no "server"/"machine"/"remote"
synonyms in anything user-facing.

### G0. Host-affinity iconography (codify what already exists)

`DesktopTowerIcon` = the host you're working on. `GlobeSimpleIcon` = any other host. Already used
consistently in `ServerSwitcher.svelte:128`, `RunOnPicker.svelte:221/310`, `HostDirectory.svelte`,
`TabStrip.svelte:396`. Two rules that fall out of it:

- **Quiet by default.** Local is the unmarked case — no badge, no chip. `TabStrip` gets this right
  (`{#if remoteServer}`, :384): a local session is visually unchanged, a dispatched one earns a
  globe. Do not add a desktop-tower badge to local sessions "for symmetry"; it doubles the
  chrome for the majority case and buys nothing.
- **The globe carries liveness — in the glyph, not beside it.** The whole question a user has
  about a dispatched session is "is that machine still there", so the badge has to answer it. But
  **no status dots**: a dot is a second element competing for a 12px slot, and it marks all three
  states with equal weight when only one of them is worth interrupting for. Express state through
  the glyph itself:

  | Host state | Glyph |
  |---|---|
  | Online | `GlobeSimpleIcon`, `--solus-text-tertiary` — the unmarked, expected case |
  | Connecting | same glyph, `animate-pulse`, `--solus-accent` |
  | Offline | `CloudSlashIcon`, `--solus-status-error` — a different glyph, so it reads at a glance without relying on colour alone |

  Colour never carries the meaning by itself (the offline state changes shape too), which keeps it
  legible in both themes and for colour-vision deficiency. `TabStrip.svelte:392` currently renders
  a ringed dot — replace it with this.

  `HostDirectory.svelte` has the same dot (`dotClass`, :29) sitting next to a `statusLabel` that
  already says "Online" / "Offline" in words. Drop the dot there rather than restyling it: a row
  with room for text doesn't need a glyph repeating the text.

### G1. Surfaces missing host affinity

| Surface | Today | Needed |
|---|---|---|
| `TabStrip.svelte` | ⚠️ globe + `Runs on <host>` tooltip, but liveness is a ringed dot (:392) | swap the dot for the G0 glyph states; then it's the reference implementation |
| `NewTabHome.svelte` | ✅ "on \<host\>" switcher button (:421) | — |
| `SessionSidebar.svelte` | ❌ **nothing** | Session history mixes hosts with no way to tell them apart. Needs the globe badge per row, same shape as TabStrip. |
| Recent projects (`NewTabHome`, :87) | ❌ **nothing** | The same repo checked out on two hosts renders as two identical rows. Needs the host on the row, and dedupe/grouping by `repoKey`. |
| `StatusBarControls.svelte` | ❌ nothing | The active host belongs here — it's the ambient "where am I" indicator. |
| `GitSection.svelte` / project panel | ❌ nothing | A dispatched session's branch lives on another machine; the git surface should say which. |

### G2. Host onboarding surface

- Runs after a successful claim (`ClaimServerModal.svelte`), **always skippable** — never a gate.
- Resumable from a **Set up** action on the host's row in `HostDirectory.svelte`, which today has no
  such affordance. The row should show readiness at a glance (ready / needs setup) so the action
  isn't hidden behind a click.
- The rail contains only authentication choices: **GitHub** → credential helper → `gh auth` →
  add providers. Adding Claude Code or Codex installs it when missing and authenticates it in the
  same action.
  The helper and `gh` steps `execFileSync` the stored token and throw outright without it
  (`setup-handlers.ts:311/325`), so GitHub cannot float later in the list.
- Credential-helper and `gh` wiring are non-interactive: **run them and report**, don't ask. Host
  naming comes from claim, clone location has a host-local fallback, and git/commit identity are
  repaired contextually when first needed.
- **Agent sign-in card** (new): spawn the agent CLI's device flow server-side, scrape the URL +
  code off stdout, render as a click-to-open card. Same `runSetupProcess` + `setup-log` streaming
  the install steps already use. This is the one step with no RPC today.

### G3. Dispatch feedback

Dispatch is optimistic — no pre-flight probe — so the status card is the whole safety net.
Extend `buildWorktreeCard` (`control-plane.ts:1525`) with a clone step:

```
Cloning <repo> → Creating branch & worktree → Linking workspace → Starting agent session
```

Failure surfaces, each an actionable card rather than a git error:

- **Clone failed (auth)** → "«host» can't read this repo yet · Set up" → opens the readiness rail
  with the GitHub step focused. Cheap failure: seconds, no tokens spent.
- **Destination occupied** — `assertEmptyDestination` throws when the host already has a folder at
  `projectsRoot/<repo>` that Solus never registered → offer **"«host» already has a folder here —
  use it?"**, which `recordProject`s it and continues.
- **Anonymous clone succeeded** → non-blocking note: "«host» can read this repo but can't push
  yet · Set up". This is the one failure that would otherwise surface 25 minutes late, at PR time.
- **Push/PR failed** → same rail, `gh auth` step focused.

### G4. Dispatch availability

- A project with **no git remote** must not offer other hosts in `RunOnPicker` — it is reachable
  only by opening a folder on that host, or by switching to it. Show the constraint, don't hide the
  picker.
- Guard it in `retargetSessionHost` (`run-on.ts:42`) too, not just the UI: it currently does
  `if (path) session.workingDirectory = path`, so a dispatch with no resolvable remote path
  silently keeps the *local* directory and starts the session in a path that doesn't exist on the
  target.
- A **non-GitHub remote** (GitLab, self-hosted) is dispatchable only over SSH —
  `git-credential.ts` serves `github.com` only — so the HTTPS fallback has no credential to offer.
  Don't promise more than that in copy.

### G5. Standing rules (CLAUDE.md)

Every surface above: dark + light, keyboard navigable, refocus the active input after any action,
Tailwind v4 utilities, no logic in `.svelte` (host-affinity helpers go in a colocated `lib/`).

### G6. Parallelisation

Decisions are recorded in [ADR-0001](../adr/0001-https-token-provisioning-ssh-first-cloning.md)
and [ADR-0002](../adr/0002-dispatch-carries-the-repository-not-your-working-tree.md).

**What actually constrains parallelism is file ownership, not logical dependency.**
`setup-handlers.ts` (613 lines) and `control-plane.ts` are each single-writer — three agents
editing `setup-handlers.ts` concurrently will conflict no matter how independent their tasks read
on paper. Lanes are drawn around files first, features second.

**Prerequisite, not parallelisable:** agree the RPC names and payloads up front — `HostReadiness`
gaining an `agent` field, and the agent sign-in RPC. Both lanes A and the wave-2 UI encode them.
Fan out only after those signatures are written down.

#### Wave 1 — four lanes, fully parallel

| Lane | Owns | Work (sequential within the lane) |
|---|---|---|
| **A** | `setup-handlers.ts`, `shared/rpc.ts`, `shared/types.ts` | SSH-first clone attempt + `BatchMode`/`StrictHostKeyChecking`/`ConnectTimeout` flags (ADR-0001); agent sign-in RPC streaming the CLI device flow over `setup-log`; fold agent installed/signed-in into `HostReadiness` |
| **B** | `control-plane.ts` | Dispatch orchestration: clone-when-missing, then `createWorktree` with no `baseBranch`; extend `buildWorktreeCard` with the clone step |
| **C** | `components/servers/lib/`, `TabStrip.svelte`, `HostDirectory.svelte` | G0 glyph states as a shared helper, then apply to both existing dot sites |
| **D** | `run-on.ts`, `RunOnPicker.svelte` | Guard dispatch when no remote resolves (ADR-0002); reflect availability in the picker |

Lane C's helper is the only shared artefact in wave 1 — land it first within the lane, then
**C-2, C-3, C-4 fan out to three agents in parallel**, one file each and no overlap:
`SessionSidebar.svelte`, recent-projects rows in `NewTabHome.svelte`, `StatusBarControls.svelte`.

#### Wave 2 — needs wave 1's RPCs and card steps

- **Host onboarding surface** + the Set-up affordance on the host row — needs lane A.
- **Dispatch failure cards** (clone auth, occupied destination, anonymous-clone warning, push
  failure) — needs lanes A and B.

These two are independent of each other and parallelisable with one another.

---

## Workstream E — Homebrew (CLI/daemon only, no cask)

### E1. Tap repo `solus-sh/homebrew-tap`
- New repo containing `Formula/solus.rb`. Formula **pours the prebuilt per-arch tarball** from
  GitHub Releases (D3) — do NOT `depends_on "node"` (native modules are NODE_MODULE_VERSION-
  pinned; brew's node upgrades would break them). `on_macos`/`on_linux` + `Hardware::CPU` blocks
  select the artifact; install into `libexec`, symlink `bin/solus`.
- `service do` block: run `opt_bin/"solus-server"` (a tiny wrapper entry that execs the vendored
  node with `server/index.js`), `keep_alive true`, log to `var/log/solus.log`, env
  `SOLUS_DATA_DIR` default.
- `test do`: `solus --version` and a `/health` curl against an ephemeral-port boot.
- Acceptance: `brew install solus-sh/tap/solus && brew services start solus && solus claim`
  works on macOS and Homebrew-on-Linux.

### E2. Release auto-bump
- In the main repo's release workflow (D3): after publishing, use
  `mislav/bump-homebrew-formula-action` (or an equivalent scripted commit) to update version +
  per-arch SHA256s in the tap.
- Acceptance: cutting a release updates the tap without manual edits; `brew upgrade solus` picks
  it up.

---

## Workstream F — Product layer (Group 3)

### F1. Attention model (keystone — do before F2–F4)
- New `src/main/attention/attention-service.ts` + persistence under `~/.solus/state/`.
- Source of truth: hook `_setStatus` transitions in `control-plane.ts` (it already sees
  `awaiting_input`, `completed`, `failed`) plus permission/question event emission. Maintain
  per-session attention entries:
  `{ sessionId, kind: 'needs_approval'|'question'|'finished'|'failed', since, summary,
  projectKey, resolvedBy? }`. Resolve on respond/next-prompt/session-close.
- RPC: `listAttention` + broadcast topic `attention-changed` (add both to `src/shared/rpc.ts`,
  register handler in `bootServer` — all clients pick it up automatically from the RPC constants
  via the shared `WsTransport`; after C3 there is no preload RPC surface to update).
- Acceptance: unit tests for transition → entry lifecycle; two clients see consistent attention
  state after reconnect (replay/bootstrap via `listAttention`).

### F2. Notifications
- Server: add `web-push` dependency. VAPID keys generated once into `server-keys.json`. RPCs:
  `pushSubscribe(subscription)`, `pushUnsubscribe`, stored per-device in `~/.solus/state/push.json`.
  On attention-entry creation (F1), send Web Push to subscribed devices **not currently
  connected** (presence map in `SolusServer` knows who's online); payload
  `{ title, body, sessionId, serverName }`.
- Web client: service worker (part of PWA work, but the subscription + notification-click →
  deep-link to session can land now behind HTTPS); notification click focuses/opens the session.
- Electron client: on `attention-changed` while app unfocused, fire an OS `Notification` (this is
  desktop-shell code, allowed to use Electron) with click-to-focus-session. Add a dock badge
  count on macOS (`app.dock.setBadge`).
- Acceptance: agent requests permission with no client connected → phone receives push within
  seconds; tapping lands on the approval card. Desktop: notification + badge, click focuses the
  right tab.


---

## Order & dependencies

```
D1 (decouple) ──► D2 (standalone) ──► D3 (bundle/CI) ──► D4 (claim) ──► D5 (CLI) ──► E1 ──► E2
A1..A4 ──► C1 (WS-first) ──► { B1, C2, C3 }
B3 (independent — anytime)
C2 + A4 + D5 ──► D6 (discovery) ──► D7 (checklist) ──► D8 (QR)
F1 ──► F2  (needs A-level auth for push endpoints; independent of D)
```

C1 is deliberately early: it collapses the dual-transport problem before B1 builds on per-device
identity, and C2/C3 fall out of it.

Parallelizable tracks: **[D1→D5 + E]**, **[A → C1 → B1/C2/C3]**, **[B3]**, **[F]** — four
agents can work concurrently; D6/D7 are the only cross-track merge points (need A4 + C2 + a
daemon to discover).

Ship gates:
1. **Internal remote use**: A1–A4, C1–C3, B1.
2. **Installable server**: + D1–D5, E1–E2.
3. **Buttery onboarding**: + D4 claim UX, D6–D8.
4. **Actually useful remotely**: + F1–F2.

## Global acceptance

- `bun run build` green at every workstream boundary; unit tests via `bun test tests/unit`.
- No new `from 'electron'` imports outside the allowed desktop-shell file list (D1 test).
- Every new renderer surface: dark + light mode, keyboard navigable, refocuses input after action.
- No spreading `TabState`; durable renderer data flows through stores.
