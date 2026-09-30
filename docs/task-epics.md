# Task epics

Solus does not manage epics. An epic comes only from an upstream ticket: the
parent issue on GitHub, or the `parent` field on Jira. Solus shows it and gives
its description to the agent. Solus never creates, moves, or closes an epic, and
never writes the link upstream.

## The model

An epic is a snapshot on the task (`Task.epic`, `TaskEpic` in
`packages/contracts/src/task-types.ts`), not a reference to another Solus task.
The epic does not need to be a Solus task.

- A provider read sets it. The GitHub adapter reads `parent { number title url }`
  on every issue, and the parent's `body` on a detail read. The Jira adapter reads
  `parent` and, on a detail read, fetches the parent's summary and description.
  Jira Cloud reports an epic through `parent` for every project type, so the
  retired Epic Link field is not read.
- A list read carries the epic without its description.
- For a native task linked to a ticket, the sync engine stores the snapshot in
  `tasks.epic` on every pull (`writeTaskEpic`). It is not a sync field: a local
  edit cannot change it or queue it upstream. A read that reports no parent
  clears it.

## Where it shows

- **Task page.** The properties rail has a read-only **Epic** row after
  Project, in both the column and the stacked sheet. It shows the provider
  logo, the epic's title, and its reference. Clicking it opens the epic
  upstream. The row is absent when the task has no epic.
- **Task packet and `read_task`.** One block names the epic and carries its
  description, clipped to 2000 characters:

  ```text
  Epic: jira ACME-1 — "Release 2.0" — https://acme.atlassian.net/browse/ACME-1
    Every client in one week.
  ```

There are no subtasks, no epic list, and no epic filter on the board. Sessions
that work on one task are attempts on that task.
