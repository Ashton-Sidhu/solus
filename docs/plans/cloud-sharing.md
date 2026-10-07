# Cloud sharing without the host link

Status: done, 2026-09-30. Replaces the "one server publication operation"
rule in `organization-scope.md` §4 for works and tasks. Since 2026-10-07 no
session is published either, and Insights reports are not shared (§8).

Where it lives:

- Host: `workExportForCloud`, `workMarkMoved`, `taskExportForCloud`, and
  `taskMarkMoved` (`transport/handlers/organization-handlers.ts`, over
  `data/works/works.ts` and `data/tasks/task-transfer.ts`).
- Solus API: `workUpload` and `taskUpload`
  (`transport/solus-api/cloud-uploads.ts`).
- Client: `SharesStore.uploadWork` and `uploadTask`.
- A session stays on its host: Share opens the host's own share list. The
  host has no publication operation.

## 1. Problem

Every Share goes through the host today:

```text
client → host publicationStart → PublicationCoordinator → host link
       → delegated token (host OAuth client) → Solus API runner endpoints
```

So the host link is a prerequisite for every share:

- `sharesStore.canShareFrom` hides every Share entry point until the host
  reports a link (`contexts/sharing/shares.store.svelte.ts`).
- `publicationStart` refuses an organization the host's link does not list
  (`transport/handlers/organization-handlers.ts`).
- A work goes to `RUNNER_WORKS_PATH` and a task goes through the outbox, both
  with a token that names the host (`sync/publication.ts`, `transport/http.ts`
  `admitRunner`).

A person who is signed in, on a computer whose link is missing or rejected,
cannot share a work, a task, or an Insights report. None of these need the
computer after they are shared.

## 2. Rule

Sharing requires the client to be signed in. The shared Share button and other
Share controls stay disabled while signed out, with “Sign in to share” as the
tooltip. This applies to desktop, web, and mobile.

There are two kinds of share.

| Kind | Resources | Needs the host link | Path |
|---|---|---|---|
| **Cloud copy** | work, task | No | The client writes a copy to the Solus API with the person's sign-in. The link points at the cloud copy. |
| **Live session** | session | Yes | The session stays on its host. Share opens the host's own share list and uploads nothing. |

For a cloud copy, the host is only a source of content. The client reads the
content from the host over the ordinary host RPC, then writes it to the Solus
API as the signed-in person. The host token, the host OAuth client, and
delegations have no part in it.

Linking a host registers it and runs the tunnel. Linking is necessary only
for remote access and for live session sharing.

## 3. Flow for a cloud copy

The cloud copy keeps the local id. That one rule makes every step safe to
repeat, so there is no pending row and no idempotency key.

1. **Read.** The client reads the content from the host (§4).
2. **Upload.** The client sends it to the Solus API with the person's sign-in.
   The API stores it under the same id. If that id is already there with the
   same content, the API answers "already there". If it is there in another
   organization, the API refuses.
3. **Point.** The client tells the host to point the local record at the
   organization. The host does this only if the record did not change since
   step 1 (same fingerprint); otherwise it keeps the newer copy and says so. A
   work or a task keeps its row with a location (§3a). A work also keeps its
   content.
4. **Share.** The dialog applies the access rules on the cloud record and
   shows its link.

If the client stops after step 2, the local copy is still there. The next
Share repeats the steps; step 2 answers "already there", and step 3 finishes.
Nothing is lost and nothing is copied twice. The host makes no network call.

The membership check moves to the API: it refuses an upload the person may not
make. The client offers the organizations of the signed-in account.

## 3a. A shared work keeps its row

Step 3 does not delete the work's row. It gives the row a **location**: the
organization that has the work now. Only the pointer changes (decision
2026-10-06): the host keeps the body, the revisions, and the comments. The
organization's copy is the authority, and the host answers `WORK_MOVED` for
its own copy.

