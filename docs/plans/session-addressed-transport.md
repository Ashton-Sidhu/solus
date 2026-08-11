# Session-Addressed Transport

**Goal:** one id, everywhere. `ControlPlane` keys every map by the session id, publishes `{ sessionId, event }` to the clients watching that session, and the renderer resolves session → tabs itself. The tab registry in the main process is deleted outright, along with the disconnect-grace machinery that exists only to keep tabs alive.

**Status:** the renderer half already landed on the working tree — `SessionEventReducer.apply(sessionId, …)`, `TabRegistry.tabIdsBySession`, `title`/`diffComments*` moved onto `Session`, `Tab` down to `{ id, sessionId, hasUnread }`. This plan changes the main process and the wire to match, and deletes the `feedingTab` shim currently papering over the mismatch.

**Reviewed and ratified.** The two product calls below are the owner's decision and are marked *Confirmed* in place: (1) a transport disconnect never resolves attention (**decision 4**); (2) no backwards compatibility on the wire (above). **Decision 10** was added in review — the plan originally filed `_tabBelongsToOwner` under GC machinery, which was wrong; it is an authorization gate and its removal now has its own justification. **WP4b** was split out of WP4 for the same reason it is dangerous: it is invisible on a single client. WP1's second item is already landed.

**Reference implementation: `~/t3code`.** It already runs the architecture this plan is aiming at, and every locked decision below cites it. Read `packages/contracts/src/orchestration.ts` and `apps/server/src/ws.ts:1270-1395` before implementing.

---

**One correction to the framing, up front.** The instruction was "one id, and it should be the agent id." t3code does have exactly one id — but it is **not** the provider's session id. It is `ThreadId`, an app-owned id minted by whoever creates the thread. The provider's own id is `RuntimeSessionId`, and it appears in **no** contract, event envelope, or subscription — it is used only inside the provider adapter (`packages/contracts/src/baseSchemas.ts:76`, with essentially no consumers outside a test adapter).

It cannot be the provider's id, for two reasons that apply identically to Solus:

1. **It does not exist yet when it is first needed.** t3code's `thread.turn.start` command carries `bootstrap.prepareWorktree` *and* `bootstrap.createThread` under an id the client already holds (`orchestration.ts:733-777`; `apps/web/src/components/ChatView.tsx:5041-5090`). Worktree creation, setup scripts and the `connecting` state all happen before any provider is spoken to. Solus has the same window — `createWorktree` at `control-plane.ts:2069-2114` streams status cards for tens of seconds before `session_init` — and today it addresses that window by `tabId`, which is exactly the thing being deleted.
2. **It changes while the conversation does not.** A provider switch nulls `tab.sessionId` and waits for a new one (`control-plane.ts:944-964`); a fork mints a fresh provider session from an old one. The conversation the user is looking at survives all of it. An address that changes under a stable subject is not an address.

So: **one id, and it is Solus's own `Session.id`.** `agentSessionId` stops being an address and becomes what t3code's `RuntimeSessionId` is — a field on the session record, used at the provider boundary and nowhere else. That is the whole of this plan. If you disagree with this reading, resolve it before WP2; everything downstream assumes it.

---

**Verification gap — read this before trusting a green check.** `tsconfig.json` has `include: ["src/**/*"]`, so **neither `client/` nor `tests/` is typechecked** by the project's own tooling, and `bun run build` does not typecheck `.svelte` at all. This migration is unusually exposed, because **every id in play is a bare `string`**. A renamed `string` parameter that keeps its old callers compiles clean and routes to nothing. Two consequences:

1. Every rename below is sequenced so the compiler *can* catch it (add-then-delete, or rename a field that has no same-typed sibling). Where that is impossible, the plan says "find by hand" and names the grep.
2. Verify all three targets after each package:

```
bunx svelte-check --tsconfig ./tsconfig.json          # src/  — 248-error baseline
bunx svelte-check --tsconfig <tmp with client/src>    # client/ — its own Vite app + demo harness
bunx tsc -p <tmp with tests/>                         # tests/
```

**Baseline:** `bun run build` clean · `bunx svelte-check --tsconfig ./tsconfig.json` = **248 errors** · `bun run test:unit` = **1451 pass / 85 fail / 14 errors**. Diff full-suite failures against that recorded list rather than reading a raw count, and pin `LC_ALL=C` when sorting, or identical sets read as wholly changed.

`client/src/demo/` fabricates `session.eventReceived` payloads directly (`demo/replay/engine.ts:58,87`, `demo/handlers/agent-intercept.ts:21`). It is not typechecked and not covered by `bun run test:unit`. It breaks at WP4 and must change in the same commit.

**No backwards compatibility. — Confirmed by the product owner; do not re-open.** The wire changes shape in place. No dual-ship, no capability gate, no transition window. A version-skewed desktop/web pair drops events silently because every id is a `string`; that is accepted, not designed around. Ship desktop and web from one build.

**Verify after every work package:** `bun run build` (warnings/errors only) and `bun run test:unit`. Do **not** start a dev server; if one is running, read `dev.log`.

**House rules (from CLAUDE.md — binding):** surgical diffs; no pass-through wrappers; delete orphaned code; match existing style; never `git revert`.

## Vocabulary (locked — do not invent synonyms)

