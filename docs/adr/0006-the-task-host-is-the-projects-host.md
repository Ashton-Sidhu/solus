# ADR-0006 — The task host is the project's host, not the run's host

**Status**: accepted
**Related**: [ADR-0002](./0002-dispatch-carries-the-repository-not-your-working-tree.md)

## Context

Solus has two ways to put work on another machine, and they had grown different
answers to the same question.

1. **Dispatch.** You are working in a checkout here and send the session to
   another host. That host is given a clone; your project stays where it is.
2. **Open a project on a host.** You point Solus at a folder on another host and
   work there. That folder is that host's project.

Both must feel like one gesture — pick a host, keep typing — but they differ in
one durable way: who owns the task the session files under.

Task minting used to be a side effect of the prompt landing: whichever host ran
`promptSession` called `prepareSessionTask` against its own database. Combined
with a renderer task store bound to the primary connection, that produced two
wrong outcomes:

- A **dispatched** session minted its task on the borrowed machine, where nothing
  reads it. The work vanished from the board it was started from.
- A session on a **remote project** minted in the right place, but no client ever
  read that host's tasks, so it vanished too.

The run config also had no way to tell the two apart. `worktreeRequired` was
doing double duty — a user preference when a draft set it, a "this is a dispatch"
marker when `withHost` set it — and `isDispatchedRun` read the second meaning
back off it. A mechanism was standing in for a fact.

## Decision

**A run names two hosts.** `RunConfig.serverId` is where the agent runs.
`RunConfig.taskServerId` is where its task lives. The rule that sets them is one
sentence:

> The task belongs to the host where the project was opened, which is not always
> the host where the session runs.

Dispatch moves `serverId` and leaves `taskServerId` (`withHost`). Opening a
project moves both (`withProjectHost`). A queued choice is a two-arm
`PendingHostDispatch` union, so a dispatch always names the repository to clone
and an opened project never carries one it would not use. Everything else
follows:

- **A dispatch is `serverId !== taskServerId`.** Not a flag — a fact about the
  run. `isDispatch()` reads it directly and `worktreeRequired` is gone.
- **A dispatch always uses an isolated worktree**, because its base checkout is
  unattended. The user can create a new worktree or select an existing worktree
  on the target host; branch rows are not dispatch destinations. A new worktree
  uses `worktree: { baseBranch }`, while the pending dispatch carries the exact
  target-host worktree path when an existing worktree is selected.
- **Minting moved to the client.** Before the prompt leaves, the renderer mints or
  binds the task on `taskServerId` (`tasksPrepareForSession`) and hands the
  execution host the resulting id with `skipTaskCreation`. The session link is
  written to the same host at `session_init`, which is the first moment a session
  id exists. The execution host keeps its own minting path for sessions it starts
  itself — agent tools, automations — which run where their project already is.
- **The task store reads every connected host** and remembers which host each task
  came from, routing later reads and writes back to it. Task ids stay bare strings
  — they are ULIDs, unique across hosts — so routes, deep links and agent tools
  never learn that hosts exist.

## Consequences

One dispatch pattern serves both flows; they differ only in which host the picker
records as the project's. The `Run on` picker derives its whole state from the two
ids (`runTarget`), which is what lets it distinguish "runs on Studio, files here"
from "is Studio's project" — two states that look identical but behave opposingly,
and previously could not be told apart at all.

Costs:

- One extra round trip before the first prompt of a session. It is overlapped with
  the watch and start-target resolution that already gate that prompt, and a
  failure falls back to the old behaviour rather than swallowing the send.
- The task list is only as complete as the set of connected hosts. A host that is
  not connected contributes nothing, and its absence is reported rather than
  silently narrowing the list.
- Task ids must stay globally unique. They are ULIDs, so this holds without
  coordination, but a future id scheme cannot be per-host sequential.

## Amendment (2026-08-20, session attempts)

Only *binding* still happens before the prompt leaves. A session whose target is
a new task keeps that target through its whole first turn, so the user or the
agent can link it to an existing task while the turn runs; the client mints the
fallback task after the turn settles, and only when neither did. The host is
unchanged: both the binding and the fallback mint run on `taskServerId`, and the
execution host is still told `skipTaskCreation`. Branch and execution host now
live on the session record rather than on the link (ADR-0016).

## Amendment (2026-09-02, one owning task per session)

The settlement mint above is withdrawn. A task that exists only after the first
turn cannot group sessions from the start: a second session opened under it
during that turn has nothing to join, and every one of them minted its own. The
mint returns to the first dispatch, on `taskServerId`, so a session has its task
from the moment it exists.

What the settlement was protecting against — the agent linking an existing task
mid-turn and the sidebar then drawing the conversation under both — is now a
store rule rather than a timing trick. `task_session_links` keeps exactly one
`working` owner per session. Writing a working link elsewhere transfers
ownership: the previous owner's attempt row is removed and recorded as an
unlink, and a session-born placeholder left with nothing in it — no other
session, no subtask, no comment, no link — is deleted. The rule lives in the
link write, so it holds for the client's first-dispatch bind, the agent's
`link_task_session`, an automation, and an older build alike. A `referenced`
link is a relationship, not ownership: it appears on the task page and projects
a sidebar row only where the user opened that task.

Consequences for the client: the durable link outranks the binding recorded at
first dispatch when a started session sends its next prompt, so a transfer moves
the row and the follow-up prompts together. Existing rows with several working
links are settled on upgrade the way a live transfer would settle them: the
newest is the owner, older ones become references, and an untouched placeholder
is dropped.
