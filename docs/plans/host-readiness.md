# Host readiness

Each host has one **readiness**. Every surface on desktop, web, and mobile
reads it. No surface reads the supervisor phase, the transport status, or a
health probe to decide whether a host can do work.

## Why

Before this change, a client had about eight overlapping states for a host:
the transport `ConnectionStatus`, the supervisor `HostPhase` (with an
`offline` phase after three failed dials), the desktop and web
`ServerItemStatus` (with `saved` and probe overrides), `HostPresence`,
`connectedServerIds()`, the mobile `HostConnectionPhase`, and more. About
twenty surfaces read different ones. They disagreed:

- A request to a host that was down never settled. The transcript and the
  session sidebar showed skeletons for as long as the host was down.
- The transcript row said "Can't reach" for a host that was never dialed.
- "Reconnect" dialed the window's active host, not the session's host. "Run
  locally" switched the window to the local host. It did not move the
  session.
- The overlay pill named the active host, and the transcript row named the
  session's host. Both could show at the same time for different hosts.
- The 12-second grace was in some surfaces and not in others.

## Vocabulary

- **Readiness** — the answer to "can this client do work on this host now?"
- **Grace** — 12 seconds (`UNREACHABLE_AFTER_MS`). A host that is down for less
  than the grace is `checking` or `reconnecting`. After the grace it is
  `unreachable`.
- **Last seen** — the time the host was last `ready`. Null if it was never
  ready on this client.
- **Away** — `HostReadinessState.away`: the host went past its grace and has
  not been `ready` since. A retry does not clear it. A `gone` host is away.
- **Diagnostics** — what a person needs to debug a host or to ask for support
  (`hostDiagnosticRows`, `hostDiagnosticsText` in client-core).

## States

| Readiness | Meaning | Loaders |
|---|---|---|
| `checking` | First dial, inside the grace. Or a managed host that Solus Cloud is starting. | Wait |
| `ready` | The socket is accepted. | Run |
| `reconnecting` | Was `ready`. Dialing again, inside the grace. | Wait |
| `unreachable` | Down for longer than the grace. Solus keeps dialing. | Fail at once |
| `refused` | The host refused this client's credential, or another host answered its address. Dials stop until the user pairs again. | Fail at once |
| `gone` | This client does not know the host (`HostPresence` `gone`). | Fail at once |

`unreachable` has a reason:

- `no-answer` — the host did not answer for longer than the grace.
- `not-running` — a managed host is stopped or failed. A Start starts it.
- `no-address` — the host has no route that this client can dial.

`refused` has a reason: `auth` or `identity-mismatch`.

The grace starts when the host stops being `ready`, or at the first dial. A
user retry (or a wake from sleep) dials at once and starts a new grace: the host
shows `reconnecting` (or `checking` if it was never ready) until it answers or
the new grace ends.

Host facts (`capabilities`, `serverInfo`, ...) keep their own
`loading | ready | error` state (`docs/plans/host-model.md`). Readiness does not
wait for them.

## Rules

1. **One owner.** The supervisor computes readiness from its dial outcomes and
   the clock. `ServerConnections.readinessFor(id)` and the mobile
   `HostConnections` add `gone` and the managed-host reasons. The phase type
   is not exported for UI code.
2. **No request waits forever.** When a host becomes `unreachable`, its
   transport rejects every queued request with `HostUnreachableError`, and it
   rejects new requests at once until the next dial. `HostUnreachableError` is
   a `TransportDisconnectedError`, so the send outbox keeps the prompt and
   sends it when the host is `ready` again.
3. **A loading state ends.** A skeleton shows only while its host is `checking`
   or `reconnecting`. When the host is not ready and nothing is loaded, the
   surface shows the host state, not a skeleton.
4. **A surface names its own host.** The transcript shows the state of the
   session's host. Retry dials that host. No surface shows the state of the
   window's active host for a different host's content.
5. **One copy table.** `hostReadinessCopy(readiness, label, lastSeenAt)` in
   client-core gives the headline and the detail for every state. Desktop, web,
   and mobile use it.