- **`sessionId`** — Solus's id for one conversation. The **only** address, on the wire and in every map in `ControlPlane`. **One per session, globally** — not one per client per session. Minted once, by whoever brings the session into existence (the renderer for a fresh UI session; main for an MCP `create_session` or for a session being resumed that main already knows), and **resolved by main** for every client thereafter. Stable across provider switch, fork, resume, reboot and additional clients. Written `sessionId`, never abbreviated, never qualified.
- **`agentSessionId`** — the provider's thread id. A **field on the session, not an address**: it is what gets passed to the backend for `--resume`, and what a row loaded from a provider transcript on disk is matched by. Appears at exactly two seams (below) and nowhere else. Never abbreviated to `sessionId`.
- **The two seams.** `agentSessionId` is legal only where Solus talks to something that has never heard of a Solus session: (a) `_wireBackend`, where backend events arrive tagged with the provider's id and are translated once; (b) `list_sessions` / `getSessionInfo` / the session picker, which read provider transcripts off disk. Everywhere else it is a bug.
- **Watch** — a client listening to a session: `Map<sessionId, Set<clientId>>`, and nothing more. No record type, no status, no timestamps, no device — with one id space there is nothing left for a watch to carry.
- **Fan-out** — one publish per watching client. Two tabs on one renderer = one publish. Desktop + web = two, same payload.

**Never** reintroduce the tab sense of any of this: `getTabClientId`, `_findTabsBySession`, `TabRegistryEntry`, `TabOwner`, `SessionCtx.tabId`, `sourceTabId`, `tabGitEnvironments`, `tabDisconnectGraceMs`, `cancelTab`, `closeTab`, `resetTabSession`, `_setStatus({ tabId })`. After this plan the main process has never heard of a tab.

---

## How t3code does it

Five facts, each of which becomes a locked decision below.

**1. One id in every contract.** `OrchestrationEvent.aggregateId` is `ProjectId | ThreadId` (`orchestration.ts:1246-1247`). Not a provider id in sight. `OrchestrationSession` (`:273-283`) carries `threadId` as its key and `providerName` / `providerInstanceId` as ordinary attributes. The provider is a *property of* the session, not a name *for* it.

**2. The id precedes the session.** `ThreadTurnStartCommand` (`:758-777`) carries `threadId` plus an optional `bootstrap: { createThread, prepareWorktree, runSetupScript }`. A local draft thread already owns its id; the first turn materializes it server-side **under that same id**, and worktree prep runs inside the same command. There is no window in which work is happening under no address. Solus already has the client-side half of this — `SessionDraft` from *Session-First Drafts* — it just mints a *new* `Session.id` at dispatch instead of carrying the draft's through.

**3. There is no subscriber registry.** `subscribeThread` is an RPC that *returns a stream* (`ws.ts:1270-1395`): `orchestrationEngine.streamDomainEvents.pipe(Stream.filter(e => e.aggregateId === input.threadId))`. The subscription's lifetime is the call's scope. A dropped socket closes the scope. There is no client map, no grace period, no adoption, no GC — because there is nothing to garbage-collect.

**4. A thread with no subscriber is normal, not an exception.** `ThreadBackgroundLiveness.ts` exists specifically to track work continuing on a thread nobody is watching, and its doc comment treats an empty registry after restart as *correct* ("orphaned background work is not live"). Compare `control-plane.ts:582-586`, five lines of comment explaining why the exit path must not early-return when no tab is listening.

**5. Resubscribe is sequence-based, and the ordering is documented.** Events carry a monotonic `sequence`; a reconnecting client passes `afterSequence` and gets a bounded catch-up replay, falling back to a fresh snapshot past `THREAD_RESUME_MAX_GAP`. And, verbatim from `ws.ts:1288-1290`:

> Attach live delivery before reading either replay or snapshot state. Otherwise an event published while the snapshot is loading is lost.

That is the same hazard as `bindRuntimeSession`'s `turnText` replay racing `pendingFlush` (**locked decision 6**), found independently. Solus is not adopting event sourcing in this plan, but it must adopt that ordering rule.

## What Solus adopts, and what it does not

| From t3code | Verdict | Why |
|---|---|---|
| One app-owned id, globally unique per session | **Adopt** | The whole migration. Solus already has the id (`Session.id`); it just doesn't trust it as a key. |
| Provider id demoted to a field with narrow seams | **Adopt** | What stops the two-id-space trap from regrowing. |
| Subscription lifetime = the connection; no grace/GC | **Adopt** | Deletes ~11 members that exist only to keep *tabs* alive. |
| Zero subscribers is an ordinary count | **Adopt** | Mostly deletion; also fixes the swallowed headless error. |
| Stream-scoped RPC subscriptions (no registry at all) | **Adopt the semantics, not the mechanism** | Needs a streaming RPC transport Solus does not have. A `Map<sessionId, Set<clientId>>` buys the same lifetime guarantee on the transport Solus does have. |
| `bootstrap: { createThread, prepareWorktree }` in the first turn | **No** | Rewrites dispatch to buy a property Solus already gets from `Session.id` existing before Send. |
| Event sourcing (`decider` / `projector`) | **No** | Solus's persistence is not built on it, and "address events by session" does not need it. |
| Per-session `sequence` + `afterSequence` catch-up | **Not now — next plan** | See below. |

