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
- **Only a dispatch forces an isolated worktree**, because only a dispatch leaves
  a base checkout on a machine nobody is watching. The user's own choice lives in
  a single nullable `worktree: { baseBranch } | null` — present the moment
  isolation is asked for, with a null branch while the host has yet to say which
  one it would fork from. One field rather than a request flag beside a branch,
  because a pair can express "not branching, from `main`", and a toggle that
  flipped only half of it is exactly the bug this replaced.
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
