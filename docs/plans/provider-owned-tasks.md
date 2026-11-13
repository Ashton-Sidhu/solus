# Provider-owned tasks: GitHub and Jira are the only task stores

Status: implemented, 2026-11-10 (approved 2026-11-09). §11 lists where the build
differs from this plan.

> **2026-11-11: tasks are projectless; sources are personal settings.** A task
> source is the person's own, not a project's. The sources are in the personal
> settings (`taskSources`; the `defaultTaskSource` of the first version is
> gone: the work says where a new task goes), which sync with the account
> and reach the host with each prompt in the execution preferences. The project
> config no longer has `taskSources` or `defaultTaskSource`; a file that still
> has them reads without them. Decisions 4, 9, 10 and 11, §4.2, §5, §6 and §11
> are corrected below. `taskDoneOnMerge` stays in the project config. User documentation: [Tasks](../tasks.md). This plan replaces the
local-first task model (`docs/plans/task-conversation.md` keeps its rules for
session links; its "native entity" storage does not stay). There are no users
and no tasks to keep, so this plan removes the old code and does not migrate
data.

## 1. Why

Today a task is a row in the host's `tasks` table. A project can also show
"upstream tickets" from one provider binding (`taskProvider`: `local`, `github`
or `jira`). That gives two models of the same thing:

- Two read paths: `tasksSidebarSnapshot` (rows) and `tasksListUpstream` (live
  provider reads, cached as one JSON blob per scope).
- Three RPC pairs: `tasksGet` / `tasksGetUpstream`, `tasksUpdate` /
  `tasksUpdateUpstream`, `tasksComment` / `tasksCommentUpstream`.
- A mirror engine (`sync-engine.ts`, `task-sync-store.ts`) with publish, import,
  dirty fields, status reconciliation and "promote before a session can link".
- A new task is always local. A ticket appears only after `tasksPublish`.
- One binding per project: the origin repository, or one Jira project. No
  board is a source.

The product decision is: Solus does not own tasks. GitHub and Jira own them.
Solus reads them from the sources a project names, writes changes to the
provider, and adds only its own attachments.

## 2. Vocabulary

- **task** — an item of work that GitHub or Jira owns: a GitHub issue, a GitHub
  Project draft item, or a Jira issue. Solus has no other kind of task.
  `ticket` stays the word inside a provider adapter only (`NormalizedTicket`).
- **task source** — one place a project reads tasks from. Four kinds:
  `github-repo`, `github-project`, `jira-project`, `jira-board`.
- **board** — a GitHub Project (v2) or a Jira board. A board is a task source
  that has columns.
- **column** — a status grouping that the source owns: a GitHub Project Status
  option, a Jira board column, `Open` / `Closed` for a repository, a workflow
  status for a Jira project. Solus shows the provider's names and order.
- **status category** — `open`, `active` or `done`. The one coarse fact Solus
  derives from a column, for agent rules and for views that mix sources.
- **task ref** — the identity of a task: provider, provider scope and the
  provider's stable id. The **task key** is its string form and is the only
  task id in Solus.
- **attachment** — data that Solus owns about a task: links to sessions, works,
  plans, automations and pull requests, a snooze, a read mark.
- **default source** — the task source of a project where a new task is
  created.
- **task cache** — the host's copy of tasks (the `tasks` table and the source
  tables). The provider is the truth; the next read replaces the copy.

Removed words: local task, native task, upstream ticket, mirrored ticket,
publish, import, promote, candidate, external link, private comment.

## 3. Decisions

Decisions 1 to 8 are the maintainer's answers of 2026-11-09. The others are
proposals that follow from them.

1. There are no local tasks. `TaskProviderId` is `'github' | 'jira'`.
2. The provider is the source of truth. The host keeps a task cache for fast and
   offline reads. A write goes to the provider.
3. No data migration. A schema migration drops the old tables.
4. A person lists their task sources in their personal settings (2026-11-11;
   it was the project config). A person can have many sources. One source can
   be the source of many people. A task belongs to no project.
