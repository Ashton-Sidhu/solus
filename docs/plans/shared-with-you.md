# Shared with you — a separate place for sessions other people own

Status: built, 2026-10-28, not yet checked in a running app. §12 lists where the build differs from the sections above.

A session that another person shares with you gets its own section in the
sidebar, **Shared with you**, between Sessions and Working. A share also
shows a toast and puts an entry in your notifications. A shared session never
goes into Tasks, Sessions, Working, Snoozed, or Completed.

This plan is the sidebar and notification part of the sharing-first
workspace direction: your own items first, then the items other people share
with you.

## 1. Problem

Today a share does not tell the recipient anything. A shared session goes
into the recipient's list when they open it in a tab, prompt it, or open a
task that links it. After that it is mixed with their own sessions in
Sessions or Working, and it has no mark. The recipient cannot see which
sessions are theirs and which are not.

As read on 2026-10-27:

- The list read is `sessionRecordList` → `SessionApiOperations.list`
  (`packages/server/src/data/sessions/api-operations.ts:208`). It applies
  `sessionListedClause` (`session-records.ts:100`): a session you do not own
  is listed only when you have a `session_views` row for it.
- A share writes an `acl_entry` row. It does not write a `session_views`
  row. A prompt writes one (`SessionViewer.returnToList`,
  `session-states.ts:208`), and so does an open tab (`session-sidebar.store.svelte.ts:427`).
- The sidebar puts rows in sections in `session-sidebar.store.svelte.ts:729-820`.
  `ListedSession` and `SidebarTask` do not carry `ownerKey`, so the sidebar
  cannot tell a shared session from your own.
- `share.changed` (`packages/contracts/src/sharing.ts:154`) reaches every
  client that can see the resource. The client shows a toast only for
  "Access removed" (`shares.store.svelte.ts:110-121`). The notifications hub
  has no share kind (`packages/contracts/src/notification-hub.ts:66-74`).
- Mobile reads the same list (`apps/mobile/src/features/threads/thread-directory.ts:159`).
  It finds shared sessions only in search.

## 2. Rule

1. **The owner decides the section.** A session in your list whose
   `ownerKey` is not your person key is in Shared with you. This is true
   however it got into the list: a share, an open tab, a prompt, or a link.
2. **A direct share puts the session in your list.** A `user` entry that
   names you, or a `team` entry for a team you are in, lists the session.
   You do not have to open it first.
3. **An organization entry or a link does not.** "Everyone in
   `<organization>`" and "Anyone with the link" give access only. Such a
   session goes into your list when you open or prompt it, as it does today.
   It then goes into Shared with you by rule 1.
4. **Archive removes it. A new grant brings it back.** You archive a shared
   session in the same way as your own session: on your own `session_views`
   row. It comes back when the owner shares it with you again or raises your
   role after you archived it. A lower role does not bring it back.
5. **A share tells you one time.** A direct share (rule 2) shows a toast and
   writes one notification. The same is true when the owner raises your role.
6. **Removed access removes the row.** When the owner removes your access,
   the row goes away and a notification says who removed it.

A task is not shared (`cloud-sharing.md` §4b). A shared session that is a
child of your own task stays in that task's row: the task is yours.

## 3. Vocabulary

- **Shared with you** — the sidebar section, and the matching group on
  mobile. Do not call it "inbox", "shared sessions", or "other people's
  sessions".
- **shared session** — a session in your list that you do not own.
- **direct share** — a `user` or `team` ACL entry. An `organization` entry
  and an `everyone` entry (a link) are not direct shares.
- **granted at** — when a direct share last gave you access or raised your
  role.
- **archive** — as in `session-archive.md`. Do not say "dismiss" or "hide".

## 4. Server

### 4.1 When a grant happened

`acl_entry.created_at` does not change when `shareSet` raises the role on a
row that exists. Add `granted_at` (bigint) and `granted_by_name` (text), both
nullable (migration `0026_acl_granted_at`). Set them on insert. Set them again,
with `granted_by_user_id`, when the role goes up: a higher role is a new grant
by the person who raised it. Do not change them when the role goes down. A
read takes a null `granted_at` as `created_at`. The mirror to the Solus API
carries both fields. `granted_by_name` lets a notification say "Alex shared …"
on a host that keeps no names of people.

### 4.2 The list

Change `sessionListedClause` so that a session you do not own is listed in
one more case: a direct share admits you, and your view row is absent, or its
`archived_at` is null, or `archived_at` is older than `granted_at`. The
present cases do not change. Nothing writes another person's view row, and a
grant does not clear an archive: the archive only stops counting.

