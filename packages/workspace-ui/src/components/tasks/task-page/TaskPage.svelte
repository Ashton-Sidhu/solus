<script lang="ts">
  import { tick } from "svelte";
  import type {
    Task,
    TaskLink,
    TaskLinkInput,
    TaskUpdatePatch,
  } from "@solus/contracts/task-types";
  import {
    getProjectConfigStore,
    getWindowContext,
    getWorkspaceContext,
    getPullRequestsContext,
  } from "../../../contexts";
  import { findOpenTabForSession } from "../../../lib/sessionUtils";
  import { toasts } from "../../../lib/toasts";
  import { localApi } from "@solus/client-core/local-api";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { LOCAL_SERVER_ID } from "@solus/client-core/server-registry";
  import { readSessionMeta } from "@solus/client-core/session-meta";
  import { setMarkdownImageContext } from "../../conversation/lib/markdown-image";
  import {
    useKeybinding,
    useScope,
  } from "../../../lib/keybindings/use-keybinding.svelte";
  import { paneActions } from "../../ui/lib/pane-actions.svelte";
  import type { RouteSurfaceProps } from "../../ui/lib/pane-surface";
  import { authorInitials, sortTasks } from "../lib/tasks-api";
  import {
    isTaskRailFolded,
    linkedWorkProvider,
    taskPageCapabilities,
    taskRef,
  } from "./lib/task-page";
  import {
    heldBackCommentIds,
    taskPublishTarget,
    taskUpstreamState,
  } from "./lib/task-upstream";
  import { taskPrRows, prLifecycleOf } from "./lib/task-prs";
  import { linkedPrNavigationTarget } from "./lib/linked-pr-navigation";
  import TaskActivityFeed from "./TaskActivityFeed.svelte";
  import TaskPrList from "./TaskPrList.svelte";
  import TaskChromeBar from "./TaskChromeBar.svelte";
  import TaskRecordBar from "./TaskRecordBar.svelte";
  import TaskCommentComposer from "./TaskCommentComposer.svelte";
  import TaskHeader from "./TaskHeader.svelte";
  import TaskLinkPicker from "./TaskLinkPicker.svelte";
  import TaskLinkedTable from "./TaskLinkedTable.svelte";
  import TaskPageSkeleton from "./TaskPageSkeleton.svelte";
  import TaskSessionsList from "./TaskSessionsList.svelte";
  import TaskSidebar from "./TaskSidebar.svelte";
  import TaskTabStrip from "./TaskTabStrip.svelte";
  import type { TaskTabId } from "./lib/task-tabs";
  import { BottomSheet } from "../../ui/bottom-sheet";
  import { isStackedPane, observePaneWidth } from "../../../lib/pane-width";
  import {
    ChevronRight as CaretRightIcon,
    SlidersHorizontal as PropertiesIcon,
    Plus as PlusIcon,
    User as UserIcon,
  } from "@lucide/svelte";

  interface Props extends Omit<RouteSurfaceProps<"task">, "paneId"> {
    paneId?: RouteSurfaceProps<"task">["paneId"];
    embedded?: boolean;
    onRequestClose?: () => void;
    onRequestPrevious?: (() => void) | null;
    onRequestNext?: (() => void) | null;
    onOpenRoute?: () => void;
  }

  let {
    params,
    paneId,
    surfaceVisible = true,
    embedded = false,
    onRequestClose,
    onRequestPrevious,
    onRequestNext,
    onOpenRoute,
  }: Props = $props();

  const session = getWorkspaceContext();
  const pullRequests = getPullRequestsContext();
  const windowCtx = getWindowContext();
  const store = session.tasksStore;
  const projectConfig = getProjectConfigStore();
  const outbox = session.outboxStore;
  const pane = paneActions(() => paneId);

  const taskId = $derived(params.taskId);
  // Writes an agent recorded on another host that have not landed here yet
  // (ADR-0007). While any exist, this page is behind by exactly that much and
  // says so rather than passing stale state off as current.
  const syncOps = $derived(taskId ? outbox.pendingOpsFor("tasks", taskId) : []);
  const failedSyncCount = $derived(
    syncOps.filter((op) => op.state === "failed").length,
  );
  const pendingSyncCount = $derived(syncOps.length - failedSyncCount);
  const task = $derived(store.peek(taskId));
  const details = $derived(store.get(taskId).details);
  const links = $derived(details?.links ?? []);
  const linkedWorkIds = $derived(
    links.filter((link) => link.kind === "work").map((link) => link.targetKey),
  );
  const sessions = $derived(store.get(taskId).sessions);
  const projectCwd = $derived(
    task?.projectKey ?? session.tasksProjectCwd ?? undefined,
  );
  setMarkdownImageContext({
    cwd: () => projectCwd,
    serverId: () => store.get(taskId).serverId ?? LOCAL_SERVER_ID,
    ctx: () => projectCwd ? session.ctxForDirectory(projectCwd) : undefined,
    isWeb: () => windowCtx.isWeb,
    api: () => {
      const serverId = store.get(taskId).serverId;
      return serverId ? serverConnections.apiFor(serverId) : undefined;
    },
  });
  const projectLabel = $derived(
    projectCwd ? (projectCwd.split("/").pop() ?? projectCwd) : "Inbox",
  );
  const upstream = $derived(
    task
      ? taskUpstreamState({
          task,
          externalLink: details?.externalLink,
          comments: details?.comments ?? [],
        })
      : null,
  );

  // A PR's title and state are a provider round trip the host deliberately
  // keeps off the task read, so the page overlays them here — from the shared
  // PR caches, never from the PRs page's own list, which belongs to whichever
  // project it is showing.
  const prs = pullRequests.projects;
  const taskServerId = $derived(store.get(taskId).serverId);
  $effect(() => {
    const workIds = linkedWorkIds;
    if (!surfaceVisible || workIds.length === 0) return;
    // The link table carries identity and title, not Folio mirror metadata.
    // Refresh only when the page has linked works; listWorks returns metadata
    // without shipping every document body across a remote connection.
    void session.worksStore.loadAll(projectCwd ?? "~");
  });
  // A scope is one repository, so the number alone identifies the pull request
  // here — no base-repo comparison is needed to tell #65 in this project from
  // #65 in another one.
  const prRows = $derived(
    taskPrRows(
      links,
      (number) => prLifecycleOf(prs.at(taskServerId, projectCwd)?.prFor(number) ?? null),
      (number) => prs.at(taskServerId, projectCwd)?.prFor(number)?.title || undefined,
    ),
  );
  $effect(() => {
    const serverId = taskServerId;
    const root = projectCwd;
    const numbers = prRows.map((row) => row.number);
    if (!serverId || !root || !numbers.length) return;
    prs
      .get(serverConnections.apiFor(serverId), serverId, session.ctxForDirectory(root))
      .ensureNumbers(numbers);
  });

  // Auto-post is a project decision, not a per-task one: it is the same choice
  // for every ticket filed against this repo, and it already lives in the
  // project config the Tasks page writes.
  const configHost = $derived(
    taskServerId
      ? { serverId: taskServerId, api: serverConnections.apiFor(taskServerId) }
      : null,
  );
  const autoPost = $derived(
    upstream?.canSync && taskServerId && projectCwd
      ? (projectConfig.configFor(taskServerId, projectCwd)?.tasksAutoPushComments ?? false)
      : null,
  );
  const heldBack = $derived(
    heldBackCommentIds(details?.comments ?? [], !!upstream?.canSync),
  );
  const providerStatus = $derived(store.providerStatus(projectCwd));
  const capabilities = $derived(task ? taskPageCapabilities(task, providerStatus) : null);
  const publishTarget = $derived(
    task ? taskPublishTarget({ task, upstream, status: providerStatus }) : null,
  );

  // Both reads answer "where could this task be filed, and what happens to a
  // comment when it is": the page cannot draw its sync controls without them.
  $effect(() => {
    const host = configHost;
    const cwd = projectCwd;
    if (!host || !cwd) return;
    if (projectConfig.configFor(host.serverId, cwd) === undefined) {
      void projectConfig.load(host, cwd).catch(() => {});
    }
    if (!store.providerStatus(cwd)) {
      void store.loadProviderStatus(cwd, { serverId: host.serverId }).catch(() => {});
    }
  });

  let picking = $state(false);
  let refreshing = $state(false);
  let syncing = $state(false);
  let scrollViewport = $state<HTMLElement | null>(null);

  // The route param is the request: whenever it names a task we haven't read the
  // detail of, fetch it. A $derived can't express "go do IO", so this is one of
  // the cases $effect is actually for.
  let loadedId = $state<string | null>(null);
  let loadingTaskId = $state<string | null>(null);
  $effect(() => {
    const id = taskId;
    if (!id || !surfaceVisible) {
      loadedId = null;
      return;
    }
    const stopWatching = store.get(id).watchDetails();
    if (id !== loadedId) {
      loadedId = id;
      loadingTaskId = id;
      void store.ensureLoaded().catch(() => {});
      void store
        .get(id, projectCwd)
        .loadDetails()
        .catch((err) => toastError("open task", err))
        .finally(() => {
          if (loadingTaskId === id) loadingTaskId = null;
        });
    }
    return stopWatching;
  });

  // ── Prev/next follow the Tasks page's own ordering, so "next" is the row the
  // user actually saw underneath this one. ──
  const siblings = $derived(
    sortTasks(
      task?.projectKey ? store.tasksForProject(task.projectKey) : store.inbox,
      "updated",
    ),
  );
  const position = $derived(siblings.findIndex((t) => t.id === taskId));
  const previous = $derived(position > 0 ? siblings[position - 1] : null);
  const next = $derived(
    position >= 0 && position < siblings.length - 1
      ? siblings[position + 1]
      : null,
  );

  function toastError(action: string, err: Parameters<typeof String>[0]) {
    toasts.error(`Couldn't ${action}`, {
      description: err instanceof Error ? err.message : String(err),
    });
  }

  function save(patch: TaskUpdatePatch) {
    if (!taskId) return;
    void store
      .get(taskId)
      .update(patch)
      .catch((err) => toastError("save task", err));
  }

  async function refresh() {
    if (!taskId || !projectCwd || refreshing) return;
    refreshing = true;
    try {
      await store.get(taskId, projectCwd).loadDetails();
    } catch (err) {
      toastError("refresh issue", err);
    } finally {
      refreshing = false;
    }
  }

  /** Exchange with the ticket now rather than on the engine's own debounce. */
  async function syncNow() {
    if (!taskId || syncing) return;
    syncing = true;
    try {
      await store.get(taskId).syncNow();
    } catch (err) {
      toastError("sync with the provider", err);
    } finally {
      syncing = false;
    }
  }

  async function comment(body: string, alsoPost: boolean) {
    if (!taskId) return;
    try {
      // The host uploads pasted attachments the provider can host and refuses
      // the rest, so the rule lives there rather than in a string check here.
      await store.get(taskId).comment(body, { pushToExternal: alsoPost });
      await tick();
      scrollViewport?.scrollTo({ top: scrollViewport.scrollHeight });
    } catch (err) {
      toastError("post comment", err);
      throw err;
    }
  }

  async function publishComments(commentIds: string[]) {
    if (!taskId || !commentIds.length) return;
    try {
      await store.get(taskId).publishComments(commentIds);
    } catch (err) {
      // The host names the attachment it cannot publish and says to use the
      // provider composer, which the masthead's open-source control reaches.
      toastError("publish that comment", err);
    }
  }

  async function deleteComment(commentId: string) {
    if (!taskId) return;
    try {
      await store.get(taskId).deleteComment(commentId);
    } catch (err) {
      toastError("delete that comment", err);
    }
  }

  /** File this task with the project's provider for the first time. */
  async function publishTask() {
    if (!taskId || !projectCwd || syncing) return;
    syncing = true;
    try {
      await store.get(taskId).publishUpstream(projectCwd);
    } catch (err) {
      toastError("publish this task", err);
    } finally {
      syncing = false;
    }
  }

  function setAutoPost(next: boolean) {
    const host = configHost;
    if (!host || !projectCwd) return;
    void projectConfig
      .save(host, projectCwd, { tasksAutoPushComments: next })
      .catch((err) => toastError("save the auto-post setting", err));
  }

  function addLink(input: TaskLinkInput) {
    if (!taskId) return;
    void store.get(taskId).link(input).catch((err) => toastError("link this", err));
  }

  function removeLink(link: TaskLink) {
    void store
      .get(link.taskId)
      .unlink(link.kind, link.targetKey, link.targetScope)
      .catch((err) => toastError("unlink this", err));
  }

  /** The host draws the still, so this waits on a browser; the row shows it. */
  async function attachArtifact(link: TaskLink) {
    try {
      await store.get(link.taskId).attachArtifact(link.targetKey, projectCwd);
      toasts.success(
        upstream?.canSync
          ? `Preview queued for ${upstream.provider}`
          : "Preview attached to this task",
      );
    } catch (err) {
      toastError("attach the artifact preview", err);
    }
  }

  /** A linked row opens wherever that kind lives. */
  function openLink(link: TaskLink) {
    switch (link.kind) {
      case "work":
        void session.openWorkModal(
          link.targetKey,
          link.liveTitle || link.title,
          { secondary: true, via: "click" },
        );
        break;
      case "plan":
        void session.openPlanModal(
          `${link.targetScope}__${link.targetKey}`,
          undefined,
          { secondary: true },
        );
        break;
      case "automation":
        session.openAutomationBuilder(link.targetKey, "aside");
        break;
      case "pr": {
        const number = Number(link.targetKey);
        if (Number.isFinite(number)) {
          const target = linkedPrNavigationTarget({
            taskServerId: store.get(taskId).serverId,
            taskProjectDirectory: projectCwd,
            linkProjectDirectory: link.targetScope,
          });
          void session.openPullRequest({
            number,
            title: link.title,
            url: link.url,
          }, {
            ctx: target.projectDirectory
              ? session.ctxForDirectory(target.projectDirectory)
              : session.ctx,
            serverId: target.serverId,
          });
        }
        break;
      }
    }
  }

  /** Focus the session's tab when it's already open, otherwise resume it from
   *  history. Resolve the indexed record first: the link stores a session id,
   *  not which agent backend wrote it. */
  async function reveal(sessionId: string): Promise<string | null> {
    const link = store.get(taskId).sessions.find((candidate) => candidate.sessionId === sessionId);
    const serverId = link?.executionServerId ?? store.get(taskId).serverId;
    const openTab = findOpenTabForSession(
      sessionId,
      session.tabs,
      session.sessions,
      session.tabOrder,
      undefined,
      serverId ? serverConnections.resolveId(serverId) : undefined,
    );
    if (openTab) return openTab;
    const meta = serverId ? await readSessionMeta(serverId, sessionId) : null;
    return meta ? await session.resumeSession(meta) : null;
  }

  async function openSession(sessionId: string) {
    const tabId = await reveal(sessionId);
    if (!tabId) return;
    session.selectTab(tabId);
    session.router.closeGroup("page");
  }

  async function openSessionSplit(sessionId: string) {
    const tabId = await reveal(sessionId);
    const revealed = tabId ? session.sessionFor(tabId) : undefined;
    if (revealed) session.openSplitChat(revealed.id);
  }

  /** Compose a new session already bound to this task. The link lands when the
   *  draft is sent, so an abandoned composer leaves nothing behind. */
  function startSession(record: Task) {
    void session
      .openTaskSession(record)
      .catch((err) => toastError("start a session", err));
  }

  function unlinkSession(sessionId: string) {
    void store
      .get(taskId)
      .unlinkSession(sessionId)
      .catch((err) => toastError("unlink this session", err));
  }


  async function stopSession(sessionId: string) {
    try {
      const serverId = store.get(taskId).serverId;
      if (!serverId) return;
      await serverConnections.apiFor(serverId).stopSession(sessionId);
    } catch (err) {
      toastError("stop session", err);
    }
  }

  // ── The stacked rung ──
  // Wide, the four sections scroll past each other in one column and the
  // sidebar sits beside them. Below 30rem neither is possible: the sidebar has
  // no column to be, and a long Activity feed would push the composer off the
  // bottom. So the sections become a strip, the sidebar becomes a sheet, and
  // the composer is pinned.
  //
  // Read from the page's own box at the same 30rem the stylesheet uses — the
  // window would answer for the whole display and be wrong in a companion pane.
  let rootEl = $state<HTMLDivElement | null>(null);
  let paneWidth = $state(0);
  $effect(() => {
    if (!rootEl) return;
    return observePaneWidth(rootEl, (width) => (paneWidth = width));
  });
  const stacked = $derived(isStackedPane(paneWidth));

  // ── The folded rung ──
  // A separate question from `stacked`, and a wider one. `stacked` asks whether
  // this is a phone layout — one section at a time, a record bar, a pinned
  // composer. This asks only whether the rail still has a column to sit in,
  // which it loses at 60rem, long before the page becomes a phone. Between the
  // two the rail used to fold under the content and land beneath the comment
  // composer, past everything, with no way to reach it as a sheet instead.
  const railFolded = $derived(isTaskRailFolded(paneWidth));

  /** The branch the task's runs check out, and the ticket it mirrors — the two
   *  facts the identity row states beneath the assignee. Both are optional, and
   *  the row simply drops the line when neither exists. */
  const identityDetail = $derived(
    [
      sessions.find((entry) => entry.branch)?.branch,
      upstream ? `${upstream.provider} ${upstream.ref}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
  );

  let tab = $state<TaskTabId>("overview");
  let propertiesOpen = $state(false);
  const tabCounts = $derived({
    linked: links.length + prRows.length,
    sessions: sessions.length,
    activity: (details?.comments?.length ?? 0) + (details?.events?.length ?? 0),
  });

  /** Sections are hidden, never unmounted: a tab that unmounts loses its
   *  expanded threads and re-fetches its artifact previews on every switch. */
  const hiddenTab = (id: TaskTabId) => stacked && tab !== id;

  // ── The bottom bar belongs to the tab, not to the page ──
  // Where the four sections scroll past each other there is one thing to do at
  // the foot of the page: comment. Where only one section is on screen, the
  // move that section is for is the one the thumb should land on — Linked wants
  // a link, Sessions wants a run — and the composer is what steps aside for it.
  // It is hidden rather than unmounted, so a half-written comment survives a
  // trip through the other tabs.
  const bottomAction = $derived(
    stacked && (tab === "linked" || tab === "sessions") ? tab : null,
  );

  // Shares the Tasks scope: `task` and `tasks` are one exclusive page group, so
  // only ever one of them is mounted and Escape means the same thing in both.
  useScope("tasks", { active: () => !embedded });
  useKeybinding("tasks.close", () => pane.close(), {
    enabled: () => !embedded,
  });
</script>

{#snippet identityRow()}
  <!-- The sidebar's first three fields, on the one rung where that column has
       nowhere to be: who it is assigned to, the branch its runs check out, and
       the ticket it mirrors. It is a button, not a card — the whole row opens
       the sheet that holds the rest of them. -->
  <button
    type="button"
    class="flex h-[52px] w-full cursor-pointer items-center gap-2.5 rounded-xl border-0 bg-card px-3 text-left text-foreground shadow-[shadow:var(--elev-ring)] [-webkit-tap-highlight-color:transparent]"
    onclick={() => (propertiesOpen = true)}
    aria-haspopup="dialog"
    aria-expanded={propertiesOpen}
  >
    {#if task?.assignee}
      <span
        class="flex size-[26px] shrink-0 items-center justify-center rounded-full text-xs font-semibold"
        style="background:color-mix(in oklch, var(--chart-1) 22%, transparent);color:color-mix(in oklch, var(--chart-1) 74%, var(--foreground))"
        aria-hidden="true">{authorInitials(task.assignee)}</span
      >
    {:else}
      <span
        class="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-[var(--wash-3)] text-muted-foreground"
        aria-hidden="true"><UserIcon size={14} /></span
      >
    {/if}
    <span class="flex min-w-0 flex-1 flex-col gap-0.5">
      <span class="truncate font-medium"
        >{task?.assignee ?? "Unassigned"}</span
      >
      {#if identityDetail}
        <span
          class="truncate font-mono text-xs text-muted-foreground"
          >{identityDetail}</span
        >
      {/if}
    </span>
    <CaretRightIcon
      size={15}
      class="shrink-0 text-muted-foreground opacity-70"
    />
  </button>
{/snippet}

{#snippet bottomBar(record: Task)}
  <!-- The composer is outside the tabs on purpose: a comment is about the task,
       not about whichever section is on screen, and rule one of the redesign is
       that the input is always reachable.

       Properties sits on the left from the folded rung up, not the stacked one:
       that is the moment the rail leaves the column, and hiding a destination
       without building its replacement in the same breath is how it went
       missing for every pane between the two. -->
  {#if capabilities?.canComment}
    <div class="flex items-end gap-2" class:hidden={bottomAction !== null}>
      {#if railFolded}
        <button
          type="button"
          class="mb-1 flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-foreground shadow-[shadow:var(--elev-ring)] active:bg-[var(--wash-2)] [-webkit-tap-highlight-color:transparent] pointer-fine:[.is-laptop-display_&]:size-9"
          onclick={() => (propertiesOpen = true)}
          aria-haspopup="dialog"
          aria-expanded={propertiesOpen}
          aria-label="Task properties"
        >
          <PropertiesIcon size={17} />
        </button>
      {/if}
      <div class="min-w-0 flex-1">
        <!-- Where the bar is pinned by the page, the composer's own sticky
             offset and scrim are the second copy of a job already done, and
             they were what padded it into a floating card. -->
        <TaskCommentComposer
          onSubmit={comment}
          provider={upstream?.canSync ? upstream.provider : null}
          autoPost={autoPost ?? false}
          class={stacked ? "static bottom-auto p-0 [background:none]" : undefined}
          compact={stacked}
          placeholder={stacked ? `Comment on ${taskRef(record)}…` : undefined}
        />
      </div>
      {#if stacked && tab === "overview"}
        <button
          type="button"
          class="mb-1 flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-primary text-primary-foreground shadow-[0_1px_2px_rgba(24,20,16,.2)] [-webkit-tap-highlight-color:transparent]"
          onclick={() => startSession(record)}
          aria-label="New session"
        >
          <PlusIcon size={18} />
        </button>
      {/if}
    </div>
  {/if}

  <!-- Linked and Sessions each have one move worth a whole bar. Primary for
       Sessions, because starting a run is the page's own verb; outlined for
       Linked, because attaching something is a reference, not a commitment. -->
  {#if bottomAction === "sessions"}
    <button
      type="button"
      class="flex h-12 w-full cursor-pointer items-center justify-center gap-[7px] rounded-lg border-0 bg-primary font-semibold tracking-[-0.006em] text-primary-foreground active:opacity-90 [-webkit-tap-highlight-color:transparent]"
      onclick={() => startSession(record)}
    >
      <PlusIcon size={16} />
      New session
    </button>
  {:else if bottomAction === "linked"}
    <button
      type="button"
      class="flex h-12 w-full cursor-pointer items-center justify-center gap-[7px] rounded-lg border-0 bg-transparent font-medium text-foreground shadow-[shadow:var(--elev-ring)] active:bg-[var(--wash-2)] [-webkit-tap-highlight-color:transparent]"
      onclick={() => (picking = true)}
    >
      <PlusIcon size={15} />
      Link an item
    </button>
  {/if}
{/snippet}

{#snippet propertiesPanel(variant: "column" | "sheet")}
  {#if task}
    <TaskSidebar
      {task}
      {variant}
      {projectLabel}
      projectRoot={projectCwd}
      serverId={taskServerId}
      canEdit={capabilities?.canEditContent ?? false}
      canEditPlanningFields={capabilities?.canEditPlanningFields ?? false}
      canEditPriority={capabilities?.canEditPriority ?? false}
      canEditLabels={capabilities?.canEditLabels ?? false}
      editableStatuses={capabilities?.editableStatuses ?? []}
      {upstream}
      {publishTarget}
      {syncing}
      {autoPost}
      onSyncNow={syncNow}
      onSetAutoPost={setAutoPost}
      onPublishAll={() => void publishComments(heldBack)}
      onPublishTask={publishTask}
      onOpenUpstream={(url) => void localApi.openExternal(url)}
      onSave={save}
    />
  {/if}
{/snippet}

<div
  bind:this={rootEl}
  class="@container relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background text-chrome-dense"
  role="dialog"
  aria-label="Task"
  tabindex="-1"
>
  {#if taskId !== loadedId || loadingTaskId === taskId || !store.loaded}
    <TaskPageSkeleton />
  {:else if task}
    <!-- Two heads, one set of decisions. The wide bar and the record bar take
         the same handlers; what differs is how much of the page's chrome each
         has room to state, which is why they are two components rather than one
         with a rung's worth of hidden branches inside it. -->
    {@const chromeSync = upstream?.canSync
      ? syncNow
      : task.providerId === "github"
        ? refresh
        : null}
    {@const chromePrevious = embedded
      ? onRequestPrevious
      : previous
        ? () => session.goToTask(previous.id, "click")
        : null}
    {@const chromeNext = embedded
      ? onRequestNext
      : next
        ? () => session.goToTask(next.id, "click")
        : null}
    {@const chromeOpenSource = task.url
      ? () => void localApi.openExternal(task.url!)
      : null}
    {@const chromeOpenList = onRequestClose ?? (() => session.openTasks("click"))}
    {#if stacked}
      <TaskRecordBar
        {task}
        {projectLabel}
        {upstream}
        syncing={syncing || refreshing}
        onSync={chromeSync}
        onPrevious={chromePrevious}
        onNext={chromeNext}
        onOpenSource={chromeOpenSource}
        onOpenPage={embedded ? onOpenRoute : undefined}
        onOpenList={chromeOpenList}
      />
    {:else}
      <TaskChromeBar
        {task}
        {projectLabel}
        projectRoot={projectCwd}
        serverId={taskServerId}
        {upstream}
        syncing={syncing || refreshing}
        onSync={chromeSync}
        onPrevious={chromePrevious}
        onNext={chromeNext}
        onOpenSource={chromeOpenSource}
        onMoveAcross={pane.inPane ? pane.moveAcross : undefined}
        isLeading={pane.isLeading}
        onOpenPage={embedded ? onOpenRoute : undefined}
        onOpenList={chromeOpenList}
        onClose={onRequestClose ?? (() => pane.close())}
      />
    {/if}

    <!-- The strip only exists where the column cannot. Above the rung the four
         sections are all on screen, so a control for choosing between them
         would be choosing between things you can already see. -->
    {#if stacked}
      <div class="shrink-0 border-b border-[var(--hairline)] px-[14px]">
        <TaskTabStrip {tab} counts={tabCounts} onSelect={(next) => (tab = next)} />
      </div>
    {/if}

    <div
      bind:this={scrollViewport}
      class="min-h-0 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:w-0"
    >
      {#if syncOps.length}
        <div class="mx-auto w-full max-w-[1420px] px-[52px] pt-4">
          <div
            class="flex items-center gap-2 rounded-md border-[.5px] border-[var(--hairline)] bg-[var(--wash-1)] px-3 py-2 text-xs text-muted-foreground"
            role="status"
          >
            <span
              class="size-1.5 shrink-0 rounded-full {failedSyncCount
                ? 'bg-red-500'
                : 'bg-amber-500'}"
              aria-hidden="true"
            ></span>
            {#if pendingSyncCount}
              <span
                >{pendingSyncCount} update{pendingSyncCount === 1 ? "" : "s"} from
                a dispatched session waiting to sync</span
              >
            {/if}
            {#if failedSyncCount}
              <span
                >{failedSyncCount} update{failedSyncCount === 1 ? "" : "s"} failed
                to sync</span
              >
            {/if}
          </div>
        </div>
      {/if}
      <div
        class="mx-auto flex w-full max-w-[1420px] items-start gap-[34px] px-[52px] pt-6 @max-[60rem]:px-6 @max-[42rem]:px-4"
      >
        <div class="flex min-w-0 flex-1 flex-col">
          <!-- Overview: the task itself, and the pull requests that close it.
               Every section below is wrapped rather than branched, so switching
               tabs hides a subtree instead of destroying it. -->
          <div class="flex flex-col" class:hidden={hiddenTab("overview")}>
            <TaskHeader
              {task}
              canEdit={capabilities?.canEditContent ?? false}
              onSaveTitle={(title) => save({ title })}
              onSaveBody={(body) => save({ body })}
              editableStatuses={capabilities?.editableStatuses ?? []}
              canEditPriority={capabilities?.canEditPriority ?? false}
              onSaveStatus={(status) => save({ status })}
              onSavePriority={(priority) => save({ priority })}
              identity={stacked ? identityRow : undefined}
            />

            {#if prRows.length}
              <TaskPrList
                rows={prRows}
                {stacked}
                onOpen={openLink}
                onOpenExternal={(url) => void localApi.openExternal(url)}
                onUnlink={removeLink}
                onAdd={() => (picking = true)}
              />
            {/if}
          </div>

          <div class="flex flex-col" class:hidden={hiddenTab("linked")}>
          <TaskLinkedTable
            {links}
            {stacked}
            onOpen={openLink}
            onUnlink={removeLink}
            onAdd={() => (picking = true)}
            upstreamProvider={(link) =>
              linkedWorkProvider(link, (workId) => session.worksStore.get(workId))}
            artifactHtml={(link) => session.worksStore.get(link.targetKey)?.content || null}
            onExpandArtifact={(link) =>
              void session.worksStore.ensureContent(link.targetKey, "task-artifact-preview", projectCwd)}
            previewsEnabled={surfaceVisible}
            onAttachArtifact={attachArtifact}
            attachLabel={upstream?.canSync ? `Send to ${upstream.provider}` : "Attach preview"}
          />
          </div>

          <div class="flex flex-col" class:hidden={hiddenTab("sessions")}>
            <TaskSessionsList
              {sessions}
              {stacked}
              taskTitle={task.title}
              onOpen={openSession}
              onOpenSplit={openSessionSplit}
              onStop={stopSession}
              onUnlink={unlinkSession}
              onNewSession={() => startSession(task)}
            />
          </div>

          <div class="flex flex-col" class:hidden={hiddenTab("activity")}>
            <TaskActivityFeed
              {stacked}
              comments={details?.comments ?? []}
              events={details?.events ?? []}
              {sessions}
              onOpenSession={(sessionId) => void openSession(sessionId)}
              provider={upstream?.canSync ? upstream.provider : null}
              onPublish={(commentId) => publishComments([commentId])}
              onDelete={deleteComment}
            />
          </div>

          <!-- The composer is outside the tabs on purpose: a comment is about
               the task, not about whichever section is on screen, and rule one
               of the redesign is that the input is always reachable. At the
               stacked rung it sticks to the foot of the scrollport and gains
               a new run on the right, which is the whole bottom bar.

               Properties sits on the left from the folded rung up, not the
               stacked one: that is the moment the rail leaves the column, and
               hiding a destination without building its replacement in the same
               breath is how it went missing for every pane between the two. -->
          {#if !stacked}
            {@render bottomBar(task)}
          {/if}
        </div>

        <!-- One definition, two homes: a column beside the content where there
             is room for one, and a sheet where there is not. Rendering it twice
             would be twenty props kept in step by hand. -->
        {#if !railFolded}
          {@render propertiesPanel("column")}
        {/if}
      </div>
    </div>

    <!-- Pinned, not sticky. `position: sticky` only holds a bar down once the
         content behind it is taller than the scrollport; a short task left the
         composer floating in the middle of the phone with dead space beneath
         it. Outside the scroll region it is the page's own foot at every
         length, which is what the spec draws. -->
    {#if stacked}
      <div class="shrink-0 px-4 pb-[max(0.5rem,env(safe-area-inset-bottom,0px))]">
        {@render bottomBar(task)}
      </div>
    {/if}
  {:else}
    <div
      class="flex flex-1 items-center justify-center text-muted-foreground"
    >
      {store.loaded ? "That task no longer exists." : "Loading…"}
    </div>
  {/if}
</div>

{#if picking}
  <TaskLinkPicker
    {projectCwd}
    onPick={addLink}
    onClose={() => (picking = false)}
  />
{/if}

<!-- The desktop sidebar, in order, as a sheet. It stops short of the top so the
     task behind it stays identifiable — this edits the task you are reading,
     and covering it entirely would leave nothing to say which one that is. -->
{#if railFolded && propertiesOpen}
  <BottomSheet label="Task properties" onClose={() => (propertiesOpen = false)}>
    {#snippet header()}
      <div class="flex items-center justify-between">
        <span class="text-workspace-chrome font-medium text-foreground">Properties</span>
        <button
          type="button"
          class="h-9 cursor-pointer rounded-lg border-0 bg-transparent px-2 font-medium text-[color-mix(in_oklch,var(--primary)_82%,var(--foreground))] [-webkit-tap-highlight-color:transparent] pointer-fine:[.is-laptop-display_&]:h-8"
          onclick={() => (propertiesOpen = false)}
        >
          Done
        </button>
      </div>
    {/snippet}
    {@render propertiesPanel("sheet")}
  </BottomSheet>
{/if}
