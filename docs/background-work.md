# Background work

An agent can leave work running after its turn ends: a background shell, a
`Monitor` call, a sub-agent, or a Codex command that outlives its turn. Solus
shows this as one session status, `background`, for both providers.

To wait for an outside result ("tell me when CI finishes"), the agent runs the
wait as background work. The result wakes the agent. Solus has no host-side
watch or probe of its own. Watches were removed because they duplicated this
path.

## Status

| Event | Status |
|---|---|
| A turn ends while background work runs | `background`. The turn does not settle and does not notify. |
| A background task finishes on its own | The agent wakes with the result in a new turn. That turn settles once, as usual. |
| The person stops the work from the background row, or Stop on mobile | Only the tasks stop, and the session settles as `completed`. Claude's SDK first gives the agent a turn to react; Codex does not wake the agent. |
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

## Clients

- **Desktop and web.** The last turn shows the background row: what runs and a
  Stop that ends only the tasks (`stopBackgroundTasks`). The sidebar row shows
  the background glyph.
- **Mobile.** The thread shows the "Background task running" pill. Stop in
  `background` ends only the tasks, as on desktop and web.
