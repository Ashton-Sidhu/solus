# The dispatch client — web/mobile without a home server

**Status**: **all seven migration steps complete** (2026-08-14). Step 5's
deletion sweep landed last: `primaryApi()`, `eventsForPrimary()`, the no-arg
`connectionFor()`, and the web `local` alias in `resolveId` are deleted;
`switchTo` moves the new-work default in place (no reload, the displaced
host keeps its supervised socket and live sessions); the synthesized web
"local row" is gone — hosts are symmetric rows under their real ids, with
platform-managed entries joining from the live registry; the Run-on
picker's "stay" names the run's own host on web; tab persistence is one
client-wide namespace (tabs each name their host; retired per-host blobs are
not read); and the explicit remnants are named APIs —
`defaultServerId()` (the visible new-work default), `localServerId()` /
`localHostApi()` (the desktop machine; null on web, so
`hostPolicy.isClientMachine` is now honest and client-machine actions gate
off in browsers). The per-site inventory that drove the sweep is
[dispatch-client-step5-inventory.md](./dispatch-client-step5-inventory.md).
Remaining hardening (deliberately outside the migration steps): the
credential-storage riders — IndexedDB/secure storage (forces the
server-registry API async), the HttpOnly serving-origin cookie, per-method
RPC scopes, and removal of credentials from localStorage.

**Compatibility cleanup complete** (2026-08-15): because this migration has
no backwards-compatibility requirement, authenticated sockets now accept only
short-lived WS tickets (a long-lived session token in Socket.IO auth is
rejected); the client no longer falls back to that token when ticket exchange
fails; retired per-installation tab/draft keys and the old `#/connect` boot
route are no longer read; saved and newly paired hosts must carry a stable
installation id; and unstamped plan/pin records never inherit the new-work
default host. Forward-compatible wire decoding, version-skew handling,
supervised reconnect, and offline snapshot recovery remain: those protect
current clients during skew and failure, not older data models.

