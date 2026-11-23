# Turn stop

Stop (Ctrl+C, the stop button, `stop_session`) ends the running turn of a session. Each turn has one stop, a `TurnStop` (`packages/server/src/execution/sessions/turn-stops.ts`). `SessionRuntime.interruptSession` asks the session's turn stop to stop. It does not search the launcher, the backends, and the setup controllers for something to cancel.

On native mobile, Ctrl+C belongs to the focused thread screen. Native navigation
can keep other thread screens mounted. They must not handle Stop while hidden.
The focused screen consumes the command even when it has no work to stop, so it
cannot pass Stop to a running thread behind it. Switching threads does not stop
their work.

The native composer's physical press belongs to the action and session where
the touch began (`ComposerActionTouch`). A release cannot activate a replacement
Stop button, stop another thread, or activate the same action twice. A new touch
can stop immediately; there is no timed delay. Accessibility activation does
not require a touch sequence. The existing hardware command is separate.

Mobile renders the host's `stopped` activity for both people and agents, live
and from history. This matches desktop and web, which already show who stopped
the turn. A stop before the first answer must not leave only the user's prompt
on screen.

The iPad report for session `3f4b6f4a-7112-4d85-b05f-a62e856a4d09`
confirms a client `stopSession` request at 2026-11-19 04:16:48.035 UTC, about
0.6 seconds after the turn started. The host recorded `interrupted` and a stop
activity. The user used touch only. The log identifies the client request, but
does not record the native touch sequence. The touch guard covers action
replacement and duplicate-release cases; those cases have deterministic tests,
not a device reproduction. T3's checked composer action button also forwards
`onPress` without this guard; the same incident has not been confirmed upstream.

## Why

Before, Stop looked in six places: the worktree move, the setup controllers, the backend run of the thread, the pending handles of each backend, and the waits on other sessions. A phase that none of them covered could not be stopped. A Ctrl+C immediately after Send came during the setup steps before the provider spawned. The server did nothing, the agent started, and the stopped turn opened again on every client ("Picking this back up…").

## Vocabulary

- **Turn stop**: the stop of one turn. It opens when the prompt is admitted (`RunLauncher.startRunLifecycle`, or `compactSession`). A new turn of the session replaces it.
- **Phase**: a part of the turn that registers what Stop cancels while it runs (`TurnStop.onStop`). The phase releases its registration when it ends.

## Phases

| Phase | What Stop cancels |
| --- | --- |
| Launch, from admission to the provider spawn | The launch itself. The launcher checks the signal before it publishes the dispatch and again before it spawns the provider. |
| Auto model routing | The routing request. |
| Repository copy, worktree creation | The setup, and the prompts queued behind it, which were written for a checkout that now never exists. |
| Provider run | The run: by its thread after `session_init`, by its handle before. |
| Background work after the run exits | The work the agent left (`backend.cancelSession`), until a later turn replaces this one. |

Stop answers `true` only when a phase had work to cancel. Then the turn is `interrupted` and its signal aborts with `Error('Interrupted')`. A turn whose run ended with no background work closes its stop, so Stop on that session does nothing.

A phase stays registered until it ends, so a second Stop on a turn whose work ignored the first reaches that work again. The turn is recorded as stopped once.

## A Codex turn that ignores Stop

Codex can return a turn ID before the turn is active. If it refuses the interrupt with `no active turn to interrupt`, Solus retries when Codex reports `turn/started` for that turn. Prompts sent while the provider run is still stopping wait in the queue until the run exits.

Stop sends `turn/interrupt` and starts a 15 s bound (`STOP_CONFIRM_TIMEOUT_MS` in `codex-backend.ts`). If Codex has not ended the turn by then, Solus settles the run as `interrupted`, so the session leaves its turn and its queue moves on. Nothing is killed at the bound. A second Stop before the bound is a force stop: Solus unloads only that thread from its app-server (`thread/unsubscribe`), which ends its turn and terminals; the app-server and its other threads keep running. A turn that ignored Stop is also force stopped when the next prompt starts a run on its thread, so the old turn cannot take that prompt. Events of a turn whose run Solus already settled are dropped, and `turn/start` refuses a turn that an earlier run started.

## Stop before the prompt reaches the host

The client sets the tab to `connecting` on Send, but it can wait before it sends the prompt: for uploads, for a Git answer about a new worktree, for the task, and for the send context. A Stop in that time reaches a host that has no turn to stop. So the client withdraws the send: a turn's first prompt that is no longer `connecting` when its wait ends does not go to the host (`PromptDispatch.promptTab`, `sendWhenUploaded`). Its outbox entry is removed, and its text goes back to an empty composer. A queued prompt is not withdrawn by Stop.

## Not part of a turn

- A worktree move can run outside a turn. Stop still aborts it.
- A session that only waits on the sessions it sent work to stops waiting (`orchestration.cancelSentBy`).
- Queued prompts stay (plan 004 D12), except behind a stopped setup. Because a stopped launch has no provider exit, the launcher starts the next queued prompt itself.