5. The source kinds are boards (GitHub Projects, Jira boards) and also the
   current scopes (the origin repository's issues, a Jira project).
6. The organization cloud keeps attachments only. It does not store tasks or a
   task cache. Each person reads a task with their own provider sign-in.
7. A board shows the provider's columns as they are. Solus keeps a status
   category for each column.
8. Each comment is a provider comment. Solus keeps only a queue of comments that
   are not sent yet. From a GitHub Project, Solus shows issues and draft items,
   not pull requests.
9. A person can mix GitHub and Jira sources.
10. A task that is in more than one source of the person shows one time in a
    mixed view. It shows in each board's own view with that board's column.
11. A person with no task source has no tasks. The Tasks page shows the source
    setup. `create_task` answers with an error that says to add a source on the
    Tasks page.
12. Tasks load like pull requests (`docs/plans/pr-sync.md`): the host owns
    freshness, a client reads all its projects in one request per host, and the
    host tells clients what changed.
13. Mobile does not show tasks today (plan 017). This plan does not add a
    mobile task UI. It keeps the contract shared so that mobile can use it. The
    maintainer approved this platform exception on 2026-11-09.
14. Task credentials resolve as each other provider call does: the acting
    person's connection, from their account when they are signed in, or from the
    host. This is the same on a personal host and on an organization machine.
    There is no task-specific credential path.
15. A GitHub Project column gets its status category from its name, and the
    person can correct it in the source settings (§4.4).
16. A Jira board source can ask the person to connect Atlassian again for the
    Jira Software scopes. The source health reports this.
17. The agent task tools stay as Solus tools and write to the provider (§6).
    They are not replaced by third-party GitHub or Jira MCP servers: only Solus
    knows a session's task, its attachments, the lifecycle policy and the
    person's connection. `create_task` creates a real GitHub or Jira task, so it
    is an outward-facing action and takes a permission prompt in a supervised
    session.

## 4. Model

### 4.1 Task ref and task key

| Kind | Stable id | Task key | Shown as |
|---|---|---|---|
| GitHub issue | issue node id | `github:<nodeId>` | `owner/repo#123` |
| GitHub draft item | draft issue node id | `github:<nodeId>` | board name |
| Jira issue | numeric issue id | `jira:<cloudId>:<issueId>` | `PROJ-12` |

Tasks are read from `github.com` only, as today, so a key has no GitHub host.

The key uses the provider's stable id, not `#123` or `PROJ-12`: GitHub can
transfer an issue to another repository, and Jira changes the key when an issue
moves to another project. The display reference is a field of the cached task.

Each attachment table keys on the task key. `resource_links.source_id`,
`personal_resource_state.resource_id` and `comment_threads.subject_id` are
strings already, so only the values change.

### 4.2 Task sources in the personal settings

```ts
type TaskSource =
  | { kind: 'github-repo'; owner: string; repo: string }
  | { kind: 'github-project'; owner: string; number: number }
  | { kind: 'jira-project'; cloudId: string; projectKey: string }
  | { kind: 'jira-board'; cloudId: string; boardId: number }

// Personal settings (`packages/contracts/src/settings.ts`), also execution preferences.
interface PersonalSettings {
  taskSources: TaskSource[]
  defaultTaskSource: string | null // a source key; null = the first source
}

interface ProjectConfig {
  taskDoneOnMerge?: boolean
}
```

2026-11-11: the sources were in the project config. They are now the person's
own. A project config that still has `taskSources` or `defaultTaskSource` reads
without them.

The types and the key functions are in `packages/contracts/src/task-sources.ts`.

`taskProvider`, `taskProviderConfig` and `tasksAutoPushComments` are removed.
A `github-repo` source is no longer forced to equal the origin remote. The
source setup suggests the repositories that the person pushed to most recently.

A **source key** names a source independent of a person
(`github-project:<owner>/<number>`, `jira-board:<cloudId>/<boardId>`), so two
people who read the same board share one cache and one poll. A source has no
other id: the default source is named by its source key. A default that names
no source of the person gives the first source.

### 4.3 A task is not a Solus resource

A task has no organization, no owner and no share list in Solus. Who can read
or change a task is decided by the caller's own GitHub or Jira connection.
Each task method needs only the ordinary use of the host (`host.use`); the
`task` resource actions, the `taskIdAt` locators and the task rows of the share
tables are removed. A guest link never reaches a task.

An **attachment** does have an organization: the organization of the session
or the person that made it. Attachment reads use the caller's record scope, as
before. The key of an attachment is the task key, so a host can hold
attachments of a task it never read (the organization's Solus API does).

### 4.4 Host tables

| Table | Key | Holds |
|---|---|---|
| `tasks` | `id` (task key) | The host's copy of a task: `provider`, `kind`, `reference`, `url`, `title`, `body`, `state_name`, `state_category`, `category`, `assignee`, `assignee_avatar_url`, `labels`, `priority`, `due_date`, `epic`, `writable_fields`, `home` (JSON the adapter needs to write: repository, issue number, Jira key), `created_at`, `updated_at` (provider time), `fetched_at`, `detail_fetched_at`, `last_read_at`, `comment_position` |
| `task_sources` | `source_key` | `source` (JSON), `label`, `columns` (JSON), `write_state` (JSON the adapter needs: project node id, field ids), `fetched_at`, `truncated`, `health`, `message` |
| `task_source_items` | (`source_key`, `task_id`) | `column_id`, `item_id` (the board item, for writes), `position` |
| `task_source_access` | (`user_id`, `source_key`) | `checked_at`: this person's own connection read the source |

Removed tables: `task_counters`, `task_external_links`, `upstream_task_cache`.
Removed `tasks` columns: `short_id`, `project_key`, `title_source`, `status`,
`assignee_user_id`, `source`, `origin_session_id`, `origin_automation_id`,
`triaged_at`, `done_at`, `location`, `organization_id`, `created_by`.
`asset_publications` stays.

A task's comments stay in `comment_threads` (subject kind `task`, subject id
the task key, organization `local`): a comment read from the provider has
`delivery_state = 'sent'` and its provider id; an unsent comment is `pending`
with its error. The `private` state is removed.

The cache is shared on one host. A person sees the tasks of a source only after
their own connection read that source (`task_source_access`). So two people on
one host with different provider access do not see each other's tasks, and one
source is not read twice for them. A task that a session is linked to shows to
each person who can see that session.

### 4.5 Status category

- Jira: the status category of the status (`new` → `open`, `indeterminate` →
  `active`, `done` → `done`). Jira gives this.
- GitHub repository: `Open` → `open`, `Closed` → `done`. The `in-progress`
  label convention is removed.
- GitHub Project: Solus detects the category of a Status option from its name
  (`Done`, `In progress`, `In review`); an option it does not know is `open`.
  A person can correct this in the source settings (a later step; the first
  version detects only).
- `Task.category`: `done` when the provider's state is done; else `active` when
  the state or one column of the task is active; else `open`.

### 4.6 Provider adapters

One `TaskSourceAdapter` for each source kind (`data/tasks/sources/`):

- `read(source)` — the label, the columns, and the tasks with their column, at
  most 200, with `truncated`.
- `search(source, query)` — tasks that match, from the provider.

One `TaskProviderAdapter` for each provider (`data/tasks/providers/`), which
works from the task's `home`:

- `fetch(home)` — the task with its comments and epic.
- `update(home, patch)`, `comment(home, body)`, `assignees(home)`,
  `setState(home, category)`, `publishAssets(home, body)`.

A source adapter also has `create(source, draft)` and `move(source, item,
columnId)`, and a GitHub Project adapter has `remove(item)` for a draft.

- GitHub repository: the existing issue reads. Columns `Open`, `Closed`.
- GitHub Project: `repositoryOwner(login) { projectV2(number) }` with `items`
  and field values; writes the Status field with the existing
  `updateProjectV2ItemFieldValue` code; creates with `addProjectV2DraftIssue`.
  Needs the `project` scope.
- Jira project: the existing JQL reads. Columns are the project's statuses
  (`/rest/api/3/project/{key}/statuses`).
- Jira board: the Agile API (`/rest/agile/1.0/board/{id}/configuration` for
  columns, `/board/{id}/issue` for items). A missing Jira Software scope gives
  health `reconnect`.

## 5. Read, refresh and write

- `tasksSidebarSnapshot` stays the one list read for a host, with its revision
  resume (`docs/plans/task-snapshot-resume.md`). It answers each task the
  caller's sources list, and each task a visible session is linked to.
- `tasksSources(sources)` takes the person's sources from the client and
  answers their state, in the given order, and tells the host that the caller
  wants them. The host reads a source that is older than 30 s (each one with
  `refresh: 'force'`), and reads the wanted sources again every 5 minutes while
  a client asked for them in the last 15 minutes. Two callers with the same
  source cause one read. `tasksSearch(sources, query)`,
  `tasksCreate({ source, ... })` and `tasksListAssigneeCandidates({ source })`
  also name the source; `tasksSourceOptions()` names no project. The host
  checks the shape of each source that a client sends.
- After a read the host broadcasts `tasks.sourcesChanged { sourceKeys }`, and
  `tasks.invalidated` for the tasks that changed. A client resumes its snapshot.
- `tasksGet(id)` reads one task from the provider with its comments, updates
  the host's copy, and answers it with the attachments on this host. When the
  provider does not answer, it answers the last copy with `fromCache`.
- A write (`tasksUpdate`, `tasksMove`, `tasksCreate`, `tasksDelete`) goes to the
  provider first. On success the host updates its copy and broadcasts. On
  failure the caller gets the error and the copy does not change. There is no
  dirty-field queue.
- `tasksComment` posts to the provider. A comment the provider did not take
  stays as `unsent` with the error; `tasksRetryComment` sends it again and
  `tasksDeleteComment` discards it.
- A provider call uses the acting person's connection (decision 14).

RPC surface after the change (`packages/contracts/src/host-api.ts`):

| Plane | Methods |
|---|---|
| execution (needs this machine's connection) | `tasksSources`, `tasksSourceOptions`, `tasksSearch`, `tasksGet`, `tasksCreate`, `tasksUpdate`, `tasksMove`, `tasksDelete`, `tasksMarkRead`, `tasksComment`, `tasksRetryComment`, `tasksDeleteComment`, `tasksListAssigneeCandidates`, `tasksAttachArtifact` |
| collaboration (attachments; also served by the Solus API) | `tasksSidebarSnapshot`, `tasksSearchComments`, `tasksAttachments`, `tasksSnooze`, `tasksSnoozes`, `tasksLinkSession`, `tasksUnlinkSession`, `tasksSessions`, `tasksForSession`, `tasksPrepareForSession`, `tasksSnapshot`, `tasksLink`, `tasksUnlink`, `tasksLinkedTo` |

Removed: `tasksProviderStatus`, `inboxListUpstream`, `tasksListUpstream`,
`tasksGetUpstream`, `tasksUpdateUpstream`, `tasksCommentUpstream`,
`tasksListCandidates`, `tasksImport`, `tasksPublish`, `tasksSyncNow`,
`tasksReadExtras`, `tasksPublishComments`, `tasksRecordActivity`, `taskExportForCloud`,
`taskMarkMoved`, `taskUpload`. The Solus API (`/v1`) loses its task record
routes (`/tasks`, `/tasks/:taskId`, activity, comments) and the `tasks`
capability; `PUT /links` and `DELETE /links` stay and take a task key.

## 6. What each dependent does

| Dependent | After the change |
|---|---|
| Session links (`task-sessions.ts`) | Same rules (`working`, `referenced`); keyed by task key. No promote step. A link needs no row in `tasks`. |
| Links to works, plans, automations, PRs | Keyed by task key. |
| Snooze | Keyed by task key; needs no row. |
| Agent tools | `list_tasks` and `read_task` read the host's copy (`read_task` reads the provider first). `create_task` creates in a source of the person that the agent names by its source key, else in the source the session points to (its task, its checkout's repository, the only source), else answers with the sources; `list_tasks` lists the tasks of the person's sources (2026-11-11; it was the session's project). `update_task_status` takes a status category or a column name. `comment_task` posts to the provider. The lifecycle policy stays. The descriptions say that these write to GitHub or Jira. On an organization machine the tools work the same way, with the acting person's connection; they do not call the Solus API. |
| Task packet (`task-context.ts`) | Built from the host's copy of the task and its attachments. |
| Dispatch (`foreign-tasks.ts`) | The snapshot still ships with the prompt. The owner host applies `comment` and `set-status` operations as provider writes. |
| Finished task | A task whose category becomes `done` settles its working sessions, as before. A follow-up prompt to a session of a finished task does not reopen the task on the provider (`tasksRecordActivity` is removed). |
| Session start | A session that starts work on an `open` task moves the task to `active` on the provider. A failure of that move is logged and does not stop the session. |
| Done on merge | Moves the task to category `done`. |
| Browser evidence | Posts a provider comment with a published asset. If the provider cannot hold the asset, the capture control says so; nothing stays private. |
| Notifications | "Assigned to you" compares the provider assignee with the person's connected provider login. `assigneeUserId` is removed. |
| Insights | `task_id` on a span is the task key. |
| Inbox (`inboxListUpstream`) | Removed: no client calls it. |
| Search | Titles and bodies in the host's copy; comments of tasks that were opened. |
| Title regeneration, `shortId`, `titleSource`, `inbox` status, `triagedAt` | Removed. |
| Sharing | `task` leaves the share tables and the access policy (§4.3). |
| Organization cloud | No task rows. The Solus API answers `tasksSidebarSnapshot` with no tasks and the session links of the task keys it knows, and serves the attachment methods. The Local-to-cloud task upload and `tasks.location` are removed. `../solus-cloud` needs the same schema. |