A team entry admits the reader in the same way as `roleOf` does
(`access-model.md` §2.3). Use one predicate for both, so that the list and a
get cannot disagree.

The Solus API's copy of the rows (`host-sharing.md` §4.2) answers the same
clause for a mirrored session.

### 4.3 What a record carries

`SessionRecord` already carries `ownerKey` and `role`. Add `sharedBy`, the
person who made the direct share (from `granted_by_user_id`), and
`grantedAt`. Both are absent on a session you own and on a session that only
an organization entry or a link lists.

### 4.4 Events and notifications

A host does not know who is in a team. It learns a person's teams only from
that person's token (`principal.teamIds`, `admission/access.ts:65`). So a
share does not write one notification per member. The recipients are found
when a person reads, with the same match as the list and the access check.

- The notifications hub gets one new resource, `session`, and one new kind,
  `session.shared`, with `role` and, for a team share, `teamId`. Before a
  person's hub is listed or counted, the host reads its direct shares that
  name them (their id and `teamIds`, §4.2) and writes one hub row for each
  grant inside the list's idle window (`recordSharedSessions`). The event id
  is `session.shared:<entry id>:<granted at>`, so a repeated read writes
  nothing and a higher role writes a new row. The rows then have the hub's
  normal read and archive state. A person who joins a team later gets the
  team's recent shares the same way, and not its whole history. Only the
  session's home writes these rows, the same home a client reads the
  session's list from (`sessionHomeId`): the organization's Solus API for a
  published organization session, the machine for any other. A client reads
  the hub of both, so a row at each would show the share twice. The event id
  is `session.shared:<session>:<subject kind>:<subject id>:<granted at>`, not
  a row id: a Solus API writes a runner's share rows again, with new ids,
  each time they arrive.
- A share that gives a person a session, or a higher role on it, sends
  `notifications.changed` to that person, so their client reads the hub at
  once and the read writes the notice. A team share sends nothing: a host does
  not know the team's members. They find the notice on their next read (the
  window comes to the front, a reconnect, or Notifications opens).
- `share.changed` does not change. The client reads that one session again on
  it (`sessionRecordGet`): the row joins, changes, or leaves the list.
  The client also reads the list again when a hub source's unread count goes
  up (`onUnreadRose`), because a new notice can be a share. A shared row with a
  `grantedAt` newer than what this client saw before shows the toast (§5). So
  the row and the toast come with the notice, also when `share.changed` does
  not reach the client.
- Removed access uses `removedUserIds` as it does today, and the host writes
  a `session.unshared` notification for each of them, so that the notice
  stays after the toast. A removed team entry names nobody
  (`share-manager.ts:585`). Its members see no notice: the row leaves their
  list.

### 4.5 Opening a session you cannot open

The host checks every request (`access-model.md` §2.3), so a notification or
a stale row never gives access. A member who opens a session with no role
sees "You don't have access to this session" and "`<owner>` owns
`<title>`. Ask them to share it with you." The message names the session,
not the host. A request-access action is not part of this plan. A host that does
not answer shows "`<owner>`'s computer is offline", which is a different
state.

## 5. Desktop and web

- `ListedSession` and `SidebarTask` carry `ownerKey`, `sharedBy`, and
  `grantedAt`. `SessionListStore` keeps them. Today it drops `ownerKey`.
- `session-sidebar.store` gets `sharedRows`. Rule 1 takes a row out of
  `sessionRows` and `workingRows` and puts it in `sharedRows`. An open tab of
  a shared session is a row in `sharedRows`.
- `SidebarSection` gets `shared`. The header reads "Shared with you" and shows
  a count. It goes between Sessions and Working. It is open by default. It
  opens when a new direct share arrives.
- A row has the normal session row layout, the owner's avatar, and the role
  ("Can view", "Can edit"). Rows go newest `grantedAt` first. A row that you
  have not opened shows the unread dot (`UnreadDot.svelte`).
- The context menu has **Archive**. The archived session is in the session
  picker, as for your own session.
- `SessionListStore` reads the session again on a `share.changed` for it.
- When that read adds a shared row with a newer `grantedAt`, a toast shows
  "`<name>` shared `<title>` with you · Can edit". It has one action, **Open**.
  It does not take focus from the composer.
- The session picker and the command palette show a "Shared" label on a
  shared session.
- The sidebar search covers the section, as it covers the others.

## 6. Mobile

- The home list in `apps/mobile/src/features/threads/` gets a Shared with
  you group in the same position, with the same rows and the same Archive.
