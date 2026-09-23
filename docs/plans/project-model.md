# Project model: one project per repository, hosts as places to run it

**Status:** Partly implemented (2026-09-22); see "Implementation status" below. Task "Cloud-Native Remote Sessions" holds the comparison with T3 Code that led to these decisions.

**Decision this implements:** on the cloud and on every client, a project is a Git repository. A folder on a host is a *checkout* of a project. A session has one host, chosen when it starts. No page, list, or record takes its host from the tab that has focus.

## Vocabulary

- **project** — a Git repository, identified by its **repository key**: the canonical `host/owner/repo` of its primary remote, in lowercase (`github.com/acme/web`). One project per repository in an organization.
- **local-only project** — a folder with no Git remote. Its key is its host and path. It never appears in the cloud directory.
- **checkout** — one folder on one host that holds a project: the main working tree or a worktree. A fact about a host, not an identity.
- **working folder** — the folder a session runs in. It can be a subfolder of a checkout (`apps/web`). It does not change the session's project.
- **run-on rule** — how a new session chooses its host (§6).
- **page scope** — what a Tasks, PRs, Automations, or Workspace page lists: all projects or one project (§5).

Do not use "subproject", "logical project", or "project path" in new code or UI. There are no subprojects (§1).

- **organization** — the account group that owns cloud projects, shared hosts, and the managed host. Every account is in at least one, and may join more. A person who signs up on their own gets one: sign-up makes it, and the welcome step on the account site asks them to keep or change its name. A person who signs up with a pending invitation gets none of their own; they are sent to the invitation and join that organization. If they decline and are in no organization, the welcome step makes one. "Team" is reserved for a later sub-group of an organization; do not use it for the organization or its hosts.
- **Cloud host** — a managed host. A host row reads the name given on the account site, which members can change, beside a cloud icon; with no name it reads "Cloud host". No host label names the organization.

## §1 Identity

The key function lives in `packages/contracts` so that the server and every client compute the same value:

1. Find the repository root with `git rev-parse --show-toplevel`.
2. Choose the primary remote: `upstream`, then `origin`, then the first remote in alphabetical order. (T3 Code uses the same order: `RepositoryIdentityResolver.ts`.)
3. Normalize its fetch URL to `host/owner/repo` in lowercase. SSH, HTTPS, and `git@` forms of one repository give one key.
4. When a GitHub connection is available, resolve renames through `canonicalRepoRef`.

A folder without a remote gives the local-only key `<serverId>:<path>`.

**No subprojects.** A user who wants to work in `apps/web` of a monorepo opens that folder. The folder becomes the session's working folder; the task, the session record, and the pull requests belong to the repository. The Tasks page can later add a filter by working folder. That filter is not identity.

**Forks.** The project is the upstream repository when an `upstream` remote exists. The push remote is a property of the checkout.

Dispatch uses a second value, the **clone source**: the `origin` of the checkout, which for a fork is the fork (`project-config/project-identities.ts`). It is not a project key. It uses the same URL rule (`repositoryKeyFromRemoteUrl`), so the full path is kept. The target host finds a dispatch checkout by the §1 key of that checkout (`resolveDispatchHistoryRoots`); a dispatch clone has only its clone source as a remote, so the two agree. To remove `listProjectIdentities`, a dispatch must carry the project key and the clone URL as two fields, and the dispatch clone must add the `upstream` remote. That is open (see Implementation status).

## §2 The cloud project record

