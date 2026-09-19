# Session messages: one-table schema and exact SQL trace

Status: design proof; not integrated into Solus.
Written at base commit `7fc9de3f`, 2026-09-18, against the current working tree.
Task: `01M2RDBWB45CX4C3EFFKWJ9Q5S` — Reliable Parent Task Orchestrator.
Supersedes the two-table (exchange + turn) revision of the same date.

## Accepted direction

User decisions, 2026-09-18:

1. Minimal SQLite persistence. The ControlPlane owns scheduling and routing in
   memory. SQLite stores what a restart must not lose: accepted inputs, launch
   intent, outcomes, and inputs still waiting in a queue.
2. One table. Every row is one input addressed to one session. The row that
   runs a turn is also that turn's ledger entry, replacing the existing
   `session_turn` shape. Steering input, answers, results and questions share
   the table instead of separate receipt, outbox, inbox or request tables.
3. Two commits per turn, idle or busy. One before the provider is called, one
   when the turn settles. The settlement transaction also starts the next queued
   row of the same session, so a busy session never pays a separate dispatch
   commit. There is no separate provider-acceptance commit; provider ids are
   recorded at settlement when the adapter reports them.
4. The same path serves ordinary chat, agent tools, inline cards, automations,
   and the future task coordinator. Peers exchange messages without becoming
   children; delegation ownership is a separate concern above this layer.
5. Host events drive scheduling and client updates. No SQL polling.

## Result

For one request to an **existing idle child**, through storing its result as a
**durable input for the parent**, the proof executes:

- **3 data statements:** 1 INSERT before launch, then 1 UPDATE and 1 INSERT at
  settlement.
- **2 commit boundaries:** the pre-launch INSERT commits alone; settlement and
  the parent input commit together.
- **0 standalone SELECT statements** on the warm, nonduplicate success path.
  Index, constraint and INSERT SELECT reads still occur.
- Compared with the existing ledger's INSERT and UPDATE, **1 additional data
  statement** and one additional row, in exchange for a request that survives
  restart and a result that reaches the parent.

| Path | Data statements | Commits |
| --- | ---: | ---: |
| Idle child request through queued parent result | 3 | 2 |
| Busy child: accept now, start inside the previous settlement, then settle | 4 | 2 |
| Ordinary request with no reply session | 3 (reply writes 0 rows) | 2 |
| Parent consumes a queued result, no automatic reply | 3 (reply writes 0 rows) | 2 |
| Question from a routed running turn | 1 (0 rows without a route) | 1 |
| Answer, any surface | 2 | 2 |
| Steer accepted by a running turn | 2 (accept + consume) | 2 |
| Cancel a session's queue, then stop the running turn | 1 + normal settlement | 1 + 1 |

## Files and verification

| File | Purpose |
| --- | --- |
| `plans/002-session-exchange/schema.sql` | Executable single-table schema |
| `plans/002-session-exchange/statements.mjs` | Every statement used by the proof and benchmark |
| `plans/002-session-exchange/normal-trace.sql` | Exact idle-path SQL with fixture parameters expanded |
| `plans/002-session-exchange/proof.test.mjs` | Statement counts plus failure, restart, question, steer and cancel tests |
| `plans/002-session-exchange/benchmark.mjs` | Disposable local SQLite latency study |
| `plans/002-session-exchange/benchmark-results.json` | Measured samples summarized as percentiles |

Run `node --test plans/002-session-exchange/proof.test.mjs`. To regenerate the
SQL evidence, set `EXPORT_EXCHANGE_TRACE=1`.

The proof uses Node's `node:sqlite` and a new temporary directory for each test,
with WAL and synchronous=NORMAL, matching the host configuration. It does not
import the application database module or touch live Solus data. Do not apply
schema.sql to an existing database; it is not a migration.

Verification on 2026-09-18: **24/24 tests passed** with Node v25.8.1. The
exported normal-trace.sql was replayed against schema.sql in a second temporary
database and produced one completed child turn and one queued parent result with
no foreign-key violations.

## Storage model

One table, `session_message`. Columns in groups:

| Group | Columns | Notes |
| --- | --- | --- |
| Command identity | message_id, actor_user_id, command_key, request_fingerprint | `(actor, command_key)` is unique. Exact retry returns the saved row; changed arguments are rejected. |
| Routing | kind, mode, sender_session_id, recipient_session_id, reply_session_id | kind is instruction, result, question or answer. mode is auto, queue or steer. |
| Payload | text, options_json | Result rows have no text; the payload is on the source row. |
| Links | source_message_id, consumed_by_message_id | Source: the turn a result reports, the turn a question came from, the question an answer answers. Consumed-by: the running turn that accepted a steer or answer. |
| Execution | state, attempt_no, seat_user_id, provider, execution_json, provider_thread_id, provider_turn_id | Filled when the row runs as a turn. Provider ids arrive at settlement. |
| Outcome | result_text, error_text, created_at, started_at, settled_at | |

