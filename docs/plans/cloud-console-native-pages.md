# Cloud console: native pages on shared surfaces

**Status:** superseded 2026-09-22 (§10). The console pages this plan built are
deleted; `app.solus.sh/` serves the web client, and the console is the
dashboard. `SurfaceContext` (§4) and `lint:surfaces` stay. See
`cloud-service-model.md` §15 "One door".

## 1. The problem

The tree had three doors to the same cloud rows:

1. The **cloud console** (the account website, `../solus-cloud`) — sidebar,
   team switcher, connections, sign-in.
2. `packages/workspace-ui/src/embedded/` — the console mounted one component
   that booted the whole workspace runtime (`createAppCore`, router, panes,
   agent events, toaster, popover layer) and translated the console's URLs to
   and from pane routes. Native chrome outside, a second application inside.
3. The `/app/` web client, which became a cloud-only board client when the
   account origin served it (`WebShell.showsCloudBoardsOnly = BASE_URL !== '/'`).

Doors 2 and 3 were one product twice. Both read `serversStore.activeCloudServer`,
both hid the project switcher and the New action, both carried their own empty
and unreachable states. Door 3 also made the web client a different product
depending on where it was served, which §15 itself said must not happen.

The root cause: every surface reads `getWorkspaceContext()`, so every consumer
had to construct a `WorkspaceContext`, and the only way to do that is to boot
the workspace.

## 2. Decisions

- **One door per capability.** The console owns *read, follow, and continue*:
  the task board, a task, the works ledger, a work, a session record with the
  prompt relay (`cloud-service-model.md` §23 "Reads and prompts"). `/app/` owns
  what needs a runner: new sessions, permissions, diffs, the editor, plus guest
  links and pairing, which only the account origin can mint. `/app/` is the same
  bundle a machine serves at `/`; it has no cloud mode.
- **Native pages, shared surfaces.** The console's SvelteKit routes are real
  pages. They own layout, navigation (`goto`), loading and error states, the
  crumb, and the organization choice. They render the *same* surface components
  desktop and web render, so a task looks and behaves the same everywhere. No
  router, no panes, no URL translation layer.
- **A surface reads a narrow context, not the workspace.** `SurfaceContext`
  (§4) is what a record or board surface needs: the stores of its hosts, an RPC
  context builder, and the commands that open another resource. The workspace
  provides one from `WorkspaceContext`; the console provides one from
  `ConsoleWorkspace`. Workspace-only actions (split chat, plan modal, automation
  builder, the pane chrome) are capabilities the surface asks for and omits when
  absent, the way `ClientShellContext.canOpenResource` already works.
- **The console adopts the workspace design system.** Already true:
  `src/routes/layout.css` imports `@solus/workspace-ui/workspace.css` and maps the
  console's shadcn tokens onto the Solus tokens. The pages use workspace-ui's
  `components/ui/*` primitives. Desktop styling is the source of truth.
- **No backwards compatibility.** There are no users. The embedded shell, the
  cloud-only mode, and the page-route remnants are deleted, not deprecated.

## 3. Vocabulary

- **cloud console** or **console** — the account website at `app.solus.sh`
  (`../solus-cloud`, SvelteKit on Cloudflare Workers). Retires "account
  website" and "embedding site" in code and comments going forward.
- **surface** — one component that renders one board or one record: the task
  board, a task, the works ledger, a work, a session record. Same word as
  `RouteSurfaceProps`: a surface is what a pane mounts in the workspace and what
  a page mounts in the console.
- **record surface** — a surface for one resource (`TaskPage`, `WorkPane`,
  `SessionRecordPage`). Reused whole; its logic is the product.
- **board** — a surface that lists a scope (`TasksPage`, `PrsPage`,
  `WorkspacePage`). The console mounts the workspace boards whole (§9): the
  same search, filters, sort, multi-select, and keyboard walk as desktop. The
  only difference is the scope: one host, the organization's workspace
  service, so a board shows the rows that were made in Solus Cloud or moved
  there. (Revised 2026-09-21; the first slice composed thin boards from the
  shared rows, which the product rejected — a board that lacks its filters is
  a different product, not a narrower scope.)
- **`SurfaceContext`** — the narrow context a surface reads (§4).
- **`ConsoleWorkspace`** — the console's `SurfaceContext`: one host, the
  organization's workspace service.
- **`ConsoleShell`** — the console's `ClientShellContext`: no local
  attachments, no native settings, no project panel, no companion panes;
  `openResource` is `goto`.

## 4. `SurfaceContext`

`packages/workspace-ui/src/contexts/app/surface-context.svelte.ts`:

```ts
export interface SurfaceContext {
  readonly settings: SettingsContext
  readonly tasksStore: TasksStore
  readonly worksStore: WorksStore
  readonly outboxStore: OutboxStore
  /** A transcript's plan and automation cards resolve against these. */
  readonly automationsStore: AutomationsStore
  readonly planStore: PlanStore
  readonly deferHistoryToolInputs: boolean
  /** The host a session is read from: its tab's host, or the console's one host. */
  apiForSession(sessionId: string): HostApi
  /** The project the task board is scoped to; the console has none. */
  readonly tasksProjectCwd: string | null
  readonly pluginCommands: Session['pluginCommands']
  /** The session the person is in, when this client has one. */
  readonly activeSession: Session | undefined
  sessionForAgentSession(agentSessionId: string, serverId: string | undefined): Session | undefined
  ctxForDirectory(workingDirectory: string): IpcContext
  ctxForEnvironment(workingDirectory: string, gitContext: GitCheckout | null): IpcContext
  goToTask(taskId: string, via?: Via, target?: 'leading' | 'secondary'): void
  openTasks(via?: Via, target?: 'focused' | 'aside'): void
  openWork(workId: string, target?: 'focused' | 'aside'): void
  openFolio(via?: Via, target?: 'focused' | 'aside'): void
  closeWork(paneId?: PaneId): void
  /** Delete a work with a brief undo window. */
  requestWorkDelete(work: Work): void
  /** The commands only the workspace has, or null on a client without one. */
  readonly workspace: WorkspaceCommands | null
}
```

`workspace` is `WorkspaceCommands`: the named subset of `WorkspaceContext`
that record surfaces actually use (a `Pick` in
`contexts/app/surface-context.svelte.ts`). A surface still writes
`session.workspace?.openPlanModal(...)` and gates the one control at the one
place that uses it. Do not add a member the console cannot satisfy to
`SurfaceContext` itself; add it to `WorkspaceCommands`, so each new reach from
a portable surface into the runner-backed workspace is a visible decision.