A `workspace_projects` table in the workspace service, ported with the `Db` pattern (`cloud-service-model.md` §3–§7): `id`, `organization_id`, `repository_key` (unique within the organization), `display_name`, `default_branch`, `created_by`, `created_at`. (`projects` is already the host's manifest of folders, which stays runner-local.) The project settings in §7 are not columns yet.

A member **adds** a project explicitly, from the GitHub connection or from a checkout on a host. A checkout never creates a cloud project by itself: that keeps scratch and personal repositories out of the organization's directory.

A host checkout whose repository key matches a cloud project connects to it automatically. A checkout with no match stays on its host, and the client shows it as "Not in Solus Cloud" with an **Add to Solus Cloud** action.

## §3 Checkouts

Each execution host names the repository of every folder it lists (`listProjects` answers `repositoryKey`). The client records those checkouts with their repository keys in its project catalog, so it still knows where a project is when the host is offline, and shows that host as "offline". Checkouts are hints: they say where a project can run. They never identify a project.

Hosts do not report their checkouts to the workspace service (decided 2026-09-22): it would only let a new device name an offline machine it never connected to. Where that notice is wanted, the session records already name which machines worked on a project (`runner_host_id`).

A path appears in the UI only on a project's **Checkouts** list and in a session's own details.

## §4 Records


| Record         | Project field                                                            | Checkout fact                                         |
| -------------- | ------------------------------------------------------------------------ | ----------------------------------------------------- |
| Task           | `project_key` = repository key (local-only key for a local-only project) | `checkout_path`: the folder the task was created from |
| Session record | normalized `project_remote`                                              | `project_path`, `runner_host_id`                      |
| Pull request   | the repository key it was read for                                       | none                                                  |
| Work           | optional project link, unchanged                                         | none                                                  |


A host task keeps its path; the client resolves it to the checkout's repository when it reads it. No migration rewrites stored keys, and a task filed before this model is not carried over.

**Where a new task is stored (decided 2026-09-22): local first.** A task is created on the host that holds the checkout, whether a person creates it in a composer or an agent creates it with a tool, and also when the project is a cloud project. The one exception is a cloud instance: on a managed host linked to an organization, the composer and the agent tools write the task to the workspace service (`tasksAreCloudOwned`), because that machine is shared and its local database is not a place anyone looks. A task for a cloud project with no known checkout (created from the web with only the workspace service) is created in the workspace service. `TaskCreationContext.serverId` names the destination; the composer and `TasksStore.create` do not choose it.

**Pushing a task to the cloud.** A local task reaches the workspace service only when a person pushes it. That action is not built yet; see "Open items".

**Reading a project's tasks.** A project scope lists the cloud tasks of its repository and the host-only tasks of every connected host with a checkout of it. A host that holds checkouts but is offline is shown as offline, never as an empty list.

## §5 Page scope

`ProjectPageScope` is `{ kind: 'all' } | { kind: 'project', key, checkout }`. `key` is the project and filters every list; `checkout` is one checkout of it, through which host-side facts (project configuration, a task provider binding) are read, and null for a cloud project no known host holds. The `kind: 'host'` scope is gone: the workspace service is never shown as a host (`cloud-service-model.md` §15).

- The first time a page opens, the scope is **All projects**. After that, each page remembers the last scope the user chose.
- The active tab never sets a page scope. `prepareProjectPageScope` stops copying the composer's run.
- **Current project** is the first entry of the project selector, with an `opt+<key>` shortcut. It is one keystroke, never automatic.
- The selector lists cloud projects and local-only projects. No project is attributed to the default host.

**Tasks.** All projects is a list grouped by project; the board view needs one project, as today. Creating a task while the scope is All projects asks for the project in the composer.

**Pull requests.** One provider query per repository key, through the account's GitHub connection when the user is signed in (collaboration plane). Signed out, the client still queries each repository once, through any online host that has a checkout. An offline host hides no pull request. A host is chosen only for an action: **Check out**, **Ask an agent**, **Resolve conflicts**.

**Sidebar.** The working set stays the default and lists all projects. The list is flat on every client, newest task first; it has no project headers, because each row already names its project. The project filter narrows the list to one project. A row shows a host label only when its host is not local.

## §6 The run-on rule

A session's host is chosen once, when the session starts, and never changes after that. Session transfer is a separate future operation (`cloud-service-model.md` §25).

1. An explicit choice in the run picker.
2. Else the project's last-used host, when it is online.
3. Else the organization's managed host (`managed-hosts.md`), started when its lifecycle is `stopped`.

The picker shows the result before Send. If the chosen host cannot run the session, the picker says why and offers another host. It never moves the session to a different host silently.

A new session copies the model and the interaction mode from the session in focus. It does not copy the host, the checkout, or the branch: those come from the run-on rule and §7.

A task's own host decides where its session starts from the task page. The task's home and the session's host are separate facts: a task in the cloud can run on any host.

## §7 Checkout defaults

Precedence: an explicit choice in the composer, then the project's setting, then the host's default.

- **Sessions on a managed host** start in a new worktree: several members share that machine and its checkouts. On a person's own machine — from desktop or from the web — a session starts in the checkout, by design. A new worktree starts from the project's shared default branch when the organization set one, else from the branch the host detects.
- **Desktop sessions** keep today's default: the current checkout.
- **Managed host without a checkout:** clone the project from its repository key, then run the project's setup script. A failed setup script stays visible; the agent still starts.

Project settings (setup script, default branch, checkout mode, default model) live on the cloud project when one exists, and in the local project configuration otherwise. The Settings page has two scopes: **Workspace** (cloud) and **Host** (shown on that host's details only). Device settings stay on the device.

## §8 Delivery

Prompts to a session whose host is offline stay refused (`cloud-service-model.md` §19). The host stores each `clientPromptId` with its session, so a client that resends after a host restart does not start a second turn.

## Workstreams


|       | Scope                                                                                                                                                                                                                                                                                                                                                                  | Depends on |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **A** | A session owns its host. A1 task creation names its host and project (implemented 2026-09-22: `TaskCreationContext.serverId`, `TasksStore.create(input, serverId)` with no default-host fallback); A2 a task's session starts on the task's host; A3 Git state is looked up by host and path; A4 the web client loads host settings; A5 durable prompt de-duplication. | —          |
| **B** | §1 key function; hosts report repository keys; §2 cloud `projects`; §3 checkout reports; client project store by repository key.                                                                                                                                                                                                                                       | —          |
| **C** | §4 records: tasks, session records, search by repository key.                                                                                                                                                                                                                                                                                                          | B          |
| **D** | §5 page scope, remove default-host attribution, Tasks grouping, sidebar headers.                                                                                                                                                                                                                                                                                       | B          |
| **E** | §5 pull requests through the account connection; offline-host states.                                                                                                                                                                                                                                                                                                  | B          |
| **F** | §6 run-on rule; managed host start and clone; §7 checkout defaults and project settings.                                                                                                                                                                                                                                                                               | A, B       |


Every workstream covers desktop, wide web, and mobile web; Claude and Codex; and the connection modes desktop signed out, desktop signed in, and web with every host offline.

## Implementation status (2026-09-22)

Implemented in the working tree:

- **A.** A task names its host at creation; a task's session starts on the task's host; Git state is keyed by host and path (the path-only lookup is gone); the web client loads and follows host settings. A5 is not in the working tree: `TurnLedger.hasStartedPrompt` and its index were removed by later uncommitted work, so a prompt is de-duplicated only until the host restarts (the in-memory `acceptedClientPromptIds` set). See "Open items".
- **B.** `@solus/contracts/repository-key` (§1). Hosts answer `repositoryKey` on `listProjects`; the dispatch `repoKey` stays the clone source (`origin`, which for a fork is the fork), and is not a second project key: it uses the §1 URL rule, and the target host matches dispatch checkouts with `resolveRepositoryKey` (§1). The `workspace_projects` table and `workspaceProjectList` / `workspaceProjectAdd` / `workspaceProjectRemove`, with the `workspaceProjects.changed` event. The client's project directory (`listenForProjectDirectory`, `ProjectsStore.projectKeyFor`, `WorkspaceProjectsStore`).
- **C.** Tasks group by project across hosts (`TasksStore.tasksInProject`). Tasks are local first (§4): only a managed host writes new tasks to the workspace service, keyed by repository. Sidebar rows filter by `groupKey`. Conversation search sends each host its own checkout of the scoped repository.
- **D.** `ProjectPageScope` is `{ key, checkout }`; the tab in focus never sets it; one selector row per project (`projectScopeOptions`); **Current project** in each selector and on `⌥C`; the sidebar stays one flat list (its project headings were removed 2026-09-22). **Add to Solus Cloud** on the Tasks page header.
- **E.** `prOpenReview`, `prGetDiff`, and `prGetDiffFileContents` are collaboration-plane reads (a guide diff stays execution-only). The PR page reads a repository through the workspace service when no checkout host is online, so an offline machine hides no pull request. The Tasks page names checkout hosts that are offline.
- **F.** The run-on rule (`chooseRunOnHost`) for a cloud task's session: a checkout on a host that is up, in a new worktree; else the organization's managed host, which clones the repository on Send through the dispatch path. A stopped managed host is started on Send: any member of the organization may call `POST /v1/hosts/<hostId>/start` or `/stop` (`solus-cloud`, `startManagedHost` / `stopManagedHost`; decided 2026-09-22 until a permissions model exists), and the client re-reads the directory until the host is `ready` and connected. Retrying and deleting a managed host stay with owners.
- The page scope is kept on the device (`page-scope-preference.ts`) and survives a reload.

Removed with no backward compatibility: guessing a task's host from its path (`TasksStore.hostForProject`) and every default-host fallback in the task loaders; the path-keyed `tasksForProject` and `byProject` (replaced by `tasksInProject(key)` and `tasksForCheckout(serverId, path)`); the boards' `boardProjects` catalog; the page fallbacks that followed the input bar when no project was scoped; the optional `repositoryKey` for older hosts and the optional sidebar `groupKey`.

Differences from the plan, and what is still open:

- **All projects** on the Tasks page is still the inbox, not a list of every task grouped by project; a task created from it files where the input bar's project would, rather than asking.
- ⌘N (new task) keeps the focused session's project, model, and mode, starts in the project's main checkout, and stays on the focused host while it is up; when it is not, the run-on rule picks another online checkout. ⌘T (new session in the task) keeps everything, worktree included. The focused source is the chat or draft in the focused pane, and an empty draft counts: ⌘N reads its project before letting it go.
- When nothing on screen names a project, a new session starts in the project the last session started in (`settings.lastProject`, device-local), unless that host is known to be down; else in the default host's `my-workspace`. `defaultStartProject` in `run-config.ts` is the one rule, and `WorkspaceContext.defaultRunConfig` is the one reader. There is no other mutable "default directory".
- Settings → Projects lists the organization's cloud projects above the selected host's folders: add (by repository or from a checkout on your machines), rename, remove, the default branch for new worktrees, and the machines that hold a checkout. Solus has no setup-script or per-project model setting to share yet, so the cloud project holds only its name and default branch.

## Open items

- **Durable prompt de-duplication (A5).** §8 asks the host to keep each `clientPromptId` with its session. The ledger check was removed from the working tree; restore it or change §8.
- **One key for dispatch.** `listProjectIdentities` still gives the clone source of each local checkout, and the run picker dispatches with it. A draft for a cloud task dispatches with the §1 key, so a fork task clones the upstream. To use one key: add a `cloneUrl` to `PendingHostDispatch` and `setupPrepareProject`, key the dispatch checkout path by the §1 key, add the `upstream` remote to a fork clone, and read the key and the clone URL from `listProjects`. Then remove `listProjectIdentities`.
- **Push a task to Solus Cloud.** Not built. A transfer must carry the task row and its comments, events, links, external links, and session links in one atomic import, like `worksCloudExport` / `worksCloudImport` / `worksCloudRemove`. Three questions need a decision first:
  1. `short_id` is unique per database, so a pushed task gets a new number in the cloud; the old number stops working.
  2. Session links name sessions on the pushing host; the cloud can link them only when those sessions have records in the workspace service.
  3. Subtasks (`parent_id`): push the tree together, or refuse a task whose parent stays local.

## Not in scope

Subprojects. Session transfer. Automatic failover to another host. A cloud prompt queue. Settings writes that fan out to every host. Filtering a subfolder's pull requests by changed paths.

## Deferred

- Managed-host cost limits: when an idle managed host stops, and whether an organization has a quota.