## 7. User interface

Desktop and web (shared Svelte UI):

- **Where a task comes from.** A client reads the tasks of a project from the
  host that has the project (`tasksSidebarSnapshot` and `tasksSources` on that
  host). It reads attachments from each host that answers: session links of one
  task key from the project host and from the organization's Solus API are
  merged by task key.
- **Source setup** replaces `TaskProviderPicker`: a list of the project's
  sources with Add (GitHub repository, GitHub Project, Jira project, Jira
  board), Remove, default source, and health for each source (not connected,
  reconnect, no access, truncated). It reads `tasksSourceOptions` and saves the
  project config. Reachable from the Tasks page header and its empty state.
- **Tasks page**: a source switcher: each source of the project, and All
  sources. A source view shows the provider's columns. All sources groups by
  status category (Open, Active, Done). All projects works as on the pull
  request list. (2026-11-11: the switcher and the source setup are one row of
  source chips above the search field. Each chip shows its task count and a
  warning when it cannot be read; the warning is the repair, an × removes
  with Undo; the last chip adds a source. The header has no source control.
  There is no default source: a new task goes to a source of the task the
  work is about, else of the checkout's GitHub repository, else of the last
  new task on the device, else the only source; `inferTaskSourceKey`.)
- **Composer**: creates in the default source; the person can choose another
  source. Fields follow what that source can take.
