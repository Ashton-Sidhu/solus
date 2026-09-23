# Session messages: integration plan

Status: stage 2 done in the working tree (uncommitted); stage 1 cuts and its
call-count test are in the working tree, the provider kill test is not written.
Stages 3–4 not started. Design: `002-session-exchange.md`.
Revised 2026-09-23 against HEAD `07624969`.
Task: `01M2RDBWB45CX4C3EFFKWJ9Q5S` — Reliable Parent Task Orchestrator.

## Goal

The task asks for one long-running parent conversation that creates,
coordinates and monitors child sessions, routes their questions back to the
parent, and does small management actions such as opening pull requests. It
replaces today's finicky manual session workflow.

This plan reaches that goal in four stages. Each stage is useful alone.

| Stage | What it gives | New database calls |
| --- | --- | --- |
| 1. Fewer calls today | A resumed typed turn cut from 24 calls and 7 commits to 5 calls and 2 commits (done) | Fewer, not more |
| 2. Reliable in memory | Today's session flows stop losing replies, stranding cards, and misrouting answers while the host runs | None |
| 3. Durable messages | Queued follow-ups, owed results and dead children survive a host restart | The `session_message` table |
| 4. The coordinator | One long-running parent per task that delegates, monitors, answers, and opens pull requests | None beyond stage 3, plus one row per coordinator turn |

## Why the database, and only where

Everything in this plan works in memory while the host process lives. The
database is only for a host restart or crash. Both providers run as
non-detached children over stdio, so every running turn dies with the host.
That leaves three facts worth a durable write:

- **A queued input that was never sent.** It is in no provider transcript.
- **A turn someone depends on.** If it dies, the sender must be told.
- **A result owed to a session.** A busy parent must still receive it.

Stage 2 fixes the bugs that happen with the host running. Stage 3 adds the
durable writes, because the coordinator in stage 4 runs for hours and will span
restarts from app updates, crashes, and Solus development done inside Solus.

## Stage 1 — Fewer database calls today

One pull request per numbered change. None depends on the new table.

### 1.1 Measure

Add a focused test that counts database calls for one typed turn and one
delegation round trip. Use a fake backend with the existing control-plane test
setup (`tests/unit/control-plane-seats.test.ts`) and a temporary
`SOLUS_DATA_DIR`. Wrap the injected connection so every `prepare().run/get/all`
and `exec` is counted. Record the measured numbers here. Every later change
updates the expected counts in this one test, so a regression fails it.

Also add the kill test the rest of the plan depends on: spawn each provider's
child process the way its adapter does, kill the parent process, and assert the
child exits. If a provider survives, stop and revisit the design.

### 1.2 Result (done, uncommitted)

Measured by `tests/unit/session-turn-db-calls.test.ts` on an unlinked host.
Cuts made: status written only when the mapped record status changes; the
runner-delivery listener attached only while linked; lineage registered once per
thread and its reads cached; a start indexed once; seat and goal lookups cached.
The kill test passed for both provider CLIs (idle, with no turn running).

On 2026-09-23 the turn ledger was deleted as well. It wrote `session_turn` twice
per turn, and no production code read it: `TurnLedger.forSession` had test
callers only. `TurnActor` moved to `seats/seat-manager.ts`. Existing
`session_turn` rows stay in host databases; nothing reads or writes them.

| Turn | Before stage 1 | After cuts | After ledger removal |
| --- | --- | --- | --- |
| Resumed typed turn, no task | 24 calls, 7 commits | 7 calls, 4 commits | **5 calls, 2 commits** |
| Resumed typed turn with a task id (what the client sends for a task-bound session) | not measured | not measured | 12 calls, 2 commits |
| First turn of a session | 47 calls, 8 commits | 42 calls, 8 commits | 40 calls, 6 commits |

### 1.3 Who reads each remaining call

Every remaining call on a resumed turn was traced to its caller and to the code
that reads what it writes or returns.