**Step 1 complete** (2026-08-14, closed out
with the maintainer's no-backwards-compatibility ruling). Shipped: the
skew-safe decoding rider in full (`forwardCompatibleArray` in
`src/client-core/forward-compat.ts`; tolerant pair/claim/health/capability/
saved-server decoding; the transport ack guard); one host-scoped id grammar
for every route (`<id>~<serverId>` in the id's own segment — the
`host~<id>` path segment is gone); `session://` links and editor ref tokens
carry `serverId`, and the cross-host bare-id probe (`resolveSessionMetaRef`)
is deleted — `readSessionMeta(serverId, sessionId)` is the only resolver and
an unscoped ref is a hard miss; the agent-session tab index is keyed by
`(serverId, agentId)` and a provider id never matches a tab without its host
(client-minted Solus session ids stay hostless — they cannot collide);
notification/push routes always name the host and a push for an unknown host
opens the app plain.

**Step 2 in progress** (2026-08-14). Shipped: the freshness ladder
(`src/client-core/freshness.ts` — `empty | cached | synchronizing | live`
with `error` as an independent axis) reported per host by the session
history loader; a schema-versioned per-host session snapshot cache
(`src/client-core/session-snapshot-cache.ts`, version in the storage key for
rollback safety, corrupt records deleted, rows stored naked and stamped on
read, purged when a host is forgotten); a failed host's sources contribute
last-known rows under `cached` instead of clearing the list; an unreachable
saved host names its last-known sources (`cachedOnly`) so its rows render
without a socket; the sidebar aggregates every catalog host (the
selected-host filter and its primary fallbacks are gone; `hostTasks` is now
`catalogTasks`); pins federate — read fan-out with client-edge stamping,
writes routed to the session's own host. Interpretation note: the
"snapshot over HTTP" rider is satisfied semantically for sessions — every
load re-fetches the authoritative snapshot (no cursor survives a socket
session) with deltas streamed per scan — and the literal HTTP endpoint moves
with step 3's supervisors. 2026-08-14 later: the picker footer now renders
per-host sync notes (`host · last known` / `sync error`) from `hostStates`
via the shared component, closing step 2.

**Step 3 in progress** (2026-08-14). Shipped (design plan's PRs 1–2): the
host supervisor (`src/client-core/host-supervisor.ts`) is the sole retry
owner — the transport dials with `reconnection: false` and reports dial
outcomes; the ladder is the old socket.io curve, so pacing is unchanged; the
one long-lived socket keeps connection-state recovery and the request queue
(verified against the real-socket harness). Phases:
`connecting | reconnecting | connected | blocked | offline`, where offline
is a presentation of the capped ladder, auth-block stops the ladder, and an
identity mismatch stays blocked even through a user retry. Every catalog
entry (saved hosts + the local/platform entry) is eagerly desired from boot;
`release()` no-ops for catalog entries; forgetting a host destroys its
supervisor. `serversStore` maps phase authoritatively; the web global
connection toast (and its reload-the-window "retry") is deleted — the
per-host status chip retries via the supervisor, and mobile's server sheet
rows are phase-driven. ADR-0004 amended. 2026-08-14 later, **step 3
complete** — all riders shipped: the wake taxonomy
(`src/client-core/wake-signals.ts`: one classified stream fanned out by the
registry; foregrounding probes a healthy host, only a ≥30s suspension resets
a ladder, plain activation is ignored mid-dial and otherwise pulls the
scheduled dial forward at its rung); capabilities are session-scoped on the
supervisor (the TTL cache, its generations, and its constants are deleted —
one load per accepted server session, cleared on disconnect, absent means
hide); and the per-host version-skew notice
(`src/client-core/version-skew.ts`: host version rides the capability
advertisement additively, remediation text names the gated features,
dismissal keyed `${hostId}:${clientVersion}:${serverVersion}`, purged when a
host is forgotten; `serversStore.versionSkewNoticeFor()` is the surface API
— host rows rendering it is follow-on UI alongside sidebar task-domain
freshness). **Step 4 core shipped** (2026-08-14): catalog-driven web boot — no
winner-picking, the workspace mounts whenever the catalog holds any host,
the hostless home means an empty catalog, `CHOOSE_HOST_KEY` and
activation-by-reload for logout are gone ("switch server" opens the in-app
server surface), a pre-mount credential rejection yields to the next
catalog candidate instead of rebooting into a picker, and the serving
origin joins the catalog as a platform-managed entry (auto-registered,
never persisted, conferring nothing). **WS tickets shipped**: the
long-lived credential travels only in HTTP headers; each dial exchanges it
at `POST /auth/ws-ticket` for a five-minute single-purpose ticket in its
own signature domain; the handshake verifies tickets (token-in-auth was
removed in the 2026-08-15 compatibility cleanup).

**Step 6 core shipped** (2026-08-14): the durable send outbox
(`src/client-core/send-outbox.ts`) — keyed by the renderer's existing
`clientPromptId` idempotent ids, FIFO drain per host, transient failures
requeue untouched while domain failures park the entry for the
`wait | remove | send` delivery decision, schema-versioned persistence that
survives restart, corrupt queues deleted, purged on host forget.
**Deliberately unwired**: the composer send path and drain-on-live hookup,
because the renderer's `OutboundPrompt` pipeline is mid-refactor in the
maintainer's working tree — the outbox consumes that shape at one named
seam (`SendOutbox.drain` + `serverConnections.onPhaseChange`) when it
settles.

**Step 6 complete** (2026-08-14): the outbox is wired end-to-end.
`promptTab` persists every send before dispatch (durability first), removes
it on host acceptance, keeps it for the drain on a transport death, and
retires it to the in-session failed-prompt UI on a domain refusal;
`redeliverOutboxPrompt` replays drained records through the live prompt
path when a supervisor reports `connected`; and the control plane dedupes
`clientPromptId` server-side (`disposition: 'duplicate'`), so a replay can
never double-run. Both web and mobile ride the shared send path.

**Step 7 complete** (2026-08-14): the settings split demanded by the
client-focuses contract turned out to already hold structurally — the
entire renderer settings context persists to client localStorage and never
crosses the wire, while host-authoritative settings (remote access,
projects base directory, task lifecycle policy, provider auth) already
live host-side behind their own RPCs; this paragraph is the explicit
statement of that contract. The missing half was **activity leases**, now
shipped: clients heartbeat foreground visibility (`activityLease` RPC,
10s beat against a 20s TTL — `src/main/server/activity-leases.ts`), and
the host defers watch-fired git-status recomputes while no client holds a
foreground lease, flushing the deferred dirt the moment one returns.

**Step 5 deletion sweep** was mapped and classified before implementation
(218 call sites: 73 host-derivable-in-scope, 81
client-global needing an explicit choice, 53 local-platform, 11 dead; the
complete file:line inventory with per-site classifications lives in
[dispatch-client-step5-inventory.md](./dispatch-client-step5-inventory.md)). It shipped as a branch-scale hard cutover
in the WP1 mold: `primaryApi()`/`eventsForPrimary()`/the no-arg
`connectionFor()`/the web `local` alias/`switchTo`-reloads together and
were deleted together and every site was fixed per its class, with tab
persistence re-keyed per session host as the enabling prerequisite. The remaining
credential-storage riders (HttpOnly origin cookie and IndexedDB/secure
storage, which force the synchronous `server-registry` API async) remain
separate hardening work.
**Extends**: [multi-host-parity](./multi-host-parity.md),
[ADR-0008](../adr/0008-the-renderer-addresses-hosts-not-an-ambient-api.md),
[ADR-0009](../adr/0009-every-domain-declares-its-host-ownership.md).
**Amends**: [ADR-0012](../adr/0012-the-workspace-requires-a-host-and-trust-is-per-requester.md)
(the workspace-requires-a-primary invariant is restated below; the per-requester
trust model is unchanged).
**Reference**: t3code (`/Users/sidhu/t3code`), especially
`docs/internals/remote.md`, `docs/internals/connection-runtime.md`, and
`packages/contracts/src/settings.ts`. Solus keeps its own words — **host**
where t3code says "environment" — but adopts the contracts.

## The model

The web and mobile client is a **dispatch client**. It does not connect *to* a
server and live there; it holds a **host catalog** — a client-local set of
known hosts — shows one aggregated picture of the sessions across them, and
starts new work by **dispatching a session to a chosen host**. A session names
its host; the client itself is host-agnostic.

The desktop app explicitly diverges: it *is* a machine, and its own server is a
platform-managed catalog entry that behaves as local. That divergence is a
per-platform contract, not an accident.

## Locked vocabulary

- **host catalog** — the client-local set of known hosts. Replaces "saved
  servers + active server" as the governing concept. An entry is either
  *paired* or *platform-managed*.
- **paired host** — a catalog entry the user opted into (pairing code, link,
  QR, SSH bootstrap, or trusted-network auto-pair). Persisted, removable.
- **platform-managed host** — an entry the platform supplies and reconciles:
  the desktop app's own server, and — when the web client is served by a Solus
  server — that **serving origin**. Auto-registered, un-removable, not
  persisted, and otherwise ordinary: it confers no "home" status. A hosted
  static build supplies none.
- **dispatch** — starting a session on a chosen host. The only verb for new
  work on a dispatch client.
- **session host** — the host a session runs on. Every session ref that
  crosses the client is scoped: `{ serverId, sessionId }`. Host-side entities
  stay naked; the client scopes them on read.
- **host supervisor** — the one owner of a host's connection lifecycle and
  retry policy. One per catalog entry, eagerly desired; transports and RPC
  layers below it never retry.
- **client-scoped state** — state no single host can own: catalog order,
  sidebar sort/grouping, view preferences, aggregation choices, favorites.
  Lives on the client (localStorage / desktop bridge), never crosses the wire.
- **host-authoritative state** — state a host owns and syncs to every client:
  sessions, tasks, works, pins, server settings. Per-host capabilities gate
  actions; an absent capability hides the action.

## Decisions (settled with the maintainer, 2026-08)

1. **Founding invariant restated.** Old: "the workspace mounts only with a
   primary host." New: **every session names its host; the workspace mounts
   unbound.** The hostless home now means "empty host catalog," not "no
   primary chosen."
2. **The serving origin auto-registers but confers nothing.** Shipping the web
   client from the server stays — it is the easy path in — and boot
   auto-registers that origin as a platform-managed catalog entry (using the
   existing `/health` descriptor and per-requester trust). It is one host among
   several from the first frame. The client is host-agnostic unless the user
   opts in and pairs.
3. **Client focuses, not server focuses.** Aggregated surfaces and their
   presentation (sorting, grouping, filters, layout) are client-scoped by
   definition — no host can own the ordering of a list that spans hosts.
   Mirrors t3code's `ClientSettings` (local-only) vs server-authoritative
   split in `packages/contracts/src/settings.ts`.
4. **Aggregation includes unreachable hosts.** The session list shows each
   catalog host's last-known sessions with an explicit per-host sync state.
   Connection health and data sync are separate axes: a healthy socket with a
   failed sync shows "connected, sync error," and cached snapshots render
   while offline — never a lying spinner, never cached data overwriting newer
   live data on reconnect.

## What changes (by owner)

- **Boot (`client/src/main.ts`)** — no winner-picking. Mount the workspace
  with the catalog; the hostless home appears only when the catalog is empty.
  `registerPrimary`, activation-by-reload, and `CHOOSE_HOST_KEY` retire.
- **`ServerConnections` (`src/client-core`)** — becomes the host-supervisor
  registry: one supervisor per catalog entry, eagerly desired, sole retry
  owner, per-host phase (`connecting | reconnecting | connected | blocked |
  offline`). `primaryApi()` / `eventsForPrimary()` and the web `local` alias
  in `resolveId` are deleted; every caller names a host (ADR-0008's endgame).
- **`serversStore`** — drops the synthesized web "local row" and
  `switchTo`-reloads. Hosts are symmetric rows with per-host status; the
  Run-on picker on web lists hosts with no "stay here" special case.
- **Session surfaces** — sidebar/history aggregate by fanning out over the
  catalog (per-host snapshot → per-host refs → flattened list, memoized per
  host), the shape `subscribeAllHosts` already anticipates.
- **Tab persistence** — keyed per session host, not per primary installation.
- **Uploads, voice, assets, token refresh** — routed to the session's host,
  never "the" server.
- **Desktop** — unchanged behavior, now stated as a platform contract: the
  local server is its platform-managed entry; platform capabilities that web
  and mobile lack (local FS, SSH bootstrap) fail typed as unsupported rather
  than branching the shared runtime.

## Migration order

Each step ships alone; desktop behavior never changes. The t3code adoptions
(surveyed 2026-08) are folded into the step they ride with.

1. **Scope every session/tab/ref by `serverId` end-to-end** (finishes
   multi-host-parity's addressing work). Riders:
   - Contracts become skew-safe here: additive schemas only,
     forward-compatible decoding (filter undecodable array elements, defaults
     for new fields) — a decode failure never takes down a connection. No RPC
     protocol version number, ever; named capabilities do skew work.
2. **Aggregate the session sidebar/history across catalog hosts.** Riders:
   - The freshness ladder: every per-host domain reports
     `empty | cached | synchronizing | live` with `error` as an independent
     field, never a status. Cached data renders while offline; no spinner may
     claim more than the ladder knows.
   - Snapshot over HTTP, deltas over WS; a resume cursor is valid only within
     one server session — a new session re-fetches the authoritative snapshot
     before applying deltas.
   - Cache schema versions bumped for rollback safety; corrupt records are
     deleted and treated as cache misses.
3. **Introduce host supervisors** (one per catalog entry, sole retry owner);
   per-host connection phase in the UI; retire the global banner on web.
   Riders:
   - Wakeup taxonomy: foregrounding *probes* a healthy session instead of
     reconnecting; only a meaningful mobile suspension resets the retry
     ladder; plain activation is ignored during an in-flight attempt.
   - Transport failures never resubscribe (the supervisor replaces the
     session); domain failures never tear down the transport, and are shown
     as the domain's error — never as a fake reconnect.
   - Capabilities become session-scoped and reset on disconnect; absent means
     hide the action, never probe.
   - Per-host version-skew notice with capability-derived remediation text,
     dismissal keyed by `${hostId}:${clientVersion}:${serverVersion}`.
4. **Kill the primary at web boot**: catalog-driven mount, serving-origin
   auto-registration as a platform-managed entry, hostless home = empty
   catalog. Riders (auth hardening — this step touches every credential):
   - WS auth moves to short-lived single-purpose tickets; the long-lived
     credential only ever travels in HTTP headers.
   - Serving-origin auth becomes an HttpOnly cookie; remote host credentials
     move out of plain localStorage into IndexedDB (web) / secure storage
     (mobile), separated from profiles.
   - Per-method scopes typed exhaustively server-side: registering an RPC
     without choosing a scope is a type error.
   - Forgetting a host is total: a cleanup contract purges that host's
     drafts, outbox entries, caches, and dismissals on removal or platform
     de-registration.
5. **Delete the web `local` alias, `switchTo` reloads, and primary
   fallbacks**; the Run-on picker becomes symmetric on web.
6. **Durable send outbox — web and mobile** (t3code ships mobile-only; the
   web composer is Solus's primary surface, so both): optimistic publish with
   confirm-durability-before-dispatch, a delivery-action state machine
   (`wait | remove | send`), transient-vs-domain failure classification,
   client-generated idempotent ids. Queued work survives a dead host and
   drains when its supervisor reports live.
7. **Split client-scoped settings from host-authoritative settings**
   explicitly (the client-focuses contract), including client-side activity
   leases: clients report visibility/focus and ref-counted subscription
   scopes on a TTL, and hosts skip expensive polling (git status,
   diagnostics) with no foreground lease.

## Deferred and declined

- **Relay fan-in** (push notifications for NAT'd hosts, hosted-web →
  home-machine tunnels): adopt after the steps above, reusing the existing
  Cloudflare tunnel integration. The relay brokers credentials and push; it
  never proxies application traffic. Push deep-link payloads are normalized
  and allowlisted, handled once.
- **No caching service worker** (a stale app shell against newer servers is a
  worse failure mode than no offline shell; the push-only service worker
  stays) and **no protocol version number** — both deliberate, both validated
  by t3code.

## Open questions

- Pill mode on desktop with multiple live hosts: which host does the summoned
  composer default to — last dispatched, or the local platform entry?
- Does mobile push routing need changes once several hosts are live at once
  (today it resolves by installation id, which already fits)?
- Where the host catalog lives for the hosted-static web build (localStorage
  today; is that durable enough, or does it warrant export/import?).