6. **Do not show what cannot work.** While a host is away, a surface on it
   does not show controls that need it: the composer, the session actions, and
   the request cards (approvals, questions, sign-ins, seats). The host panel
   takes their place. Inside the grace they stay, so a short drop does not
   remove them while the person types.
7. **Show what is needed to debug.** Every place that says a host is away shows
   its diagnostics: the address dialed, the other addresses, failed dials, the
   last error, last seen, both versions, and the IDs, with **Copy details** and
   **Host settings**.

## Copy

| Readiness | Headline | Detail | Action |
|---|---|---|---|
| `checking` | Connecting to Raiders | — | — |
| `reconnecting` | Reconnecting to Raiders | — | — |
| `unreachable` / `no-answer` | Raiders is offline | Last seen 4 min ago. Solus keeps trying. | Retry now |
| `unreachable` / `not-running` | Raiders is not running | — | Start |
| `unreachable` / `no-address` | Raiders has no address yet | — | — |
| `refused` / `auth` | Raiders needs pairing again | — | Pair again |
| `refused` / `identity-mismatch` | A different server answered as Raiders | — | Pair this server |
| `gone` | This machine was removed | — | — |

The status label in a host list is one word: Connecting, Online, Reconnecting,
Offline, Not running, No address, Refused, Removed.

## Surfaces

Desktop and web (shared Svelte):

- **Inside the grace.** The composer stays, but it is disabled: it keeps the
  draft and takes no input until the host is back. One whisper over it, with
  no box: a small spinner and "Reconnecting to Raiders…". It is not shown for the
  window's own host (the overlay says it) or the desktop's local host.
- **Host away.** One card takes the composer's place, with one statement
  ("Raiders is offline.", with "Last seen 4 min ago. Solus keeps trying."
  under it). The transcript above stays at full contrast, and the user can
  scroll and read it. Two controls: a quiet
  **Details** toggle and the one action (**Retry now**, **Start**, or **Pair
  again**). The diagnostics stay collapsed until Details opens them, with
  **Copy details** and **Host settings** under the list. During a retry the
  statement says "Trying Raiders again…". An empty transcript stays empty,
  never a skeleton. The session action
  row and the request cards are hidden.
- **Session sidebar.** Rows from ready hosts show. An unreachable host never
  keeps the list in its skeleton.
- **Draft gate.** Composer when any host is `ready`, `checking`, or
  `reconnecting`. Connect page when no host is saved or every host is
  `unreachable`, `refused`, or `gone`. The page stays until a host is `ready`.
- **Overlay.** Web only. It shows the state of the host that serves the web
  window (`serversStore.windowHostId`), because the whole window depends on it.
  Desktop has no overlay: its own host runs beside the window, and every other
  host shows its state where its content is drawn.
- **Host lists, pickers, rows, record page, settings.** Read readiness and the
  one-word label (`serversStore.readinessLabelFor`).

**Details** also shows the stages, the first failure, and what to try
(`HostConnectionStages`, `diagnoseHostConnection`). Opening it runs the connection
check; **Check again** runs it again. The Access tab has **Connection test**, which
runs the host's self-test. Mobile shows both, in `HostAsleepCard` and in
`HostSelfTestSection`.

Mobile: the host banner, the thread pill, the host rows, and the new-task gate
read the same readiness and the same copy. A thread follows the same design:
inside the grace, `HostGraceWhisper` sits over the composer, which is
disabled; while away `HostAsleepCard` takes the composer's place, with the
same statement, Details toggle, and action, and the thread above stays
readable.
The request cards and the agents pill are hidden while away. The host banner
offers Copy details.

## Staged diagnosis

Readiness says that a host is not ready. The **diagnosis** says where the
connection stopped. User guide: `docs/host-connection-troubleshooting.md`.

### Vocabulary

- **Stage** — one part of the way to a host: `device`, `cloud`, `tunnel`, or
  `host`. A host with a tunnel route has all four. A host with only direct routes
  has `device` and `host`. A direct route that fails is not a stage on a tunnel
  path: a laptop away from home would always show it as the first failure.
