# Session schedules

A Claude agent can schedule a prompt in its own session with `CronCreate`,
`ScheduleWakeup`, or `/loop`. Solus keeps the session's Claude process alive
while such a schedule is pending, so the prompt fires in the same session.

Status: in progress.

## Why

The Claude CLI keeps a session schedule in its own process: "in-memory only,
dies when this Claude session ends", and jobs "only fire while the REPL is
idle (not mid-query)". Solus runs a turn as one SDK query and closes its input
at the result unless background work runs (`claude-agent.ts`). The process then
ends, and every schedule ends with it. So Solus blocked `CronCreate`,
`CronDelete`, and `CronList`. `ScheduleWakeup` and the `/loop` skill stayed
available, accepted a schedule, and never fired it.

T3 Code keeps one query open for each thread for its whole life, and routes a
turn that the CLI starts by itself into the thread ("wake turns"). Solus mounts
many sessions, and each open query is one CLI process. So Solus holds the query
open only while something will wake it.

## Vocabulary

- **Session schedule** — a prompt that the CLI fires later in the same session:
  a `CronCreate` job (one-shot or recurring), a `ScheduleWakeup`, or a `/loop`
  tick. Not a Solus automation, which starts its own session
  (`create_automation`), and not a cloud schedule (`RemoteTrigger`, the
  `schedule` skill), which Solus still blocks.
- **Pending schedule** — a session schedule that the CLI reports in
  `session_crons`.

## Design

1. **The CLI says what is pending.** The SDK's Stop hook input carries
   `session_crons: SessionCronSummary[]`, "session-scoped cron tasks
   (CronCreate, ScheduleWakeup, /loop) that will wake this session later". The
   Stop hook runs at each turn end, before the turn's result. Solus reads it
   there. Solus parses no tool text. When the field is absent (an older CLI),
   nothing changes.
2. **A pending schedule is background work that does not hold.** Each pending
   schedule is a background task `schedule:<id>` with `awaitable: true`
   (`claude/scheduled-wakes.ts`). The existing rules then apply
   (`docs/background-work.md`): the query stays open, the turn settles as
   `completed` and notifies, a new prompt goes into the open query, and the
   clients show the background row with its Stop. A schedule that is no longer
   in the list settles as `completed`.
3. **The fire is a turn in the open query.** Assumed, and checked by the live
   check below: it starts with a new `session_init`, as a background task's
   continuation does, which takes the session from `completed` back to
   `running` (`provider-events.ts`), and it ends with its own result. Its Stop hook
   updates the list, so a one-shot wakeup releases the query after it fires.
4. **Stop.** The session's background Stop (`stopBackgroundTasks`) drops the
   pending schedules. When no other work runs and the agent is idle, the input
   closes, the process ends, and an in-memory schedule ends with it. The CLI has
   no call that deletes one schedule.
5. **Tools.** `CronCreate`, `CronDelete`, and `CronList` are no longer blocked.
   `RemoteTrigger` and `Skill(schedule)` stay blocked.

## Surfaces and providers

- Desktop, web, and mobile already show background work and its Stop
  (`showsBackgroundWork`). No client change.
- Claude only. Codex has no session schedule; the decision for Codex is
  "not applicable".

## Limits

- A schedule that the user stops while a turn runs can fire if the query is
  still open after that turn. The next turn end reports it again.
- A durable schedule (`durable: true`) is written to
  `.claude/scheduled_tasks.json`. Stop ends the process but does not delete the
  file, so the schedule comes back with the next query in that folder.
- A recurring schedule expires after 7 days. If it expires while the agent is
  idle, no turn end reports it, and the query stays open until Stop or the next
  turn.
- A Solus restart ends every Claude process and its in-memory schedules.

## Verification

- Unit tests drive the run loop with a mocked query and a Stop hook that
  reports `session_crons` (`tests/unit/claude-steering.test.ts`).
- One live check on the cheapest model: a `ScheduleWakeup` of 60 seconds must
  fire one turn in the same session and then release the query.
