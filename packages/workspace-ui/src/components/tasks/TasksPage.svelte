<script lang="ts">
  import TaskIcon from "../ui/TaskIcon.svelte";
  import { localApi } from "@solus/client-core/local-api";
  import { tick, untrack } from "svelte";
  import { fly } from "svelte/transition";
  import {
    RotateCw as ArrowClockwiseIcon,
    CalendarX as CalendarXIcon,
    Moon as MoonIcon,
    Plus as PlusIcon,
    Activity as PulseIcon,
    CircleAlert as WarningCircleIcon,
    CircleDashed as CircleDashedIcon,
  } from "@lucide/svelte";
  import { TASKS_AUTH_ERROR_PREFIX, type TaskCreateInput, type TaskMoveTarget } from "@solus/contracts/task-types";
  import type { Task } from "../../contexts/tasks/task.svelte";
  import TaskSourceAdd from "./sources/TaskSourceAdd.svelte";
  import TaskSourceStrip from "./TaskSourceStrip.svelte";
  import TasksBulkBar from "./TasksBulkBar.svelte";
  import {
    getClientShellContext,
    getSurfaceContext,
    getSessionSidebarStore,
    taskSourcesStore,
    runtime,
    serversStore,
  } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import {
    useKeybinding,
    useScope,
  } from "../../lib/keybindings/use-keybinding.svelte";
  import { comboHint } from "../../lib/keybindings/manifest";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { TASK_SORT_OPTIONS, boardColumnIdOf, moveTargetFor } from "./lib/tasks-api";
  import { isOpenColumnFilter, nextTaskWake } from "./lib/tasks-list-view";
  import { TasksPageView } from "./tasks-page-view.svelte";
  import { tasksOfSources } from "./lib/tasks-page";
  import { inferTaskSourceKey, taskSourceKey } from "@solus/contracts/task-sources";
  import { loadLastTaskSource, saveLastTaskSource } from "./lib/task-composer";
  import { ProviderTaskSearch } from "./lib/provider-search.svelte";
  import { PAGE_PRIMARY_BTN, PAGE_SECONDARY_BTN } from "../../lib/page-chrome";
  import {
    ListEmpty,
    ListFilterBar,
    ListPage,
    ListSelection,
    ListFilterGroup,
    ListSortMenu,
    ListSkeleton,
    type ListFilterSpec,
  } from "../ui/list-page";
  import { isStackedPane } from "../../lib/pane-width";
  import PageEmpty from "../ui/PageEmpty.svelte";
  import TaskComposer from "./TaskComposer.svelte";
  import TasksList from "./TasksList.svelte";
  import TaskLayoutToggle from "./TaskLayoutToggle.svelte";
  import TaskBoard from "./TaskBoard.svelte";
  import TaskBoardSkeleton from "./TaskBoardSkeleton.svelte";
  import TaskPage from "./task-page/TaskPage.svelte";
  import TaskContextMenu from "../session/TaskContextMenu.svelte";
  import { paneActions } from "../ui/lib/pane-actions.svelte";
  import type { InlinePageProps } from "../ui/lib/pane-surface";

  let { paneId }: InlinePageProps = $props();

  const session = getSurfaceContext();
  // The board is mounted by the workspace and by the cloud console alike
  // (docs/plans/cloud-console-native-pages.md §9). Starting a session from a
  // row, marking a task unread, and the page's close need a workspace.
  const workspace = session.workspace;
  /** A task held anywhere but this machine names its host on its row and card:
   *  "Solus Cloud" for the workspace service, the host's own name otherwise. */
  function homeFor(taskId: string): string | null {
    const serverId = session.tasksStore.get(taskId).serverId;
    const host = serversStore.hostFor(serverId);
    return serversStore.cloudHomeLabel(serverId) ?? (host && !host.local ? host.label : null);
  }
  const pane = paneActions(() => paneId);
  const store = session.tasksStore;
  const sessionSidebar = workspace ? getSessionSidebarStore() : null;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // A console page is open for as long as it is mounted.
  const open = $derived(workspace?.router.at("tasks") ?? true);

  // ── Tasks and their sources ──
  // Tasks belong to no project (docs/tasks.md). The page shows every task of
  // the person's task sources, which are a personal setting, and the task host
  // reads them.
  const configured = $derived(session.settings.taskSources);
  // The host's last answer can still name a source the person just removed,
  // and it holds that source's tasks until its next read: the settings decide.
  const configuredKeys = $derived(new Set(configured.map(taskSourceKey)));
  const tasks = $derived(tasksOfSources(store.tasks, configuredKeys));
  const sources = $derived(taskSourcesStore.sources.filter((source) => configuredKeys.has(source.sourceKey)));
  const sourcesError = $derived(taskSourcesStore.error);
  const hasNoSource = $derived(configured.length === 0);
  // The person has sources, but no connected machine runs agents, so no
  // machine can read GitHub or Jira.
  const hasNoHost = $derived(!hasNoSource && taskSourcesStore.host === null);

  // A new task is created on the provider, in one of the person's sources.
  const canCreate = $derived(sources.length > 0);

  // ── List-view multi-select ──
  const selection = new ListSelection();
  // The composer: open for a new task, with the column it was opened from on a
  // board. Null = closed.
  let composing = $state<{ columnId?: string } | null>(null);

  // Tick the clock so relative row times ("12m") age instead of freezing at the
  // moment the list loaded.
  let now = $state(Date.now());
  $effect(() => {
    if (!open) return;
    const interval = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(interval);
  });
  // Bring a snoozed task back the moment it wakes, not on the next 30s tick.
  $effect(() => {
    if (!open) return;
    const wake = nextTaskWake(tasks, now);
    if (wake === null) return;
    const timeout = setTimeout(() => (now = Date.now()), Math.max(1, wake - Date.now()));
    return () => clearTimeout(timeout);
  });

  // Running, not linked: a link outlives the agent that worked on it.
  function runningSessionsFor(taskId: string): number {
    const task = store.get(taskId);
    return task.sessions.filter((link) =>
      store.isAttemptRunning(link, task.serverId, (sessionId, serverId) =>
        session.sessionForHostSession(sessionId, serverId),
      ),
    ).length;
  }

  // ── View state ──
  // Which source is on screen, the search, the filters and the sort, and the
  // rows and columns that follow from them.
  const providerSearch = new ProviderTaskSearch(store);
  const view = new TasksPageView({
    tasks: () => tasks,
    sources: () => sources,
    now: () => now,
    runningSessionsFor,
    homeFor,
    providerSearch,
  });
  // A truncated source did not list every task, so filtering what is loaded
  // answers "of the tasks the host read" while looking like it answered "in
  // the source". The search text then goes to the provider too.
  $effect(() => {
    const searches = open && view.truncated;
    const text = view.query;
    untrack(() => {
      if (searches) providerSearch.request(text);
      else providerSearch.clear();
    });
  });

  // There is no default source. On a source's own board a new task goes to
  // that source; else to the source of the person's last new task on this
  // device, or to their only source (`inferTaskSourceKey`). Read when the
  // composer opens, so the last choice is the one it offers.
  function newTaskSourceKey(): string | undefined {
    if (view.source) return view.source.sourceKey;
    const sourceKeys = sources.map((source) => source.sourceKey);
    return inferTaskSourceKey(sourceKeys, { lastSourceKey: loadLastTaskSource() }) ?? undefined;
  }

  let searchEl = $state<HTMLInputElement | null>(null);
  let listEl = $state<HTMLDivElement | null>(null);
  let contentHeight = $state(0);
  let pageWidth = $state(0);
  let selectedKey = $state<string | null>(null);
  let openTaskId = $state<string | null>(null);
  let taskContextMenu = $state<{
    task: Task;
    x: number;
    y: number;
  } | null>(null);

  /** Clears what the Filters badge counts. The search stays. */
  function clearMenuFilters() {
    view.clearMenuFilters();
  }

  const refreshing = $derived(store.loading || taskSourcesStore.refreshing);
  const loadingTasks = $derived(
    (!store.loaded && store.loading) || (!hasNoSource && taskSourcesStore.host === undefined) || (refreshing && tasks.length === 0 && !hasNoSource),
  );
  const displayError = $derived(
    (store.error ?? sourcesError)?.replace(TASKS_AUTH_ERROR_PREFIX, "") ?? null,
  );

  const filters = $derived<ListFilterSpec[]>([
    {
      key: "running",
      label: "Agent running",
      icon: PulseIcon,
      count: view.filterCounts.running,
      active: view.runningOnly,
      toggle: () => (view.runningOnly = !view.runningOnly),
    },
    {
      key: "overdue",
      label: "Overdue",
      icon: CalendarXIcon,
      count: view.filterCounts.overdue,
      active: view.overdueOnly,
      toggle: () => (view.overdueOnly = !view.overdueOnly),
    },
    {
      key: "assigned",
      label: "Assigned",
      icon: TaskIcon,
      count: view.filterCounts.assigned,
      active: view.assignedOnly,
      toggle: () => (view.assignedOnly = !view.assignedOnly),
    },
    {
      key: "snoozed",
      label: "Snoozed",
      icon: MoonIcon,
      count: view.filterCounts.snoozed,
      active: view.snoozedOnly,
      toggle: () => (view.snoozedOnly = !view.snoozedOnly),
    },
  ]);

  $effect(() => {
    selection.setOrder(view.flatVisibleIds);
  });

  // Through the store, not the listed tasks: a row can be a task that only
  // the provider's search found.
  function taskById(id: string): Task | undefined {
    return store.peek(id) ?? undefined;
  }

  const openTask = $derived(openTaskId ? (taskById(openTaskId) ?? null) : null);
  const panelOpen = $derived(openTask !== null);
  const roomForSplit = $derived(pageWidth >= 1040);
  // The record rung, for the one decision a container query cannot make: the
  // virtualiser is told a row's height as a number. Same 30rem the stylesheet
  // uses, so the layout and the positions cannot disagree.
  const recordRows = $derived(isStackedPane(pageWidth));
  const boardPanel = $derived(panelOpen && view.boardLayout);
  const splitList = $derived(panelOpen && roomForSplit && !boardPanel);

  function closePanel() {
    openTaskId = null;
    void tick().then(() => {
      const selectedRow = listEl?.querySelector<HTMLElement>(
        '[data-selected="true"]',
      );
      if (selectedRow) selectedRow.focus();
      else searchEl?.focus();
    });
  }

  function stepPanel(delta: number) {
    if (!openTaskId || view.flatVisibleIds.length === 0) return;
    const index = view.flatVisibleIds.indexOf(openTaskId);
    if (index === -1) return;
    const nextId =
      view.flatVisibleIds[
        (index + delta + view.flatVisibleIds.length) % view.flatVisibleIds.length
      ];
    if (!nextId) return;
    selectedKey = nextId;
    openTaskId = nextId;
  }

  // New task opens the composer: a task is created on the provider, so it
  // needs a title and a source first.
  function startNewTask(columnId?: string) {
    if (!canCreate) return;
    composing = { columnId };
  }

  // New task from the command palette or the global shortcut
  // (`composeNewTask`): open the composer when the sources are read. A person
  // with no source gets no composer; the page then shows the source setup,
  // which is the step that is missing.
  $effect(() => {
    if (!open || !workspace?.taskComposerRequested) return;
    if (!hasNoSource && taskSourcesStore.host === undefined) return;
    workspace.taskComposerRequested = false;
    if (canCreate) composing = {};
  });

  // ── Data loading ──
  // The tasks come with each host's snapshot; the task host reads the sources.
  $effect(() => {
    if (!open) return;
    // The reads start from this effect, but their own state is not what it
    // waits on: only the page being open starts a read.
    untrack(() => {
      void store.load();
      void taskSourcesStore.load();
    });
  });

  $effect(() => {
    if (open) {
      view.clearFilters();
      composing = null;
      if (!runtime.shouldSuppressFocus) {
        void tick().then(() => searchEl?.focus());
      }
    }
  });

  useScope("tasks", { active: () => open });
  useKeybinding(
    "tasks.close",
    () => {
      // Esc backs out one layer at a time: a held selection, then an active
      // search, and only then the panel itself.
      if (panelOpen) closePanel();
      else if (selection.size > 0) selection.clear();
      else if (view.query) {
        view.query = "";
        searchEl?.focus();
      } else close();
    },
    { enabled: () => open },
  );
  // The global binding, taken over while this page is up: the composer opens
  // here, over the list.
  useKeybinding("global.new-task", () => startNewTask(), {
    enabled: () => open && canCreate,
  });
  function close() {
    workspace?.router.close("tasks");
    requestInputFocus();
  }

  // A person's refresh: the task host reads the sources from the provider
  // again, and says when the read ends.
  // The repair of a connection failure: the connections page of the task host,
  // where GitHub and Atlassian are connected.
  const shell = getClientShellContext();
  function openConnections() {
    const serverId = taskSourcesStore.host;
    if (serverId) shell.openResource({ kind: "connections", serverId });
  }

  // While tasks show, a source that cannot be read is said in a toast, as the
  // pull request list does: the rows stay. One failure is said one time; a
  // source that fails in a new way is said again.
  let toastedFailureKey: string | null = null;
  $effect(() => {
    const failure = view.failure;
    const hasTasks = tasks.length > 0;
    if (!failure) {
      toastedFailureKey = null;
      return;
    }
    if (!hasTasks || failure.key === toastedFailureKey) return;
    toastedFailureKey = failure.key;
    untrack(() =>
      toasts.error(failure.title.replace(/\.$/, ""), {
        description: failure.detail,
        action: failure.kind === "generic"
          ? { label: "Retry", onAction: refresh }
          : { label: failure.kind === "github-auth" ? "Connect GitHub" : "Connect Atlassian", onAction: openConnections },
      }),
    );
  });

  function refresh() {
    if (refreshing) return;
    void store.load();
    void taskSourcesStore.load({ refresh: "force" });
  }

  function selectViewSource(sourceKey: string | null) {
    view.showSource(sourceKey);
    selection.clear();
  }

  // A row opens its task page over the list.
  function onOpen(task: Task) {
    selectedKey = task.id;
    openTaskId = task.id;
  }

  async function onStart(task: Task) {
    if (!workspace) return;
    try {
      await workspace.opening.openTaskSession(task);
    } catch (error) {
      toastTaskError("start task", error);
    }
  }

  function onResume(task: Task) {
    void workspace?.opening.openTaskLinkedSession(task);
  }

  function openTaskRoute(task: Task) {
    openTaskId = null;
    session.goToTask(task.id, "click");
  }

  function onOpenLink(task: Task) {
    if (task.url) void localApi.openExternal(task.url);
  }

  function openTaskContextMenu(event: MouseEvent, task: Task) {
    event.preventDefault();
    event.stopPropagation();
    selectedKey = task.id;
    taskContextMenu = { task, x: event.clientX, y: event.clientY };
  }

  function toastTaskError(action: string, err: Parameters<typeof String>[0]) {
    const message = err instanceof Error ? err.message : String(err);
    toasts.error(`Couldn't ${action}`, { description: message });
  }

  // The move goes to the provider. A refused move shows its error, and the
  // task goes back to where it was.
  async function onMoveTask(task: Task, target: TaskMoveTarget) {
    try {
      await task.move(target);
    } catch (err) {
      toastTaskError("move the task", err);
    }
  }

  function moveToColumn(task: Task, columnId: string) {
    const target = moveTargetFor(view.board, columnId);
    if (target && boardColumnIdOf(task, view.board) !== columnId) void onMoveTask(task, target);
  }

  /** Only a draft item of a GitHub Project can be deleted. An issue is closed
   *  or moved on its provider. */
  function deleteTasks(ids: string[], label: string) {
    const tasks = ids.map((id) => taskById(id)).filter((task): task is Task => !!task);
    const draftIds = tasks.filter((task) => task.canDelete).map((task) => task.id);
    const issueCount = tasks.length - draftIds.length;
    if (issueCount) {
      toasts.error(`Couldn't delete ${issueCount} task${issueCount === 1 ? "" : "s"}`, {
        description: "Only a draft item can be deleted. Close an issue on its provider, or move it to a done column.",
      });
    }
    const pending = store.softRemove(draftIds);
    if (!pending.length) return;
    toasts.undo(label, () => store.restorePending(pending), {
      // commitPending restores any rows whose delete failed; surface why.
      onDismiss: () =>
        store
          .commitPending(pending)
          .catch((err) => toastTaskError("delete the draft item", err)),
    });
  }

  function onDelete(task: Task) {
    deleteTasks([task.id], "Draft item deleted");
  }

  // ── Bulk actions over the current selection ──
  const selectedTasks = $derived(
    [...selection.ids].map((id) => taskById(id)).filter((task): task is Task => !!task),
  );

  function bulkMove(columnId: string) {
    const tasks = selectedTasks;
    selection.clear();
    for (const task of tasks) moveToColumn(task, columnId);
  }

  function bulkDelete() {
    const ids = selectedTasks.filter((task) => task.canDelete).map((task) => task.id);
    selection.clear();
    deleteTasks(ids, `${ids.length} draft item${ids.length === 1 ? "" : "s"} deleted`);
  }

  async function bulkComplete() {
    const tasks = selectedTasks;
    selection.clear();
    for (const task of tasks) {
      try {
        await task.move({ category: "done" });
      } catch (error) {
        toastTaskError(`complete “${task.title}”`, error);
        break;
      }
    }
  }

  async function bulkMarkUnread() {
    const tasks = selectedTasks;
    selection.clear();
    for (const task of tasks) {
      try {
        await task.markRead(false);
      } catch (error) {
        toastTaskError(`mark “${task.title}” unread`, error);
        break;
      }
    }
  }

  // The board is a single-selection surface. Both list views share this one
  // selection store and the same bulk-action bar.
  $effect(() => {
    if (view.boardLayout || !open) selection.clear();
  });

  // ── Keyboard nav over the rendered rows ──
  function onBodyKeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const ids = view.flatVisibleIds;
      if (!ids.length) return;
      e.preventDefault();
      const idx = selectedKey ? ids.indexOf(selectedKey) : -1;
      selectedKey =
        e.key === "ArrowDown"
          ? (ids[Math.min(idx + 1, ids.length - 1)] ?? ids[0])
          : (ids[Math.max(idx - 1, 0)] ?? ids[0]);
    } else if (e.key === "Enter" && selectedKey) {
      const task = taskById(selectedKey);
      if (task) onOpen(task);
    } else if ((e.key === "x" || e.key === "X") && selectedKey) {
      const task = taskById(selectedKey);
      if (!task) return;
      e.preventDefault();
      selection.toggle(task.id, e);
    }
  }

  async function onCreate(input: TaskCreateInput) {
    try {
      await store.create(input);
      saveLastTaskSource(taskSourceKey(input.source));
    } catch (err) {
      toastTaskError("create the task", err);
      // Rethrow so the composer keeps the modal (and the user's draft) open; the
      // composer owns dismissal on success so "Create more" can stay open.
      throw err;
    }
  }