States: `queued`, `running`, `consumed`, `completed`, `failed`, `cancelled`.
The first two are unfinished and are the only rows recovery reads. `running`
covers launch intent through settlement. A running row found at restart with no
live handle is uncertain: it is reconciled and settled, never relaunched.

Indexes: a partial index on unfinished rows per recipient; a partial unique
index enforcing one running turn per session; an index on consumed-by for
result fan-out; and the seat index the ledger has today. No triggers.

### What each kind means

- **instruction** is what a user, tool, card or automation sends. On an idle
  target it is inserted already `running`. On a busy target it is inserted
  `queued`, and the settlement transaction of the turn ahead of it runs the
  `dispatch` UPDATE that starts it.
- **result** is inserted at the source turn's settlement, one per distinct reply
  session, addressed to that session. It is the durable parent input. It has no
  reply route, so handling a result cannot start a chain of results.
- **question** is inserted when a running turn with a reply route raises a
  question or permission request. It carries the provider question id and
  revision. Without a route nothing is written; the human answers through the
  pending-event path as today.
- **answer** is inserted `queued` by any surface before the provider responder
  is called, then `consumed` by the running turn or `failed`. It is never a turn.

### Exact idle-path trace

The fully bound statements are in `normal-trace.sql`.

| # | Statement | Purpose | Compared with the current ledger |
| --- | --- | --- | --- |
| 1 | INSERT row as running, ON CONFLICT DO NOTHING, RETURNING | Save command, request, reply route and launch intent in one row | Replaces the ledger start INSERT |
| 2 | UPDATE to completed with result and provider ids | Settle the exact attempt | Replaces the ledger settle UPDATE |
| 3 | INSERT SELECT DISTINCT result rows | One durable input per distinct reply session among the turn and every row it consumed | +1 |

Statement 1 commits before the provider is called. If the one-turn index rejects
it because a turn is active, nothing is written and the host accepts the same
command through the queued INSERT instead. Statements 2 and 3 run in one BEGIN
IMMEDIATE transaction, together with the `dispatch` UPDATE for the next queued
row when the host has one ready. Nothing launches or wakes a parent before that
commit succeeds. If the commit fails, the settled turn, the parent input and
the next dispatch all roll back together; the proof checks this.

### Why not fewer

The pre-launch write is the difference between a request that survives restart
and today's lost reports. The settlement write is the result itself. Everything
else rides inside those two commits. The only further reduction would be to
skip persisting queued rows, which reintroduces the exact bug this replaces.

## Question, steer and cancel

**Question.** A question lives and dies with the running turn. If the host
restarts, the child process is gone and the question cannot be answered.
Persistence is for telling the parent and recording the answer outcome.

- Statement `question`: one INSERT SELECT from the asking turn. Zero rows unless
  the turn is running and has a reply session. Repeated provider events for the
  same question id write nothing.
- The parent dispatches a question row through the normal `dispatch` UPDATE,
  which returns no row when the asking turn is no longer running. The scheduler
  then runs `expireQuestion`, settling it `cancelled` with reason `stale`. No
  write happens at child settlement to expire questions.
- Whether a question steers a running parent or starts a new turn is wake
  policy, decided in memory, not stored.
- `answer` inserts the row `queued`; the host calls the provider responder;
  `consume` settles it with consumed_by = the child's running turn, or `fail`
  records `stale` or `rejected`. Human and agent answers use the same command.
  At restart `failStaleAnswers` settles any answer still queued.

**Steer.** A steer never gets its own turn.

- The row is accepted `queued` like any instruction. If the target is running
  and mode is auto or steer, the host calls the backend steer. On acceptance,
  `consume` marks the row consumed by the running turn. On refusal at a turn
  boundary nothing is written; the row stays queued and starts a normal turn
  from the next settlement.
- Mode `steer` is excluded from `dispatch` and is settled `failed` with
  `not_running` when no turn is active.
- At the turn's settlement, the `reply` statement fans out to each distinct
  reply session among the turn and the rows it consumed. A parent that steered
  a turn it did not start gets exactly one result. A steer from the same session
  that started the turn adds no second row.
- A consumed row cannot be consumed again or dispatched as a turn. It cannot be
  withdrawn without interrupting the turn, as today.

**Cancel.** Cancel is a command with no row and no intent marker. On restart an
active turn is reconciled and never relaunched, so a marker would only protect a
provider turn that outlives the host. Neither provider has one.

- `cancelQueued` and `cancelSessionQueue` settle queued rows `cancelled` in one
  write. The same write dismisses a queued result or question for a parent.
- A running turn is interrupted through the backend and settles through the
  normal `settle` statement with state `cancelled`. Its result rows carry that
  outcome, so the parent learns the child was stopped without a separate notice.
- The session slot stays occupied in memory until the backend confirms the stop
  or the watchdog settles the turn as failed. The row stays `running` until then.
