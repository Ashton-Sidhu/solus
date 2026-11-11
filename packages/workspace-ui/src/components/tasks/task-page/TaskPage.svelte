<script lang="ts">
  import { projectDirLabel } from "../../../lib/paths";
  import { tick, untrack } from "svelte";
  import {
    getClientShellContext,
    getSurfaceContext,
    getPullRequestsContext,
    taskSourcesStore,
    groupKeyFor,
  } from "../../../contexts";
  import { localApi } from "@solus/client-core/local-api";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { LOCAL_SERVER_ID } from "@solus/client-core/server-registry";
  import { setMarkdownImageContext } from "../../conversation/lib/markdown-image";
  import {
    useKeybinding,
    useScope,
  } from "../../../lib/keybindings/use-keybinding.svelte";
  import { paneActions } from "../../ui/lib/pane-actions.svelte";
  import type { RouteSurfaceProps } from "../../ui/lib/pane-surface";
  import {
    DEFAULT_TASK_SORT,
    PROVIDER_NAMES,
    sortTasks,
    taskPlacementLabels,
    taskRef,
  } from "../lib/tasks-api";
  import {
    isTaskRailFolded,
    taskDetailsSummary,
    taskFieldLocks,
    linkedWorkProvider,
  } from "./lib/task-page";
  import { taskMoveGroups } from "./lib/task-move";
  import { createTaskPageCommands, toastTaskError } from "./lib/task-page-commands";
  import { taskPrRows } from "./lib/task-prs";
  import { presenceStore } from "../../../contexts/presence/presence.store.svelte";
  import TaskActivityFeed from "./TaskActivityFeed.svelte";
  import TaskBottomBar from "./TaskBottomBar.svelte";
  import TaskPrList from "./TaskPrList.svelte";
  import TaskChromeBar from "./TaskChromeBar.svelte";
  import TaskRecordBar from "./TaskRecordBar.svelte";
  import TaskDetailsTrigger from "./TaskDetailsTrigger.svelte";
  import TaskHeader from "./TaskHeader.svelte";
  import TaskLinkPicker from "./TaskLinkPicker.svelte";
  import TaskLinkedTable from "./TaskLinkedTable.svelte";
  import TaskPinnedArtifact from "./TaskPinnedArtifact.svelte";
  import TaskPageNotices from "./TaskPageNotices.svelte";
  import TaskPageSkeleton from "./TaskPageSkeleton.svelte";
  import ContentSkeleton from "../../ui/ContentSkeleton.svelte";
  import TaskSessionsList from "./TaskSessionsList.svelte";
  import TaskSidebar from "./TaskSidebar.svelte";
  import TaskTabStrip from "./TaskTabStrip.svelte";
  import type { TaskTabId } from "./lib/task-tabs";
  import { isStackedPane, observePaneWidth } from "../../../lib/pane-width";

  interface Props extends Omit<RouteSurfaceProps<"task">, "paneId"> {
    paneId?: RouteSurfaceProps<"task">["paneId"];
    embedded?: boolean;
    onRequestClose?: () => void;
    onRequestPrevious?: (() => void) | null;
    onRequestNext?: (() => void) | null;
    onOpenRoute?: () => void;
    onOpenSession?: (sessionId: string) => void;
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
    onOpenSession,
  }: Props = $props();

  const session = getSurfaceContext();
  const pullRequests = getPullRequestsContext();
  const shell = getClientShellContext();
  const store = session.tasksStore;
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
  const task = $derived(store.peek(taskId));
  const details = $derived(store.get(taskId).details);
  const links = $derived(details?.links ?? []);
  const linkedWorkIds = $derived(
    links.filter((link) => link.kind === "work").map((link) => link.targetKey),
  );
  /** The artifact this task opens with, when the reader pinned one. `work` is
   *  the only kind that can carry it, and only an artifact work has a render. */
  const pinnedArtifact = $derived(
    links.find(
      (link) => link.kind === "work" && link.pinned === true && link.liveStatus === "artifact",
    ) ?? null,
  );
  const sessions = $derived(store.get(taskId).sessions);
  // Title repair is housekeeping: it waits for the page's own detail read, so
  // its calls never queue ahead of what the reader opened the page to see.
  $effect(() => {
    if (surfaceVisible && detailsSettled && sessions.length) void store.repairWorkerTitles(taskId, sessions);
  });

  // A task has no project of its own: the task sources of a project list it.
  // The page works in the first project that lists the task, in a checkout of
  // that project on a connected host.
  const taskServerId = $derived(store.get(taskId).serverId);
  const listingProjectKey = $derived(task ? (store.projectKeysOf(task)[0] ?? null) : null);
  const projectCwd = $derived.by(() => {
    if (task && listingProjectKey) {
      for (const placement of task.placements) {
        const checkout = taskSourcesStore.checkoutForSource(listingProjectKey, placement.sourceKey);
        if (checkout) return checkout.cwd;
      }
    }
    return session.tasksProjectCwd ?? undefined;
  });
  const taskProjectKey = $derived(
    listingProjectKey ??
      (projectCwd && taskServerId ? groupKeyFor(taskServerId, projectCwd) : null),
  );
  const projectLabel = $derived(projectCwd ? projectDirLabel(projectCwd) : null);

  // The pinned render is open by default, so its body is fetched as soon as the
  // page is visible rather than on a disclosure the reader never has to press.
  $effect(() => {
    const link = pinnedArtifact;
    if (!link || !surfaceVisible) return;
    void session.worksStore.ensureContent(link.targetKey, "task-pinned-artifact");
  });

  setMarkdownImageContext({
    cwd: () => projectCwd,
    serverId: () => taskServerId ?? LOCAL_SERVER_ID,
    ctx: () => projectCwd ? session.ctxForDirectory(projectCwd) : undefined,
    api: () => taskServerId ? serverConnections.apiFor(taskServerId) : undefined,
  });

  const commands = createTaskPageCommands({
    session,
    shell,
    taskId: () => taskId,
    projectCwd: () => projectCwd,
    onOpenSession: () => onOpenSession,
    onClose: () => (onRequestClose ? onRequestClose() : pane.close()),
  });

  // The PR store owns linked identity, saved observations and background reads.
  const prs = pullRequests.projects;
  // A session of a task runs on a machine. A client with no workspace (a guest
  // shell) has none to start from.
  const canStartSession = $derived(!!session.workspace);
  $effect(() => {
    const workIds = linkedWorkIds;
    if (!surfaceVisible || workIds.length === 0) return;
    // The link table carries identity and title, not Folio mirror metadata.
    // Refresh only when the page has linked works; listWorks returns metadata
    // without shipping every document body across a remote connection.
    void session.worksStore.loadAll();
  });
  // Each link owns its repository; PR numbers are not unique across links.
  const prRows = $derived(
    taskPrRows(
      links,
      (link) => prs.linkedPr(taskServerId, link, projectCwd ?? null),
    ),
  );
  $effect(() => {
    const serverId = taskServerId;
    const linked = [...links, ...store.get(taskId).prLinks];
    const root = projectCwd;
    if (!serverId || !surfaceVisible) return;
    return untrack(() => prs.wantLinkedPrs(
      serverConnections.apiFor(serverId), serverId,
      session.ctxForEnvironment(root ?? "~", null), linked,
    ));
  });

  // The provider decides which fields this task takes, and each source that
  // lists the task owns the columns it can move to.
  const locks = $derived(task ? taskFieldLocks(task) : null);
  const placements = $derived(task ? taskPlacementLabels(task, taskSourcesStore.sourceByKey) : []);
  const moveGroups = $derived(task ? taskMoveGroups(task, taskSourcesStore.sourceByKey) : []);
  const assigneeTarget = $derived({ taskId });
  const labelCandidates = $derived(store.knownLabels(taskServerId, projectCwd));

  let picking = $state(false);
  let refreshing = $state(false);
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
      // The columns of the move menu come with the task sources. A page opened
      // from a link can be the first surface that needs them.
      if (untrack(() => taskSourcesStore.sourceByKey.size === 0)) {
        void taskSourcesStore.load().catch(() => {});
      }
      void store
        .get(id)
        .loadDetails()
        .catch((err) => toastTaskError("open task", err))
        .finally(() => {
          if (loadingTaskId === id) loadingTaskId = null;
        });
    }
    return stopWatching;
  });
  const detailsSettled = $derived(loadedId === taskId && loadingTaskId !== taskId);

  // ── Prev/next follow the Tasks page's own ordering, so "next" is the row the
  // user actually saw underneath this one. ──
  const siblings = $derived(
    sortTasks(
      listingProjectKey ? store.tasksInProject(listingProjectKey) : [],
      DEFAULT_TASK_SORT,
    ),
  );
  const position = $derived(siblings.findIndex((t) => t.id === taskId));
  const previous = $derived(position > 0 ? siblings[position - 1] : null);
  const next = $derived(
    position >= 0 && position < siblings.length - 1
      ? siblings[position + 1]
      : null,
  );

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      await commands.refresh();
    } finally {
      refreshing = false;
    }
  }

  async function comment(body: string) {
    await commands.comment(body);
    await tick();
    scrollViewport?.scrollTo({ top: scrollViewport.scrollHeight });
  }

  function openAssigneeMenu(): void {
    // The menu shows the error of a failed read.
    void store.loadAssigneeCandidates(assigneeTarget).catch(() => {});
  }

  // ── The stacked rung ──
  // Wide, the four sections scroll past each other in one column and the
  // sidebar sits beside them. Below 30rem neither is possible: the sidebar has
  // no column to be, and a long Activity feed would push the composer off the
  // bottom. So the sections become a strip, the sidebar opens under the title,
  // and the composer is pinned.
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
  // the pane is narrow enough for one section at a time, a record bar, a pinned
  // composer. This asks only whether the rail still has a column to sit in,
  // which it loses at 72rem, long before the page stacks. Between the two the
  // rail used to fold under the content and land beneath the comment composer,
  // past everything.
  const railFolded = $derived(isTaskRailFolded(paneWidth));

  let tab = $state<TaskTabId>("overview");
  let detailsOpen = $state(false);
  let detailsTriggerRef = $state<TaskDetailsTrigger | null>(null);
  // Where the rail folds, its fields open in place under the title, inside
  // this pane.
  const detailsSummary = $derived(task ? taskDetailsSummary(task) : null);
  const tabCounts = $derived({
    linked: links.length + prRows.length,
    sessions: sessions.length,
    activity: (details?.comments?.length ?? 0) + (details?.activity?.length ?? 0),
  });

  /** Sections are hidden, never unmounted: a tab that unmounts loses its
   *  expanded threads and re-fetches its artifact previews on every switch. */
  const hiddenTab = (id: TaskTabId) => stacked && tab !== id;

  // Wait for the measured layout before mounting a hidden Activity tab. Once
  // opened, keep its expanded comments and artifact state across tab switches.
  let activityMountedFor = $state<string | null>(null);
  const activityVisible = $derived(surfaceVisible && paneWidth > 0 && !hiddenTab("activity"));
  $effect(() => {
    if (activityVisible) activityMountedFor = taskId;
  });

  // The picker reads a machine's docs, plans, automations and PRs through the
  // workspace index; the console has none to pick from.
  const openPicker = session.workspace ? () => (picking = true) : null;

  // Shares the Tasks scope: `task` and `tasks` are one exclusive page group, so
  // only ever one of them is mounted and Escape means the same thing in both.
  useScope("tasks", { active: () => !embedded });
  useKeybinding("tasks.close", () => pane.close(), {
    enabled: () => !embedded,
  });