- **Task page**: no publish target, no sync state, no "local" badge. An issue
  has no delete; a draft item can be deleted. An unsent comment shows its
  error with Retry and Discard. Status is the task's state and its column in
  each source.
- Removed: promote before a session link (`session-task-link.ts`,
  `TaskPicker.svelte`), the `#looksUpstream` id test, `upstreamTasksByProject`,
  `TaskStatus` and its six-value menus, title regeneration, the task short id.

Each state is part of the feature: loading, empty (no source), not connected,
reconnect, truncated, offline from cache, write failed, comment not sent.

## 8. Order of work

1. Contract and project config (done first: `task-sources.ts`, `task-types.ts`,
   the RPC registry, planes, permissions, the Solus API contract).
2. Host: tables, adapters, source reads, handlers, attachments by task key.
3. Host dependents: agent tools, task packet, dispatch applier, done on merge,
   notifications, evidence, sharing, the Solus API, organization handlers.
4. Workspace UI, desktop palette and keybindings, demo handlers.
5. Removal of dead code and tests; docs.

## 9. Risks

- **Provider rate limits.** A board refresh reads many items. The refresh must
  use interests and `changedSince`, not a poll for each task. GitHub Project
  items have no "changed since" filter; the plan is a full item read per
  refresh with a floor on the interval, and issue `updatedAt` to skip detail.
