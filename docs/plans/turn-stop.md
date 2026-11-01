# Turn stop

Stop (Ctrl+C, the stop button, `stop_session`) ends the running turn of a session. Each turn has one stop, a `TurnStop` (`packages/server/src/execution/sessions/turn-stops.ts`). `SessionRuntime.interruptSession` asks the session's turn stop to stop. It does not search the launcher, the backends, and the setup controllers for something to cancel.

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

Stop sends `turn/interrupt` and starts a 15 s bound (`STOP_CONFIRM_TIMEOUT_MS` in `codex-backend.ts`). If Codex has not ended the turn by then, Solus settles the run as `interrupted`, so the session leaves its turn and its queue moves on. Nothing is killed at the bound. A second Stop before the bound is a force stop: Solus unloads only that thread from its app-server (`thread/unsubscribe`), which ends its turn and terminals; the app-server and its other threads keep running. A turn that ignored Stop is also force stopped when the next prompt starts a run on its thread, so the old turn cannot take that prompt. Events of a turn whose run Solus already settled are dropped, and `turn/start` refuses a turn that an earlier run started.

## Not part of a turn

- A worktree move can run outside a turn. Stop still aborts it.
- A session that only waits on the sessions it sent work to stops waiting (`orchestration.cancelSentBy`).
- Queued prompts stay (plan 004 D12), except behind a stopped setup. Because a stopped launch has no provider exit, the launcher starts the next queued prompt itself.
