# Derived session status

A session's status is a view of a few facts. The server computes it from those
facts with one function. No call site writes a status by hand.

Status: step 1 (shadow mode) is in. Steps 2 and 3 are not started.

## Why

`SessionStatus` has twelve values. About 34 call sites in 10 files under
`packages/server/src/execution/` write it with `setStatus`. Each call site
updates a fact, for example it adds a permission request, and then it also
writes the status that it thinks follows. Each call site has its own guard:
"anything busier outranks it", the `queueWillTakeOver` and `wasStarting`
suppressions, the watcher that writes `rate_limited` again.

So the facts and the status drift apart:

- An `interrupted` session can keep a pending permission request.
- A late `task_started` moves `idle`, `completed`, `failed`, `interrupted`, or
  `dead` back to `running`.
- An exit after `completed` can move the session to `running`, `background`,
  `failed`, `interrupted`, or `dead`.

More than 100 of the 132 status pairs can occur. A transition table that
refuses moves cannot fit this. It would block about 20 pairs that nobody can
prove never occur, and a wrong refusal freezes a session. The status is not one
state machine. It is several independent facts in one value.

## Vocabulary

- **Fact** — one thing the server knows about a session, kept by its owner.
- **Turn phase** — where the current turn is: `none`, `starting`, `running`, or
  `settled` with an outcome (`completed`, `failed`, `interrupted`, `dead`). This
  is the only real state machine under the status.
- **Derived status** — `deriveSessionStatus(facts)`, the status the facts give.
- **Shadow mode** — the status is still written by hand, and each write is
  compared with the derived status. A difference is logged. Nothing changes.
- **Mismatch** — a write where the hand-written status and the derived status
  differ.

## The facts

| Fact | Owner now |
|---|---|
| Turn phase | Not stored. Each status write implies it (step 1 reads it from the write). |
| Pending input (`awaiting_input` or `awaiting_plan`) | `pendingInputEvents` on the session, read through `pendingInputStatus` |
| Rate-limit park | `RateLimitState.peek`, when the limit does not let the run continue (`deferCurrentRun !== true`) |
| Background work that holds | `backgroundWorkHolds(session)` (`docs/background-work.md`) |

## The precedence

`packages/server/src/execution/sessions/derived-status.ts`:

1. A parked rate limit gives `rate_limited`.
2. Pending input gives `awaiting_input` or `awaiting_plan`. The person outranks
   the turn. A question can come through a query that stays open for
   background work after the turn settled.
3. The turn phase gives the rest: `none` → `idle`, `starting` → `connecting`,
   `running` → `running`, `settled` → `background` while background work holds,
   or else the outcome.

## Steps

### Step 1 — shadow mode (done)

- `deriveSessionStatus` and `turnOfStatus`, with tests in
  `tests/unit/derived-session-status.test.ts`.
- `SessionStatuses.compareWithDerived` runs at the end of `applyStatus`, only
  when a record exists and the status really changes. It reads facts without
  changing them. When the derived status differs, it logs
  `session_status_derived_mismatch` with the facts and `writer`, the first stack
  frame outside `session-statuses.ts`. The stack is read only on a mismatch.
- No turn phase is stored yet, so `turnOfStatus` reads it from the status that
  the call site writes. Step 1 therefore checks the other facts against each
  write. It does not check the turn phase itself.

Read the mismatches from a running dev server:

```bash
jq -r 'select(.msg == "session_status_derived_mismatch")
  | "\(.oldStatus) -> \(.newStatus) derived=\(.derived) \(.writer)"' dev.log \
  | sort | uniq -c | sort -rn
```

First finding, from the unit test fixtures: Stop on a session in `background`
(`session-runtime.ts`, `interruptSession`) writes `interrupted`. The background
task ids stay on the session until the provider's exit arrives, so the facts
still give `background`.

### Step 2 — store the turn phase, then publish the derived status

1. Add the turn phase to `BackendSession` as an explicit machine with its own
   transition table. It has four states and strict moves:
   `none → starting → running → settled`, `settled → starting`, `starting →
   settled` (a launch that fails), and any state → `none` (reset, handoff).
   Replace `turnOfStatus` with the stored phase.
2. For each mismatch kind in `dev.log`, decide whether the fact is stale (fix
   the fact owner) or whether the call site holds a real rule (make it a fact).
3. When the log is quiet in real use, let `applyStatus` publish the derived
   status instead of the written one.

### Step 3 — remove the hand-written status

1. Replace the `setStatus(sessionId, status)` calls with fact updates and one
   `refreshStatus(sessionId)` that computes, compares, and publishes.
2. The restart receipt state (`data/sessions/run-ledger.ts`) reads the turn
   phase, not a mirror of the status.
3. The workspace UI takes the status from the server and stops writing it
   (`prompt-dispatch.ts`, `session-event-reducer.svelte.ts`, and four other
   writers). Mobile already reads the status from host events.

## Surfaces and providers

- Step 1 changes no behavior on desktop, web, or mobile. It adds one log entry.
- Claude and Codex feed the same facts through `provider-events.ts`. The
  precedence is the same for both. Each mismatch kind names its writer, so a
  provider-specific rule shows as its own line in the log.

## Open questions

- Is `background` after a failed turn a separate outcome? Today
  `failedBeforeBackground` remembers it outside the session.
- Should a settled turn with pending input be possible at all, or is that input
  always stale? Step 2 decides from the log.