- **Offline.** A write fails when the provider is not reachable. Only comments
  queue. This is a deliberate loss against the local-first model.
- **Jira scopes.** Board reads can need a new consent.
- **Size.** About 7 000 server lines, 33 RPC methods and about 90 test files
  change. The phases keep each pull request reviewable.

## 10. Open items

- **O1. Credential check.** Decision 14 sets the rule. Phase 2 must verify that
  `githubCredentials()` and the Atlassian token store both resolve the acting
  person's account connection on an organization machine, and fix the one that
  does not.

## 11. Where the build differs from this plan

The build follows the plan. These are the points where the code says something
that the sections above do not, or says it in another way.

**Host tables (§4.4)**

- The health of a source is stored for each person, not for the source.
  `task_source_access` has the key (`user_id`, `source_key`) and the columns
  `checked_at`, `health` and `message`: the result of that person's last read
  with their own connection. `task_sources` has no `health` and no `message`.
  Two people on one host with different provider access thus each see their
  own state of one source.
- The person column of `task_source_access` is `user_id`, not `person_key`.
- `tasks` also has `state_id` (the Jira status id of the state; null on
  GitHub).

**RPC surface (§5)**

- `tasksRecordActivity` is removed. A follow-up prompt to a session of a
  finished task does not reopen the task.