| Call | Caller | Reader | Verdict |
| --- | --- | --- | --- |
| `UPDATE session_records` status `running` at turn start | `_writeSessionRecordStatus` from `_applyStatus` | Boot sweep `markOwnRunningSessionRecordsInterrupted`: tells parents a child died with the host, and mirrors the killed turn when linked. `last_activity_at` orders the session list (`sessionsFromRecords`). Cloud records when linked. | Keep |
| `UPDATE session_records` status `idle` at turn end | same | Same readers. Without it, boot marks every session interrupted. | Keep |
| `SELECT task_session_links` + `SELECT tasks` (no task id on the prompt) | `_turnTask` → `Task.forSession` | The `taskId` and title on the turn's trace (`sessionEmitter.completeSetup`) for insights | Keep the data; cache the binding per session and drop the 2 reads |
| `SELECT sessions` by id at turn end | `_syncAttention` → `finishedSummary(getIndexedSession(...))` | The text of the "finished" attention entry and push notification | Keep. One indexed read, no commit |
| 7 task snapshot SELECTs (task id on the prompt) | `_taskSystemContext` → `taskSnapshot` | The task packet in the system prompt, rebuilt every dispatch so the agent sees live status and comments | Keep. It reads the task row twice |
| `SELECT tasks` again (task id on the prompt) | `_turnTask` → `Task.byId` for the title | Trace title | Remove: the snapshot just read the same row |

No remaining per-turn write lacks a reader. The remaining cuts are reads only:
the per-session task binding cache (−2 calls on a turn without a task id) and
the repeated task row reads (−2 on a task-bound turn). The first turn's calls
mint and link the session-born task, index the session, and register lineage.
Each has a reader: the task board, the session list and stable session ids.
Within them the same task row is read seven times.

## Stage 2 — Reliable in memory

These bugs happen while the host is running. None needs a database write.

| Bug today | Where | Fix |
| --- | --- | --- |
| `prompt_session` dispatches before it registers the watch; a fast reply is lost and the tool reports an error | session-tools.ts:608–616 | The reply route is part of the accepted message |
| `create_session` registers its watch after three awaits; a fast child strands its card at "dispatching" | session-tools.ts:753–826 | Same |
| `dispatchToPeer` has the same order | session-review-tools.ts:111–139 | Same |
| `wait_for_session` checks then registers in two steps | session-tools.ts:658–668 | Check and register in one synchronous step |
| Answering a child's question from its card queues text behind the question | AgentConversationCard.svelte:131 | Call `respondQuestion` |
| Cards rebuild from report prose; real ids are lost, so a later result cannot match | agent-conversation-transcript.ts | Rebuild from structured state served by the host |
| `answered` updates carry no id | types.ts:1623 | Every update carries the message id |
| Delegation is recorded after the child starts, and silently does nothing if the child's index row does not exist yet | session-delegations.ts:20 | Parent and root ride on the run request into the child's first index write |

### 2.1 One message command

- A control-plane command `sendSessionMessage({ messageId, targetSessionId,
  text, delivery, wake })`, delivery `auto | queue | steer`. The message id is
  allocated before dispatch: the client prompt id, `<sender>:<tool call id>`,
  or a host UUID. It returns `{ messageId, disposition }`.
- `prompt_session`, `create_session`'s first message, `dispatchToPeer`, the
  card's send and the switchboard all use it. The wake route is stored on the
  accepted request, so no watch is registered afterwards and no race remains.
- `exchangeId` is renamed `messageId` everywhere. One name per concept.
- The completion-route machinery stays in memory for now but is keyed by the
  message id and created at accept. Stage 3 moves the same routes onto rows.

### 2.2 Structured state for cards

- Add one read RPC, `sessionMessagesSentBy(sessionId)`, served from the
  control plane's memory in this stage. It returns each message the session
  sent: target, state, and reply. Handler, preload method and WebSocket path
  together. A client that reconnects to a live host sees exact state.
- The workspace UI rebuilds cards from that RPC. Delete `REPORT_HEAD` parsing,
  `rebuilt:` ids, the 15-second aging of restored exchanges, and the
  created-session regex in `result-projection.ts`.
- The card's answer box calls `respondQuestion` for questions and shows
  permissions as answerable only in the child's own session, as today.

### 2.3 Make a restart visible

Without stage 3, a restart still loses queued follow-ups and owed results. It
must not strand a parent silently. At boot the host already marks its running
session records interrupted (session-records.ts:263). Make that statement
return the affected session ids. For each one that has a parent in the existing
`sessions.parent_session_id` column, queue a report to the parent that the
child was interrupted by a restart. This adds no per-turn calls.

### 2.4 As built

- **One command.** The control plane's `promptSession` is the message command.
  A prompt with a reply route puts the message on the sender's card
  (`dispatched`) before the target can answer it, and settles it `failed` if
  the target never accepts it. `prompt_session`, `dispatchToPeer` and the card
  RPC use it; the tools no longer emit `dispatched`. `create_session` still
  shows its pending card from the tool, because the child does not exist yet;
  its route and parent link go in with the create request.
