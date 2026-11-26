# Plan 037: The turn owns the session status

Status: DONE on `solus/turn-owned-status` (steps 1–4 in `c5c225511`, step 5 in the
next commit). Planned at `9c9b9b632`, 2026-11-26.
Category: correctness. Risk: MED (every status writer on the host changes).
Replaces the two plans that the code names but that do not exist:
`docs/plans/derived-session-status.md` and `docs/plans/turn-stop.md`.

## 1. The problem

A person pressed Ctrl+C one second after Send. The host settled the turn as
`interrupted`. One second later, the Claude run that Stop had aborted sent its
`session_init`. The `session_init` handler saw a session that was not busy and
set it to `running`. `applyStatus` then made a new turn id, because "running
after a settled turn" is its rule for a turn that the provider starts. At the
exit, the `wasStarting` rule read "interrupted while running" as a run that
still starts, so it sent no status. All clients kept the turn open and showed
"Picking this back up…" until the next prompt.

This is one example of a group of defects. The causes are structural:

1. **Many writers set one value.** 32 calls in 9 files write the session status
   directly. Each writer has its own guard: `wasStarting`,
   `isSessionBusyStatus`, `settledTurnId`, `startsOwnTurn`, and the checks of
   `turnStops.get(...).signal.aborted`. Each new race adds one more guard.
2. **A run's events do not name their turn.** The host finds the session of an
   event (`agentSessionId → sessionId`) and changes the session's current state.
   A late event from an old run changes the current turn.
3. **A settled turn can open again.** The turn has no stored phase. The status
   string is the only record, and `interrupted → running` is a legal write.
4. **The check cannot see a wrong turn phase.** `compareWithDerived` reads the
   turn phase from the status that the caller writes (`turnOfStatus`). It
   accepts every `running` write. `dev.log` shows the defect
   (`interrupted->running`) and no `session_status_derived_mismatch` entry.

## 2. Vocabulary

- **turn** — one cycle from an admitted prompt (or a wake) to its settlement.
  It has an id (`turnId`), a phase, an outcome when settled, and a stop.
- **phase** — `starting` (setup and launch, no provider report yet),
  `running`, or `settled`. It moves only forward.
- **outcome** — `completed`, `failed`, `interrupted`, or `dead`.
- **run** — one provider process or query that a launch started. One run can
  hold more than one turn: Claude starts a new turn in its open query when a
  background task wakes it.
- **the run's turn** — the newest turn that a run belongs to.
- **current turn** — the newest turn of a session.
- **facts** — the values that give the status: the phase and outcome of the
  current turn, the pending input, the rate-limit park, and the background
  holds.
- **settlement** — the one `turn_settled` event of a turn.

## 3. Decisions

**D1. One `Turn` object.** `Turn` (in `execution/sessions/turns.ts`, from
`turn-stops.ts`) holds the turn id, the phase, the outcome, and the stop
(`signal`, `onStop`, `stop`). `Turns` keeps the current turn of each session.
`BackendSession.activeTurnId` and `settledTurnId` go.

**D2. The phase moves only forward.** `markRunning()` moves `starting` to
`running` and does nothing in another phase. `settle(outcome)` works one time;
a later call does nothing. A settled turn never opens again.

**D3. A run belongs to its turn.** The launch binds the run handle to its turn
(`Turns.bindRun`). A run event acts on the run's turn, not on the session's
current turn. The exit (or a backend error) settles the run's turn. If that turn
is not the current turn, the exit settles only that turn: it does not write a
status, and it does not remove the record, the log, or the run request of the
newer turn. This replaces `wasStarting`. A Stop before `session_init` lets a
new prompt start before the old run exits (the scheduler waits only for a run
with a thread id), so this case is real.

**D4. Only a run that was not stopped can open a turn.** Claude reports
`session_init` at the start of each turn in its open query, also for a wake.
When a run reports work and its turn has settled, the host opens a new turn for
that run, but only if the outcome is not `interrupted`. A run that was stopped
never opens a turn. This replaces the guess in `startsOwnTurn`.

**D5. The status is derived.** `deriveSessionStatus(facts)` (in
`derived-status.ts`) is the one status. A writer changes a fact and calls
`statuses.refresh(sessionId)`. `refresh` derives the status and publishes it only
when it changes. No writer gives a status value. The precedence stays as
`derived-status.ts` has it: a parked rate limit, then the person's input, then
the turn (a settled turn with background holds is `background`).

**D6. Settlement belongs to the turn.** The phase settles at the result or at
the exit. The `turn_settled` event of a turn goes out one time
(`Turn.claimSettlement`): when the status becomes terminal, or when a queued
prompt takes over. A turn that waits on background work has settled, but its
event goes out when the wait ends. If the agent wakes into a new turn first,
the event never goes out, so the person gets no "finished" message while work
still runs. A queued prompt that takes over holds back the terminal status, so
no client sees `completed` between two turns. It does not hold back the event.

**D7. No turn is `idle`.** A session with no current turn is `idle`. A provider
handoff, the release of a rate-limit park, and a reset of a dead session clear
the current turn (`Turns.clear`). A parked turn never settles: its prompt waits
in the queue and runs again as a new turn, as today.

## 4. The writers and their facts