- Cancel plus a new instruction is the restart mode: two commands, no new kind.

**Retry.** A confirmed-safe retry, such as a rate-limit rejection, runs
`requeue`: the same row returns to `queued` with the error recorded. No result
row is published for the abandoned attempt. The next `dispatch` increments
attempt_no. Retry timing stays in memory; if it must survive a restart it
belongs in the row's options, not in a state. An uncertain launch is not a
confirmed rejection and is never retried automatically.

## Crash and duplicate behavior

| Boundary | Durable evidence | Required recovery behavior |
| --- | --- | --- |
| Before the accept commit | No row | Sender may retry the same command |
| Queued, not dispatched | queued row | Eligible to start at the next settlement or when idle |
| Running, provider outcome unknown | running row | Reconcile; settle failed or completed; never relaunch blindly |
| During settlement | settle, reply and next dispatch commit together or not at all | Reapply once |
| After settlement, before wake | result row queued, next row running | Rebuild the queue and wake when policy allows |
| Answer in flight | queued answer | Settle failed stale |

The proof injects a rollback after each settlement write, exits a separate
process without COMMIT while settlement is uncommitted, reopens after each
committed boundary, rejects conflicting duplicates, and enforces one turn per
session. No claim of exactly-once provider execution is made; the host cannot
commit atomically with an external provider.

## Measured database cost

Run `node plans/002-session-exchange/benchmark.mjs`. Results from 2026-09-18 are
in `benchmark-results.json`: separate disposable databases, WAL, synchronous
NORMAL, 200 warm-up and 2,000 measured samples, 1 KiB prompt, 8 KiB result,
Node v25.8.1 on this macOS host. Only SQL preparation and execution are timed.

| Storage slice | Median total | p95 total | p99 total |
| --- | ---: | ---: | ---: |
| Existing ledger, two writes, prepared per call | 0.036 ms | 0.108 ms | 0.221 ms |
| Proposed idle path, prepared per call | 0.179 ms | 0.425 ms | 2.843 ms |
| Existing ledger, reused prepared statements | 0.021 ms | 0.042 ms | 0.085 ms |
| Proposed idle path, reused prepared statements | 0.090 ms | 0.224 ms | 2.529 ms |

The proposed path's pre-launch write measured 0.058 ms median per call and
0.033 ms with reused statements. These are differences between sample medians of
a storage slice, not end-to-end latency. Tail spikes above 2 ms occur in both
cases and are not attributed. Synchronous SQLite work blocks the host event
loop; contention, large histories and other writers need integrated measurement.

## Current code and replacement boundary

- `packages/server/src/sessions/turn-ledger.ts`: its table becomes this one.
  Attribution intent from `tests/unit/turn-ledger.test.ts` carries over: rows
  are attributed to actor and seat, and settle once.
- `packages/server/src/control-plane.ts`: `requestQueue`, `pendingStarts` and
  `completionRoutes` hold what `queued` rows and `reply_session_id` now hold.
  `_startRunLifecycle` writes the ledger after launch; the accept INSERT must
  commit before launch and a failed write must refuse the launch. The place
  that today pops the next queued request after a run settles becomes the
  `dispatch` statement inside the settlement transaction.
  `_dispatchSessionReport` injects prose; the result row replaces it.
  `_steerActiveTurn`, `stopSession`, `respondToQuestion` and
  `respondToPermission` become the steer, cancel and answer commands.
- `packages/server/src/agents/agent-backend.ts`: `steerSession` returns the
  accepting run handle, which is how consume learns its turn. `cancelSession`
  and the permission responder are unchanged in shape. Provider thread and turn
  ids are passed to settle when the adapter has them; Claude has no turn id.
- `packages/server/src/sessions/session-tools.ts`: create, prompt, wait, answer
  and stop tools submit these commands instead of watches and exchange ids.
- Session creation, worktree setup, delegation ownership, attention and task
  linkage are outside this trace and keep their own writes.

## Integration sequence

1. Finalize the typed options envelope and canonical session identity. Preserve
   history and seat attribution at cutover; no dual writers.
2. Land the table and the accept, dispatch, settle, reply and recover statements
   in the control-plane domain. Make writes fail closed before effects.
3. Route ordinary chat, tools, cards and automations through the accept command.
   Expose row state over both IPC and WebSockets; rehydrate cards from rows.
4. Add question, answer, steer and cancel commands, replacing the in-memory
   exchange watches, prose reports and completion routes in the same cutover.
5. Instrument a fixture flow end to end for statement counts, bytes written and
   event-loop delay, including creation, indexing and attention.

Integration checks: focused ledger and session tests, `bun run check`, lint,
`bun run build`, and runtime verification on desktop, web and mobile including
reconnect. Stop and surface a design issue if more than one process writes this
table, or a reply must be marked handled before the parent consumes it.