- **Card sends.** The `promptSession` RPC takes `{ messageId, fromSessionId }`.
  The client chooses the id; the host checks the caller may drive the sender
  too. The reply comes back to the card, not to the sender's model.
- **Answers.** `respondToQuestion` and a plan ruling through
  `respondToPermission` emit `answered` with the message id to every sender
  waiting on that turn, whoever answered: a tool, a card, or a person in the
  child's tab. A card answers a single plain question through
  `respondQuestion`; the `awaiting_input` update carries its `answerKey`.
  Permissions, plans, forms and multi-question requests say "answer in its
  session".
- **Read RPC.** `sessionMessagesSentBy(sessionId)` returns the messages the
  host still carries: `queued`, `running`, `awaiting_input` (with the question
  and its key), and `reply_queued`. A rebuilt card asks once
  (`sent-messages.store`); a message the host no longer carries reads as
  settled. The 15-second aging is deleted.
- **Restart.** The boot sweep returns the interrupted record ids;
  `reportChildrenInterruptedByRestart` queues an `interrupted` report to each
  parent that delegated (`intent = 'delegate'`), once.
- **Rename.** `exchangeId` is `messageId` in contracts, server, UI and tests.
  The `sessions.delegation_exchange_id` column keeps its name.

**Deviation from 2.2, accepted 2026-09-23.** Report-prose parsing, the `rebuilt:`
fallback id and the `sessionId=` regex in `result-projection.ts` stay until
stage 3. Memory does not survive a restart, and the report in the parent's
transcript is the only durable copy of a reply. Deleting the parser now would
drop replies from reloaded cards. Instead each report and tool result names its
message (`message: <id>`, `message=<id>`), so a rebuilt card pairs a reply with
the exact message; the arrival-order fallback remains only for transcripts
written before this change.

**Known gaps until stage 3, accepted 2026-09-23.** A message sent from a card has no transcript row,
so after a reload it is gone from the card. A message whose route was lost to a
restart and whose target was not a delegated child reads as settled with no
reply.

## Stage 3 — Durable messages

The design is `002-session-exchange.md`: one table, and a row written only when
someone other than the turn's author depends on it.

| Path | Calls | Commits |
| --- | ---: | ---: |
| Typed turn, idle session | 0 | 0 |
| Delegation round trip, idle parent, two turns | 4 | 3 |
| Same, busy parent in a typed turn | 5 | 4 |
| Steer from a sender | 1 | 1 |
| Question or answer | 0 | 0 |

**3.1 Table and store.** A host-local migration slot at the end of
`db/migrations.ts`, as `mirror_log` was added. It creates `session_message`.
A new `sessions/session-messages.ts` owns the SQL, caches prepared statements,
and has exact zod row types; `options_json` has a typed schema for the prompt
options a queued row needs to run after a restart.

**Transaction hazard.** There is one connection, and `withTx` joins any open
async transaction (db/index.ts:56–100). A settlement could commit or roll back
with an unrelated awaiting `getDatabase().transaction`. The store must refuse
to open its transaction while another is open. Cover it with a test.

**3.2 Control plane on the table.**
- Accept: a routed turn is inserted `running` before launch, and a failed
  insert refuses the launch. A queued input is inserted `queued`. An accepted
  steer from a sender is inserted `consumed`. A typed turn writes nothing.
- Settle: the run's done handler becomes the single settlement point. One
  transaction settles the turn, inserts a result per distinct wake route (born
  `running` when the recipient is idle), and claims the next queued row. The
  exit handler launches the claimed row without another write.
- Delete the in-memory route machinery from stage 2 in the same change:
  `completionRoutes`, `_deliverCompletionRoutes`, `_dispatchSessionReport`,
  `_cancelPendingAgentReplies`, `_cancelAgentConversationRunWatches`. No dual
  writers.
- Boot: after the record sweep, one transaction re-queues killed result
  deliveries, fails other killed routed turns and owes their outcome to each
  wake route. Queued rows restart when their session is idle. Stage 2.3's boot
  report is deleted; this replaces it.
- `sessionMessagesSentBy` reads the table instead of memory.

**3.3 Docs.** Update `docs/plans/cloud-service-model.md` §13 and §19: queued
prompts become durable on the host that runs the session; the cloud still holds
no prompt rows. Session transfer (§25) must move or refuse sessions with
unfinished rows.