</script>

<!-- Where the person's tasks come from, and the one place to change it. With
     no source, the empty state adds the first one instead. -->
{#snippet sourceStrip()}
  <TaskSourceStrip
    sourceKey={view.source?.sourceKey ?? null}
    counts={view.sourceCounts}
    allCount={view.allSourcesCount}
    onSelect={selectViewSource}
    onChanged={() => void store.load()}
  />
{/snippet}

{#snippet filterBar()}
  <ListFilterBar
    bind:query={view.query}
    bind:searchEl
    compactText
    placeholder={splitList ? "Search tasks…" : "Search tasks, labels, assignees…"}
    {filters}
    activeCount={Number(!view.boardLayout && !isOpenColumnFilter(view.columns, view.columnIds))}
    onClearFilters={clearMenuFilters}
  >
    {#snippet filterContent()}
      <!-- The board plots every column itself, so a column filter there
           would only ever empty one. -->
      {#if !view.boardLayout}
        <ListFilterGroup label={view.source ? "Column" : "Status"} icon={CircleDashedIcon} options={view.columnOptions} selected={view.columnIds} onChange={(next) => (view.selectedColumnIds = next)} multiple showAll emptyLabel="None" />
      {/if}
    {/snippet}
    {#snippet trailing()}
      {#if view.truncationNote}
        <!-- Why the list is short, said where the narrowing is done. -->
        <span
          class="shrink-0 text-xs whitespace-nowrap text-muted-foreground @max-[44rem]:hidden"
          >{view.truncationNote}</span
        >
      {/if}
      {#if !splitList}
        <TaskLayoutToggle bind:layout={view.layout} />
        <ListSortMenu
          bind:value={view.sort}
          options={TASK_SORT_OPTIONS}
          ariaLabel="Sort tasks"
        />
      {/if}
    {/snippet}
  </ListFilterBar>
{/snippet}

{#if open}
  <div
    class="@container relative flex min-h-0 flex-1 overflow-hidden bg-(--solus-container-bg) focus:outline-none [--task-list-width:380px]"
    bind:clientWidth={pageWidth}
    role="dialog"
    aria-label="Tasks"
    tabindex="-1"
  >
    <div
      class="flex min-h-0 min-w-0 shrink-0 {splitList
        ? 'w-(--task-list-width)'
        : 'w-full'}"
    >
    <ListPage
      split={splitList}
      hideHeader={splitList}
      page="tasks"
      onRefresh={refresh}
      {refreshing}
      syncedAt={view.syncState.syncedAt}
      syncFromCache={view.syncState.fromCache}
      primaryAction={canCreate && !splitList
        ? {
            label: "New task",
            shortcut: comboHint("global.new-task"),
            run: () => startNewTask(),
          }
        : undefined}
      onClose={workspace ? close : undefined}
      toolbarFilters
      scopes={!hasNoSource && !splitList ? sourceStrip : undefined}
      filters={filterBar}
      contentOwnsScroll
      bind:contentHeight
    >
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <!-- The board and its skeleton fill the scroll region. Empty states
           keep the same natural height in both layouts. -->
      <div
        bind:this={listEl}
        class={view.boardLayout && (loadingTasks || view.visibleTasks.length > 0) ? "flex h-full min-h-0 flex-col" : ""}
        onkeydown={onBodyKeydown}
        role="presentation"
      >
        {#if loadingTasks}
          {#if view.boardLayout}
            <TaskBoardSkeleton />
          {:else}
            <ListSkeleton identWidth={62} />
          {/if}
        {:else if view.failure && tasks.length === 0}
          <!-- Nothing loaded: the failure takes the page, with its repair. -->
          <PageEmpty icon={WarningCircleIcon} tone="muted" title={view.failure.title}>
            {view.failure.detail}
            {#snippet actions()}
              {#if view.failure?.kind !== "generic" && taskSourcesStore.host}
                <button type="button" class={PAGE_PRIMARY_BTN} onclick={openConnections}>
                  {view.failure?.kind === "github-auth" ? "Connect GitHub" : "Connect Atlassian"}
                </button>
              {/if}
              <button type="button" class={PAGE_SECONDARY_BTN} onclick={refresh}>
                <ArrowClockwiseIcon size={14} />
                Retry
              </button>
            {/snippet}
          </PageEmpty>
        {:else if displayError && tasks.length === 0}
          <PageEmpty
            icon={WarningCircleIcon}
            tone="muted"
            title="Couldn't load tasks."
          >
            {displayError}
            {#snippet actions()}
              <button
                type="button"
                class={PAGE_SECONDARY_BTN}
                onclick={refresh}
              >
                <ArrowClockwiseIcon size={14} />
                Retry
              </button>
            {/snippet}
          </PageEmpty>
        {:else if hasNoSource && tasks.length === 0}
          <!-- GitHub and Jira own every task, so a person with no task source
               has no tasks. The empty state is the source setup. -->
          <PageEmpty icon={TaskIcon} title="No task source.">
            Tasks come from GitHub and Jira. Add a GitHub repository, a GitHub
            Project, a Jira project or a Jira board.
            {#snippet actions()}
              <TaskSourceAdd look="invite" onChanged={() => void store.load()} />
            {/snippet}
          </PageEmpty>
        {:else if tasks.length === 0 && view.searched.length === 0}
          <PageEmpty icon={TaskIcon} title="No tasks yet.">
            {#if hasNoHost}
              No connected machine runs agents, so your task sources cannot be
              read. Connect a machine to see their tasks.
            {:else}
              Your task sources list no task. Create one, then start a session
              from it to give the agent its full context.
            {/if}
            {#snippet actions()}
              {#if canCreate}
                <button
                  type="button"
                  class={PAGE_PRIMARY_BTN}
                  onclick={() => startNewTask()}
                >
                  <PlusIcon size={14} weight="bold" />
                  <span>New task</span>
                </button>
              {/if}
            {/snippet}
          </PageEmpty>
        {:else if view.visibleTasks.length === 0}
          <ListEmpty title="Nothing matches">
            Clear the filters or widen the search.
            {#snippet actions()}
              <button
                type="button"
                class={PAGE_SECONDARY_BTN}
                onclick={() => view.clearFilters()}
              >
                Clear filters
              </button>
            {/snippet}
          </ListEmpty>
        {:else if view.boardLayout}
          <TaskBoard
            tasks={view.visibleTasks}
            {homeFor}
            view={view.board}
            canReorder={view.boardUnfiltered}
            {selectedKey}
            onOpen={(task) => {
              selectedKey = task.id;
              onOpen(task);
            }}
            {onMoveTask}
            {runningSessionsFor}
            {now}
            onContextMenu={openTaskContextMenu}
            onAddInColumn={canCreate ? (columnId) => startNewTask(columnId) : undefined}
          />
        {:else}
          <TasksList
            groups={view.groups}
            height={contentHeight}
            {recordRows}
            split={splitList}
            {selection}
            {selectedKey}
            taskFor={taskById}
            {onOpen}
            onMove={(task, target) => void onMoveTask(task, target)}
            onContextMenu={openTaskContextMenu}
          />
        {/if}
      </div>
    </ListPage>
    </div>

    {#if panelOpen && openTask}
      <!-- Full screen means over the crumb line too. The project and page
           crumbs raise their own triggers to z-40 so their menus clear the
           list, so a panel at z-20 covered the rows and left "my-workspace ⌄
           Tasks ⌄" painted across the task's own record bar. A panel that
           replaces the page outranks the page's chrome. -->
      <div
        class="flex flex-col bg-background {boardPanel && roomForSplit
          ? 'absolute inset-y-0 right-0 z-10 w-[clamp(680px,72%,1400px)] shadow-[-1px_0_0_var(--hairline-strong),-18px_0_30px_-26px_rgba(0,0,0,.28)]'
          : roomForSplit
            ? 'absolute inset-y-0 right-0 left-(--task-list-width) z-10 min-w-0 shadow-[-1px_0_0_var(--hairline-strong),-18px_0_30px_-26px_rgba(0,0,0,.28)]'
            : 'absolute inset-0 z-50'}"
        transition:fly={{ x: 14, duration: reduceMotion ? 0 : 200 }}
      >
        <TaskPage
          params={{
            taskId: openTask.id,
            serverId: store.get(openTask.id).serverId ?? undefined,
          }}
          {paneId}
          embedded
          surfaceVisible={open}
          onRequestClose={closePanel}
          onOpenRoute={() => openTaskRoute(openTask)}
          onRequestPrevious={view.flatVisibleIds.length > 1
            ? () => stepPanel(-1)
            : null}
          onRequestNext={view.flatVisibleIds.length > 1 ? () => stepPanel(1) : null}
        />
      </div>
    {/if}

    {#if !view.boardLayout && selection.size > 0 && !panelOpen}
      <TasksBulkBar
        {selection}
        moveOptions={view.moveOptions}
        onComplete={() => void bulkComplete()}
        onMarkUnread={sessionSidebar ? () => void bulkMarkUnread() : undefined}
        onMove={bulkMove}
        onDelete={selectedTasks.some((task) => task.canDelete) ? bulkDelete : undefined}
      />
    {/if}

    {#if composing && canCreate}
      <TaskComposer
        {sources}
        initialSourceKey={newTaskSourceKey()}
        initialColumnId={view.source ? composing.columnId : undefined}
        knownLabels={store.knownLabels}
        workingDirectory={session.tasksProjectCwd ?? undefined}
        provider={session.settings.activeAgent}
        {onCreate}
        onCancel={() => (composing = null)}
      />
    {/if}

    {#if taskContextMenu}
      {@const menuTask = taskContextMenu.task}
      {@const linkedSessionCount = store.get(menuTask.id).sessions.length}
      <TaskContextMenu
        x={taskContextMenu.x}
        y={taskContextMenu.y}
        task={menuTask}
        hasLinkedSession={linkedSessionCount > 0}
        isRunning={false}
        onStart={workspace ? () => onStart(menuTask) : undefined}
        onResume={workspace && linkedSessionCount > 0 ? () => onResume(menuTask) : undefined}
        onOpenTask={() => onOpen(menuTask)}
        onOpenSource={menuTask.url ? () => onOpenLink(menuTask) : undefined}
        onSetStatus={(category) => void onMoveTask(menuTask, { category })}
        onDelete={menuTask.canDelete ? () => onDelete(menuTask) : undefined}
        onClose={() => (taskContextMenu = null)}
      />
    {/if}
  </div>
{/if}