| Writer today | Fact it changes |
| --- | --- |
| Dispatch: `connecting` or `running` (`run-launcher`) | Begin a turn, phase `starting`, or `running` for a resumed thread |
| Model routing and setup failures: `failed` (`run-launcher`) | Settle the turn `failed` |
| Launch failure: `failed`; a stopped launch already settled (`run-launcher`) | Settle the turn `failed` |
| Stop: `interrupted` (`session-runtime`) | Settle the current turn `interrupted` |
| Plan rejected: `interrupted` (`input-requests`) | Settle the current turn `interrupted` |
| `session_init`: `running` (`provider-events`) | `markRunning` on the run's turn, or open a wake turn (D4) |
| Background task started while not busy: `running` | Open a wake turn (D4) |
| Permission, question, plan, decision (`provider-events`, `input-requests`) | Pending input; `refresh` |
| `task_complete`: `completed` or `background` | Settle the run's turn `completed`; background holds give `background` |
| Background wait ends: `completed` or `failed` | Holds end; `refresh` gives the stored outcome. `failedBeforeBackground` goes |
| Rate limit: `rate_limited` | Park; `refresh` |
| Park released or stopped: `idle` (`rate-limit-park`) | Clear the turn (D7); `refresh` |
| Exit: the outcome (`provider-events`) | Settle the run's turn (D3) |
| Exit with a parked limit: `rate_limited` | Park; `refresh` |
| Watchdog and exit without a code: `dead` (`session-statuses`, `provider-events`) | Settle the turn `dead` |
| Handoff: `idle` (`provider-handoffs`) | Clear the turn |
| New session record: `idle` (`session-runtime`) | No turn; `refresh` |
| Dead session reset: `idle` (`prompt-dispatch`) | Clear the turn |
| Compaction: `connecting`, `interrupted`, `failed` (`session-compaction`) | Begin a turn; settle it |
| Watch: re-publish (`session-watchers`) | `refresh` |

## 5. Steps

Each step is one commit, but steps 2 to 4 are one commit: a wake turn must be
a `Turn` that Stop can reach, so the turn and the run binding change together.
The focused tests of the changed files pass after each step, compared with the
baseline of the step before.

1. This plan.
2. A test that fails today: Stop, then a late `session_init`, then the exit. The
   session must stay `interrupted`, with no `running` after the stop.
3. `Turn` and `Turns` with id, phase, outcome, and stop (D1, D2). The turn id
   readers (`recordActivity`, the execution recorder in `boot-server`,
   `queueTurnSettlement`, compaction) read the current turn.
4. Bind each run to its turn; the exit and the run events act on the run's turn;
   wake turns are explicit (D3, D4). `wasStarting` and `startsOwnTurn` go.
5. `refresh` and the derived status (D5, D6, D7), one writer file at a time:
   `provider-events`, `run-launcher`, `session-runtime`, `input-requests`,
   `rate-limit-park`, `provider-handoffs`, `prompt-dispatch`,
   `session-compaction`, `session-watchers`, `session-statuses`. Then `setStatus`
   goes, and `compareWithDerived` and `turnOfStatus` go with it.

## 6. What does not change

- The `SessionStatus` values, the `status_change` and `turn_settled` events, and
  the client reducers. The clients already follow the host's status.
- Claude and Codex both use these rules. The provider adapters do not change.
- Stop keeps the queue (plan 004 D12). A second Stop on the same turn is a force
  stop, as today.

## 7. Open questions

- A run event that arrives with no handle (an exit without a run, which can
  belong to any pending run) acts on the current turn, as today.

### Decisions for step 5, as built

Each writer was compared with `deriveSessionStatus`. These five did not map one
to one. The person accepted the proposals; the code differs from them where noted.

1. **Stop with a pending permission.** Built as a rule of the derived status,
   not as an expiry: a turn settled as `interrupted` waits for no answer, so
   its pending input does not show. The run still expires the request when it
   exits, as before. A late request from the stopped run also shows nothing.
2. **A queued prompt that takes over.** A turn fact (`Turn.handOverToQueue`).
   A settled turn that the queue takes over derives `running`. The exit clears
   the fact first, so a prompt that left before the exit lets the turn show its
   outcome.
3. **A session with no record.** No change was needed. With no record, the
   status is published with `idle` as the previous status, as before. Every
   refresh of such a session comes from a writer that changed a fact.
4. **A failed exit after a completed result.** A later outcome replaces an
   earlier one (`Turn.settle`). The settlement event still goes out once,
   with the first terminal status. `failedBeforeBackground` is removed: the
   turn's own outcome gives `failed` when the wait ends.
5. **The rate-limit fact.** The snapshot is not the fact: it also holds a limit
   while a run continues (Codex `deferCurrentRun`, and a limit that gates the
   next send). The fact is `Turn.park()`, set where the host wrote
   `rate_limited` before. A release clears the turn (D7).

One more rule came out of the comparison: a failed turn waits in `background`
for its own work only, not for reports from other sessions
(`statusAfterExit` had this rule). The facts therefore split
`backgroundWorkHolds` from `holdsOutsideRun`.

One change that a client can see: a client that reattaches no longer turns a
session that runs or has completed into `rate_limited` because a limit
snapshot gates its next send. The status follows the park. That client still
gets the limit event and its card, as before.