</script>

{#snippet detailsTrigger()}
  {#if detailsSummary}
    <TaskDetailsTrigger
      bind:this={detailsTriggerRef}
      summary={detailsSummary}
      assigneeAvatarUrl={task?.assigneeAvatarUrl}
      open={detailsOpen}
      controls="task-details-panel"
      onToggle={() => (detailsOpen = !detailsOpen)}
    />
  {/if}
{/snippet}

{#snippet detailsPanel()}
  {#if detailsOpen}
    <!-- Open, the rail's fields sit between the title and the description.
         Escape closes them and hands focus back to Details, before the page's
         own Escape can close the task. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      id="task-details-panel"
      class="pt-3"
      onkeydown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        detailsOpen = false;
        detailsTriggerRef?.focus();
      }}
    >
      {@render propertiesPanel("panel")}
    </div>
  {/if}
{/snippet}

{#snippet bottomBar()}
  {#if task}
    <TaskBottomBar
      {stacked}
      {tab}
      providerName={PROVIDER_NAMES[task.providerId]}
      taskRef={taskRef(task)}
      onComment={comment}
      onStartSession={canStartSession ? commands.startSession : null}
      onOpenPicker={openPicker}
    />
  {/if}
{/snippet}

{#snippet propertiesPanel(variant: "column" | "panel")}
  {#if task && locks}
    <TaskSidebar
      {task}
      {variant}
      {projectLabel}
      projectKey={taskProjectKey}
      {locks}
      {placements}
      {moveGroups}
      {labelCandidates}
      assigneeCandidates={store.assigneeCandidates(assigneeTarget)}
      assigneeCandidatesLoading={store.assigneeCandidatesLoading(assigneeTarget)}
      assigneeCandidatesError={store.assigneeCandidatesError(assigneeTarget)}
      onMove={(target) => void commands.move(target)}
      onSave={commands.save}
      onOpenExternal={(url) => void localApi.openExternal(url)}
      onOpenAssigneeMenu={openAssigneeMenu}
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
  <!-- The sidebar row already holds the record, so the page draws at once;
       only the detail read (links, comments, activity) is still in flight. -->
  {#if !task && (taskId !== loadedId || loadingTaskId === taskId || !store.loaded)}
    <TaskPageSkeleton />
  {:else if task && locks}
    <!-- Two heads, one set of decisions. The wide bar and the record bar take
         the same handlers; what differs is how much of the page's chrome each
         has room to state, which is why they are two components rather than one
         with a rung's worth of hidden branches inside it. -->
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
    <!-- The provider link is the task's only address. A draft has none. -->
    {@const chromeCopyLink = task.url ? () => void commands.copyLink() : null}
    <!-- Only a draft can be deleted. An issue is closed or moved on its provider. -->
    {@const chromeDelete = task.canDelete ? commands.deleteDraft : null}
    {#if stacked}
      <TaskRecordBar
        {task}
        {projectLabel}
        {refreshing}
        onRefresh={() => void refresh()}
        onPrevious={chromePrevious}
        onNext={chromeNext}
        onOpenSource={chromeOpenSource}
        onOpenPage={embedded ? onOpenRoute : undefined}
        onCopyLink={chromeCopyLink}
        onDelete={chromeDelete}
        onOpenList={chromeOpenList}
      />
    {:else}
      <TaskChromeBar
        {task}
        {refreshing}
        onRefresh={() => void refresh()}
        onPrevious={chromePrevious}
        onNext={chromeNext}
        onOpenSource={chromeOpenSource}
        onOpenPage={embedded ? onOpenRoute : undefined}
        onCopyLink={chromeCopyLink}
        onDelete={chromeDelete}
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
      <TaskPageNotices
        fromCache={details?.fromCache === true}
        {refreshing}
        onRefresh={() => void refresh()}
        pendingSyncCount={syncOps.length - failedSyncCount}
        {failedSyncCount}
      />
      <div
        class="mx-auto flex w-full max-w-[1420px] items-start gap-[34px] px-[52px] pt-3 @max-[60rem]:px-6 @max-[42rem]:px-4"
      >
        <div class="flex min-w-0 flex-1 flex-col">
          <!-- Overview: the task itself, and the pull requests that close it.
               Every section below is wrapped rather than branched, so switching
               tabs hides a subtree instead of destroying it. -->
          <div class="flex flex-col" class:hidden={hiddenTab("overview")}>
            <TaskHeader
              {task}
              {locks}
              onSaveTitle={(title) => commands.save({ title })}
              onSaveBody={(body) => commands.save({ body })}
              {moveGroups}
              onMove={(target) => void commands.move(target)}
              onSavePriority={(priority) => void commands.save({ priority })}
              detailsTrigger={railFolded ? detailsTrigger : undefined}
              detailsPanel={railFolded ? detailsPanel : undefined}
            />

            {#if prRows.length}
              <TaskPrList
                rows={prRows}
                {stacked}
                onOpen={commands.openLink}
                onOpenExternal={(url) => void localApi.openExternal(url)}
                onUnlink={commands.removeLink}
                onAdd={openPicker}
              />
            {/if}
          </div>

          <!-- Links, comments and activity come from the detail read. Until it
               lands the page draws one placeholder in their place rather than
               empty sections, and they arrive together with the composer below
               them, so nothing already on screen is pushed down. A failed read
               ends the wait and shows the sections as they are. -->
          {#if details || detailsSettled}
          <div class="flex flex-col" class:hidden={hiddenTab("linked")}>
          {#if pinnedArtifact}
            <TaskPinnedArtifact
              link={pinnedArtifact}
              html={session.worksStore.savedWork(pinnedArtifact.targetKey)?.content || null}
              enabled={surfaceVisible}
              onOpen={commands.openLink}
              onUnpin={(link) => void commands.pinArtifact(link, false)}
            />
          {/if}
          <TaskLinkedTable
            {links}
            {stacked}
            onOpen={commands.openLink}
            onUnlink={commands.removeLink}
            onAdd={openPicker}
            upstreamProvider={(link) =>
              linkedWorkProvider(link, (workId) => session.worksStore.get(workId))}
            artifactHtml={(link) => session.worksStore.savedWork(link.targetKey)?.content || null}
            onExpandArtifact={(link) =>
              void session.worksStore.ensureContent(link.targetKey, "task-artifact-preview")}
            previewsEnabled={surfaceVisible}
            onAttachArtifact={commands.attachArtifact}
            attachLabel={`Send to ${PROVIDER_NAMES[task.providerId]}`}
            onPin={(link, pinned) => void commands.pinArtifact(link, pinned)}
          />
          </div>

          <div class="flex flex-col" class:hidden={hiddenTab("sessions")}>
            <TaskSessionsList
              {sessions}
              {stacked}
              taskTitle={task.title}
              onOpen={commands.openSession}
              onOpenSplit={shell.hasCompanionPanes ? commands.openSessionSplit : null}
              onStop={commands.stopSession}
              onUnlink={commands.unlinkSession}
              onNewSession={canStartSession ? commands.startSession : null}
            />
          </div>

          <div class="flex flex-col" class:hidden={hiddenTab("activity")}>
            {#if activityVisible || activityMountedFor === taskId}
              {#key taskId}
              <TaskActivityFeed
                {stacked}
                comments={details?.comments ?? []}
                activity={details?.activity ?? []}
                {links}
                enabled={surfaceVisible && !hiddenTab("activity")}
                {sessions}
                onOpenSession={(sessionId) => void commands.openSession(sessionId)}
                currentUserId={taskServerId ? presenceStore.currentUserId(taskServerId) : null}
                providerName={PROVIDER_NAMES[task.providerId]}
                onRetry={commands.retryComment}
                onDiscard={commands.discardComment}
              />
              {/key}
            {/if}
          </div>

          <!-- The composer is outside the tabs on purpose: a comment is about
               the task, not about whichever section is on screen, and rule one
               of the redesign is that the input is always reachable. At the
               stacked rung it sticks to the foot of the scrollport and gains
               a new run on the right, which is the whole bottom bar.

               Where the rail folds, its fields are reached from Details at the
               end of the status line, not from a button beside the composer. -->
          {#if !stacked}
            {@render bottomBar()}
          {/if}
          {:else}
            <ContentSkeleton label="Loading task details" />
          {/if}
        </div>

        <!-- One definition, two homes: a column beside the content where there
             is room for one, and a panel under the title where there is not. Rendering it twice
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
        {@render bottomBar()}
      </div>
    {/if}
  {:else if !store.loaded}
    <TaskPageSkeleton />
  {:else}
    <div class="flex flex-1 items-center justify-center text-muted-foreground">
      Solus cannot find this task on a connected host.
    </div>
  {/if}
</div>

{#if picking && session.workspace}
  <TaskLinkPicker
    {projectCwd}
    onPick={commands.addLink}
    onClose={() => (picking = false)}
  />
{/if}
