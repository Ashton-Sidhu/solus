# Task epics

Solus does not manage epics. An epic comes only from the provider: the parent
issue on GitHub, or the `parent` field on Jira. Solus shows it and gives its
description to the agent. Solus never creates, moves, or closes an epic, and
never writes the link to the provider.

## The model

An epic is a snapshot on the task (`Task.epic`, `TaskEpic` in
`packages/contracts/src/task-types.ts`), not a reference to another task. The
host does not need a copy of the epic.

- A provider read sets it. The GitHub adapter reads `parent { number title url }`
  on every issue, and the parent's `body` on a detail read. The Jira adapter reads
  `parent` and, on a detail read, fetches the parent's summary and description.
  Jira Cloud reports an epic through `parent` for every project type, so the
  retired Epic Link field is not read. A Jira epic that the person cannot read
  does not fail the read of the task: the task names the epic with no
  description.
- A list read (a read of a task source) carries the epic without its
  description. The host's copy (`tasks.epic`) keeps the description of the same
  epic from an earlier detail read.
- The epic is not a writable field (`Task.writableFields`). A read that reports
  no parent clears it.
- A draft item of a GitHub Project has no epic.

## Where it shows

- **Task page.** The properties rail has a read-only **Epic** row, in both the
  column and the stacked sheet. It shows the provider logo, the epic's title,
  and its reference. Clicking it opens the epic on the provider. The row is
  absent when the task has no epic.
- **Task packet and `read_task`.** One block names the epic and carries its
  description, clipped to 2000 characters:

  ```text
  Epic: jira ACME-1 — "Release 2.0" — https://acme.atlassian.net/browse/ACME-1
    Every client in one week.
  ```

There are no subtasks, no epic list, and no epic filter on the board. Sessions
that work on one task are attempts on that task.