- **Stage result** — `ok`, `failed`, or `unknown`. `failed` means that the check
  ran and did not pass from where it ran. `unknown` means that no evidence exists.
- **Connection check** — a short, active read that a client runs when a person
  opens Details: `/health` on each dialable address, and Solus Cloud.
- **Self-test** — the check that a host runs on itself (`hostSelfTest`). It sees
  the connector, the proxied listener, port 7844, and the host's public address.

### Assumptions

1. A dial error alone cannot name a stage. A browser WebSocket error has no HTTP
   status, so the connection check is necessary.
2. A browser cannot read a Cloudflare 530 or 502: the error page has no CORS
   headers. A `no-cors` fetch tells only that something answered. On desktop and
   web the tunnel and host stages then stay `unknown`. Mobile reads the status.
3. Solus Cloud reports no tunnel health. Its code is in another repository, and
   "what the connector observes stays on this host". The client does not guess.
4. A dial does not always need Solus Cloud: an access token lives eight hours. So
   a failed `cloud` stage does not make the later stages `unknown`.
5. Only evidence makes a stage `ok`. A stage is never `ok` because a later stage
   failed. An answer from a later stage does prove the stages before it, because
   the answer came through them.
6. `/.well-known/openid-configuration` is the public read for Solus Cloud. Clients
   already read it, and it needs no account.

### Rules

1. **One model.** `diagnoseHostConnection` in client-core gives the headline, the
   stages, and the steps. Desktop, web, and mobile render it.
2. **One check.** `HostLink.checkConnection` runs it and holds the last result.
   It runs on Details, on Check again, and on Retry while Details is open. It
   never runs in the background.
3. **The first failed stage is the headline.** The steps cover each failed stage.
4. **The self-test owns its words.** The host sends the reason and the fix, so the
   CLI and every client show the same text. It marks `device` as `unknown`: it
   cannot test another device's network.
5. **Port 7844 is tested with TCP only.** A TCP test says nothing about QUIC over
   UDP. A failed test counts only when no tunnel connection is up.

### Not in this change

- A tunnel health read from Solus Cloud. It would name the stage in a browser.
- A check of the clock on either side.
- A link from the UI to the guide. The steps are in the UI.

## Known gap

A prompt sent to a host that is away is queued, but the conversation still
says "Thinking it through…" and the sidebar says "Working". The optimistic
turn state predates this plan and is not yet tied to readiness.

## Removed

- "Run locally" and `serversStore.useLocalHost()`. Moving a session to another
  machine is a separate feature. (The render-crash scene keeps its "Use this
  Mac" button: it switches the window, not a session.)
- `serversStore.retryActive()`. `serversStore.retry(hostId)` dials the named
  host.
- The supervisor `offline` phase and `OFFLINE_AFTER_ATTEMPTS`. Time is the only
  rule.
- `ServerItemStatus`, `statusFor()`, the `saved` state, and the probe override
  of a supervised host. The health probe is kept only for hosts without a
  supervisor (the add-host flow).
- `RECONNECT_ESCALATE_MS` and the copies of the grace in the draft gate and the
  overlay.
- `serversStore.connectionPhase` (the active host's phase).
- The overlay on desktop, its "Still trying" card with the elapsed counter,
  its "Reconnected" toast, and its "Use this Mac" action.
- The transcript status row with "Can't reach" / "Reconnect" / "Run locally".
- `recordRunnerState`, `RUNNER_CONNECTING_NOTE`, `RUNNER_OFFLINE_REASON`.
- The status labels and dot classes in `host-affinity.ts`.
- `shouldRejectQueuedRequest` and `queuedBeforeFirstConnect`.
- Mobile `HostConnectionPhase`, `host-connection-status.ts`, the host part of
  `floating-working-status.ts`, and `new-task-host-gate.ts`.

## Kept

- `HostPresence`. It is the input for `gone`.
- `HostFact` states.
- `connectedServerIds()`. It lists the connections that exist. A caller that
  used it to mean "ready" reads readiness.
- Web `HostlessHome`. "No host chosen" is not a readiness.
- The session-level `isReconnecting`. It is about the agent's stream.
- The live-document status in `work/`. It is about document sync.