This replaced an earlier choice to expose the whole `WorkspaceContext` here.
The workspace refactor (task "Workspace refactor: ownership and startup
loading") narrows it so the record surfaces cannot come to depend on the rest
of the workspace's roughly 250 members.

`WorkspaceContext` implements `SurfaceContext` with `workspace = this`.
`getSurfaceContext()` reads the Svelte context; `setSurfaceContext()` is called
by `createAppCore` (with the workspace) and by `createSurfaceCore`
(`contexts/app/surface-core.ts`), the console's composition root, which also
registers the settings, status bar, plan store, project config, pull
requests, agent, and keybindings contexts the record surfaces read.

The files this change moves from `getWorkspaceContext()` to
`getSurfaceContext()`, and what each gates on `workspace`:

| File | Gated on `workspace` |
|---|---|
| `tasks/task-page/TaskPage` | plan and automation links, the PR link's pane target, `revealSession`, split open, start session, the link picker |
| `tasks/task-page/TaskHeader` | the body editor (`DocumentPromptEditor` completes references against the workspace); title and fields still edit |
| `tasks/task-page/TaskSessionsList` | reads `sessionForAgentSession` instead of the tab lookup; `onOpenSplit` is null with no companion pane |
| `tasks/task-page/TaskLinkedTable`, `TaskPrList` | `onAdd` null hides the Link control |
| `tasks/link-control/TaskLinkControl`, `tasks/TaskComposer` | none |
| `work/WorkPane`, `ArtifactShell`, `ArtifactRail`, `ArtifactActivityCard`, `DocumentShell`, `WorkHeaderActions`, `DocumentStackCard`, `ExternalComment*` | none |
| `work/WorkPublishMenu` | the "Connect in Settings…" route |
| `diagram/DiagramShell`, `DiagramCommentsPanel` | send comments to a new session |
| `artifact/ArtifactView` | an image read through a tab's machine |
| `session/record/SessionRecordPage`, `SessionRecordStore`, `session-record-transcript`, `materializeSessionTranscript` | the pane close |
| `conversation/UserMessageBubble` | attachment reads, the mark page, the automation link |
| `conversation/MarkdownLink`, `WebLink` | a work or task link opens through `ClientShellContext.openResource`; plan, session, and file links and "Open in Solus" need the workspace |
| `conversation/MarkdownText`, `ui/CodeSpan` | a file token previews only with a workspace |
| `ui/ProjectFavicon` | the workspace directory |
| `ui/lib/pane-actions` | inert answers with no pane |

`TaskLinkPicker`, `work/ImportDocDialog`, and `artifact/FilePreviewStream`
keep `getWorkspaceContext()`: each is mounted only behind a gate. `bun run
lint:surfaces` rejects a `getWorkspaceContext()` in the record-surface folders
and files and keeps that allow-list (`tests/unit/surface-boundary.test.ts`).

## 5. The console

`../solus-cloud/src/lib/workspace/`:

- `boot.ts` — `bootConsoleWorkspace(origin)`: read the account directory with
  the cookie, merge it into the saved hosts, answer the cloud row marked
  `isActiveWorkspace`, else the first. (Was `embedded-boot.ts`.)
- `connect.ts` — `connectConsoleHost(server)`: dial the workspace service as
  the primary connection in `serverConnections`. (Was `connect-embedded-host.ts`.)
- `console-workspace.svelte.ts` — `ConsoleWorkspace implements SurfaceContext`
  for one `serverId`, building RPC contexts with `IpcContextBuilder` over
  empty defaults; `ConsoleShell implements ClientShellContext`;
  `getConsoleWorkspace()` for a page that needs the host id.
- `resource-paths.ts` — the console's path for each resource
  (`pathForResource`, `taskPath`, `workPath`, `sessionPath`).
- `ConsoleWorkspaceProvider.svelte` — the composition root: dials the host,
  `createSurfaceCore`, the popover layer, the share dialog, the toaster, the
  theme observer. Mounted once by the layout with the booted server.
- `repositories.store.svelte.ts` — the repositories the organization's GitHub
  connection can read, for the boards' project picker (§9).

`src/routes/(signed-in)/(workspace)/+layout.svelte` boots once
(`bootConsoleWorkspace`), renders the console's own loading, signed-out,
no-workspace, and unreachable states, and mounts the provider around the
child pages, which are real pages:

| Route | Renders |
|---|---|
| `/tasks` | `TasksPage`, scoped `{ kind: 'host' }` — every task the service holds (§9) |
| `/prs` | `PrsPage`, scoped to the picked repository (§9) |
| `/tasks/[taskId]` | `TaskPage` |
| `/docs` | `WorkspacePage`, scoped `{ kind: 'all' }` (§9) |
| `/docs/[workId]` | `WorkPane` |
| `/sessions/[sessionId]` | `SessionRecordPage` with `SharedPrompt` as the composer — the prompt relay to the assigned runner while it is online (`editable`, `ownAccount`; the service refuses what the member may not send) |

Navigation between them is `goto`; the surfaces call `ctx.goToTask` and
`ctx.openWork`, which the console implements with `goto`. The crumb leaf is the
task or work title once read.

The console's own toaster and tooltip provider live in the root layout; a
surface does not bring its own.

## 6. Deletions

Solus:

- `packages/workspace-ui/src/embedded/` (five files).
- `ClientShellContext.showsCloudBoardsOnly`; the `BASE_URL !== '/'` line in
  `WebShell`; the desktop line.
- `serversStore.activeCloudServer`; `components/tasks/lib/board-scope.ts`; the
  cloud-only branches in `TasksPage` and `WorkspacePage`.
- The §15 paragraph "The client, revised 2026-09-21" in
  `cloud-service-model.md`, replaced by a pointer here.

Console:

- `src/lib/shell/surface-routes.ts` and its test; the workspace `+layout.svelte`
  that mounted `EmbeddedWorkspace`.

## 7. Not in this change

- The guest shell (`apps/client/src/GuestApp.svelte`) keeps `createAppCore`. It
  gains nothing from the narrow context yet; when the console grows a public
  share route, it moves the same way.
- Comments on works and tasks in the console beyond what the record surfaces
  already render.
- Real provider consent, native runs, deployment.

## 8. Implemented (2026-09-21)

Solus: `SurfaceContext`, `createSurfaceCore`, the moves in §4, the lint and its
test, the deletions in §6, `cloud-service-model.md` §15 and
`packages/workspace-ui/CLAUDE.md` updated. Console: everything in §5, the
route test replaced by `resource-paths.test.ts`, `docs/uplink.md` and
`scripts/link-solus.ts` reworded.

Verification: `bun run lint:surfaces` clean; `tests/unit/surface-boundary.test.ts`
3/3; the touched Solus files carry no new `svelte-check` or `tsc` diagnostics
(the packages have pre-existing ones, listed in `cloud-service-model.md` §26);
the unit files that import the touched modules pass except three that fail
before this change too (`workspace-mode`, and `server-status` and
`server-removal` on a missing `runed` package in this checkout). Console:
`bun run check` 0 site errors, `bun run test` 117/117, `bun run build`
succeeds.

Not exercised: a browser run of the console pages against a live workspace
service, and the phone layout of the console boards. The console's own
sidebar and administration pages keep their shadcn copies of the primitives;
converging them on `workspace-ui/components/ui` is a later change.


## 9. Boards at parity (2026-09-21, second slice)

`ConsoleTaskBoard` and `ConsoleWorksLedger` are deleted. The console's
`/tasks`, `/prs`, and `/docs` mount `TasksPage`, `PrsPage`, and
`WorkspacePage` — the files desktop and web mount — and those three read
`getSurfaceContext()` like the record surfaces do. `lint:surfaces` covers them.

### What the boards need that the record surfaces did not

Added to `SurfaceContext`, each satisfiable by the console:

| Member | Workspace | Console |
|---|---|---|
| `projectPageScope`, `setProjectPageScope` | the shared page scope | one `$state` the page sets on mount: tasks and docs `{ kind: 'host' }` / `{ kind: 'all' }`, pull requests the picked repository |
| `boardProjects` | `projectsStore.entries` — the client's project catalog | the repositories the organization's GitHub connection can read (`providerRepositories`), as `projectRoot: 'github.com/<owner>/<repo>'` — the scope form `repoForScope` already accepts, so `prList` needs no checkout |
| `ctx` | the active tab's RPC context | `ctxForDirectory('~')` |
| `staticInfo` | the host's static info | `null` |
| `activeRun` | the input bar's run | `undefined` |
| `taskCreationContext` | the input bar's project | `null` — a task is made on the machine that runs it |

A board's `open` flag is `session.workspace?.router.at(page) ?? true`: the
console page is open as long as it is mounted. Gated on `workspace`: the
sidebar's live projects and `markTaskUnread` (`getSessionSidebarStore`),
catalog removal and recent-project refresh (`projectsStore`), starting or
resuming a session from a row, the split/companion opens, the composer, the
review mode and guide generation, the New menu and imports on the ledger, and
the page's close. `GithubConnectionRequired` sends the console to its own
connections page through `ClientShellContext.openResource({ kind: 'connections' })`.

### The repository picker

`providerRepositories(providerId)` — collaboration plane — answers the
repositories the host's credential for that code host can read, newest push
first. The console's `repositories.store.svelte.ts` reads it once the host
connects and feeds `ConsoleWorkspace.boardProjects`. With no GitHub connection
the list is empty and the pull requests page shows the connect action.

### Not in this slice

Opening a pull request from the console list. The detail panel
(`PrDetailPanel` → `PrReviewPane`) prepares a worktree through
`preparePrReview`, an execution-plane call the workspace service cannot
answer; the activity feed is provider-backed and could show without one, but
`PrReviewPane`, `ActivityFeed`, `PrDetailChrome`, `ReviewSurface`, and
`DiffPanel` all read the workspace today. A console row opens the pull request
on the code host until that tree is moved to `SurfaceContext` with the diff
tab gated on a workspace.


## 10. Superseded: the client at the root (2026-09-22)

Product reversed §2 "one door per capability". Splitting the door by capability
— records on the console, runners on `/app/` — is not what a native-client
product does: Cursor, Zed, Warp, and Claude Code all open one client and keep
administration on a web dashboard. So:

- `app.solus.sh/` serves the web client (`solus-cloud/src/routes/[...path]/+server.ts`
  over `src/lib/server/client-shell.ts`; `scripts/sync-client.ts` builds
  `apps/client` at base `/` into `static/` and moves `index.html` out of the
  asset layer). Signed out, a client path redirects to sign-in with `next`.
  `/w`, `/s`, `/t` serve the same document to anyone. `/app/` is gone.
- The client boots the same way on every origin: `main.ts` drops its
  `BASE_URL` guards, probes the serving origin for the account directory and
  for a host in parallel, and parses a share link wherever it is served.
  `cloudOrigin.signInUrl` returns to `/`; `linkMachineUrl` opens the console's
  `/hosts/link`.
- Deleted from the console: the `(workspace)` route group, `src/lib/workspace/`
  (`ConsoleWorkspace`, `ConsoleShell`, `ConsoleWorkspaceProvider`, boot,
  connect, `repositories.store`, `resource-paths`), the sidebar's Workspace
  section, the signed-in home page and `home-state`. The link-code flow moved
  to `/hosts/link`; `/hosts` gained "Link a machine". The workspace summary
  keeps only the last-activity line.
- Kept in Solus: `SurfaceContext`, `lint:surfaces`, `providerRepositories`,
  the `connections` route kind, the cloud-connection store rule, the
  `WorkspacePage` fixes. `createSurfaceCore` (`contexts/app/surface-core.ts`)
  had no caller left and is deleted; `createAppCore` is the one composition
  root.
- Not added: a read-only Organization section in the client's Settings. It
  comes with the signed-in account control in the session sidebar.
