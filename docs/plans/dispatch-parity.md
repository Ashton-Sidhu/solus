# Dispatch Parity — task context, write-back, and draft inheritance

**Goal:** a dispatched session behaves like a local one. Its agent receives the task
packet, its task tools work, and a draft opened from it inherits where the work
happens. Three defects today, one root cause for the first two: the execution host
hydrates task state from its own sqlite, and on a dispatch the task lives elsewhere.

**Status: implemented.** WP1–WP5 are in the working tree. Deviations found while
implementing, worth keeping:

1. **WP5.3 was already built.** `apiForRun` retains and `ensure`s a remote run's
   connection on use, and released connections regenerate on demand — the
   draft-connection gap this plan described had been closed by the drafts work.
   No code changed for it.
2. **The forced-worktree rule also lives in `runTarget`.** It hard-coded
   `worktreeForced: true` for every dispatch; it now derives from
   `startsWorktree`, so a dispatch continuing inside a session worktree shows
   selectable rows instead of a forced, false "New worktree".
3. **Follow-up prompts need their own snapshot read.** `tasksPrepareForSession`
   only fires on a first dispatch (the no-backfill rule), so a second RPC —
   `tasksSnapshot` — re-reads the task state the packet re-ships on every later
   prompt of a dispatched session.
4. **The snapshot marks foreignness.** The execution host skips its local
   `_linkPreparedTask` write exactly when a snapshot was shipped — no separate
   flag, since shipping one is the definition of "this task lives elsewhere".
5. **Foreign lookups key by the Solus session id, and tools must present it.**
   The ControlPlane holds the snapshot under Solus's `sessionId`, but
   `AgentToolContext.sessionId()` reports the provider's thread id — a
   different string — so every production `foreignTaskFor` lookup missed and
   the tools fell through to the execution host's empty store ("not found").
   The unit tests used one string for both ids and could not see it.
   `AgentToolContext` now also carries `solusSessionId()` (backed by
   `RunHandle.sessionId`); foreign lookups use it, while durable rows
   (comments, links, provenance) keep the provider id.
6. **Linked items ride the snapshot, at per-kind depth.** The packet and
   comments point the agent at linked items, and the execution host cannot
   read the task host's stores. The snapshot RPC sites now wrap `taskSnapshot`
   with `attachLinkedContent` (`src/main/tasks/linked-content.ts`), which ships
   the full content of content-bearing links — works from the folio store,
   plans through the session controller — as `TaskSnapshot.linked`
   (`TaskLinkedItemSnapshot`). PR and automation links ship nothing extra;
   their facts already ride `details.links`. On the execution host:
   `read_work`/`read_plan`/`list_works` serve the shipped copies marked
   read-only; `read_pr` falls back to the link's facts when no provider is
   reachable; `read_automation` serves the link's facts; and every write
   against a shipped item (`update_work`, `comment_document`, automation
   mutations) fails honestly, pointing at `comment_task`. Content ships in
   full on every prompt — ship-on-change is a later optimization if payload
   profiles demand it.
7. **The packet and `read_task` render the Linked list.** Links previously
   rendered nowhere agent-visible, so an agent — local or dispatched — could
   not discover the design doc its task pointed at. `formatTaskContext` and
   `read_task` now list each link with the id its read tool takes
   (`formatTaskLink`).
8. **`works` is the outbox's second domain.** A dispatched session's works
   belong to its task's host: `create_work`/`update_work` record ops instead
   of writing to the borrowed machine (`src/main/folio/work-applier.ts`; the
   dispatch marker is the held foreign snapshot, via `foreignTaskIdFor`). The
   op's resourceId is the work id — minted at record time for a create — and
   the applier writes the row under it (id-keyed idempotence) then links the
   task, so the next snapshot re-ship carries the work back and converges with
   the record-time overlay, exactly as task comments do. Because a create op
   names a work id no host has yet, every works op carries `taskId` and the
   courier's `OwnerResolver` now receives the op group: the works resolver
   locates the owner through the task. A dispatched session without a bound
   task keeps today's local-write behavior — there is no owner pointer to
   route by. Annotations (`comment_document`) remain unsupported cross-host;
   automations and plans can join the same registry later.