**On sequence numbers, since this is the closest call.** Solus's resume today is `bindRuntimeSession` replaying `turnText` plus `pendingInputEvents` — text and pending input only. Tool calls, status cards and everything else that happened during a disconnect are lost, and `resyncRuntime` papers over it by clearing streaming state. A per-session sequence fixes that properly, and it is the highest-value thing in t3code that this plan does not take.

It is deferred because it is a different project: an append-only per-session event log in main, sequence stamping, and a client-side cursor. That is "make events durable and replayable", not "address events by session". It lands better *after* this plan, on a wire that already has one id — and with no backwards compatibility to honour, changing the wire a second time is free.

**Do not** stamp a speculative `seq` onto the payload now as a down payment. A field nobody reads is dead weight (CLAUDE.md rule 2).

## Why Solus needs this

`ControlPlane`'s own doc comment (`:173-179`) describes the target and then contradicts itself in its last line:

> Tabs are thin subscription records. All session state lives in BackendSession (keyed by agent session ID in activeSessions). Tabs point to sessions via tab.sessionId. **Events are emitted by tabId and routed to that tab's owner.**

1. **Three translations to deliver one fact.** `_findTabsBySession` (`:497`) turns a session into tabs, `emit('event', tabId, …)` (`:561-564`) fans out per tab, `getTabClientId` (`server/index.ts:311`) turns each tab back into the client it came from, and the renderer re-derives the session from the tab.
2. **Duplicate publishes on one socket.** Two tabs on one renderer produce two identical frames; the renderer drops the second via `feedingTab`, whose own comment says it exists only because the wire is tab-addressed.
3. **`pendingFlush` coalesces N times** (`:207`, `:530-544`). Streaming text is buffered *per tab* with independent 300 ms boundaries, so one token stream is chunked differently per tab. `turnText` (`:212`) is already per-session — the right shape, in the same block.
4. **Terminal paths pick an arbitrary tab.** `backend.on('error')` (`:669-678`) takes `tabs[0] ?? pendingHandles[…].sourceTabId`; when that is null it takes an **entirely different branch** (`:678-692`) that deletes the session and never delivers the enriched error to anyone. A headless session's failure is silently swallowed today.
5. **`_setStatus` takes a union of two targets** (`:3069`) and is called both ways from the same file, because a pre-`session_init` dispatch has no provider id and its status still has to reach somebody.
6. **`create_session` cannot answer until the provider does.** It returns `{ agentSessionId }` (`:1602`), resolved at `session_init`, so an MCP caller has no handle on the session it just started until the provider grants one.

227 `tabId` references in `control-plane.ts` exist to serve those six points.

## Locked design decisions (do not re-litigate)

**1. One id: `sessionId`. `agentSessionId` is a field, not an address.**
Per the correction above and t3code fact 1. Concretely: `activeSessions` re-keys from the provider's id to Solus's, and `BackendSession` gains `agentSessionId: string | null` beside its existing `backendId`. Every other map in `ControlPlane` follows.

**1b. Main is authoritative on session identity, because the id must be unique per *session*, not per client.**
This is the load-bearing half of decision 1 and the easiest thing in the plan to get wrong, because getting it wrong is invisible on a single client.

Today `makeSession` mints `id: uuid()` locally (`session.factories.ts:32`), and `resumeSession(meta)` — driven by `getSessionInfo(agentSessionId)`, which reads a provider transcript off disk — builds a fresh local `Session` with a fresh uuid. So **desktop and web resuming the same session produce two different `Session.id`s today.** If that survives, "one id" is false exactly where it matters: two clients on one session would hold two addresses, `activeSessions` could not be keyed by either, and the plan degrades into a per-client correlation token that has to stop at the socket.

So:
- `watchSession` **resolves, it does not assert.** A client that is resuming sends the `agentSessionId` it read from disk; main answers with the live session's `sessionId`, minting one only if no session for that provider thread exists. A client starting a fresh session mints its own id and main accepts it — nothing else can collide with a uuid that has never left the renderer.
- `resumeSession` therefore cannot fabricate an id before it has talked to the host. It builds its `Session` from main's answer.
- t3code has no equivalent problem because thread identity arrives via `subscribeShell` — the server's thread list — and there is no read-the-transcript-and-mint-locally path for a live thread. Solus keeps that path (the session picker genuinely reads from disk), so it needs this resolution step where t3code needs nothing.

**Test this explicitly:** two clients resuming one live session must land on one `sessionId` and receive the identical payload from a single `publish`. It is the only assertion that distinguishes this design from a per-client correlation token.

**2. Exactly one translation point.** Backends emit `('normalized', agentSessionId, event)` and cannot know a Solus id, so `_wireBackend` holds `agentSessionToSession: Map<string, string>` and resolves once, at the top of each handler. That map is populated at `session_init` and cleared on exit. It is the only place in the file where both ids are in scope; a second one is a design regression, not a convenience.

