# Watches — wait on the host, then wake the agent

Status: implemented, 2026-09-25. §12 lists where the build differs from the first proposal.

## 1. Why

A user often gives an agent a task that must wait for an outside result:

- "Watch CI and fix any failure."
- "Tell me when the deploy is healthy."
- "When the training run finishes, summarize the metrics."
- "If the server log shows a panic, find the cause."

Each task has two phases:

1. **Wait.** Poll something until a result is ready. This needs no model.
2. **Act.** Give the result to the agent so that it can do the work.

Solus has no general way to do phase 1 on the host. The agent must spend a full
turn on each poll, or keep a background shell open, which only Claude supports
and which a host restart kills.

## 2. What the code does today

- **Session-bound automations.** `AutomationAction.sessionId`
  (`packages/contracts/src/types.ts`) binds an automation to a chat. The runner
  (`automations/automation-runner.ts`, the `action.sessionId` branch) sends a
  "Scheduled follow-up" prompt into that chat through
  `ControlPlane.dispatchAutomationRun`. Each fire is a full agent turn, also when
  nothing has changed. Only the agent can stop it, with
  `update_automation archived: true`. Each create needs user approval.
- **Claude background tasks.** `claude-agent.ts` keeps the SDK query open while
  background shells, Monitor calls, or sub-agents run, and the SDK wakes the
  agent when one settles. The session status is `background`. This is in memory,
  it is lost on a host restart, and Codex has no equivalent.
- **Codex.** A background `commandExecution` that completes after the turn does
  not wake the agent.
- **Goals.** Codex goals continue inside Codex. Claude goals are a label with
  counters and never cause a continuation.

t3code (orchestrator v2, branch `pr-4229`) uses the same two ideas: an
in-memory provider continuation when background work ends, and a
`schedule_task` timer bound to the thread. It has no host-side condition and no
stop condition that the system enforces.

## 3. Vocabulary

- **watch** — a durable record, owned by one session, that waits on the host and
  then wakes that session. Use this word in code, tools, UI, and docs.
- **probe** — the command that a watch runs on the host to read the current
  state. A watch without a probe is a timer.
- **until** — the condition on the probe result that ends the wait.
- **wake** — the prompt that the host sends into the session when the wait ends.
- **re-arm** — return a `repeat` watch to waiting after the woken turn ends.

Do not use "monitor" (it is the name of a Claude Code tool), "wait for" (it is
used by `browser_wait_for`), or "follow-up".

## 4. Model

```ts
interface Watch {
  id: string
  sessionId: string
  /** What the agent must do when it is woken. */
  reason: string
  /** Absent: a pure timer. */
  probe?: {
    command: string
    /** Default 60. */
    timeoutSeconds: number
  }
  schedule: { everySeconds: number } | { at: string }
  until:
    | { exitCodes: number[] }
    | { outputMatches: string }
    | { outputChanges: true }
  /** 'notify' tells the user and does not wake the agent. */
  onMatch: 'wake' | 'notify'
  /** Re-arm after the woken turn ends. */
  repeat: boolean
  /** Default 5. */
  maxWakes: number
  /** Default 24 hours after creation. */
  expiresAt: string
  wakeCount: number
  consecutiveProbeErrors: number
  /** Hash of the last probe output, for `outputChanges`. */
  lastFingerprint?: string
  /** Hash of the result that caused the last wake, so one result wakes once. */
  wokenFingerprint?: string
  lastResult?: { exitCode: number | null; outputTail: string; at: string }
  nextRunAt?: string
  status: 'waiting' | 'paused' | 'woken' | 'done' | 'exhausted' | 'expired' | 'cancelled' | 'failed'
}
```

### Examples

| Task | Probe | Until |
|---|---|---|
| Fix CI when it fails | `gh pr checks 42 --required` (exit 8 = pending) | `exitCodes: [0, 1]`, `repeat: true` |
| Deploy is healthy | `curl -fsS https://app/health \| grep v1.4.2` | `exitCodes: [0]` |
| Long job ends | `test -f out/DONE` | `exitCodes: [0]` |
| Error in a log | `tail -n 200 server.log` | `outputMatches: "ERROR\|panic"` |
| "Check back in 30 minutes" | none | `schedule: { at }` |

The host has no knowledge of GitHub, deploys, or logs. The probe carries all of
that knowledge.

## 5. Behavior

### Probe run

- `WatchService` stores watches in SQLite and runs due probes. It limits how many
  probes run at the same time.
- A probe runs on the session's host, in the session's resolved working
  directory (`resolveHomePath`), with the session's environment.
- The host keeps the last 16 KB of stdout and stderr.
- A probe error is not a result. A probe error is a timeout, a spawn failure, or
  exit code 126 or 127. After 3 consecutive errors, the watch goes to `failed`
  and wakes the agent one time with the error.

### Wake

- When `until` matches and the fingerprint is new, the watch goes to `woken` and
  calls `ControlPlane.dispatchWake(sessionId, wake)`. This is the only path that
  prompts an agent without the user.
- The wake prompt contains the reason, the command, the exit code, the output
  tail, "wake N of M", and the `cancel_watch` call that stops the watch.
- If the session is busy, the wake waits in the queue behind the active turn.
- If the session is not in memory, the control plane resumes it from disk.
- `onMatch: 'notify'` ends the watch as `done` and does not wake the agent. The
  client shows a toast. A notify watch cannot repeat.

### Re-arm and stop

- With `repeat: true`, the watch goes back to `waiting` when the woken turn ends.
  The saved fingerprint stops a second wake for the same result.