- **Decisions**: [ADR-0006](../adr/0006-the-task-host-is-the-projects-host.md)
  (a run names two hosts), [ADR-0007](../adr/0007-clients-ferry-cross-host-writes-through-an-outbox.md)
  (the outbox — read it first; this plan implements its first consumer).
- **Prior art**: [session-first-drafts.md](./session-first-drafts.md) owns the
  draft/`RunConfig` vocabulary used below, and its verification-gap notes
  (svelte-check three-target caveat) apply to every renderer package here.

## The defects, precisely

1. **The task packet never reaches a dispatched agent.** The client mints the task
   on `taskServerId` and sends only a bare `taskId` to `serverId`
   (`workspace.context.svelte.ts` `resolveTaskOnItsHost`). On the execution host,
   `ControlPlane._launchRun` → `_taskSystemContext` → `Task.byId` throws against
   local sqlite; the catch logs `task_context_injection_failed` and the agent runs
   with no packet. Silent degradation.
2. **Agent task tools lie on a dispatch.** `read_task`, `comment_task`,
   `update_task_status` (`src/main/tasks/task-tools.ts`) resolve against the
   execution host's DB and throw `Task <id> not found.` for a task that exists —
   on another machine. The packet's own Work contract instructs the agent to call
   them. `_linkPreparedTask` fails the same way (the renderer already compensates
   at `session_init`).
3. **A draft from a dispatched session inherits imperfectly.** Host ids, working
   directory, and checkout already carry (`inheritRunConfig`); what breaks is the
   forced-worktree rule, sidebar grouping, connection lifetime, the anchor, and
   two draft-id bugs (WP5 enumerates them).

## Vocabulary (locked — do not invent synonyms)

- **Foreign task** — a task whose row lives on a host other than the one executing
  the session. The only test is "not in my sqlite, but named by my session."
- **Task snapshot** — the serializable task state a dispatched prompt carries:
  `{ details: TaskDetails, parent: TaskDetails | null, sessions: TaskSessionLink[] }`
  — exactly `formatTaskContext`'s inputs, so the packet renders from it verbatim.
- **Task packet** — the rendered `[Working On Task …]` system-prompt block
  (existing concept, `src/main/tasks/task-context.ts`). Unchanged in shape.
- **Outbox / op / owner host / applier / drain / ack** — as defined in ADR-0007.
  The op id is minted at record time and is the idempotence key end to end.
- **Courier** — the client-side routine that drains outboxes. One per client
  process; domains give it only an owner-resolution hook.

## Locked design decisions (do not re-litigate)

1. **The client carries the snapshot; hosts never fetch across.** The snapshot
   rides the `tasksPrepareForSession` round trip that already gates every prompt —
   no new gate, no second round trip, per-turn freshness preserved.
2. **Structured snapshot, not a rendered string.** The execution host renders the
   packet itself and serves `read_task` from the same snapshot. One shape, two uses.
3. **Write-back is outbox ops, not a live relay.** `comment` and `set-status`
   only. `create_task` from a dispatched session stays unsupported with an honest
   error — minting on a machine that does not own the project is a product
   question, not a delivery question.
4. **Foreign task tools never throw "not found."** Reads answer from the snapshot
   (plus undelivered-op overlay); unsupported writes name the real situation.
5. **The outbox is generic from day one** (ADR-0007): generic table, RPCs, event,
   applier registry, courier. Tasks are the only registered domain in this plan.
   No speculative second domain ships with it.
6. **Isolation is forced only where its rationale holds.** A dispatch branches a
   worktree because its *base checkout* sits on a machine nobody watches. A draft
   continuing inside an existing session worktree is watched; it behaves like
   local.

## Target contract

