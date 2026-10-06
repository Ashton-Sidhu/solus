# Notifications hub

The Notifications page shows what is addressed to the person: review requests
and decisions, task and pull request assignments, finished automation runs,
finished guides and lenses, and mentions. It reads every host and every
organization home the client reaches. Implementation plan:
[plans/015-notifications-hub.md](../../plans/015-notifications-hub.md) (v2).

## Ownership

One `notifications` table at each record home. A notification lives where the
event happened:

| Event | Home of the notification |
| --- | --- |
| Local work or task change | Its Local host |
| Work or task change saved by an organization's Solus API | That API |
| Automation run finished | The host that stores the run |
| Guide or lens finished | The host that stores the result |
| Pull request assignment or review request | The personal host whose PR sync read it |

An agent that changes an organization record through the Solus API makes the
notification there; its host writes no copy. Host-owned results stay on the
host, including runs made for an organization. Nothing replicates
notifications between homes.

## The SDK

`recordNotification(tx, input)` in `packages/server/src/data/notifications/store.ts`
is the only producer entry. Call it inside the transaction of the change that
caused the event, so the row commits or rolls back with it. It validates the
typed facts and resource, removes repeated recipients, drops a person's own
review, assignment, or mention action toward themselves, and keeps one row per
recipient and `eventId` (one occurrence: a replay writes nothing, a deliberate
re-request has a new id). It announces the change to the recipient's
connections after the commit.

`recordNotificationSync(sqlite, input)` is the same write for the automation
store, which still uses the synchronous `withTx`. It runs on the host's one
SQLite connection inside that transaction. Where the hub's table is in another
database (a Postgres engine), no atomic write is possible and no row is written.

Recipients are user keys at the home and always come from the domain operation:
the requested reviewers, the requester of a decision, the typed
`assigneeUserId` of a task (never a provider login), the creator of an
automation, the requester of a generation, the person a mention names. A
pull request event names the host's user only on a personal host, whose
code-host credential is theirs.

A row holds no work body, transcript, or automation output: a kind, bounded
facts, a portable resource reference, who acted, and a short summary.

## Reads and state

`notificationsList`, `notificationsCount`, `notificationsSetRead`, and
`notificationsSetArchived` serve IPC, WebSocket, and the record API
(`/v1/me/notifications`). The recipient is the admitted principal; a client
never names a user. Rows the caller can no longer open are left out before a
page or a count is cut. Read and archived are separate facts the recipient sets
(never toggles); neither approves, completes, or cancels anything. Whether a
review is still open or a task is still yours is the owning domain's answer.

`notifications.changed` carries nothing but the fact. A client reads that
source's count again. While the Notifications page is visible, it also reads
the first page again; older pages are read again through Load more.

## Clients

`packages/client-core/src/notifications/` holds the engine, the source list,
the merge order, and the presentation helpers. The Svelte store
(`contexts/notifications/notification-hub.store.svelte.ts`) and the native hub
(`apps/mobile/src/features/notifications/`) use the same engine.

Startup reads the unread count and subscribes to changes. History is read only
while a Notifications pane is visible on desktop/web, or its screen has focus
on mobile. Closing the last such surface clears the loaded history and stops
history reads; counts remain live. Opening it again reads a fresh first page.
Capability is read once per source connection and checked again after reconnect.
The first connection shares a pending startup read instead of starting another.

- Sources are read on their own, with bounded concurrency; one slow or failing
  source holds no other. A failed read is stale state, not a revocation: loaded
  rows stay, marked, and their controls are off until the source answers.
- A read or archive choice goes to the row's own source while it is connected.
  It is sent once and awaited; the source is then read again. Nothing is queued,
  stored, or sent again on its own.
- Sign-out or another identity clears every row; nothing is cached on disk.
- An older host shows as "update Solus", not as an empty inbox.
- Two directories listing one organization id is shown as a conflict, and no
  service is dialed for it.

Opening a row opens its resource on its source and marks it read. The native
client has no work, task, pull request, or automation screen yet (plan 017); it
says where the resource opens instead.

## Limits

- Pull request events are recorded only when PR sync reads the needs-review
  list for a repository, which happens while a client shows that list. A request
  made and removed between two reads is never seen, and none is recorded while
  no read runs. The first read for a repository records nothing.
- The hub raises no sound, toast, system alert, or push. Those stay with the
  existing delivery owner; background push for personal rows is a separate
  feature that needs recipient-bound device registration.
- Organization membership of a task assignee is the client directory's answer,
  as it is for review requests; the server checks the key's kind only.