- After a source read that changed more than 5 tasks, the host sends one
  `tasks.invalidated` with no task id, and a client reads its whole list.
- Solus never sends an unsent comment again by itself. Only
  `tasksRetryComment` does.

**Moves (§4.6, §6)**

- A move to a status category on GitHub closes or reopens the issue, and then
  sets the first column of that category on each GitHub Project that lists the
  task **and is a task source on this host**. The host knows a Project only
  from its own cache, so a Project that no person on the host has read does not
  change. A draft item has no issue state; only its columns move.
- A move to a status category on Jira makes one legal workflow transition to a
  status of that category, and fails with an error when the workflow has none.
- When a session starts work on a task whose category is `open`, the host
  moves the task to `active` on the provider (`prepareSessionTask`). A failure
  of that move is logged and does not stop the session.

**Done on merge (§6)**

- The rule is on by default, and needs no project (2026-11-11). A task that
  links the merged pull request, directly or through a working session, moves
  to `done`. The pull request's project can turn it off: a project of this host
  (a listed project, or the checkout of one of the task's working sessions)
  whose `origin` is the pull request's repository and that sets
  `taskDoneOnMerge` to `false`. Before 2026-11-11 the rule applied only when a
  project of the host listed a source of the task.
- A task moves to `done` only when each pull request it links is merged, and
  not while a working session of the task is in the middle of a turn.

**Notifications (§6)**

- "Assigned to you" is GitHub only. The Atlassian connection keeps no account
  name, and a Jira assignee is a display name. The first read of a task is a
  quiet baseline: a task that was the person's before Solus saw it gives no
  notification.

**User interface (§7)**

- The source setup also takes a source that `tasksSourceOptions` does not
  list: `owner/repo`, a `github.com` repository URL, or a GitHub Project URL
  (`parseManualTaskSource`). The host reports the health after the first read.
- `tasksSourceOptions` offers the 50 repositories that the person pushed to
  most recently (owner, collaborator or organization member), newest first
  (2026-11-11; it was the project's `origin` repository). Another repository
  is added by manual entry.
- A client merges the attachments of one task key from more than one host.
  Session links and pull request links come with each host's
  `tasksSidebarSnapshot`. For a task page, the client also calls
  `tasksAttachments` on each host that holds a session link of the task but
  does not read the task, and remembers which host holds each link so that an
  unlink goes back to that host. `TaskLink` does not name its host.
- When two hosts list one task, the first of them in the client's host order
  reads and writes the task.
- The all-projects list also shows a task that no known project source lists
  (a task that only a session link brought to the client).
- The order of cards in a board column is kept on the client, for each project
  and view. It is not written to the provider.
- The composer decides on the client which fields a source takes on a new
  task (`composerFieldsFor`). The contract has no such field.
- The move menu of a task is always enabled. The contract has no flag that
  says a task cannot move; a refused move shows the provider's error.
- "Copy link" on a task copies the provider URL. A task has no Solus link.
- A status category of a GitHub Project column cannot be corrected in the UI
  (decision 15 and §4.5 name this as a later step).