Many records name a work only by its id: transcript receipts, task links, the
work's sessions, and `work://embed` links in other works. Some of them cannot
be changed after a Share (a provider transcript is written once), and some are
on other hosts. A reader of any of them asks the host it knows. The location
lets that host answer "this work is in organization X" instead of "not found".

- **Column.** `works.location` is null while the work is on this host, and
  `{ "organizationId": "…" }` after Share.
- **Lists.** This host's work lists, search, reviews, and a task's linked works
  skip a row with a location.
- **Reads and edits.** A read or edit of a moved work fails with the code
  `WORK_MOVED`. Its message names the organization.
- **Client.** The works store follows `WORK_MOVED` once: it reads the work
  lists of the connected hosts, records the owner, and asks the owner. A
  reload therefore does not depend on which host the reader asked first. A
  work the client has not listed yet is looked up in the lists first, because
  a work shared before this rule has no row on its old host.
- **Agent tools.** `read_work` and `update_work` on a moved work tell the agent
  which organization has it. They do not read or write the organization's
  copy.
- **Tasks.** A task keeps its row the same way: `tasks.location`, and a read
  or edit fails with `MOVED` (`TaskMovedError`). The host clears the body, the
  comments, the ticket link, and the history, and keeps the id, the title, and
  the links. Its session links stay, so a session on this host still names its
  task, and an agent in it is told which organization has the task. Task lists,
  the sidebar, search, and every other read of a task skip a row with a
  location (`TASK_HERE`). Its linked works get a location through the same step.
- **Sessions of a shared task.** The session stays on the host that runs it;
  nothing of its transcript or checkout goes. The organization's copy of the
  task gets a link to it with its title, agent, and role, and names the host by
  its installation id. A client resolves that id to its own id for the host
  (`serverConnections.resolveId`). Only a client with that host can open the
  session; for everyone else the task page shows the row with no Open, Split,
  or Stop.

## 4. Per resource

| Resource | Read from the host | Upload to the Solus API | Point on the host |
|---|---|---|---|
| Work | `workExportForCloud` (history, annotations, fingerprint) | `workUpload`: the logic of the old runner work route, admitted with the person's sign-in | `workMarkMoved`: a location only, the content kept (same fingerprint, or kept). |
| Task | `taskExportForCloud`: the task, its local comments, its linked Local works, and its sessions' title, agent, role, and host installation id | `workUpload` for each linked work first, then `taskUpload` (task and comments under their ids, linked to the uploaded works and to the sessions on their host) | `taskMarkMoved`: a location on the task and on each uploaded work, each only if unchanged |

`importWork` and `createTask` are not used: `importWork` reads a Google Doc or
Confluence page from a URL, and `createTask` cannot keep the local id. The
Solus API creates works only over HTTP, so a report is filed on the host first
and then travels as a work.

The Insights turn panel shares a report, not the session it came from. To
share the session itself, the person uses the session's own Share. Each Share
captures a new report, labelled with its capture time. The Share dialog sets
who may comment on it, mark it, or rename it.

A report holds what the turn panel reads: the trace, the session rollup, the
session and task names, the comparison against the window's other turns
(`baselines`, not the rows), the session's prompts, and the turn's patch
(`components/insights/lib/turn-report.ts`). Share waits for git's
answer about the change, so the diff is in the report even when the person
shares before the Result card has loaded. `InsightsReportShell` draws it with
the same `TurnReadings` body as the live panel, under the same crumb band as
the turn page (no separate works header), so the person it was shared with
reads the page its sharer did. Nothing on it leads to another turn, the
session, or the task: those stayed on the computer. Comments pin to points on
the page, as on an artifact.

What each role may do on a report:

| Role | Read | Comment | Mark (Good example, Too slow, …) | Rename |
|---|---|---|---|---|
| Viewer | Yes | No | Sees the marks; control disabled | No |
| Commenter | Yes | Yes | Yes, their own | No |
| Editor, owner | Yes | Yes | Yes, their own | Yes |