## Stage 4 — The coordinator

The coordinator is an ordinary session in a coordinator role, bound to one root
task. The host keeps scheduling, routing, retries and ownership. The model keeps
the decisions. No new table: tasks, subtasks and session links already exist.

### Goal coverage

| Task requirement | How the design meets it | Stage |
| --- | --- | --- |
| One long-running parent conversation | The coordinator is one session bound to the root task with a `coordinator` link in `task_session_links`. Provider compaction and the existing lineage handoff keep one conversation across context limits. Its turns are written `running` with itself as the wake route, so a turn killed by a restart resumes after boot with a notice. | 3, 4 |
| Creates child sessions | `create_session` with the message command: child, first message and parent link are accepted together before launch. Each child is linked to a subtask with `create_task` and `link_task`. | 2, 4 |
| Coordinates children | Follow-ups, steers and stops go through the one message command. Queued follow-ups survive restart. | 2, 3 |
| Monitors children | A child's result wakes the coordinator. A child that fails, is stopped, dies to the watchdog, or dies with the host reaches the coordinator as a result with that outcome. `read_session` and `find_sessions` stay for progress checks. | 2, 3 |
| Routes questions back to the parent | A child's question wakes its waiting sender in memory. The coordinator answers with `answer_session` or `review_plan`. Permission requests still need a person (the existing permission boundary); the coordinator is told the child is waiting on a person. | 2 |
| Opens pull requests | A new agent tool, `create_pull_request`, runs the existing git action for the child's worktree (`git-action-manager.ts:260`). It already checks for an existing pull request on the branch first, so a retry returns the same one. GitHub is the durable record; no row is needed. | 4 |
| Replaces the manual workflow | Cards, tools and the coordinator share one command and one structured state, on desktop, web and mobile. | 2, 6 |

### 4.1 Coordinator role and wake policy

- Add `coordinator` as a `task_session_links` role, set when a session is
  started for a root task in coordinator mode.
- A coordinator's own turns are written `running` with itself as the wake
  route. Normal settlement never delivers to the turn's own session; only boot
  recovery honors that route, so a turn killed by a restart resumes and nothing
  loops. The proof tests both. This is one extra call per coordinator turn and
  nothing for other sessions.
- Wake policy stays in memory: a result or question from a child wakes an idle
  coordinator at once and waits behind its current turn when it is busy.
  Results arriving together are delivered in one turn.

### 4.2 Pull-request tool

- `create_pull_request({ session_id })` resolves the child's worktree and runs
  the existing git action with commit, push and pull request steps. It returns
  the pull request's URL and number and links it to the child's subtask.
- Claude and Codex both call it as a Solus tool. Unsupported when GitHub is not
  connected: the tool returns the existing "GitHub is not connected" error.

### 4.3 Coordinator UI

- The coordinator is an ordinary tab. Its children appear as its conversation
  cards and as subtasks on the task board.
- Starting a coordinator for a task needs one entry point on the task detail,
  plus the command palette. The reverse is stopping it, which uses the normal
  session stop.

## Decisions required

Before stage 3:

1. **Result delivery after a restart is at least once.** A parent turn killed
   while handling a result sees it again after boot.
2. **Accepted 2026-09-23: no turn ledger.** A turn nobody depends on writes no
   row. Its text stays in the provider transcript.
3. **The cloud plan's statement that queued prompts stay only in memory
   changes.**

Before stage 4:

4. **A child's permission requests stay with a person.** The coordinator is told
   but cannot approve them, as today's tools already enforce.
5. **Where a coordinator starts.** Proposed: the task detail and the command
   palette.

## Surfaces

- **Providers.** Claude steers by input push and has no provider turn id. Codex
  uses `turn/steer` with a turn id check. Stage 1.1 verifies both die with the
  host.
- **Clients.** Desktop, web and mobile share the workspace UI. The new read RPC
  works over IPC and WebSockets. Verify all three, including reconnect and a
  host restart, with a disposable `SOLUS_DATA_DIR`.
- **Connection modes.** Rows live on the host that runs the session. Remote
  clients read them through the RPC. Nothing new is sent to the cloud.
- **Reverse states.** A queued message can be cancelled from a card. A result
  queued for a parent can be dismissed. A coordinator stops like any session.

## Stop conditions

Stop and raise the design question if a provider turn survives a host kill, a
second process writes the table, a reply must be marked handled before the
parent consumes it, or a queued row cannot be restarted from its stored options.