```ts
// shared/task-types.ts
export interface TaskSnapshot {
  details: TaskDetails
  parent: TaskDetails | null
  sessions: TaskSessionLink[]
}

// shared/types.ts — PromptOptions gains one field
taskSnapshot?: TaskSnapshot   // present iff the prompt dispatches a foreign task

// shared/outbox-types.ts (new)
export interface OutboxOp {
  id: string                  // ULID, minted at record; the idempotence key
  domain: 'tasks'             // widens as domains join
  resourceId: string          // e.g. the task id; how the courier finds the owner
  name: string                // domain verb: 'comment' | 'set-status'
  payload: unknown            // domain-shaped, versioned by `name`
  sessionId?: string          // provenance
  state: 'pending' | 'failed'
  error?: string
}

// shared/rpc.ts — three invoke methods + one topic
'outboxList'    // ()            → OutboxOp[]           (any host)
'outboxAck'     // (opIds)       → void                 (recording host)
'outboxApply'   // (ops)         → { applied: string[]; failed: { id, error, permanent }[] }  (owner host)
// topic: 'outbox-changed' — emitted by the recording host on record/fail
```

`tasksPrepareForSession` gains `includeSnapshot?: boolean` and returns
`{ task, snapshot? }`.

---

## WP1 — the dispatched prompt carries its task snapshot

**Files:** `shared/task-types.ts`, `shared/types.ts`,
`src/main/server/handlers/tasks-handlers.ts`, `src/main/tasks/task-sessions.ts`,
`src/renderer/contexts/tasks/tasks.store.svelte.ts`,
`src/renderer/contexts/workspace/workspace.context.svelte.ts`,
`src/main/control-plane.ts`.

1. `tasksPrepareForSession` assembles the snapshot when asked (`details()`,
   parent details, `taskSessions`), returns it beside the task.
2. `resolveTaskOnItsHost` requests it when `isDispatch(session.run)` and attaches
   `taskSnapshot` to the prompt options.
3. `_launchRun`: render the packet from the snapshot when present; local
   hydration otherwise (local runs, automations, agent-created sessions are
   untouched). Keep the snapshot on the `BackendSession`. When `taskId` names a
   dispatch and no snapshot arrived, log it as the defect it is — no more silent
   degradation.
4. Skip `_linkPreparedTask` when the task is foreign; the renderer already writes
   the link on the owner host. Kills the `task_session_link_failed` noise.
5. `read_task` answers from the session's snapshot when the id matches its
   foreign task. Refreshes every prompt with the snapshot.

*Acceptance:* unit — packet renders from a snapshot with no local row;
local-path rendering unchanged; foreign link attempt skipped; `read_task` serves
snapshot data. No new RPC round trip on the prompt path.

## WP2 — the host outbox (generic core)

**Files:** `shared/outbox-types.ts`, `shared/rpc.ts`, new `src/main/outbox/`
(store, applier registry, handlers), `src/main/server/index.ts`.

1. Tables: `outbox_ops` (the queue) and `applied_ops` (owner-side guard, keyed by
   op id). Both in the host's existing sqlite.
2. `record(op)` mints the ULID, persists, emits `outbox-changed`.
3. `outboxApply` dispatches to the registered domain applier inside the guard:
   already-applied ids are skipped and reported as applied; applier errors mark
   `permanent` when retry can never succeed (resource gone).
4. `outboxAck` deletes; unknown ids are a no-op (lost-ack redelivery).

*Acceptance:* unit — record → list → apply → ack lifecycle; double-apply is a
no-op; replay after a later human write does not regress it (guard, not
timestamps); permanent failure flags the op `failed` and stops redelivery.

## WP3 — task tools write ops for foreign tasks

**Files:** `src/main/tasks/task-tools.ts`, new `src/main/tasks/task-applier.ts`,
`src/main/outbox/` registration, `src/main/tasks/task-store.ts` (comment insert
accepts a caller-supplied id).

1. Foreign branch in the tools: `comment_task` records `{ name: 'comment' }`,
   `update_task_status` records `{ name: 'set-status' }`; both overlay the op onto
   the session snapshot so the agent reads its own writes; both return plain
   success. Other foreign writes return an error naming the owner-host situation.
