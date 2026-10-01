# Cloud sharing without the host link

Status: done, 2026-09-30. Replaces the "one server publication operation"
rule in `organization-scope.md` §4 for works, tasks, and Insights reports.

Where it lives:

- Host: `workExportForCloud`, `workRemoveUploaded`, `taskExportForCloud`, and
  `taskRemoveUploaded` (`transport/handlers/organization-handlers.ts`, over
  `data/works/works.ts` and `data/tasks/task-transfer.ts`).
- Solus API: `workUpload` and `taskUpload`
  (`transport/solus-api/cloud-uploads.ts`).
- Client: `SharesStore.uploadWork`, `uploadTask`, and `shareReport`; the report
  document is built by `components/insights/lib/turn-report.ts`.
- `PublicationCoordinator` publishes sessions only.

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

There are two kinds of share.

| Kind | Resources | Needs the host link | Path |
|---|---|---|---|
| **Cloud copy** | work, task, Insights report | No | The client writes a copy to the Solus API with the person's sign-in. The link points at the cloud copy. |
| **Live session** | session | Yes | Unchanged. The session runs on the host, and the host sends its later turns. |

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
3. **Remove.** The client tells the host to remove the local copy. The host
   removes it only if it did not change since step 1 (same fingerprint);
   otherwise it keeps the newer copy and says so. A work keeps its row with a
   location (§3a).
4. **Share.** The dialog applies the access rules on the cloud record and
   shows its link.

If the client stops after step 2, the local copy is still there. The next
Share repeats the steps; step 2 answers "already there", and step 3 finishes.
Nothing is lost and nothing is copied twice. The host makes no network call.

The membership check moves to the API: it refuses an upload the person may not
make. The client offers the organizations of the signed-in account.

## 3a. A shared work keeps its row

Step 3 does not delete the work's row. It gives the row a **location**: the
organization that has the work now. The host clears the body, the revisions,
and the comments, so the organization's copy is the only copy of the content.
The row keeps the id, title, type, and links.

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
- **Tasks.** A task is still removed after its upload. Its linked works get a
  location through the same step.

## 4. Per resource

| Resource | Read from the host | Upload to the Solus API | Remove on the host |
|---|---|---|---|
| Work | `workExportForCloud` (history, annotations, fingerprint) | `workUpload`: the logic of the old runner work route, admitted with the person's sign-in | `workRemoveUploaded` (same fingerprint, or kept) |
| Task | `taskExportForCloud`: the task, its local comments, and its linked Local works | `workUpload` for each linked work first, then `taskUpload` (task and comments under their ids, linked to the uploaded works) | `taskRemoveUploaded`: the task and each uploaded work, each only if unchanged |
| Insights report | The turn panel's readings, captured at Share as an `insights-report` work (JSON) | Filed as a Local work with `createWork` on the host, then the Work row | As the Work row |

`importWork` and `createTask` are not used: `importWork` reads a Google Doc or
Confluence page from a URL, and `createTask` cannot keep the local id. The
Solus API creates works only over HTTP, so a report is filed on the host first
and then travels as a work.

The Insights turn panel shares a report, not the session it came from. To
share the session itself, the person uses the session's own Share. Each Share
captures a new report, labelled with its capture time. The Share dialog sets
who may comment on it or rename it.

A report holds what the turn panel reads: the trace, the session rollup, the
session and task names, the comparison against the window's other turns
(`baselines`, not the rows), the session's prompts, and the turn's patch
(`components/insights/lib/turn-report.ts`). `InsightsReportShell` draws it with
the same `TurnReadings` body as the live panel, under the works header, so the
person it was shared with reads the page its sharer did. Nothing on it leads to
another turn, the session, or the task: those stayed on the computer. Comments
pin to points on the page, as on an artifact.

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

## 4b. A task is not shared

A task has no Share, no share rows, and no guest link. Its organization sees
it: the workspace service gives the organization the editor grant when the
task is claimed there (`ShareManager.claimOwner`), and the sessions and works
linked to it are opened through it (`data/tasks/task-sharing.ts`).

The task's control is **Copy link** (`SharesStore.copyTaskLink`). For a Local
task it first runs the upload in §3 and §4: the task, its comments, and its
linked Local works go to the window's organization. Then it copies the app's
own route for the task on the account origin
(`contexts/sharing/task-link.ts`), which opens it for anyone in the
organization.

The host refuses `shareSet` and `shareSetLink` for a task, and a task link made
before this change admits nobody (`resolveLinkSecret`).

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
   separate guest layout.
4. **2026-10-01:** a task is not shared (§4b). Share on a task becomes Copy
   link, which still uploads a Local task with everything linked to it.
5. **2026-10-01:** a shared work keeps its row with a location (§3a), so a
   reference to the work on this host finds the work. A separate table of
   moved records was rejected as more than the need.
