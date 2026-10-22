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
time its process starts. The change number increases after each committed task
write (`emitChanged`, the same writes that send `tasks.invalidated`) and after
each share change of a task. The reader key is a hash of the principal (without
its grant expiry) and its record scope, because two readers can see different
lists. The server keeps the last 2,048 changes in memory.

## Compatibility rule

- An old client sends no `since`. It gets the whole list, as before. It ignores
  `revision`.
- A new client that talks to an old server gets the whole list without
  `revision`. It then does a whole read at each connect, as before.
- The server gives the whole list when it cannot answer exactly: a different
  boot id or reader key, a revision older than the kept changes, a change that
  named no task (a delete or a write to many tasks), or more than
  `MAX_SIDEBAR_TASK_IDS` changed tasks.

## Stale and reverse cases

- A change while the client was away: its id is in `changedTaskIds`. The client
  reads that row again, or removes it when the answer does not hold it.
- A server restart: the boot id is different, so the client gets the whole list.
- A whole read of all hosts forgets the revision of each host that it did not
  read, so the next connect of that host is a whole read.
- Limit: a resume is as fresh as the `tasks.invalidated` events. A field that
  changes without that event (for example the `lastActivityAt` of an attempt) is
  not read again at a reconnect. A second server process on the same data
  directory does not increase this server's change number.
- Mobile does not read the task list, so it has no change.

The answer no longer has `prLinksByTask`. Each client since the first public
release reads `prLinkListsByTask`, and its first entry is the newest link.
