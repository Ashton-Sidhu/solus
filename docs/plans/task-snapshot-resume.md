# Task list resume

Status: done.

## Problem

A client read the whole task list of a host each time its socket connected
again. The list is more than 1 MB at 1,000 tasks. Web and mobile clients connect
again often, and most times nothing changed.

## Vocabulary

- **Whole read**: `tasksSidebarSnapshot()` with no filter. It sends every row.
- **Revision**: an opaque string that a whole read and a resume give back. It
  names the state of the task list that the answer covers.
- **Resume**: `tasksSidebarSnapshot({ since: revision })`. The answer names the
  tasks that changed after that revision (`changedTaskIds`) and holds their
  rows. When nothing changed, the list of ids is empty and the answer has no rows.

## Token shape

`<boot id>.<change number>.<reader key>`. The server makes a new boot id each
time its process starts. The change number increases after each of these:

- a committed task write (`emitChanged`, the same writes that send
  `tasks.invalidated`);
- a share change of a task;
- a write to a session's index row or lineage (`session-indexer.ts`,
  `session-lineage.ts`). A task row shows the title, branch, model, checkout,
  and activity of its linked sessions, and these writes do not send
  `tasks.invalidated`.

The reader key is a hash of the principal (without its grant expiry) and its
record scope, because two readers can see different lists. The server keeps the
last change number of each task and of each session, up to 4,096 of each. A
session that changes on every turn uses one entry. A resume finds the tasks
linked to the changed sessions with one query on `task_session_links`.

## Compatibility rule

- An old client sends no `since`. It gets the whole list, as before. It ignores
  `revision`.
- A new client that talks to an old server gets the whole list without
  `revision`. It then does a whole read at each connect, as before.
- The server gives the whole list when it cannot answer exactly: a different
  boot id or reader key, a revision older than the kept changes, a change that
  named no task (a delete or a write to many tasks), more than 1,000 changed
  sessions, or more than `MAX_SIDEBAR_TASK_IDS` changed tasks.

## Stale and reverse cases

- A change while the client was away: its id is in `changedTaskIds`. The client
  reads that row again, or removes it when the answer does not hold it.
- A server restart: the boot id is different, so the client gets the whole list.
- A whole read of all hosts forgets the revision of each host that it did not
  read, so the next connect of that host is a whole read.
- A linked session that changed while the client was away: its tasks are in
  `changedTaskIds`, so a resume is as fresh as a whole read was.
- A connected client does not get all of these session changes. Only title and
  pull request changes send `tasks.invalidated` (`emitSessionTasksChanged`).
  Activity, branch, and model changes reach a connected client at its next
  reconnect, as before.
- Limit: a second server process on the same data directory does not increase
  this server's change number.
- Mobile does not read the task list, so it has no change.

The answer no longer has `prLinksByTask`. Each client since the first public
release reads `prLinkListsByTask`, and its first entry is the newest link.
