# Background work

An agent can leave work running after its turn ends: a background shell, a
`Monitor` call, a sub-agent, a Codex command, or a Codex native sub-agent
that outlives its turn. Solus shows this as one session status, `background`,
for both providers.

To wait for an outside result ("tell me when CI finishes"), the agent runs the
wait as background work. The result wakes the agent. Solus has no host-side
watch or probe of its own. Watches were removed because they duplicated this
path.

## Status

| Event | Status |
|---|---|
| A turn ends while background work runs | `background`. The turn does not settle and does not notify. A Codex turn that failed shows its error at once, then waits in `background` too. |
| A background task finishes on its own | The agent wakes with the result in a new turn. That turn settles once, as usual. A Codex native sub-agent wakes nobody: when the last task has ended, the session settles. |
| The person stops the work from the background row, or Stop on mobile | Only the tasks stop, and the session settles as `completed`. Claude's SDK first gives the agent a turn to react; Codex does not wake the agent. |
| The background work of a failed Codex turn ends | The session settles as `failed`, once. |
| The person stops the session (Stop shortcut, `stop_session`) | The tasks stop and the session settles as `interrupted`. |
| The host restarts | The work is lost. The restart prompt names the tools that were running. |

`background` is not busy. A new prompt is accepted and runs as the next turn.

## Providers

- **Claude** keeps its SDK query open while tasks run. A new prompt goes into
  that query. The SDK wakes the agent when a task settles. Stop on the session
  cancels the query, and with it the tasks.
- **Codex** ends its turn and exits the run. A command still running at the end
  of the turn becomes a background task (`background_task_started`, keyed by
  the command item). When it completes, the host settles the task and queues a
  "Background command" wake prompt. Stopping a task, or the session, calls
  `thread/backgroundTerminals/terminate` for each command. A stopped command
  does not wake the agent. If the app-server exits, its commands settle as
  `killed`.
- **Codex native sub-agents** run on their own threads, so one can still work
  when the root turn ends, completed or failed. The root run ends at once and
  frees the queue. A child still working becomes a background task
  (`background_task_started`, keyed by the child's thread, on its sub-agent
  card), announced before the turn's result. The host keeps the child with the
  root run's normalizer, so its output and report go to its card, never to a
  later root turn. Only card events pass; the child cannot settle, plan for,
  or change the usage of the session. The task settles once:
  - The child's turn ends: `completed` or `failed`. Nothing wakes the agent.
    Solus sees no Codex wake for this case and does not queue one. When no
    other task is left, the session settles.
  - Stop on the background row (`stopBackgroundTasks`) or on the session sends
    `turn/interrupt` to the child: `stopped`. The task settles only from what
    Codex reports. If Codex answers the interrupt with an error, or the turn id
    is not known, the host reads the child's thread (`thread/read`): a turn in
    progress is interrupted, and a turn that already ended settles the task as
    it ended. If the child has no turn yet, the Stop waits and interrupts the
    turn when it starts. A Stop that proves nothing (no answer, or Codex still
    runs the turn) leaves the task visible and answers false, to stop again.
  - A later root turn links the same child again: the old card's task settles
    as `completed`, and the new card owns the child.
  - The app-server exits: the card reports the failure, and the task settles as
    `killed`.

  A repeated spawn record does not make an ended child work again; only its
  next `turn/started` does. An interrupted or ephemeral root keeps no child. A detached child cannot ask
  for approval: its requests are declined, as before. While a child works, its
  root thread stays loaded. A Codex sub-agent that a later root turn re-engages
  (`subAgentActivity` `interacted`) is not routed to that turn; this is a
  separate, existing limit.

## Clients

- **Desktop and web.** The last turn shows the background row: what runs and a
  Stop that ends only the tasks (`stopBackgroundTasks`). The sidebar row shows
  the background glyph.
- **Mobile.** The thread shows the "Background task running" pill. Stop in
  `background` ends only the tasks, as on desktop and web.