- The toast is a native toast with Open.
- The notifications screen shows `session.shared` and `session.unshared`.

## 7. Not changed

- Guests. A guest sees only the shared session (`host-sharing.md` §10).
- The Share dialog, roles, and links.
- Claude and Codex. Nothing here is provider-specific.

## 8. Order

1. `granted_at`, the list clause, and the record fields, with tests (§9).
2. `session.shared` as a read-time match, `session.unshared`, and the
   no-access state (§4.5).
3. The desktop and web section, the toast, and the labels.
4. Mobile.
5. Update `session-archive.md`: its "session list" definition says a session
   is yours when you own it, prompted it, or organized it. Add a direct share.

## 9. Proof

Server tests on the list (`sessionRecordList` as one person):

- A `user` entry for the reader lists the session, with `sharedBy` and
  `grantedAt`.
- A `team` entry for a team the reader is in lists it.
- An `organization` entry and a link do not list it until the reader prompts it.
- After the reader archives it, it is not listed. A raised role lists it
  again. A lower role does not.
- Removing the entry removes it from the list.

Client tests on `session-sidebar.store`:

- A listed session with another `ownerKey` is in `sharedRows` and not in
  `sessionRows` or `workingRows`, also when it is running and when its tab is
  open.

## 10. Decisions (maintainer, 2026-10-27)

1. Shared with you goes between Sessions and Working.
2. An archived shared session comes back when it is shared again or the role
   goes up.
3. A share shows a toast and writes a notification.
4. This flow has its own plan. The workspace page proposals are a different
   plan.

5. A host finds the recipients of `session.shared` when a person reads, not
   when a share is made (§4.4). The notification, the list, and the access
   check use one match, so a notification never opens to "no access".

## 12. As built (2026-10-28)

Where the code differs from the sections above, the code and this section win.

- **Personal completion removes a shared session from the sidebar.** This
  applies on desktop, web, and mobile, including an open session. Undo or
  marking it active in the session picker returns it. A shared settle by its
  task or pull requests does not remove it from the reader's list.

- **A client finds a shared session by its role.** A role other than `owner`
  or `none` means "another person owns it". No client needs the reader's
  person key. A record with no role, from an older host, is the reader's own.
  Since plans/031 (2026-11-03) the owner of a personal host holds `owner` on
  every record on it, so nothing on their own machine is in Shared with you;
  Shared with you comes from what other people share on hosts the reader does
  not own, and from Solus API reads. Mobile reads the same rule.
- **Desktop and web: "not opened" is local.** The host does not say whether
  the reader opened a shared session. The client keeps the opened grants in
  `localStorage` (`solus:opened-shared-sessions`, at most 500).
- **Desktop and web: the no-access state is a notice, not a pane.**
  `getSessionInfos` answers null for a refused session and for a deleted
  one alike. So the notice of §4.5 shows only for a session the client knew
  as shared; any other session keeps "Couldn't find that conversation".
  The notice names the session and its owner, never the host, and says
  "`<owner>`'s computer is offline" when the host is not connected.
- **A viewer may archive and return a shared session.** Archive writes only
  the reader's own view, which the server already allowed. The context menu
  and the picker no longer ask for `drive` for these two actions.
- **No task rows.** The sidebar lists sessions only; a linked task is a chip
  on its session's row. So the rule "a shared child of your own task stays in
  the task row" has no task row: a shared session keeps its task chip and is
  in Shared with you. A shared session nested under one of the reader's own
  sessions stays nested there.
- **A shared row shows the owner and the role in place of the host label.**
- **`session.unshared` opens the session on desktop and web,** which shows
  the no-access notice. On mobile it opens nothing and is only marked read.
- **Mobile has one active group** (Sessions and Working together). Shared
  with you goes after it and before Snoozed. Mobile has no task rows, so the
  task-child rule does not apply there. Mobile has no people directory: its
  rows show a person icon and the role, and its toast says
  "Shared with you: `<title>` · `<role>`". Its toast uses the Undo notice,
  so it shows on Home and the iPad sidebar only.
- **No toast for shares made while the client was closed.** Each client keeps
  a mark per host that starts when it starts; the hub keeps those shares.
- **Version skew.** A client reads the session list through the record API,
  which checks each page against a strict schema. A client older than this
  change rejects a page that holds `sharedBy` or `grantedAt`, so its list is
  empty while that page holds a shared session. `listed` was added the same
  way. A `/v1` reader of the hub has the same limit for the new kinds.

