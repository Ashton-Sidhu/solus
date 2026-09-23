# Session messages: one-table schema and exact SQL trace

Status: design proof; not integrated into Solus. Integration plan: `003-session-message-integration.md`.
Revised 2026-09-23 against HEAD `07624969`. First written 2026-09-18 at `7fc9de3f`.
Task: `01M2RDBWB45CX4C3EFFKWJ9Q5S` — Reliable Parent Task Orchestrator.

## Accepted direction

User decisions, 2026-09-18 to 2026-09-23:

1. Minimal SQLite persistence. The ControlPlane owns scheduling and routing in
   memory. SQLite stores only what a restart must not lose.
2. One table, `session_message`. Every row is one input addressed to one session.
   The `session_turn` ledger is deleted, not replaced: no production code read
   it (2026-09-23).
3. The fewest database calls that keep the guarantees. This revision applies one
   rule to every path, below.
4. The same path serves typed chat, agent tools, inline cards, automations, and
   the future task coordinator. Peers exchange messages without becoming
   children. Host events drive scheduling and client updates; no SQL polling.

## The write rule

**A row is written only when a party other than the turn's author depends on
it. Every other turn writes nothing.**

The rule rests on one fact: no provider turn outlives the host process. Codex runs as `codex app-server` over stdio
(`agents/codex/codex-agent.ts`), and Claude runs through the SDK's `query()`
with a local executable. Neither is detached. When the host dies, every running
turn dies with it. So a record that only matters while a turn runs protects
nothing across a restart. Stage 1 of the integration plan checked this by
killing a host process that ran each provider's CLI; both CLIs exited. The CLIs
were idle, with no turn running.

What therefore must be durable:

- **An input that has not started.** A queued follow-up must survive a restart.
- **A turn that a sender depends on.** If it dies, the sender must be told.
- **A result owed to a session.** The parent must receive it even if it was
  busy, and even across a restart.

What therefore is never persisted:

- **Questions and answers.** A question dies with the turn that asked it. The
  asking turn is persisted if anyone depends on it, so its death is reported.
- **Steers without a sender.** A typed correction dies with its turn, as today.
- **A turn nobody depends on.** Its prompt and reply live in the provider
  transcript. `session_records` already marks such a session interrupted at
  boot.

## Result

| Path | Statements | Commits | Today's ledger |
| --- | ---: | ---: | ---: |
| Typed turn, idle session | 0 | 0 | 2 / 2 |
| Typed follow-up on a busy session: save, start when the turn ahead ends, settle | 3 | 3 | 2 / 2, queue lost on restart |
| Delegation round trip, idle parent: child accept, child settle + parent result born running, parent settle | 4 | 3 for two turns | 4 / 4, result lost on restart |
| Same, busy parent in a typed turn: result waits, starts when that turn ends | 5 | 4 | same |
| Card send, no model wake | 2 | 2 | 2 / 2 |
| Steer from a sender | 1 | 1 | 0, route lost on restart |
| Steer typed by a person | 0 | 0 | 0 |
| Wait registered on a running turn | 1 | 1 | 0, lost on restart |
| Question, answer | 0 | 0 | 0 |
| Cancel a session's queued inputs | 1, 0 if none | 1 | 0 |

"Statements" counts SQL calls on the success path. Commit counts include
autocommitted single statements. "Today's ledger" is the `session_turn` ledger
this table's design replaced; it is now deleted. The other per-turn calls the
host makes, and who reads each one, are in the integration plan.

## Files and verification

| File | Purpose |
| --- | --- |
| `plans/002-session-exchange/schema.sql` | Executable schema |
| `plans/002-session-exchange/statements.mjs` | Every statement used by the proof and benchmark |
| `plans/002-session-exchange/normal-trace.sql` | Exact delegation round-trip SQL with fixture values |
| `plans/002-session-exchange/proof.test.mjs` | Counts, failure, restart, steer, wait and cancel tests over a model of the host's memory |
| `plans/002-session-exchange/benchmark.mjs` | Disposable local SQLite latency study |
| `plans/002-session-exchange/benchmark-results.json` | Measured percentiles |

Run `node --test plans/002-session-exchange/proof.test.mjs`. To regenerate the
trace, set `EXPORT_EXCHANGE_TRACE=1`. The proof uses `node:sqlite` in a new
temporary directory per test with WAL and synchronous=NORMAL, as the host does.
It never opens live Solus data. Do not apply schema.sql to an existing database.

Verification on 2026-09-23 with Node v25.8.1: **20/20 tests pass**, including
the coordinator self route and a typed turn that makes no call. The exported
trace replays against schema.sql in a second temporary database: one completed
child turn, one completed parent result turn, no foreign-key violations.

## Storage model

| Group | Columns | Notes |
| --- | --- | --- |
| Identity | message_id, actor_user_id, seat_user_id | message_id is the command's own id: a client prompt id, `<sender>:<tool call id>`, or a host UUID. A resend conflicts on the primary key. The seat is what a queued row runs under after a restart. |
| Routing | kind, sender_session_id, recipient_session_id, reply_session_id | kind is instruction, result or question. sender is who sent it, for card rehydration. reply is the wake route: who receives a result row. |
| Payload | text, options_json | Kept only on rows someone reads. Result rows never copy the source payload. |
| Links | source_message_id, consumed_by_message_id | Source: the turn a result or question came from. Consumed-by: the running turn that accepted a steer or wait. No foreign key on consumed-by: an unrouted turn has no row until it settles. |
| Execution | state, attempt_no, provider, execution_json, provider_thread_id, provider_turn_id | Provider ids are written at settlement. Claude supplies no turn id. |
| Outcome | result_text, error_text, created_at, started_at, settled_at | |