**3. Subscriptions are `Map<sessionId, Set<clientId>>`, registered explicitly.**
t3code's stream-scoped subscription (fact 3) is the better mechanism, but Solus's transport is a registry-and-topic publisher (`ClientEventRegistry`, `HostEventPublisher`), not streaming RPC. Adopt the *shape*, not the mechanism: a client calls `watchSession(sessionId)` and `unwatchSession(sessionId)`, and the control plane holds nothing else about it. With one id space, a watch has no fields left — no status (that is the session's), no device, no timestamps, no `TabRegistryEntry`.

**4. Disconnect drops the watch immediately. All grace, adoption and GC machinery is deleted.**
`tabDisconnectGraceMs`, `disconnectedClients`, `disconnectedClientTimers`, `_scheduleDisconnectedClientGc`, `_gcDisconnectedClientTabs`, `_clearDisconnectedClientIfUnwatched`, `_adoptDisconnectedSessionWatch`, `_canAdoptTabOwner`, `_adoptTabOwnerIfStale`, `TabOwner`, and the injected `now`/`setTimeout`/`clearTimeout` in `ControlPlaneOptions` (used by nothing else — verified: `this.now()` appears only at `:748`, `:749`, `:1245`, `:1255`). t3code has none of it. All of it exists to stop a *tab* from being collected while its owner reconnects; a session is not owned by a tab and does not need protecting.

**`_tabBelongsToOwner` is deleted too, but it is NOT part of that machinery — see decision 10.** An earlier draft of this plan listed it here, which was wrong: it is a live authorization gate on three mutating RPCs, not a GC helper. Deleting it is a deliberate semantic change with its own justification, not a consequence of dropping the grace timer.

**One behaviour deliberately changes. — Confirmed by the product owner; do not re-open.** Today a disconnect that outlives the grace window closes the client's tabs, and `_closeTabById` resolves attention when the last tab on a session goes (`:1198-1200`). After this, **a transport disconnect never resolves attention** — only an explicit `unwatchSession` (the user closed the last view) does. That is more correct: a session awaiting input still needs you when your laptop is shut, which is precisely what `pushNotifications.sendToOfflineDevices` already assumes. The grace timer was papering over a conflation of "the user dismissed this" with "the socket dropped".

**5. `_setStatus` collapses to one form: `_setStatus(sessionId, status)`.**
The union exists only because a pre-`session_init` dispatch had no provider id. With `activeSessions` keyed by the Solus id and the record created at dispatch rather than at `session_init`, there is one target. `TabRegistryEntry.status` disappears with the registry; the ~17 call sites become one form and **every `for (const tabId of listeningTabIds)` loop wrapped around one is deleted** (`:506-518`, `:653-655`, `:657-661`).

**6. `pendingFlush` keys on `sessionId`, and `bindRuntimeSession` drains before it replays.**
The hazard: `bindRuntimeSession` replays all of `turnText` to a late joiner (`:799-802`). Under a per-*tab* buffer the new tab has no pending entry and resumes from the next chunk; under a per-*session* buffer it would receive the still-pending tail on the next flush, duplicating what the replay just delivered. So: **drain the session's pending buffer to existing watchers, then replay `turnText`, then add the new client to the watch set.** This is t3code's `ws.ts:1288` rule in a different dress. Acceptance criterion, not a note.

The shared flush boundary is also strictly more correct than today's: one stream now produces one chunking, not N.

**7. `session.statusChanged` is addressed by `sessionId` and carries `agentSessionId` as an attribute.**
Payload becomes `{ sessionId, agentSessionId, status, at }`. This is not two addresses. The address is `sessionId`; `agentSessionId` is a correlation *field*, because two consumers legitimately hold only a provider id — `SessionPicker.svelte:395`, live-updating rows that came from `list_sessions` reading transcripts off disk, and `agent-conversation-status.store.svelte.ts:34`. t3code does the same: `OrchestrationSession` is keyed by `threadId` and carries `providerName`/`providerInstanceId` as attributes (`orchestration.ts:273-283`). A snapshot may describe the provider; an envelope may not be addressed by it.

**8. The git environment keys on `sessionId`, and a source with no session registers nothing.**
`setTabGitEnvironment` opens with `const tab = this.tabs.get(tabId); if (!tab) return`. Since *Session-First Drafts* WP4b, `git-actions.svelte.ts:74` passes `tabId: this.sourceId`, which for a draft is a **draft id** — so draft registration already silently no-ops. Preserve that, but make it explicit: the renderer registers `sessionFor(sourceId)?.id` and skips when there is none. A draft still gets git state from the `gitIdentity` / `resolveSessionStartTarget` RPC responses, as today; it does not get the live watcher mirror. **Do not "fix" that here** — it is a feature, not a regression this plan introduces.

`listGitContexts()` returns `Array<GitCheckout & { tabId: string }>` and its only consumer reads `worktreePath` (`server/index.ts:264`). The id is dead weight; return `GitCheckout[]`.

**9. Headless stops being a case.** A session nobody is watching is a session whose watch set is empty. Deleted outright:
- the `:582-586` comment and the tab-loop scaffolding it defends;
- the whole no-tab branch of `backend.on('error')` (`:678-692`) — one path remains: set status, publish the enriched error to whatever clients are watching (possibly none), reject pending starts;
- the first loop of `_checkActiveRuns` (`:2929-2949`), whose only job is reaching `_markSessionDead` from a tab; merged into the session loop;
- `isPendingAttentionLive`'s tab scan (`:1166`);
- `bindRuntimeSession`'s `if (!tab) return null` (`:769`) — opening a headless session's card *is* watching it;
- `createSession`'s wait for the provider: it mints the id, returns `{ sessionId }` immediately, and `agentSessionId` arrives later on the session record.

**10. A watch is the authorization. Any device watching a session may act on it.**

`_tabBelongsToOwner` (`:1204-1207`) is not GC machinery — it is a per-call ownership gate, and it currently refuses three *mutating* RPCs when the caller does not own the tab: `bindRuntimeSession` (`:770`), `resetTabSession` (`:848`) and `closeTab` (`:1157`). Deleting the tab registry deletes that gate. State what replaces it rather than inheriting the answer by omission.

**It replaces with nothing, deliberately.** Every connected client is an authenticated, paired device of one owner — `http.ts` mints pair tokens and session tokens and supports device revocation, so the transport is the trust boundary and this gate never guarded against an untrusted party. What it actually enforced was isolation *between the owner's own devices*, and that is precisely the thing this plan exists to remove: a session watched from a laptop and a phone is one session, and either view must be able to reset or stop it. The current code already concedes the point — `_canAdoptTabOwner` exists specifically to hand a tab to a different device once the first one drops.

So: **membership in `watches.get(sessionId)` is the whole of the check.** `resetSession`, `unwatchSession` and `bindRuntimeSession` verify the caller is watching the session and nothing more. Two consequences to accept knowingly:

- A device can act on a session it is watching but did not start. Intended.
- A malformed or hostile client that guesses a `sessionId` can act on it — but it had to get past device pairing to send anything at all, at which point it can already call `stopSession` with a provider id today (`server/index.ts:245`). No new exposure.

**Do not** reintroduce a per-session owner field to recover the old behaviour. That is `TabRegistryEntry` with one member, and it makes two devices on one session illegal — the exact case this plan is built for.

**11. Out of scope, and named so nobody re-derives it.** Event sourcing (`decider.ts`/`projector.ts`), per-session monotonic sequences with `afterSequence` catch-up, and stream-scoped RPC subscriptions. All three are better than what this plan lands, and the sequence number in particular is the principled replacement for the `turnText` + `bindRuntimeSession` replay hack. None of them is required by "address events by session", and each is a larger change than this whole plan.

## Target contract

```ts
// src/main/control-plane.ts — replaces TabRegistryEntry entirely
private watches = new Map<string, Set<string>>()          // sessionId → clientIds
private agentSessionToSession = new Map<string, string>() // the one translation point

// src/shared/types.ts
export interface BackendSession {
  sessionId: string                      // Solus's id — the key of activeSessions
  agentSessionId: string | null          // the provider's, for --resume. Null until session_init.
  backendId: AgentId
  status: SessionStatus
  // …unchanged
}

export interface SessionCtx {
  sessionId: string                      // was: tabId
  agentSessionId: string | null
  // …unchanged
}
```

```ts
// src/shared/host-events.ts
'session.eventReceived': { sessionId: string; event: NormalizedEvent }
'session.errorReceived': { sessionId: string; error: EnrichedError }
'session.statusChanged':  { sessionId: string; agentSessionId: string | null; status: SessionStatus; at: number }
// HOST_EVENT_DEFINITIONS descriptions change from "for an owned tab" to "for a
// watched session" — they are the only prose contract on these topics.
```

```ts
// ControlPlane — the whole routing surface
private _emit(sessionId: string, event: NormalizedEvent): void
private _emitExcept(sessionId: string, exceptClientId: string, event: NormalizedEvent): void
private _setStatus(sessionId: string, status: SessionStatus): void   // one form

/** Resolves identity, then subscribes. `sessionId` is the client's own id for a
 *  session it is starting; `agentSessionId` is set when the client is resuming a
 *  provider thread it read off disk and does not yet know Solus's id for.
 *  Returns the authoritative id — which may not be the one passed in. */
watchSession(input: { sessionId?: string; agentSessionId?: string }, clientId: string): { sessionId: string }
unwatchSession(sessionId: string, clientId: string): void
clientsWatching(sessionId: string): readonly string[]
```

```ts
// src/main/server/index.ts — the whole routing layer
controlPlane.on('event', (sessionId: string, event: NormalizedEvent) => {
  events.publish(controlPlane.clientsWatching(sessionId), 'session.eventReceived', { sessionId, event })
})
```

`HostEventPublisher.publish` already accepts a `readonly ClientId[]` and dedupes (`host-event-publisher.ts:17-21, 42`), so the fan-out primitive needs no change.

RPC deltas in `src/shared/rpc.ts` (each also re-exposed in `src/preload/index.ts`):

| Was | Is |
|---|---|
| `createTab(clientTabId?)` → `{ tabId }` | `watchSession({ sessionId? , agentSessionId? })` → `{ sessionId }` — resolves identity (**locked decision 1b**), so the answer may differ from the argument |
| `closeTab(ctx)` | `unwatchSession(sessionId)` |
| `resetTabSession(ctx)` | `resetSession(ctx)` |
| `switchSessionAgent(tabId, provider)` | `switchSessionAgent(sessionId, provider)` |
| `stopTab(ctx)` → `ControlPlane.cancelTab` | folds into the existing `stopSession(sessionId)` (`server/index.ts:245`), which today takes a **provider** id from MCP callers and now takes a Solus one — one method, one id space |
| `createHeadlessSession(req)` → `{ agentSessionId }` | → `{ sessionId }`, returned before the provider answers |
| `bindRuntimeSession(ctx)` | unchanged name; keys off `ctx.session.sessionId`, and now creates the watch if absent |

---

## WP1 — `SessionCtx.sessionId`, additive (no behavior change)

**Files:** `shared/types.ts`, `contexts/workspace/ipc-context.ts`, `workspace.context.svelte.ts`.

1. Add `sessionId: string` to `SessionCtx` **beside** `tabId`. `IpcContextBuilder.forTab(tabId)` (`ipc-context.ts:38`) fills it from `sessionFor(tabId)?.id ?? ''`. Nothing in main reads it yet.
2. ~~Fix the renderer sites passing a tab id into the session-addressed `handleError`.~~ **Done — landed already.** Six sites, not three: `handleError` at `workspace.context.svelte.ts:1836/:2111/:2136` (found by this plan), plus `clearStreamingText(targetTabId)` at `:1539` and `refreshTurnSnapshots(tabId)` twice in `DiffPanel.svelte` (found by sweeping for the same class). All resolved through `registry.sessions[…]`, which a tab id never matches, so a failed dispatch, a retry, a session reset and the diff turn-stepper were each silently no-oping. Verified: build clean, svelte-check 248, unit failure set unchanged.

**This is the plan's own thesis, demonstrated.** Every one of the six compiled cleanly because `tabId` and `sessionId` are both `string`. Treat it as the standing warning for WP2–WP6: after each rename, grep the call sites by hand — `rg 'handleError\(|clearStreamingText\(|refreshTurnSnapshots\(' | rg -i 'tabid'` is the shape that found the last three.

**Acceptance:** build + unit green, zero wire change. A dispatch rejected by the host (offline server, bad cwd) shows its error in the conversation instead of nothing.

## WP2 — Main learns the session id

**Files:** `shared/types.ts`, `control-plane.ts`, `server/handlers/session-handlers.ts`.

1. Rename `TabRegistryEntry.sessionId` → `agentSessionId`. A one-field rename done **alone and first**, because from WP3 onward the record has a second string called a session id, and mechanically porting `tab.sessionId` would compile clean and route to the wrong space. Renaming now makes each of its ~60 readers a compiler error while there is still only one meaning to get right.
2. Add `sessionId: string` to `TabRegistryEntry`, populated from `ctx.session.sessionId` (WP1) via `createTab` / `bindRuntimeSession`. Nothing routes by it yet.
3. `BackendSession` gains `agentSessionId`; `BackendSession.sessionId` still holds the provider id for one more package.

**Acceptance:** build + unit green, zero behavior change. `rg '\.sessionId' src/main/control-plane.ts` returns only `BackendSession`/`activeSessions` reads and the new inert field.

## WP3 — Re-key the control plane

**Files:** `control-plane.ts` (and its tests). No wire change; the tab registry survives this package as a routing detail.

1. Add `agentSessionToSession` and resolve once at the top of each `_wireBackend` handler (**locked decision 2**). Populate at `session_init`, delete on exit.
2. Re-key every map to `sessionId`: `activeSessions`, `activeRunRequests`, `requestQueue`, `turnText`, `pendingFlush`, `rateLimits`, `questionIdToSession`, `missingRunCounts`, `agentConversationWatches`, `pendingHandoffs`, `pendingSetupControllers`. `BackendSession.sessionId` becomes the Solus id and `agentSessionId` the provider's.
3. `_setStatus(sessionId, status)` — one form, no union (**locked decision 5**). `_applyStatus`'s three branches (`:3074-3134`) collapse to one.
4. `SessionRunRequest.sourceTabId` → `sessionId` (`:139`), and the same on `RunHandle` (`agents/agent-backend.ts:32`) and `QueuedRequest`. `DispatchTarget`'s `{ kind: 'session'; sessionId }` now means the Solus id.
5. `createSession` mints a `sessionId`, records the session at dispatch, and returns `{ sessionId }` without awaiting the provider (**locked decision 9**). MCP session tools (`promptSession`, `stopSession`, `getSessionInfo`, `watchSessionSettled`) take Solus ids; the disk-backed ones (`listSessions`, `loadSessionTail`, `listPlans`) keep provider ids — that is seam (b).

**Acceptance:** build + unit green. `agentSessionId` appears in `control-plane.ts` only inside `_wireBackend`, `SessionRunInput` construction, and the disk-backed session-tool adapters. An MCP `create_session` returns its handle before `session_init`.

## WP4 — The wire cutover

**This package cannot be split.** The payload rename is a hard cut across three trees shipped as one artifact: `src/main/`, `src/renderer/`, `client/src/demo/`. Landing any two leaves the app with no event stream.

**Files:** `control-plane.ts`, `server/index.ts`, `server/handlers/session-handlers.ts`, `shared/types.ts`, `shared/rpc.ts`, `shared/host-events.ts`, `preload/index.ts`, `renderer/hooks/agentEvents.svelte.ts`, `renderer/contexts/workspace/session-bootstrap.ts`, `renderer/contexts/workspace/workspace.context.svelte.ts`, `client/src/demo/replay/engine.ts`, `client/src/demo/handlers/agent-intercept.ts`.

**Main:**
1. Delete `TabRegistryEntry` and `this.tabs`. `watches = Map<sessionId, Set<clientId>>` per the contract. `_findTabsBySession`/`getTabClientId` → `clientsWatching`. The three broadcast helpers (`:3201-3231`) collapse to `_emit` + `_emitExcept`.
2. `createTab` → `watchSession`, `closeTab` → `unwatchSession`, `resetTabSession` → `resetSession`, `stopTab`/`cancelTab` → the existing `stopSession`, `_closeTabById` → `_dropWatch`.
3. `server/index.ts:311-325` becomes the routing block in the contract above; `session.statusChanged` gains `agentSessionId` (**locked decision 7**).

**Renderer:**
4. Register **per session, not per tab**. `api.createTab(tabId)` at `session-bootstrap.ts:171` (resync) and `:298` (boot attach) becomes `api.watchSession({ sessionId: session.id })`, iterating `registry.tabIdsBySession.keys()` rather than `Object.keys(ctx.tabs)`. Find live-creation call sites by grepping `createTab(` — **the compiler will not find them**, the argument is a `string` either way.
5. Unwatch when the *last* tab on a session closes. `workspace.context.svelte.ts:1482` already carries that exact predicate (`tabIdsForSession(sessionId).length === 0`) — reuse it, don't re-derive it.
6. Delete `SessionCtx.tabId`. Everything left reading it is a compiler error in `src/`, and **silently fine in `client/` and `tests/`** — run the two extra typecheck targets.
7. **Delete the `feedingTab` shim** (`hooks/agentEvents.svelte.ts:17-34`) and `sessionIdForFeed` with it. Drop the explicit `: { tabId: string; event: NormalizedEvent }` annotation so the payload type is inferred from `HostEventMap` — with it in place the field rename is invisible to the compiler.

   **`sessionIdForFeed` does two jobs; only one of them goes away.** Besides the tab dedupe, line 29 guards `conversation.run.serverId !== connection.serverId` — the renderer holds one `ManagedConnection` per host and each subscribes to this topic independently, so an event must be matched against the session's own host. **Keep that guard:**

   ```ts
   connection.events.subscribe('session.eventReceived', ({ sessionId, event }) => {
     if (session.sessions[sessionId]?.run.serverId !== connection.serverId) return
     session.handleNormalizedEvent(sessionId, event)
   })
   ```

   It is arguably redundant — ids are uuids and a session never moves between hosts (*Session-First Drafts*, correction 2) — but it is the only thing standing between a host-routing bug and events being applied to the wrong conversation, and it costs one line. Deleting it is a separate decision from deleting the shim; do not let it go by accident.
8. `SessionPicker.svelte:395` and `agent-conversation-status.store.svelte.ts:34` read `agentSessionId` off `session.statusChanged` instead of `sessionId`.

**Demo client:** change `tabId` → `sessionId` in all three `client/src/demo/` sites.

**Acceptance:**
- `rg 'tabId' src/main/` returns nothing.
- One session open in two panes delivers **one** `session.eventReceived` per event — asserted in `tests/unit/server-targeted-events.test.ts`, not by eye.
- `tests/unit/control-plane-device-tabs.test.ts:1207` (today `expect(env.events.map(e => getTabClientId(e.tabId))).toEqual(['ws:a','ws:b'])`) is rewritten as two clients watching one session, both receiving the same payload from one `publish`. It is the executable statement of the fan-out rule; do not delete it.
- `feedingTab` is gone from the tree.
- Reconnect after a network gap still resumes a live session (`resyncRuntime` → `watchSession` + `bindRuntimeSession`).
- `watchSession` already *resolves* rather than asserts (the server half of **locked decision 1b** ships here); the renderer still mints locally on the from-disk resume path, which WP4b fixes. Single-client behaviour is unchanged by that gap, which is exactly why it must not be left un-landed.

## WP4b — `resumeSession` adopts main's id

**Split out of WP4 deliberately.** It cannot land before WP4 (`watchSession` does not exist yet), but it is the most behaviourally subtle change in the plan and it is invisible on one client — so it does not belong inside the largest, atomic-across-three-trees package, where a failure could not be attributed. Land it immediately after WP4, alone.

**Files:** `renderer/contexts/workspace/workspace.context.svelte.ts`, `session-bootstrap.ts`.

1. `resumeSession` calls `watchSession({ agentSessionId })` **before** constructing its `Session`, and builds it from the returned `sessionId` instead of `makeSession`'s local `uuid()` (`session.factories.ts:32`). Same for `openTaskLinkedSession` (`workspace.context.svelte.ts:2419`) and `openWork`'s resume arm (`:2302`), both of which reach `resumeSession` via `getSessionInfo`.
2. A restored tab already carries a persisted id and passes `sessionId`; only the from-disk resume path needs resolution. Do not change the fresh-session path — a uuid that has never left the renderer cannot collide.

**Acceptance:** **two clients resuming one live session from the picker land on one `sessionId`** and receive the identical payload from a single `publish`. This is the assertion that separates this design from a per-client correlation token, and it is the one thing a single-client test can never catch. Until it passes, "one id" is true within a client and false across clients.

## WP5 — Delete the disconnect-grace apparatus

**Files:** `control-plane.ts`, `server/handlers/session-handlers.ts`, `server/index.ts`.

Everything listed in **locked decision 4**. `handleClientDisconnected(clientId)` becomes: remove `clientId` from every watch set. `handleClientConnected` has nothing left to do and goes. `ControlPlaneOptions` keeps only `buildHandoff`.

Attention resolution moves from `_dropWatch` to `unwatchSession` alone (**locked decision 4**, second paragraph).

**Acceptance:** close the laptop mid-turn and reopen — the session is still running and re-watching shows the in-flight turn. A session that was awaiting input when the socket dropped is *still* in the attention list on return, and still fired its push notification. `tests/unit/control-plane-device-tabs.test.ts`'s grace/adoption scenarios are deleted, not ported — the behaviour they pin no longer exists.

## WP6 — Git environment

**Files:** `control-plane.ts`, `server/handlers/worktree-handlers.ts`, `server/handlers/session-handlers.ts`, `server/index.ts`, `renderer/contexts/git/session-environment.store.svelte.ts`, `renderer/lib/git-actions.svelte.ts`.

1. `tabGitEnvironments` → `sessionGitEnvironments`, `tabWatchKeys` → `gitWatchKeys`, both keyed by `sessionId`. `_syncGitWatcher` and its cwd ref-counting are untouched — already keyed by checkout.
2. `setTabGitEnvironment` → `setSessionGitEnvironment(sessionId, cwd, gitContext)`; drop the `if (!tab) return` guard.
3. Renderer: `refreshTab`'s `opts.tabId` → `opts.sessionId`, resolved by the caller as `sessionFor(sourceId)?.id`, skipping registration when there is none (**locked decision 8**).
4. `listGitContexts(): GitCheckout[]`. `getGitContext(sessionId)`; its one caller is `resetSession`'s finder warm-up (`session-handlers.ts:201`).

**Acceptance:** an external `git checkout` in a session's worktree still mirrors live, for tabs and split panes alike. Two tabs on one session receive one `git_status`. A draft's Git panel is unchanged.

## WP7 — Headless normalization and the doc

**Files:** `control-plane.ts`, `CLAUDE.md`.

1. Everything in **locked decision 9** not already landed: merge the two `_checkActiveRuns` loops, `_markSessionDead(sessionId)`, collapse `backend.on('error')` to one path, delete the `:582-586` scaffolding, `isPendingAttentionLive` via the watch set.
2. Rewrite the class doc (`:173-179`). Every sentence of it is now false, and it is what taught the tab model to everything above.
3. Update the Codebase Map row in `CLAUDE.md`, which still calls `control-plane.ts` the "sessions, tabs, prompts" orchestrator.

**Acceptance:** a `create_session` agent that dies before `session_init` surfaces its enriched error to a card watching it. `rg 'tab' src/main/control-plane.ts` returns nothing.

---

## Sequencing

```
WP1 ──► WP2 ──► WP3 ──► WP4 ──► WP4b ──► WP5 ──► WP6 ──► WP7
```

Strictly sequential. WP1 and WP2 are independently green and independently valuable (WP2 is the disambiguation that makes WP3 survivable). **WP3 is the largest package and the heart of the plan** — it re-keys eleven maps in a 3282-line file — but it is internal-only and fully covered by the existing control-plane suites. **WP4 is the only atomic-across-trees package**; flag it in review as such. **WP4b must land immediately after WP4** and must not be deferred: between them the app is correct on one client and silently wrong on two, which is the hardest state to notice and the easiest to ship. WP5–WP7 stand alone once WP4b lands and can be reordered among themselves.

Do not add a file to "clean up" while migrating; that hides the diff. If `control-plane.ts` grows during WP3, split it *after* WP7.

**Test debt to expect.** `control-plane-device-tabs.test.ts` (1251 lines) is written against the tab model throughout: rewritten in WP4, and its grace/adoption cases *deleted* in WP5 rather than ported. `tab-registry.test.ts`, `workspace-tab-close.test.ts` and `workspace-tab-git.test.ts` are renderer-side and survive — `TabRegistry` is not going anywhere; only main's copy of the idea is.

**Final integration check:** one session in two panes streams once · a split pane opened mid-turn shows the turn's text exactly once · desktop and web on one session both stream · closing one of two tabs keeps the stream alive, closing both unwatches · a `create_session` agent runs, fails, and reports its error with no tab ever opened · a worktree-backed dispatch streams its setup cards before `session_init` · a laptop closed mid-turn and reopened rejoins the live turn with attention intact.

## Out of scope (follow-ups, in the order they'd pay off)

1. **Per-session monotonic sequence + `afterSequence` catch-up** (t3code fact 5). Replaces `turnText` replay, `bindRuntimeSession`'s pending-input replay, and `resyncRuntime`'s "clear streaming text and hope" with a bounded, correct resume. The single largest remaining correctness win, and the natural next plan.
2. **Carry the draft's id through dispatch** (t3code fact 2). `SessionDraft` already owns an id; `createSession(spec)` mints a second one. Using the draft's would give a session one identity from the first keystroke, and make `bootstrap`-style worktree prep addressable without any special case.
3. **Stream-scoped subscriptions** (t3code fact 3), which would delete `watchSession`/`unwatchSession` and the watch map entirely. Wants a streaming RPC transport Solus does not have.
4. **Live git mirroring for drafts.** Locked decision 8 preserves today's behaviour deliberately.