Each reader has their own mark, kept beside the comments (`WorkAnnotations.marks`)
and set with the `mark` and `unmark` comment commands, so whoever may comment
may mark and nobody overwrites another person's mark
(`applyWorkCommand` in `packages/contracts/src/comment-commands.ts`). The Mark
control shows the reader's own mark; the others' marks follow it, grouped by
kind. Share sets the sharer's mark on the turn as their mark on the report. A
mark on a report does not go back to the turn on its computer.

## 4a. The share page

A share link opens a work or a session as the app draws it in a pane
(`apps/client/src/GuestApp.svelte`), with no workspace around it. The corner
where the app puts the pane controls holds who is in the session and the
guest's role and name.

The pages offer only what the guest's role may do, by the host's rules
(`admission/access-policy.ts`): a viewer reads, a commenter (Reviewer) also
comments and reviews, an editor changes. Controls that lead into a workspace
(the Workspace page, chat, duplicating) are absent, because a guest shell has
none.

A member who opens a shared session in the app follows the same rule. Only an
editor or the owner drives a session; on a session a commenter is a viewer.
The client asks one question, `canDriveSession`
(`contexts/sharing/session-drive.ts`), which reads the caller's role from the
session's share list. A session with no share list is the client's own. For a
viewer, the composer says "Shared with you to view." and takes no prompt,
attachment, paste, or screenshot. Stop, the answers on permission, question,
and rate-limit cards ("Waiting for an editor" in their place), plan decisions,
plan edits, plan comments, plan bookmarks and publishing, rename, regenerate
title, task and pull request links, settle, and snooze are absent. The client
also sends no typing presence, automatic title, or branch for that session.

Only a guest link asks the visitor for a name. A visitor who is signed in to
Solus on the account origin opens a guest link as their account at once
(`bootGuest` in `apps/client/src/main.ts`). If that account is a member of
the resource's organization with at least the link's role, the page opens the
member link in its place, so the member keeps their own role and the whole app
(`apps/client/src/lib/guest-member.ts`). A member with a lower role than the
link stays on the guest page, which gives the link's role.

A resource shared only with members (a team, the organization, or people by
name, with no link) copies the app's own address on the account origin
(`contexts/sharing/app-link.ts`), not a guest link. A signed-in member opens it
with their own sign-in; anyone else signs in first and returns to it.

## 4b. A task is not shared

A task has no Share, no share rows, and no guest link. Its organization sees
it: the workspace service gives the organization the editor grant when the
task is claimed there (`ShareManager.claimOwner`). The sessions and works
linked to it keep their own access: a link to a task shares nothing (decision
2026-10-06). Each of them is shared on its own.

The task's control is **Copy link** (`SharesStore.copyTaskLink`). For a Local
task it first runs the upload in §3 and §4: the task, its comments, and its
linked Local works go to the window's organization. Then it copies the app's
own route for the task on the account origin
(`contexts/sharing/task-link.ts`), which opens it for anyone in the
organization.

The host refuses `shareSet` and `shareSetLink` for a task, and a task link made
before this change admits nobody (`resolveLinkSecret`).

## 4c. One table of access

Decision 2026-10-06, to make each access check one query.

- **One table.** `share_grant` holds all access to a resource. The owner is a
  `user` row with role `owner`, at most one per resource (`share_grant_owner`).
  The other rows name a person, a team, the organization, or everyone with
  the link. A person has one row on a resource, so the owner has no named row:
  a transfer removes the new owner's named row, and `shareSet` ignores a named
  row for the owner.
- **Organization on the rows.** Every row carries its resource's organization.
  The owner row is written when the record is created (`claimOwner`,
  `claimForRunner`, `adoptForOrganization`), with the record's organization.
- **One read.** A role check reads the resource's rows once and computes the
  role in memory. The host owner on the whole disk reads nothing. Two checks
  still ask the record, because no row can answer them:
  - a host owner whose scope is Local only (a pairing connection on an attached
    machine), because a fork or an Insights assignment moves a session into an
    organization without rewriting its rows;
  - a resource with no owner on a managed host, which is the team's only in its
    own organization.