States: `queued`, `running`, `consumed`, `completed`, `failed`, `cancelled`.
Recovery reads only `queued` and `running` rows through a partial index. Rows
inserted already settled never enter that index.

Indexes, all partial: unfinished rows per recipient; one persisted running turn
per session; consumed-by for restart recovery; sender for card rehydration.
There are no triggers. The earlier revisions' command
key, fingerprint, mode, and answer kind are removed: the primary key is the
command id, mode is decided at command time, and answers are never stored.

## Statements

The host knows every live turn's wake routes and consumed steers in memory, so
the hot path binds values directly. There is no INSERT SELECT and no join
outside boot recovery.

- **insert** writes any row born before or during a turn: a queued input, a
  routed turn born `running`, a result owed to a session, a consumed steer, or a
  wait. `ON CONFLICT (message_id) DO NOTHING RETURNING` makes a resend a no-op.
- **settle** is one upsert for a turn someone depends on. It updates the row
  written earlier, or inserts it when the first route joined through a steer. `DO UPDATE ... WHERE state = 'running'` makes
  a repeated terminal event change nothing and return no row.
- **dispatch** starts a queued row. It runs inside the settlement transaction of
  the turn ahead of it.
- **requeue**, **cancelQueued**, **cancelSessionQueue** are one UPDATE each.
- **recover** and **consumedRoutes** run at boot only. **sentBy** serves card
  rehydration.

## Paths

**Typed turn on an idle session.** No write. A client retry within the process
is still deduplicated by the in-memory accepted-prompt set, as today. If a
queued row waits behind it, its end runs only the dispatch UPDATE.

**Routed turn.** A sender (agent tool or card) makes the turn a dependency. The
row is inserted `running` before launch; if the insert fails, the host does not
launch. At settlement one transaction runs: settle, then one result row per
distinct wake route, then the next queued row of the same session. When the
result's recipient is idle, its row is born `running`: delivery and wake are one
write, and the parent turn launches after the commit. When the recipient is
busy, the row is born `queued` and starts inside the recipient's own settlement.

**Result rows** carry no text and no reply route. The model-facing prompt is
built from the source row. A result never starts a chain of results.

**Self route.** A wake route to the turn's own session is how a long-running
coordinator survives a restart. Normal settlement skips it, so a coordinator
never wakes itself. Boot recovery honors it, so a coordinator turn killed by a
restart gets a queued notice and resumes.

**Steer.** The host calls the provider's steer first. If it is accepted and the
steer has a sender, one INSERT records it `consumed` by the running turn, and
its wake route joins the turn's routes. A refused steer falls back to start or
queue. A typed steer writes nothing.

**Wait.** `wait_for_session` on a running turn is one INSERT. If the turn has no
row yet, the turn itself is inserted `running` with the waiter as its route, so
a restart reports its death. Otherwise a textless `consumed` row records the
extra route.

**Question.** A child's question wakes the waiting sender through memory and a
host event. The parent turn it starts is written at settlement as kind
`question`, sourced from the child's turn. If the host dies, the child turn dies
and its persisted row reports the failure.

**Answer.** The provider responder returns whether the question was still live.
The answer's outcome is a host event. Nothing is stored.

**Cancel.** Queued rows are cancelled in one UPDATE, and only when the host
knows some exist. A running turn is interrupted through the backend and settles
through the normal path as `cancelled`, so its routes receive the outcome.

**Retry.** A confirmed-safe retry re-queues the same row. No interim result is
published. An uncertain launch is never retried automatically.

**Boot.** One transaction reads the unfinished rows. A running result row is
re-queued, so result delivery is at least once. Every other running row is
settled `failed` with `host restarted`, and a queued result row is inserted for
each of its wake routes and each consumed steer's route. Queued rows stay queued
and start when their session is idle.

## Crash behavior

| Boundary | Durable evidence | Recovery |
| --- | --- | --- |
| Typed turn in flight | None | Session record marked interrupted at boot, as today |
| Routed turn in flight | running row | Settled failed; each wake route gets a result row |
| Queued input | queued row | Starts when the session is idle |
| During settlement | settle, results and next dispatch commit together or not at all | Nothing partial exists |
| Result delivered, parent turn killed | running result row | Re-queued; the parent may see the result twice |
| Steer from a sender, turn killed | consumed row | Its route gets the failed outcome |

The proof injects a rollback after the settle and after the result insert, and
exits a separate process while settlement is uncommitted. It checks boot
recovery for routed turns, steers, result deliveries, queued inputs and typed
turns. No exactly-once provider execution is claimed.

## Measured database cost

Run `node plans/002-session-exchange/benchmark.mjs`. Results from 2026-09-23 are
in `benchmark-results.json`: disposable databases, WAL, synchronous=NORMAL,
200 warm-up and 2,000 measured samples, 1 KiB prompt, 8 KiB result, Node
v25.8.1 on this macOS host. Only SQL preparation and execution are timed.
A typed turn makes no call, so only the routed path is measured.

| Case | Prepared per call, median | Reused prepared, median | Reused, p95 |
| --- | ---: | ---: | ---: |
| Delegated child turn through the parent's result row | 0.163 ms | 0.088 ms | 0.142 ms |

The store must cache its prepared statements. Tail spikes of several
milliseconds occur and are not attributed. This is a storage slice, not
end-to-end latency.

## Decisions this revision asks for

1. Result delivery after a restart is at least once. A parent turn killed while
   handling a result will see it again.
2. Accepted 2026-09-23: the turn ledger is deleted. A typed turn writes no row.
   Existing `session_turn` rows stay in host databases untouched; nothing reads
   or writes them.

The integration plan lists these again with the call reductions outside this
table.
