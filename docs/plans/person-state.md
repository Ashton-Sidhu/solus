# Person state: what a person did with a record

Status: phase 1 built 2026-11-24 (server, contracts, client-core, desktop, web,
and mobile). Mobile (`apps/mobile/solus-core/features/history/person-history.ts`)
records an open when a work opens full screen in a conversation, its one entry
point. It has no Threads screen, works library, or app viewer, so it shows no
"Recently viewed" row yet. Signed out, a phone keeps its history on the first
host in its list, because a phone has no default host.

## 1. Problem

Solus kept "what this person did with this record" in many places with different
rules (an inventory of 2026-11-23): session read state per person on the host,
artifact opens in one browser's `localStorage`, the shared-session "opened" mark
in `localStorage`, pins for the host owner only and with no event, task read as
one value per host, plan comment read as one value for everyone, recent projects
per host, and recents on the phone in device storage. A fact kept on one device
is invisible to the person's other devices. A fact kept per host is shared by
everyone on that host.

## 2. Two kinds of person state

The split is by who acts on the state.

1. **Record-coupled state** is state that the record's home acts on: the read
   boundary (unread marks and notifications), archive and snooze (list
   membership, the wake timer, `organize_session`), and pins (list order). It
   stays with the record, in `personal_resource_state` in the record's home
   (this machine, a personal host, or the organization's Solus API). This
   follows the read rule of ADR 0006 and `docs/session-lists.md`.
2. **Person history** is what the person opened and when. No home acts on it.
   Only the person reads it, and always across every home ("what did I open
   recently?"). It is kept in one place for each person: the **person's home**.

## 3. The person's home

| Person | Home | Rows |
|---|---|---|
| Signed in | The Solus API, through the connection of the window's organization | Scope `person:<accountId>`. Every organization connection of the same account reaches the same rows, so the history does not split by organization. |
| Signed out, desktop or web | The device host (`deviceHostId()`: the desktop's own host, or the host that served the page) | Scope `local`, the host owner's key (plan 031 D1) |
| Signed out, phone | The phone's default host | The same |

This is the choice plan 031 D7 makes for the host list. Sign-up always makes an
organization (`portable-sessions-cloud.md` §1.1), so a signed-in person has a
Solus API connection.

**At sign-in** the client reads the device host's history and records it into
the Solus API. A record keeps the later time for each item, so this upload is
safe to repeat; the client repeats it each time the home becomes the Solus API.
Nothing is moved at sign-out: the device host keeps the rows it had.

**Limit.** While signed out, two machines that are each a device host keep two
histories. Signing in joins them.

## 4. Model

- **Record key.** One text key names a record in any home: `work:<workId>`,
  `app:<hostId>:<appId>`, `file:<hostId>:<path>`, `image:<hostId>:<path>`
  (`recentArtifactKey`). The kind is the part before the first colon.
- **Entry.** `{ key, openedAt }`. One table holds both kinds of person state:
  `personal_resource_state`. An entry is the `opened_at` column of the person's
  row, with the key split at its first colon into `resource_kind` and
  `resource_id`, in the scope of the person's home (`local`, or
  `person:<accountId>` on the Solus API). The data module is
  `data/personal-state/person-history.ts`. Every older reader of the table names
  its kind (`session` or `task`), so a history row never reaches it. When an
  entry leaves the history, only `opened_at` is cleared; the row goes only when
  it holds no other state.
- **Record.** `personHistoryRecord(entries)`: an ingest of open events. The home
  caps each time at server time and keeps the later of the stored and the new
  time, so a retry, a batch, or a late event cannot move a time back. A person
  keeps the newest 500 entries.
- **Read.** `personHistoryList()`: the person's entries, newest first.
- **Event.** `personHistory.changed { entries }`, only to the person's own
  connections, so their other devices merge the new times without a read.
- **Client.** `PersonHistory` in `client-core` keeps the entries of the current
  home, applies an open at once, and sends pending opens in one batch after a
  short delay. Opens that a home did not take stay pending and go with the next
  batch. Desktop and web wrap it in `personHistoryStore`
  (`contexts/person-history/`); the servers store tells it the account state,
  where it already chooses the host list, so the store itself stays light
  enough for any opener to import. Mobile uses the class as is.
- **Recorders.** An open is recorded where every entry point meets: `WorkPane`
  for a work, `AppSurface` for an app, and `openArtifact` for a Threads item, a
  conversation chip, or an agent card (files and images open only there).

It is not an append-only log. A feed or analytics can later append the same
events beside the reduced rows; nothing needs that now.

## 5. Readers

- **The Threads row** ("Recently viewed", `docs/plans/session-artifacts.md`
  decision 17) orders the session's items by `openedAt`, then the others by
  when they were made.
- **The Workspace page** shows a "Recently viewed" row at the top: the works and
  apps the person opened, newest first, at most 12. It hides when the person
  opened none (`docs/workspace-page.md`).

## 6. Order of work

1. **Phase 1 (built).** The table, the two methods and the event on hosts and on
   the Solus API; `PersonHistory` and its home choice; opens recorded when a
   work, an app, or a Threads item opens; the Threads row and the Workspace page
   read it. The `localStorage` open log (`ArtifactOpenLog`) is deleted.
2. **Phase 2.** Sessions and projects become history keys (`session:<id>`,
   `project:<hostId>:<path>`); recent projects and the picker read the history.
   Record-coupled outliers: pins for each person with an event, task read for
   each person (or deleted: no client marks a task read), plan comment read for
   each person, and the shared-session "opened" dot from the read boundary.
3. **Phase 3.** Mobile's recent threads and last project read the history; its
   unused `thread.visit` and device recents are deleted.
