# Remote Notifications — sessions on any host can reach the user

**Goal:** a session that needs the user — approval, question, failure — notifies
them regardless of which host runs it, on desktop, web, and mobile. Today only the
primary host can: web push subscribes to the primary connection alone, and desktop
notifications are driven by the Electron main process's own attention service,
which has never heard of remote sessions.

**Status: ready to implement.** Decisions recorded below. This is WP7 item 3 of
[multi-host-parity.md](./multi-host-parity.md); it builds on the implemented WP1–WP6
primitives (`subscribeAllHosts`, scoped session refs, `HostApi`).

- **Decisions**: [ADR-0008](../adr/0008-the-renderer-addresses-hosts-not-an-ambient-api.md),
  [ADR-0009](../adr/0009-every-domain-declares-its-host-ownership.md) (attention
  state is host-scoped; notification *preferences* are client-global).
- **Executing-agent note**: the tree carries the uncommitted multi-host series;
  verify every current-state claim with grep before editing. Line numbers drift.

## Context — what exists right now (verified)

- **Host side is done.** Each host runs an `AttentionService`
  (`src/main/attention/attention-service.ts`, wired in `src/main/server/index.ts`)
  and broadcasts the typed host event `attention.snapshotChanged`
  (`src/shared/host-events.ts`). Web push is server-complete per host:
  `pushGetPublicKey` / `pushSubscribe` / `pushUnsubscribe` RPCs
  (`src/shared/rpc.ts` ~196), VAPID keys and subscriptions persisted per host,
  pushes fired for attention-worthy states (`src/main/notifications/push-service.ts`).
- **Web push client exists but is primary-only.**
  `client/src/lib/web-push.svelte.ts` subscribes via
  `serverConnections.primaryApi().pushSubscribe(...)` — a session on any other
  host pushes to nobody, because that host's subscription table is empty.
- **Desktop notifications are local-only.** `src/main/desktop-notifications.ts`
  listens to the *local* attention service inside Electron main; sessions on
  remote hosts never produce an OS notification.
- **No client consumer of `attention.snapshotChanged` exists in the renderer** —
  in-app badges derive from watched-session state instead, which is why they
  already work for remote sessions while OS-level notification does not.

## Decisions

1. **No relay. Per-host fan-out.** Solus has no cloud component and ADR-0007 keeps
   hosts unaware of each other; the client is the multiplexer. The client
   subscribes (web push) on, and listens (events) to, every relevant host.
   A relay/broker is a product expansion — explicitly rejected here.
2. **Two delivery paths, one policy.**
   - **Connected hosts** → renderer-driven: a client-side notification manager
     consumes `attention.snapshotChanged` via `subscribeAllHosts` and raises
     OS notifications through the client shell. This covers desktop (all hosts,
     including remote) and web-while-open.
   - **Disconnected/background** → web push: each *saved* host holds this
     browser's push subscription and pushes on its own attention transitions.
     Desktop does not register push (the app is either running — path one — or
     not expected to notify).
3. **Preferences are client-global; delivery state is host-scoped** (ADR-0009).
   One notification toggle (existing settings surface) governs both paths;
   per-host subscription records live on their hosts.
4. **Dedup is client-side and key-based.** A notification is identified by
   `(serverId, sessionId, attention category, entry key)` — the attention entry
   key already exists (`attentionEntryKey` in push-service). The manager
   suppresses duplicates between the event path and a late push for the same
   entry; clicking deep-links via the scoped session ref (`session://` links
   carry `serverId` since WP1).

## Work packages

### WP-A — Client notification manager (connected hosts)

- New `src/renderer/contexts/notifications/notifications.store.svelte.ts` (store
  rule: durable behavior in a store, components read it):
  - `subscribeAllHosts('attention.snapshotChanged', (serverId, {entries}) => …)`.
  - Diff snapshots per host; notify only on *newly attention-worthy* entries
    (approval needed, question, failure — mirror the categories push-service
    considers push-worthy). Never re-notify on reconnect replays: seed the
    per-host seen-set from the first snapshot after (re)connect without firing.
  - Suppress when the relevant session's tab is focused/visible (no notification
    for what the user is looking at — check how attention/unread state is already
    surfaced in the sidebar for the idiom).
