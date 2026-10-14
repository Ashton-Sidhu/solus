# Session archive and the session list

Status: implemented, 2026-10-14.

A session's place in a person's list (active, settled, snoozed, archived) is
part of the session. Each client reads the host's full list of sessions that
are not archived, and each session in it carries its state. This follows
T3 Code: a thread shell carries `settledAt`, `snoozedUntil` and `archivedAt`,
the client gets every thread that is not archived, and a change arrives as an
event with the new state (`thread.snoozed`, `thread.unsnoozed`; read at
`pingdotgg/t3code` main, 2026-10-14).

This replaces the shelf read of `docs/plans/session-pull-requests.md`
(`sessionShelfList`). That read had a limit of 500, and a client took a session
missing from the answer as active. With more than 500 recent settles, a
snoozed session came back to the active list on each reload.

## Vocabulary

- **archived** — the state of a session a person removed from their list. It
  says nothing about the work. Its transcript stays, and the session picker
  finds it.
- **session list** — the sessions a host answers for a person's list: every
  root session that is not archived. The sidebar on desktop and web and the
  thread list on mobile show it.
- **session picker** — the search that finds any session, archived ones too.
- **settled**, **snoozed**, **active** — as in `session-pull-requests.md`. An
  active session is not settled, not snoozed and not archived.

Do not say "closed", "hidden" or "dismissed" for an archived session. Closing
a tab is a different action: it changes nothing on the host.

## Decisions

1. **The host holds the archive.** `session_states.archived_at`. Archive and
   unarchive change only that column. An archived session keeps its settle and
   its snooze, so unarchive returns it to the shelf it was on.
2. **The X on a session's row archives the session**, on its host, for every
   device, with an Undo toast. It also closes the session's tab. The keyboard
   close of a row, the bulk close, and Archive in the row menu do the same.
   "Close Tab" in the row menu only closes the tab: the session stays in the
   list. A task row keeps its X as it is: it hides the row on this client. A
   task is not archived. A session that has not started, and a session the
   reader may only view, only leave this client.
3. **A prompt makes a session active**: it un-settles, wakes and unarchives
   it (`recordSessionPrompt`).
4. **A session idle for 30 days is archived**, not settled. The rule covers a
   session record with no `session_states` row. Migration `0017` archives the
   old sessions that nothing ever put away, once, before a client reads the
   list, so the first sweep does not send one event per session. PR sync
   archives the later ones (`archiveIdleSessions`). A session with an open
   pull request, a snooze still running, or a turn in progress stays.
   `settledBy: 'idle'` stays only on old rows.
5. **The state is part of the session.** `SessionRecord.state` and
   `WorkspaceSession.state` carry `settledAt`, `settledBy`, `snoozedUntil`,
   `snoozeNote` and `archivedAt`. The host reads them with the record in one
   query (`LEFT JOIN session_states`). For an organization session, the
   organization's Solus API keeps the state (decision 8).
6. **The list has no count limit.** `listSessions` gets two filters,
   `archived` and `roots`. A client reads the list with
   `archived=false&roots=true`, every page. The bound is the archive, as in
   T3 Code.
7. **A change carries the new state.** `session.stateChanged` is
   `{ sessionId, state }`, and `sessionSetSettled`, `sessionSnooze` and
   `sessionSetArchived` answer the same state. A client writes it into the
   session it holds and reads nothing back. A session that comes back to the
   list and that the client does not hold is read with its host's list.
8. **Every client shows the list.** On desktop and web the sidebar shows each
   session of the list, with or without a tab, on its shelf. A session with a
   tab that is not in the list (an archived session opened from the picker)
   shows while its tab is open. Mobile reads the same list for its thread
   list.
   **Organization sessions.** The organization's Solus API keeps an
   organization session's place in the list, because the machines that run
   sessions rotate and go offline. The API lists the session with its state,
   settle, snooze, and archive go to the API, and the API announces
   `session.stateChanged`. A machine's own list and state of the session do
   not stand for it while the client is connected to the API. The session
   opens on the machine that ran it while that machine is connected, and from
   the API, read-only, while it is not (`cloud-service-model.md`, R1/R8). A
   turn that a runner reports (`status: 'running'`) is a prompt: the API makes
   the session active and returns it to the list (`applyRunnerSessionRecords`).
9. **The picker shows everything.** An archived session has an "Archived"
   mark. An "Archived" filter shows only archived sessions. Opening one does
   not unarchive it; its menu has Unarchive.
10. **Agents can archive.** `organize_session` gets `archive` and
    `unarchive`.

## Implementation

- Server data: `data/sessions/session-states.ts` becomes the `SessionShelf`
  class, one per session id: `settle`, `unsettle`, `snooze`, `archive`,
  `unarchive`, `recordPrompt`, `state`. The sweeps (`settleSessionsWithEndedPullRequests`,
  `archiveIdleSessions`) stay functions, because they act on many sessions.
  A migration adds `archived_at` (`bun run db:generate`).
- `listSessionRecords` and `readSessionMetadataPage` join the state.
  `SessionApiOperations.list` answers `archived` and `roots`.
- RPC: `sessionSetArchived(sessionId, archived)` beside `sessionSetSettled` and
  `sessionSnooze`. `sessionShelfList` is removed.
- `boot-server.ts` broadcasts `session.stateChanged` with the state.
- Desktop and web: `SessionListStore` (`contexts/workspace/session-list.store.svelte.ts`)
  replaces `SessionStatesStore`. It holds each host's list and writes each
  `session.stateChanged` into it. `SessionSidebarStore` builds a row for each
  listed session that has no tab, and reads the state of a session with a
  tab from the store.
- Mobile: `thread-directory.ts` reads the list; `ThreadListState` writes each
  state change into its threads and drops its shelf map. Swipe and menu get
  Archive; search reaches archived sessions through `sessionRecordSearch`.
- Picker: `conversation-search.svelte.ts` shows the mark and the filter.
- Agent tool: `execution/agents/tools/session-organize-tool.ts`.

## Compatibility

A host older than this change refuses `archived` and `roots` (the query is
strict) and sends no state. The client reads such a host without the new
filters, as `workspace-records.ts` does for `order`, and shows its sessions as
active. An old client reads a new host as before: it has no shelf read, so it
shows no shelves.

## Verification

- `session-states`: archive and its reverse, a prompt unarchives, the idle
  archive covers a record with no state row and spares an open pull request.
- The list: `archived=false&roots=true` answers every session that is not
  archived, past 500, with its state.
- `SessionListStore`: a state change moves one session; a reload keeps a
  snoozed session snoozed.
- Sidebar: a listed session with no tab has a row; X archives it.