- The host stops the watch. The agent does not have to remember. A watch ends
  when:
  - `until` matches and `repeat` is false (`done`),
  - `wakeCount` reaches `maxWakes` (`exhausted`),
  - `expiresAt` passes (`expired`),
  - the agent or the user cancels it (`cancelled`),
  - the probe fails 3 times (`failed`),
  - the session cannot be woken, for example because it no longer exists
    (`failed`).
- The watch card shows each end live. An end without the condition, and a met
  notify watch, also show a toast.

### Restart

The probe does not keep state between runs, so a watch is level-triggered. On
boot, `WatchService` loads the `waiting` watches and runs each due probe again.
A watch in `woken` whose turn did not end before the restart re-arms (if
`repeat`) or goes to `done`.

### Permissions

Decision (2026-09-24): probes run with **no permission prompt**, in every session
permission mode. This keeps a watch fully automatic.

Consequence: a watch is a way for the agent to run a command that the session's
permission mode would otherwise stop, repeatedly, with no user present. Content
that the agent reads (a web page, an issue, a log) can use prompt injection to
make it create such a watch. The controls are:

- the exact command is shown on the transcript card when the watch is created,
- the watch list shows every active command, with pause and cancel,
- the timeout, the output limit, `maxWakes`, and `expiresAt` limit each watch.

## 6. Agent tools

Provided through the Solus toolbox to Claude and Codex:

- `watch({ reason, probe_command?, probe_timeout_seconds?, every_seconds | at,
  until_exit_codes | until_output_matches | until_output_changes, on_match?,
  repeat?, max_wakes?, expires_in_hours? })`
- `list_watches()` — the watches of the current session.
- `cancel_watch({ watch_id })`

The `watch` tool description carries the guidance ("Do not poll in a loop and do
not keep a background shell open for long waits") and is always loaded, so no
separate system hint is necessary.

A tool call can only make, list, or cancel watches of its own session. One
session can have at most 10 watches that have not ended.

## 7. Refactor

- **Delete session-bound automations.** Remove `AutomationAction.sessionId`,
  `setAutomationSessionDispatcher`, the `action.sessionId` branch in
  `automation-runner.ts`, `ControlPlane.dispatchAutomationRun`, the
  `run_in_session` tool argument, the "in this chat" guidance in the automation
  tool descriptions, and the "Runs in this chat thread" UI. Delete the stored
  session-bound rows. Isolated automations stay the product for recurring jobs
  that the user creates.
- **Codex background completion.** When a background `commandExecution` completes
  after its turn, the Codex backend emits `background-command-completed` and the
  control plane queues a prompt into the session with `via: 'background-command'`.
  Claude keeps its SDK-native wake. Background shells stay the fast path for
  short waits.

## 8. RPC and events

- Methods: `watchList(sessionId)`, `watchPause(sessionId, watchId)`,
  `watchResume(sessionId, watchId)`, `watchCancel(sessionId, watchId)`. The
  session is an argument so the access policy checks it (viewer to list, editor
  to change); a watch of another session is refused.
- Topic: `watch.changed` with the full `Watch`.
- Declare all of them in `packages/contracts/src/rpc.ts`. They behave the same
  over IPC and WebSocket.

## 9. UI (mobile, desktop, web)

All three clients render the same workspace UI:

- **Watch card** in the transcript where the agent made the watch. It shows the
  reason, the command, and a live rail (state, wakes used, time to the next
  check), with Pause/Resume and Cancel. It expands to the last probe output and
  the end reason. After a history reload the card finds its watch by reason and
  command, because the id was in the tool result.
- **Watches section** in the project panel while the session has a watch that
  has not ended: each watch with its rail, Pause/Resume, and Cancel.
- **Wake bubble** labelled "Watch" (or "Background command" for a Codex wake).
- **Toast** when a watch ends without its condition (failed, out of wakes,
  expired) or a notify watch meets its condition.

## 10. Code

- Contract: `packages/contracts/src/watch-types.ts`; RPC in `rpc.ts`,
  `rpc-planes.ts` (execution), `host-api.ts`, `host-events.ts` (`watch.changed`).
- Server: `packages/server/src/watches/` — `watches-store.ts` (SQLite table
  `watches`, migration in `db/migrations.ts`), `watch-probe.ts`,
  `watch-rules.ts`, `watch-service.ts`, `watch-tools.ts`; RPC in
  `server/handlers/watch-handlers.ts`; `ControlPlane.dispatchWake`.
- Client: `contexts/watches/` (store, change subscriber, end notices),
  `components/watches/WatchRefCard.svelte`,
  `components/project-panel/WatchesSection.svelte`.
- Tests: `tests/unit/watches.test.ts`, `watch-notices.test.ts`,
  `codex-background-command-wake.test.ts`.

## 11. Later

- The PR screen's "Fix failing checks with agent" starts the fix and creates a
  CI watch with `repeat: true`.
- A `watching` session status in the sidebar.
- Combine wakes that arrive together into one prompt.
- Probe backoff.

- `until: { judge: "<condition>" }` — a small model reads unstructured output
  and decides. Deterministic conditions come first.
- Probes for isolated automations, from the same engine.

## 12. Where the build differs from the first proposal

- The field `then` is `onMatch` (tool argument `on_match`): an object with a
  `then` key looks thenable to JavaScript and to the linter.
- No `watching` session status. The Watches section and the card show the state;
  the status is listed under §11.
- No combined wakes and no probe backoff (§11).
- `at` is valid only for a timer without a probe, and cannot repeat.
- The Codex background wake goes through the existing unattended prompt path
  with `via: 'background-command'`, not through `dispatchWake`: it belongs to no
  watch.
- Session-bound automations were removed with their stored rows and runs. The
  `dispatched` automation run status went with them.