- Raising the notification:
  - Desktop: extend the existing native notification path so the *renderer* can
    request an OS notification via `localApi` (the shell owns Notification
    display; add the preload/local-api member — it is a client-shell operation
    per ADR-0008). Reuse title/body/deep-link formatting from
    `payloadForAttentionEntry` (`src/main/notifications/push-service.ts`) —
    move/share that formatter into `src/shared/` rather than duplicating.
  - Web: the browser `Notification` API directly when permitted and the page is
    open; push covers the rest.
  - Include the host name in the body for non-primary hosts ("Needs approval —
    <session> on <host>").
- Click → activate the app and open the session via the scoped ref
  (`resumeSession`/`session://` path from WP1; desktop main already handles
  route-open — reuse it).
- **Retire the duplicate**: `src/main/desktop-notifications.ts`'s direct
  local-attention listening is superseded by the manager (which covers the local
  host too). Remove or reduce it to the shell-side display primitive — decide
  from what else it owns; do not ship two sources of the same notification.

### WP-B — Web push goes per-host

- `client/src/lib/web-push.svelte.ts`: subscribe/unsubscribe/refresh iterate the
  *saved* remote hosts + primary (`serverConnections`/server registry), calling
  each host's `pushGetPublicKey`/`pushSubscribe` with that host's key — the same
  browser endpoint is registered on every host (each host pushes independently;
  the service worker displays whatever arrives; include serverId in the push
  payload for the click deep-link — extend the payload in
  `push-service.ts`… note the HOST cannot know its client-facing serverId
  (ADR-0007): instead the service worker resolves the deep-link through the
  scoped session ref carried in the payload (`session://` link built client-side
  at subscribe time is not possible either — so: payload carries `sessionId` +
  the host's `installationId`, and the client maps installationId → serverId on
  click via the saved-server records from WP1's identity verification).
- Subscription lifecycle: subscribe on save/connect of a host (when permission is
  already granted), unsubscribe on host removal (extend the existing removal path
  in the servers store), refresh per host on permission grant.
- Per-host failure isolation: one unreachable host must not block or unwind the
  others (mirror the fan-out error handling in `works.store`).
- Optional: consult the capability record for `push` if
  [host-capability-flags.md](./host-capability-flags.md) has landed; otherwise a
  failed `pushGetPublicKey` on an old host is caught and skipped (do NOT depend
  on that plan — see Parallelism).

### WP-C — Reverse states, settings, mobile

- The existing notification toggle governs both paths; disabling unsubscribes
  everywhere (fan-out) and stops the manager. Surface per the existing settings
  layout — no new settings machinery.
- Host removal → push unsubscribe on that host + drop its manager state
  (tie into the connection/server removal path).
- Mobile (the web client on a phone): same code paths; verify the service-worker
  registration and permission flow function in the mobile layout (no
  mobile-specific work expected — flag anything found instead of building
  around it).

### WP-D — Tests

- Manager: snapshot diffing fires once per new entry, reconnect replay does not
  re-fire, focused-session suppression, dedup against a push for the same key,
  per-host isolation (two hosts, same sessionId shape). Deterministic — inject
  the snapshot events; no timers.
- Push client: multi-host subscribe fan-out (each host receives its own
  subscription), one host failing does not stop others, unsubscribe-on-removal.
- Payload: installationId → serverId click resolution (pure function).

## Hard rules for the executing agent

- Contracts rule for any RPC/payload change (`src/shared/rpc.ts`, handler,
  preload, both transports). No `as HostApi`/`as any` outside `src/client-core`.
- Notifications must be finite and deduplicated — no repeated re-notification
  for a persisting attention entry.
- Never touch live Solus data; push tests use fixtures, not real subscriptions.
- Svelte 5 house rules; `subscribeAllHosts` is the only event mechanism.

## Verification gates

Same as the series: svelte-check ≤ 219 src / ≤ 293 combined, zero new;
`bun run lint:hosts` clean; `bun run build` green; distinct unit failures ≤ 82;
focused tests green.

## Parallelism with host-capability-flags.md

The two plans are independent and can run in parallel:

- Different domains: capabilities = contract + `ServerConnections` cache +
  scattered gating; notifications = attention/push + a new store + client shell.
- Shared-file friction is limited to additive edits in `src/shared/rpc.ts`,
  `src/preload/index.ts`, and possibly `local-api.ts` — trivial to merge.
- The only touch-point is WP-B's *optional* capability check, written to degrade
  gracefully when the capability plan has not landed. No ordering requirement.

Run them in separate worktrees/sessions; whichever lands second rebases over
small additive contract diffs.

## Out of scope

- Any relay, broker, or cloud push service; APNs/native mobile apps.
- Notification history/inbox UI. Per-host notification preferences.
- Provider-specific notification semantics.

## Implementation status — 2026-08-10

- **Implemented:** WP-A through WP-D. Connected-host attention events now feed
  one client notification manager on desktop and web; web push subscribes and
  unsubscribes independently on every saved host; notification clicks resolve
  `installationId` to a host-scoped chat route; the global notification setting
  and host removal both reverse all applicable state. The mobile layout uses the
  same push control, service worker, manager, and click bridge.
- **Checks:** focused notification, push, payload, and route tests: 37 pass,
  0 fail; `bun run lint:hosts`: zero violations; `bun run build`: exit 0;
  `svelte-check`: 218 errors and 32 warnings in 92 files, down from the captured
  219/32/93 baseline, with no new error in a notification-owned file. The full
  unit run reported 1,652 pass, 89 fail, and 16 loader errors; all notification
  domain tests passed. The global failure count is above the plan's recorded 82
  while unrelated multi-host and capability work is changing in the shared
  tree, so the contribution gate is the requested zero new notification-domain
  failures.
- **Deviations:** browsers bind one push subscription and application-server
  key to one service-worker registration. Because each independent Solus host
  has its own VAPID key, the implementation uses one scoped registration and
  endpoint per host rather than trying to reuse one endpoint across keys. Old
  hosts degrade by catching unsupported push RPCs; there is no dependency on
  capability flags. Mobile verification was static only; no browser or live
  push service was started, as required by the repository's verification rules.
- **Simplification pass — 2026-08-10:** connect, save, remove, enable, disable,
  and retry now feed one desired-state reconciliation operation instead of six
  separate subscription branches. A pure reconciliation plan decides which
  hosts subscribe and unsubscribe; each host operation remains failure-isolated.
  Final checks: 38 focused tests pass, host lint is clean, build exits 0, and
  Svelte diagnostics remain 218 errors/32 warnings with none in changed files.