2. The tasks applier (registered on every host — any host can own tasks): comment
   inserts with the op id as the comment id; status applies under the guard.
   Provenance (session id, agent authorship) rides the payload.

*Acceptance:* unit — a foreign `comment_task` records an op and a subsequent
`read_task` shows the comment pre-drain; delivery lands it on the owner host
exactly once under redelivery; a foreign `create_task` errors honestly; local
tool behavior byte-identical.

## WP4 — the courier and pending visibility

**Files:** new `src/renderer/contexts/outbox/courier.svelte.ts` (registered from
boot), `src/renderer/contexts/tasks/tasks.store.svelte.ts` (owner resolution
hook), task detail / task card / session task chip surfaces, `client/` and mobile
equivalents.

1. Courier: on `outbox-changed` and on every connection (re)establish, list each
   connected host's ops, resolve owners (tasks: `hostByTaskId`, falling back to
   the store's existing multi-host fan-out), apply per-resource in op-id order,
   ack. Unresolvable owners leave ops pending. Concurrent couriers are safe by
   idempotence — no election.
2. Visibility: pending/failed counts surface where the task surfaces — "N updates
   waiting to sync from «host»" on the task detail and the session's task chip.
   All three clients; a platform exception is a product decision, not an omission.

*Acceptance:* unit — reconnect drains a queued op; owner-unreachable leaves it
pending and visible. UI states exist for pending and failed in dark + light.

## WP5 — draft parity fixes (independent; parallel with WP1-4)

Each is small and separately landable.

1. **`startsWorktree` over-forces** (`run-config.ts`). New rule:
   `(isDispatch(run) && !run.gitContext?.worktreePath) || !!run.worktree`. A draft
   continuing in an existing session worktree stops claiming isolation it never
   creates; a fresh dispatch still always branches. Update the
   `SessionDraftPane` / `refreshEnvironment` callers' expectations and the rule's
   doc comment.
2. **`projectGroupPath` moves onto `RunConfig`** and inherits with the rest, so a
   session opened from a dispatched anchor keeps its sidebar grouping.
   `moveTabToHost` writes it there; `PersistedTab` keeps its field, converted at
   the boundary.
3. **Drafts hold their connection.** A draft whose run names a remote `serverId`
   takes a `serverConnections` reference on create/inherit and releases it in
   `dropDraft`. Remove the `?? window.solus` fallback for runs naming a remote
   host (`session-environment.store.svelte.ts`) — a missing connection surfaces
   as a reconnect state, never as the local API answering for a remote path.
4. **The anchor is the gesture's pane.** `openSessionDraft` takes a
   `sourceTabId`; callers pass the pane the action came from, not `activeTabId`.
5. **`RunOnPicker` draft-id bugs.** `browseHost` emits `requesterId` both app
   shells actually read; `startNewProject` carries the draft id instead of
   passing it as `tabId` and orphaning the prompt.
6. **The web client persists drafts** — mirror the desktop
   `savePersistedSessionDrafts` write path in `client/src/App.svelte`; it already
   restores.

*Acceptance:* unit coverage on rules 1-2 (`inheritRunConfig` / `startsWorktree`
tables); manual-flow checks per the final checklist for 3-6; web draft survives
refresh.

---

## Sequencing

```
WP1 ──────────────┐
WP2 ──► WP3 ──► WP4 ──► integration pass
WP5 (parallel, per-item)
```

WP1 alone already fixes the headline defect (no packet on dispatch) and is
shippable before the outbox lands. WP3 depends on WP1's snapshot (overlay) and
WP2's core. One commit per package; `bun run build` and `bun test tests/unit`
green at every boundary; renderer packages also pass the three-target
svelte-check from session-first-drafts.md.

## Out of scope

- `create_task` / subtask minting from a dispatched session (explicitly
  unsupported, honest error).
- Additional outbox domains (works, plans, automations). The contract admits
  them; no code ships for them here.
- Host-to-host transport, task replication, or mirroring task rows onto the
  execution host — rejected in ADR-0007 and ADR-0006.
