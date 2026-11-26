# Mobile session shell

Status: approved direction ("Solus RPC, T3 parts"), contract in `packages/contracts/src/session-shell.ts`.

## 1. Problem

The phone builds its session list from several reads and adds facts to the rows as they arrive:

- `sessionDirectoryOpen` (32 rows, projects, codebases, pins, attention, automation names), then more `sessionRecordList` pages, then a second read of 200 rows that are out of the list.
- `ThreadDirectory` keeps the records. `ThreadListState` keeps facts on top of them (views, states, executions, live status, attention, read state, pull request links), and reads one record again for each row event (`sessionRecordGet`).
- The device copy (`MobileSessionCache` directory) keeps records, projects, and pins only.
- Each start reads the whole list again. No cursor tells the host what the phone already has.

So the header and the filters show first, the rows show later, and badges and states change on rows that are already on the screen.

## 2. How T3 Code does it

T3 Code (`apps/mobile/packages/client-runtime/src/state/shell.ts`) keeps one shell snapshot for each host:

1. The device keeps the complete snapshot (`client_cache`, kind `shell`). Each row has every fact the list shows. The list paints from it before the network (status `cached`).
2. Each snapshot has a `snapshotSequence`. On connect, the client asks for the changes after it. The server sends the changes, then `synchronized` (status `live`). A cursor that the server cannot continue gets `snapshot-required`, and the client loads one snapshot.
3. One reducer applies the changes to the snapshot. The release rule (`stepSteadyShells`) shows the new rows of all hosts together, at the latest after 2 s.
4. The client saves the snapshot again only when the sequence moves forward.

## 3. Decision

The Solus host adds one operation and one event topic with T3's shape. Solus keeps transport, authentication, and scope. The phone keeps one copy of each host's shell and paints from it.

Reused from T3:

- the status model: `empty`, `cached`, `synchronizing`, `live`;
- the cursor protocol: snapshot, changes after a cursor, synchronized, snapshot required;
- the device table `client_cache` (kind `shell`, one record for each host and account scope) through T3's `MobileDatabase`;
- the release rule `stepSteadyShells`.

Not reused, and recorded in `apps/mobile/UPSTREAM.md`:

- T3's shell encoder and `applyShellStreamEvents`. They are typed to T3's row (`OrchestrationV2ThreadShell`), which has no place for the Solus facts the row shows (automation name, codebase, agent activity, attention). The phone stores and reduces the Solus rows, and projects them to T3 rows with `apps/mobile/src/solus/session-list.ts` when it reads them. The reducer is a keyed replace: about 30 lines.

`hostAway` (a host past its reconnect grace) stays on the phone. It describes the connection, not the session.

## 4. Contract

`packages/contracts/src/session-shell.ts`:

- `SessionShellRow`: `record` (a `SessionRecord` as the caller reads it, with their view, the state, the execution, and the pull request links), `pinnedAt`, `attention`, `automationName`, `agentActivity`.
- `SessionShellCursor`: `epoch` (one value for each host process start), `scopeKey` (a digest of the caller's person and organization scope), `sequence`.
- `SessionShellSnapshot`: `cursor`, `rows` (listed sessions and each pinned session out of the list; no child sessions), `projects`, `codebases`, `indexing`.
- `SessionShellChange`: `row.updated`, `row.removed`, `project.updated`, `project.removed`, `codebases.updated`, `indexing.changed`. Each change carries the current state of its key.
- `sessionShellOpen({ after? })` answers `{ kind: 'snapshot' }` or `{ kind: 'changes', fromSequence, cursor, changes }`. After the answer the caller is synchronized.
- Event `sessionShell.changed` (`SessionShellChanges`): the next changes for one client, with its own payload. `fromSequence` lets the client find a gap; a gap opens the shell again.
- Capability `sessionShell`. Permission `HOST_USE`, plane `collaboration`, as `sessionDirectoryOpen`.

The connection ends the subscription. There is no close operation: a client that opened the shell follows it while it is connected.

## 5. Host

### 5.1 Rows for one caller

A snapshot reads the same rows that `sessionDirectoryOpen` reads, for the same caller and scope: `listSessions` through the Solus API client, the pins, the attention, the projects, the codebases, and the automation names. The rows of every page are in one snapshot, not only the first 32. `agentActivity` comes from the host's live state.

### 5.2 Sequence and change log

- One sequence for the host process, starting at 0, and one `epoch` (random, made at start).
- The log keeps keys, not rows: `{ sequence, key }`, where a key is a session id, a project path, `codebases`, or `indexing`. It keeps the last 2,000 entries or 10 minutes, whichever is fewer.
- Each change that can move a row in someone's list adds a key: a record upsert or delete, a title, view, state, pin, read state, execution, status, activity, attention, or pull request change, a share change, a fork, an index change, `projects.changed`, `codebases.changed`, and an automation rename (each session it started).
- `sessionShellOpen({ after })` answers `snapshot` when `after` is absent, the epoch or `scopeKey` differs, or `after.sequence` is older than the log. Otherwise it reads the current state of each changed key for this caller. A session that the caller cannot read now becomes `row.removed`.

### 5.3 Live changes

- The host keeps the clients that opened the shell, with their scope. A closed connection removes its client.
- Keys that change within 50 ms go out together. For each subscribed client, the host reads the current state of those keys for that client and publishes `sessionShell.changed` to that client only (`events.publish([clientId], ...)`). `eventResource` in `sharing/event-audience.ts` returns null for this topic: the payload is already made for one caller, so the audience is the client list the host chose.
- The scope rules are the same as for the snapshot. A row that a caller lost (a share was revoked, the session moved to another organization) goes to that caller as `row.removed`.

### 5.4 Modes

- API mode reads its rows from the Solus API as `sessionDirectoryOpen` does. The log follows the same record changes.
- A host without the capability keeps the old path on the phone (§7, phase 3).

### 5.5 Host implementation (phase 2)

- `packages/server/src/transport/events/session-shell.ts` (`SessionShell`) keeps the sequence, the epoch, the log, the clients that follow, and the live agent activity. The log holds each key one time, at its newest sequence, so a busy session does not fill it.
- `packages/server/src/transport/handlers/session-shell-handler.ts` reads the rows for one caller. It uses the reads of `sessionDirectoryOpen` (`session-directory-handler.ts` exports them) with the caller's own context. A changed session is read with `getSession`: a top-level session in the caller's list, or one they pinned, is a row.
- The keys come from these sources:
  - each event that `HostEventPublisher` hands over (`observe`): title, fork, pull requests, state, status, activity, execution (not a sub-agent's), index, share, `codebases.changed`, `projects.changed`, and `automation.changed`;
  - the domain changes that no connection may hear, because they go to one person only or to no event: a record write or delete, a person's view, read state, and pin (`onPinnedSessionChanged`), and the attention entries (a diff of each `attention.onChange`).
- A project key is a path: the host compares its project list before and after `projects.changed`. An automation that is saved with a new name, or deleted, moves each session of its runs.
- Scope safety: a client gets `row.removed` or `project.removed` only for a key that this process sent to the same `scopeKey` before. A caller does not learn the id of a session, or the path of a project, that they could not read. This is how §5.2 "a session that the caller cannot read now becomes `row.removed`" applies.
- A client that falls behind the log gets an event that does not continue its copy, and opens the shell again.

## 6. Phone

One driver for each host (`apps/mobile/solus-core/features/threads/`):

1. At start, read the host's shell record from `client_cache` with the saved account scope (the same early start as the directory restore now). Status `cached`. The list paints from it.
2. On a ready connection, call `sessionShellOpen` with the saved cursor. Status `synchronizing` until the answer, then `live`. Apply `sessionShell.changed` in sequence order. A gap, a new connection, or `snapshot-required` opens again.
3. Save the record when the sequence moves forward, at most once each 500 ms.
4. Project rows to T3 rows with `session-list.ts`, then give them to `navigation-threads.ts` and `stepSteadyShells` with the driver's status.

Solus features that must keep working:

- **Cloud-only rows** (`CloudSessions`): merged after the host rows, as now.
- **One row for a session on two hosts** (`oneRowPerSession`): the same rule on the merged rows.
- **Shared with you**: a newly visible shared row arrives as `row.updated`; `ShareArrivals` reads it there.
- **Child sessions**: `loadChildren` stays a point read.
- **Pins**: in the rows. Pin and unpin keep their commands; the change comes back as `row.updated`.
- **Search results and sessions out of the list**: point reads at search time. The 200-row read at start goes.
- **Prefetch**: reads the top rows from the driver.
- **Row actions** (archive, settle, snooze, read): keep their commands and their quick local change; the host's `row.updated` confirms it.

## 7. Phases

1. Contract (this commit).
2. Host: rows for one caller, sequence, change log, `sessionShellOpen`, live changes, capability. Tests.
3. Phone: driver, `client_cache` record, status, home list and tablet sidebar read the driver when the host has the capability. Tests.
4. Remove the old list loading: the directory reads and row reads in `ThreadDirectory`, the fact overlay in `ThreadListState` where the rows carry the fact, and the `MobileSessionCache` directory. Keep what other features still use. Update `apps/mobile/UPSTREAM.md`.

## 8. Tests

- Host: a snapshot has the same rows as `sessionDirectoryOpen` for the same caller; a cursor gets only later keys; another epoch, another scope, or a cursor older than the log gets a snapshot; a revoked share becomes `row.removed` for that caller only; two callers get different payloads; changes within 50 ms go out once.
- Phone: a start paints from the saved record before any network read; an unchanged host answers with no changes and the list does not move; a gap opens the shell again; an old scope never fills a new scope; the release rule holds the fresh rows of one host while another host connects.

## 9. Open questions

- Desktop and web use their own session list. They can use this operation later; this plan does not change them.
- Phase 4 removes the old path. A host without `sessionShell` then shows its rows only after an update. Decide before phase 4 whether to keep the old path for such hosts.
- The log size (2,000 entries, 10 minutes) is a first value. Measure how often phones get `snapshot` after a short absence.
- A session leaves a list when its last activity passes the idle limit (`SESSION_LIST_IDLE_MS`, 30 days), with no event. Once an hour the host records each session that passed the limit since the last check (`SessionShell.checkIdleSessions`), so a phone that continues from its cursor gets `row.removed` too, at most one hour late.
- The first index sweep can end with no index event. Then `indexing.changed` comes with the next change, not at once.
- An automation rename reaches only the sessions of the runs that the host keeps.