- **One write for a scope.** `shareSet` writes the named rows and, when the
  request has `link`, the link, in one transaction. `shareSetLink` stays for
  regenerating the link and for the review link.

## 5. What is removed

- `PublicationCoordinator.publishWork` and `publishTask`, their publication
  rows, and their tests. The coordinator keeps sessions only.
- `RUNNER_WORKS_PATH` on the Solus API (its logic moves into `workUpload`),
  and the link from outbox ops to a publication (`publicationId`). The task
  `create` op applier stays: other outbox tests and the Lab use it. The
  `outbox_ops.publication_id` column stays, unused, because migrations only
  add.
- The host-organizations check in `publicationStart` for works and tasks.
- The link gate in `canShareFrom` for works, tasks, and reports. The new gate
  is: a signed-in account with at least one organization.

## 6. Clients

All three clients write to the Solus API through the client core's existing
API connection (`solusApiId(organizationId)`).

- **Desktop:** the account lives in main; the API connection already uses it.
- **Web from the cloud origin:** the account cookie.
- **Web or mobile through a host's tunnel, not signed in:** no account, so
  cloud-copy Share asks the person to sign in. This is the same rule as
  `organization-scope.md` §5.

On a host that is not linked, the session Share button and the session
context-menu item are disabled, with a tooltip that says live sharing needs
this computer linked. The command palette and the keybinding cannot show a
disabled state, so there Share stays unavailable.

## 7. Order

1. Works: `uploadWork`, the two host RPCs, the client flow, and the
   `canShareFrom` change.
2. Insights reports as works.
3. Tasks with their linked works.
4. Remove the host paths in §5. Update `organization-scope.md` §4.

Each step has focused tests: a repeated upload answers "already there" and
makes no second copy, an upload into another organization is refused, and the
host keeps a local copy that changed after it was read.

## 8. Decisions

1. **2026-09-30:** a task's linked Local works go with it. They are published
   as works in the same publication; linked sessions stay where they are.
2. **2026-09-30:** on a host that is not linked, session Share is disabled.
3. **2026-10-01:** a shared Insights report is the turn page, not a Markdown
   document; the share page is the app's page without the workspace, not a
   separate guest layout. Superseded by decision 7.
4. **2026-10-01:** a task is not shared (§4b). Share on a task becomes Copy
   link, which still uploads a Local task with everything linked to it.
5. **2026-10-01:** a shared work keeps its row with a location (§3a), so a
   reference to the work on this host finds the work. A separate table of
   moved records was rejected as more than the need.
6. **2026-10-02:** Copy link on a resource shared only with members copies
   the app's address, not a guest link; a signed-in visitor of a guest link is
   not asked for a name.
7. **2026-10-05:** a shared task keeps its row with a location, as a work does
   (§3a); it is no longer deleted. Deleting it also deleted its session links,
   so the organization's task showed no sessions and the sessions lost their
   task. The organization's copy lists the sessions by title and host; only a
   client of that host opens one.

## Shared work header spacing

The guest shell measures its access badge and reserves that width in the work
header. Work panes keep this inherited space on mouse and touch clients. Only
workspace panes set a fixed space for their close and pane controls.
7. **2026-10-07:** Insights reports are not shared. The turn panel has no
   Share, the `insights-report` work type and its reader marks are removed, and
   migration `0013_remove_insights_reports` deletes the report works.
8. **2026-10-07:** a session stays on its host for now. Share on a session
   opens the host's own share list. `PublicationCoordinator`, the
   `publicationStart` and `publicationList` RPCs, the `publication.changed`
   event, and the `publications` table are removed.
9. **2026-10-07:** Share is the one way to put a Local work in an
   organization. The separate "Publish to <organization>" menu command is
   removed. A work already in an organization opens on that organization's
   list, read from the work's own record.
