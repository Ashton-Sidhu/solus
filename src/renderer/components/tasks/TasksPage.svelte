<script lang="ts">
  import { tick } from "svelte";
  import {
    ArrowClockwiseIcon,
    CalendarXIcon,
    GithubLogoIcon,
    KanbanIcon,
    ListChecksIcon,
    ListIcon,
    PlusIcon,
    PulseIcon,
    TrashIcon,
    WarningCircleIcon,
  } from "phosphor-svelte";
  import {
    TASKS_AUTH_ERROR_PREFIX,
    type Task,
    type TaskStatus,
    type TaskKind,
    type TaskPriority,
    type TaskProviderId,
  } from "../../../shared/task-types";
  import {
    getWorkspaceContext,
    getProjectConfigStore,
    getSessionSidebarStore,
    runtime,
  } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import {
    TasksSelectionStore,
    setTasksSelection,
  } from "./tasks-selection.store.svelte";
  import {
    useKeybinding,
    useScope,
  } from "../../lib/keybindings/use-keybinding.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import {
    STATUS_META,
    BOARD_COLUMNS,
    relativeTime,
    type TaskSort,
  } from "./lib/tasks-api";
  import { taskCreationContextFor } from "./lib/task-creation-context";
  import {
    OPEN_TASK_STATUS_KEYS,
    TASK_STATUS_GROUPS,
    taskGroups,
    taskInboxGroups,
    taskStatusesFor,
  } from "./lib/tasks-list-view";
  import { PAGE_PRIMARY_BTN, PAGE_SECONDARY_BTN } from "../../lib/page-chrome";
  import {
    InboxRow,
    ListEmpty,
    ListFilterBar,
    ListGroup,
    ListPage,
    ListRow,
    ListSkeleton,
    ListStatusMenu,
    VirtualList,
    virtualGroupItems,
    type ListFilterSpec,
    type ListPageView,
    type ListStatusOption,
  } from "../ui/list-page";
  import PageEmpty from "../ui/PageEmpty.svelte";
  import SortMenu from "../ui/SortMenu.svelte";
  import TaskComposer from "./TaskComposer.svelte";
  import TaskBoard from "./TaskBoard.svelte";
  import TaskBoardSkeleton from "./TaskBoardSkeleton.svelte";
  import TaskContextMenu from "../session/TaskContextMenu.svelte";

  const session = getWorkspaceContext();
  const store = session.tasksStore;
  const projectConfig = getProjectConfigStore();
  const sessionSidebar = getSessionSidebarStore();

  const open = $derived(session.router.at("tasks"));

  // ── Project scope ──
  // The list is scoped to one project at a time. `null` follows the project
  // being worked in (the default); a repo root pins the list to another one
  // chosen from the header switcher. A pinned project has no checkout of its
  // own, so tasks created while pinned belong to its repo root and no branch.
  let pinnedProjectKey = $state<string | null>(null);
  const taskContext = $derived(
    pinnedProjectKey
      ? taskCreationContextFor(pinnedProjectKey, null)
      : session.taskCreationContext,
  );
  const cwd = $derived(taskContext?.projectKey ?? null);
  const projectOptions = $derived(
    sessionSidebar.projectSummaries
      .filter((project) => project.projectKey !== "~")
      .map((project) => ({
        projectKey: project.projectKey,
        label: project.label,
      })),
  );
  const projectTasks = $derived(store.tasksForProject(cwd));

  let configReady = $state(false);
  let taskLoadEpoch = 0;
  const canCreate = $derived(!!cwd);
  const allowEpics = true;

  // ── List-view multi-select ── owned by a context store so the selection isn't
  // threaded through the row components.
  const selection = new TasksSelectionStore();
  setTasksSelection(selection);
  // Composer state: null = closed; an object opens it (with an optional preset
  // parent epic when adding a child from an epic header, or a preset status when
  // adding into a board column).
  let composing = $state<{
    parentId?: string;
    status?: TaskStatus;
    context: NonNullable<typeof taskContext>;
  } | null>(null);
  // Detail view: the task whose full ticket (body, comments, PRs) is open.
  const epics = $derived(projectTasks.filter((t) => t.kind === "epic"));
  // Existing labels across the project, offered as composer suggestions.
  const knownLabels = $derived(
    Array.from(new Set(projectTasks.flatMap((t) => t.labels))).sort(),
  );

  // ── View state ──
  // The page's two views (spec Part A): the grouped global list, and the
  // personal inbox. `layout` is a Tasks-only extra that re-plots the *global*
  // view as a kanban board — the inbox is a queue and has no board form.
  let view = $state<ListPageView>("global");
  let layout = $state<"list" | "board">("list");
  const boardLayout = $derived(view === "global" && layout === "board");
  let query = $state("");
  let sort = $state<TaskSort>("updated");
  let runningOnly = $state(false);
  let overdueOnly = $state(false);
  let assignedOnly = $state(false);
  // Which lifecycle states the list and the inbox are showing. Opens on live
  // work only, so finished and dropped tasks stay out of the way until asked
  // for. The board is exempt — its columns *are* this filter, and a kanban
  // whose last column is always empty reads as broken.
  let statusKeys = $state<string[]>([...OPEN_TASK_STATUS_KEYS]);
  const statuses = $derived(taskStatusesFor(statusKeys));
  let searchEl = $state<HTMLInputElement | null>(null);
  let contentHeight = $state(0);
  let selectedKey = $state<string | null>(null);
  let collapsedGroups = $state<Record<string, boolean>>({});
  let taskContextMenu = $state<{
    task: Task;
    x: number;
    y: number;
  } | null>(null);

  function clearFilters() {
    query = "";
    runningOnly = false;
    overdueOnly = false;
    assignedOnly = false;
    statusKeys = [...OPEN_TASK_STATUS_KEYS];
  }

  const SORT_OPTIONS: { value: TaskSort; label: string }[] = [
    { value: "updated", label: "Updated" },
    { value: "priority", label: "Priority" },
    { value: "due", label: "Due" },
  ];

  const upstreamError = $derived(
    cwd ? (store.upstreamErrorByProject.get(cwd) ?? null) : null,
  );
  const refreshing = $derived(
    store.loading || !!(cwd && store.upstreamLoadingByProject.get(cwd)),
  );
  const upstreamRefreshedAt = $derived(
    cwd ? (store.upstreamRefreshedAtByProject.get(cwd) ?? null) : null,
  );
  const upstreamFromCache = $derived(
    !!(cwd && store.upstreamFromCacheByProject.get(cwd)),
  );
  const upstreamTruncated = $derived(
    !!(cwd && store.upstreamTruncatedByProject.get(cwd)),
  );
  const displayError = $derived(
    (store.error ?? upstreamError)?.replace(TASKS_AUTH_ERROR_PREFIX, "") ??
      null,
  );

  // Tick the clock so relative row times ("12m") age instead of freezing at the
  // moment the list loaded.
  let now = $state(Date.now());
  $effect(() => {
    if (!open) return;
    const interval = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(interval);
  });

  function sessionsFor(taskId: string): number {
    return store.sessionsByTask.get(taskId)?.length ?? 0;
  }

  function isOverdue(task: Task): boolean {
    if (!task.dueDate || task.status === "done" || task.status === "dropped")
      return false;
    return Date.parse(`${task.dueDate}T23:59:59`) < now;
  }

  // ── Filtering ──
  // Counts are over the search-filtered set but ignore the *other* toggles, so a
  // chip's count still means "how many more this would show" once another chip
  // is already on.
  const searched = $derived(
    projectTasks.filter((task) => {
      if (!query.trim()) return true;
      const haystack =
        `${task.title} ${task.shortId ?? ""} ${task.labels.join(" ")}`.toLowerCase();
      return haystack.includes(query.trim().toLowerCase());
    }),
  );

  const visibleTasks = $derived.by(() => {
    let rows = searched;
    if (!boardLayout) rows = rows.filter((task) => statuses.has(task.status));
    if (runningOnly) rows = rows.filter((task) => sessionsFor(task.id) > 0);
    if (overdueOnly) rows = rows.filter(isOverdue);
    if (assignedOnly) rows = rows.filter((task) => !!task.assignee);
    return sortTasks(rows);
  });

  // The board's manual order renumbers the column a card lands in, so it only
  // means anything when `visibleTasks` *is* the board. (The status filter is
  // exempt — the board already ignores it.)
  const boardUnfiltered = $derived(
    !query.trim() && !runningOnly && !overdueOnly && !assignedOnly,
  );

  function sortTasks(tasks: Task[]): Task[] {
    const rank = (task: Task) =>
      task.priority
        ? { urgent: 0, high: 1, medium: 2, low: 3 }[task.priority]
        : 4;
    const due = (task: Task) =>
      task.dueDate
        ? Date.parse(`${task.dueDate}T00:00:00`) || Infinity
        : Infinity;
    const arr = [...tasks];
    if (sort === "priority")
      arr.sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
    else if (sort === "due")
      arr.sort((a, b) => due(a) - due(b) || b.updatedAt - a.updatedAt);
    else arr.sort((a, b) => b.updatedAt - a.updatedAt);
    return arr;
  }

  const groups = $derived(taskGroups(visibleTasks, sessionsFor, now));
  const inboxGroups = $derived(
    taskInboxGroups(projectTasks, sessionsFor, now, {
      open: onOpen,
      start: onStart,
      resume: onResume,
      markDone: (task) => void onSetStatus(task, "done"),
    }, statuses),
  );
  const inboxVirtualItems = $derived(
    virtualGroupItems(inboxGroups, (row) => row.key),
  );
  const globalVirtualItems = $derived(
    virtualGroupItems(
      groups,
      (row) => row.key,
      (group) => !collapsedGroups[group.key],
    ),
  );
  const inboxActiveKey = $derived(
    inboxVirtualItems.find(
      (item) => item.kind === "row" && item.row.key === selectedKey,
    )?.key ?? null,
  );
  const globalActiveKey = $derived(
    globalVirtualItems.find(
      (item) => item.kind === "row" && item.row.key === selectedKey,
    )?.key ?? null,
  );
  const unreadCount = $derived(
    inboxGroups.find((group) => group.key === "needs")?.rows.length ?? 0,
  );

  const filters = $derived<ListFilterSpec[]>([
    {
      key: "running",
      label: "Agent running",
      icon: PulseIcon,
      count: searched.filter((task) => sessionsFor(task.id) > 0).length,
      active: runningOnly,
      toggle: () => (runningOnly = !runningOnly),
    },
    {
      key: "overdue",
      label: "Overdue",
      icon: CalendarXIcon,
      count: searched.filter(isOverdue).length,
      active: overdueOnly,
      toggle: () => (overdueOnly = !overdueOnly),
    },
    {
      key: "assigned",
      label: "Assigned",
      icon: ListChecksIcon,
      count: searched.filter((task) => !!task.assignee).length,
      active: assignedOnly,
      toggle: () => (assignedOnly = !assignedOnly),
    },
  ]);

  // Counts are over the searched set, not the status-filtered one — the number
  // beside a status has to say what picking it would show, which is exactly the
  // question a filter that is currently hiding it needs to answer.
  const statusOptions = $derived<ListStatusOption[]>(
    TASK_STATUS_GROUPS.map((group) => ({
      value: group.key,
      label: group.label,
      count: (view === "global" ? searched : projectTasks).filter((task) =>
        group.statuses.includes(task.status),
      ).length,
    })),
  );

  // The title block's three facts, lead first — the lead is the one that should
  // pull you in, and the only coloured text in the header.
  const summary = $derived.by(() => {
    const running = projectTasks.filter(
      (task) => sessionsFor(task.id) > 0,
    ).length;
    const openCount = projectTasks.filter(
      (task) => task.status !== "done" && task.status !== "dropped",
    ).length;
    const closedThisWeek = projectTasks.filter(
      (task) =>
        (task.status === "done" || task.status === "dropped") &&
        now - task.updatedAt < 7 * 24 * 60 * 60 * 1000,
    ).length;
    const facts = [
      { label: `${running} running`, tint: "running" as const },
      { label: `${openCount} open` },
      { label: `${closedThisWeek} closed this week` },
    ];
    if (upstreamRefreshedAt) {
      facts.push({
        label: upstreamFromCache
          ? `offline copy from ${relativeTime(upstreamRefreshedAt, now)}`
          : `updated ${relativeTime(upstreamRefreshedAt, now)}`,
      });
    }
    if (upstreamTruncated) {
      facts.push({ label: `most recent ${projectTasks.length}` });
    }
    return facts;
  });

  // The selectable rows in render order, for Shift range-select and arrow nav.
  const flatVisibleIds = $derived(
    groups.flatMap((g) => g.rows).map((r) => r.key),
  );
  $effect(() => {
    selection.setOrder(flatVisibleIds);
  });

  function taskById(id: string): Task | undefined {
    return projectTasks.find((task) => task.id === id);
  }

  function beginComposing(
    options: { parentId?: string; status?: TaskStatus } = {},
  ) {
    if (!taskContext) return;
    composing = { ...options, context: taskContext };
  }

  // ── Data loading ──
  $effect(() => {
    if (!open || !cwd) {
      configReady = false;
      return;
    }
    const currentCwd = cwd;
    const epoch = ++taskLoadEpoch;
    configReady = false;
    void (async () => {
      await projectConfig.load(currentCwd);
      if (epoch !== taskLoadEpoch || !open || cwd !== currentCwd) return;
      configReady = true;
      await Promise.all([
        store.load(),
        store.loadUpstream(currentCwd, { refresh: true }),
      ]);
    })();
  });

  $effect(() => {
    if (open) {
      clearFilters();
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
      if (selection.size > 0) selection.clear();
      else if (query) {
        query = "";
        searchEl?.focus();
      } else close();
    },
    { enabled: () => open },
  );

  function close() {
    session.router.close("tasks");
    requestInputFocus();
  }

  // A different project is a different list, so nothing about how the old one
  // was being read survives the switch. The load effect keys off `cwd` and
  // refetches on its own.
  function selectProject(projectKey: string) {
    pinnedProjectKey =
      projectKey === session.tasksProjectCwd ? null : projectKey;
    clearFilters();
    selection.clear();
    selectedKey = null;
    collapsedGroups = {};
    composing = null;
    void tick().then(() => searchEl?.focus());
  }

  // Re-read native tasks and explicitly poll the configured upstream provider.
  function refresh() {
    if (!cwd || refreshing) return;
    const currentCwd = cwd;
    configReady = true;
    void Promise.all([
      store.load(),
      store.loadUpstream(currentCwd, { refresh: true }),
    ]);
  }

  async function switchTaskProvider(next: TaskProviderId) {
    if (!cwd) return;
    const currentCwd = cwd;
    await projectConfig.save(currentCwd, { taskProvider: next });
    await projectConfig.load(currentCwd);
    if (cwd !== currentCwd) return;
    configReady = true;
    await Promise.all([
      store.load(),
      store.loadUpstream(currentCwd, { refresh: true }),
    ]);
  }

  function onOpen(task: Task) {
    session.goToTask(task.id, "click");
  }

  function onStart(task: Task) {
    void session.openTaskSession(task);
  }

  function onResume(task: Task) {
    void session.openTaskLinkedSession(task);
  }

  function onOpenLink(task: Task) {
    if (task.url) void window.solus.openExternal(task.url);
  }

  function openTaskContextMenu(event: MouseEvent, task: Task) {
    event.preventDefault();
    event.stopPropagation();
    selectedKey = task.id;
    taskContextMenu = { task, x: event.clientX, y: event.clientY };
  }

  function toastTaskError(action: string, err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    toasts.error(`Couldn't ${action}: ${message}`);
  }

  async function onSetStatus(task: Task, status: TaskStatus) {
    try {
      await store.setStatus(task.id, status);
    } catch (err) {
      toastTaskError("update status", err);
    }
  }

  function deleteTasks(ids: string[], label: string) {
    const localIds = ids.filter((id) => taskById(id)?.providerId === "local");
    if (!store.softRemove(localIds)) return;
    toasts.undo(label, () => store.restorePending(), {
      // commitPending restores any rows whose delete failed; surface why.
      onDismiss: () =>
        store
          .commitPending()
          .catch((err) => toastTaskError("delete task", err)),
    });
  }

  function onDelete(task: Task) {
    deleteTasks([task.id], "Task deleted");
  }

  // ── Bulk actions over the current selection ──
  function bulkSetStatus(status: TaskStatus) {
    const ids = [...selection.ids];
    selection.clear();
    for (const id of ids) {
      const t = taskById(id);
      if (t && t.status !== status) void onSetStatus(t, status);
    }
  }

  function bulkDelete() {
    const ids = [...selection.ids];
    selection.clear();
    deleteTasks(
      ids,
      `${ids.length} task${ids.length === 1 ? "" : "s"} deleted`,
    );
  }

  // Selection is a global-list concept: drop it on the board, in the inbox, and
  // when the page closes, so a stale selection can't act on a hidden view.
  $effect(() => {
    if (layout === "board" || view === "inbox" || !open) selection.clear();
  });

  // ── Keyboard nav over the rendered rows ──
  function onBodyKeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const ids = flatVisibleIds;
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
      selection.toggle(task, e);
    }
  }

  async function onCreate(input: {
    title: string;
    body: string;
    kind: TaskKind;
    parentId?: string;
    dueDate?: string;
    priority?: TaskPriority;
    status?: TaskStatus;
    labels?: string[];
  }) {
    if (!composing) return;
    try {
      await store.create({
        ...input,
        projectKey: composing.context.projectKey,
        branch: composing.context.branch,
        worktreeKey: input.parentId ? undefined : composing.context.worktreeKey,
      });
    } catch (err) {
      toastTaskError("create task", err);
      // Rethrow so the composer keeps the modal (and the user's draft) open; the
      // composer owns dismissal on success so "Create more" can stay open.
      throw err;
    }
  }
</script>

{#snippet headerActions()}
  <!-- Tasks-only: the global list can be re-plotted as a board. Sits after the
       view switch because it re-plots that view rather than replacing it. -->
  {#if view === "global"}
    <div
      class="flex items-center gap-0.5 rounded-full bg-[var(--wash-2)] p-0.5"
      role="group"
      aria-label="Layout"
    >
      <button
        type="button"
        class="grid size-6 cursor-pointer place-items-center rounded-full border-0 transition-colors {layout ===
        'list'
          ? 'bg-card text-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_12%,transparent)]'
          : 'bg-transparent text-muted-foreground hover:text-foreground'}"
        onclick={() => (layout = "list")}
        aria-pressed={layout === "list"}
        aria-label="List layout"
        title="List"
      >
        <ListIcon size={13} weight="bold" />
      </button>
      <button
        type="button"
        class="grid size-6 cursor-pointer place-items-center rounded-full border-0 transition-colors {layout ===
        'board'
          ? 'bg-card text-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_12%,transparent)]'
          : 'bg-transparent text-muted-foreground hover:text-foreground'}"
        onclick={() => (layout = "board")}
        aria-pressed={layout === "board"}
        aria-label="Board layout"
        title="Board"
      >
        <KanbanIcon size={13} weight="bold" />
      </button>
    </div>
  {/if}
{/snippet}

{#snippet filterBar()}
  <ListFilterBar
    bind:query
    bind:searchEl
    placeholder={view === "global"
      ? "Search tasks, labels, assignees…"
      : "Search your inbox…"}
    filters={view === "global" ? filters : []}
  >
    {#snippet trailing()}
      <!-- The board plots every status as a column of its own, so a status
           filter there would only ever empty one. -->
      {#if !boardLayout}
        <ListStatusMenu
          options={statusOptions}
          selected={statusKeys}
          onChange={(next) => (statusKeys = next)}
          ariaLabel="Filter tasks by status"
        />
      {/if}
      {#if view === "global"}
        <SortMenu
          bind:value={sort}
          options={SORT_OPTIONS}
          ariaLabel="Sort tasks"
          class="h-7 gap-1.5 rounded-[10px] px-2.5 text-[13px] font-normal text-muted-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)] hover:text-foreground"
        />
      {/if}
    {/snippet}
  </ListFilterBar>
{/snippet}

{#snippet rowCheckbox(taskId: string)}
  {@const task = taskById(taskId)}
  {#if task}
    <button
      type="button"
      class="mr-2 grid size-4 shrink-0 cursor-pointer place-items-center rounded border-0 text-[11px] transition-opacity {selection.has(
        taskId,
      )
        ? 'bg-primary text-primary-foreground opacity-100'
        : 'bg-[var(--wash-3)] text-transparent opacity-0 group-hover:opacity-100'}"
      onclick={(e) => selection.toggle(task, e)}
      aria-pressed={selection.has(taskId)}
      aria-label={selection.has(taskId) ? "Deselect task" : "Select task"}
    >
      ✓
    </button>
  {/if}
{/snippet}

{#if open}
  <div
    class="@container relative flex min-h-0 flex-1 flex-col overflow-hidden bg-(--solus-container-bg) focus:outline-none"
    role="dialog"
    aria-label="Tasks"
    tabindex="-1"
  >
    <ListPage
      projects={projectOptions}
      activeProjectKey={cwd ?? ""}
      emptyProjectLabel="No project"
      onSelectProject={selectProject}
      title="Tasks"
      {summary}
      {view}
      onViewChange={(next) => {
        view = next;
        selectedKey = null;
      }}
      globalLabel="All tasks"
      inboxLabel="My inbox"
      {unreadCount}
      onRefresh={refresh}
      {refreshing}
      primaryAction={canCreate
        ? { label: "New task", shortcut: "⌘N", run: () => beginComposing() }
        : undefined}
      onClose={close}
      actions={headerActions}
      filters={filterBar}
      contentOwnsScroll
      bind:contentHeight
    >
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <!-- The board owns the full scroll region and scrolls per column, so in
           that layout the body becomes a flex column the board can fill. -->
      <div
        class={boardLayout ? "flex h-full min-h-0 flex-col" : ""}
        onkeydown={onBodyKeydown}
        role="presentation"
      >
        {#if !cwd}
          <PageEmpty
            icon={ListChecksIcon}
            title="Open a project to see its tasks."
          >
            Tasks are per-project records. Open a project and its list appears
            here.
          </PageEmpty>
        {:else if !configReady || (!store.loaded && store.loading) || (refreshing && projectTasks.length === 0)}
          {#if boardLayout}
            <TaskBoardSkeleton />
          {:else}
            <ListSkeleton identWidth={62} />
          {/if}
        {:else if store.error || (upstreamError && projectTasks.length === 0)}
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
                <ArrowClockwiseIcon size={13} />
                Retry
              </button>
            {/snippet}
          </PageEmpty>
        {:else if projectTasks.length === 0}
          <PageEmpty icon={ListChecksIcon} title="No tasks yet.">
            Create {allowEpics ? "a task or epic" : "a task"}, then start a
            session from it to give the agent its full context.
            {#snippet actions()}
              {#if canCreate}
                <button
                  type="button"
                  class={PAGE_PRIMARY_BTN}
                  onclick={() => beginComposing()}
                >
                  <PlusIcon size={13} weight="bold" />
                  <span>New task</span>
                </button>
                <button
                  type="button"
                  class={PAGE_SECONDARY_BTN}
                  onclick={() => void switchTaskProvider("github")}
                >
                  <GithubLogoIcon size={13} weight="fill" />
                  <span>Connect a task provider</span>
                </button>
              {/if}
            {/snippet}
          </PageEmpty>
        {:else if view === "inbox"}
          {#if inboxGroups.length === 0}
            <ListEmpty title="Inbox zero."
              >Nothing is waiting on you right now.</ListEmpty
            >
          {:else}
            <VirtualList
              items={inboxVirtualItems}
              height={contentHeight}
              itemSize={(index) =>
                inboxVirtualItems[index].kind === "header" ? 36 : 55}
              keyOf={(item) => item.key}
              activeKey={inboxActiveKey}
            >
              {#snippet children(item, _index, style)}
                <div {style}>
                  {#if item.kind === "header"}
                    <ListGroup
                      label={item.group.label}
                      count={item.group.rows.length}
                      collapsible={false}
                      note={item.group.note}
                      accent={item.group.accent}
                    >
                      {#snippet children()}{/snippet}
                    </ListGroup>
                  {:else}
                  <InboxRow
                    row={item.row}
                    hot={!!item.group.accent}
                    selected={selectedKey === item.row.key}
                    onSelect={() => {
                      selectedKey = item.row.key;
                      const task = taskById(item.row.key);
                      if (task) onOpen(task);
                    }}
                    onContextMenu={(event) => {
                      const task = taskById(item.row.key);
                      if (task) openTaskContextMenu(event, task);
                    }}
                  />
                  {/if}
                </div>
              {/snippet}
            </VirtualList>
          {/if}
        {:else if layout === "board"}
          <TaskBoard
            tasks={visibleTasks}
            projectKey={cwd}
            canReorder={boardUnfiltered}
            {selectedKey}
            onOpen={(task) => {
              selectedKey = task.id;
              onOpen(task);
            }}
            {onSetStatus}
            {sessionsFor}
            {now}
            onContextMenu={openTaskContextMenu}
            onAddInColumn={canCreate
              ? (status) => beginComposing({ status })
              : undefined}
          />
        {:else if groups.length === 0}
          <ListEmpty title="Nothing matches">
            Clear the filters or widen the search.
            {#snippet actions()}
              <button
                type="button"
                class={PAGE_SECONDARY_BTN}
                onclick={clearFilters}
              >
                Clear filters
              </button>
            {/snippet}
          </ListEmpty>
        {:else}
          <VirtualList
            items={globalVirtualItems}
            height={contentHeight}
            itemSize={(index) =>
              globalVirtualItems[index].kind === "header" ? 36 : 44}
            keyOf={(item) => item.key}
            activeKey={globalActiveKey}
          >
            {#snippet children(item, _index, style)}
              <div {style}>
                {#if item.kind === "header"}
                  <ListGroup
                    label={item.group.label}
                    count={item.group.rows.length}
                    open={!collapsedGroups[item.group.key]}
                    onToggle={() =>
                      (collapsedGroups = {
                        ...collapsedGroups,
                        [item.group.key]: !collapsedGroups[item.group.key],
                      })}
                  >
                    {#snippet children()}{/snippet}
                  </ListGroup>
                {:else}
                <ListRow
                  row={item.row}
                  identWidth={62}
                  fallbackAvatar="solus"
                  selected={selectedKey === item.row.key ||
                    selection.has(item.row.key)}
                  onSelect={() => {
                    selectedKey = item.row.key;
                    const task = taskById(item.row.key);
                    if (task) onOpen(task);
                  }}
                  onContextMenu={(event) => {
                    const task = taskById(item.row.key);
                    if (task) openTaskContextMenu(event, task);
                  }}
                >
                  {#snippet leading()}
                    {@render rowCheckbox(item.row.key)}
                  {/snippet}
                </ListRow>
                {/if}
              </div>
            {/snippet}
          </VirtualList>
        {/if}
      </div>
    </ListPage>

    <!-- Bulk action bar — floats over the list while a selection is held -->
    {#if view === "global" && layout === "list" && selection.size > 0}
      <div
        class="pointer-events-none absolute inset-x-0 bottom-14 z-10 flex justify-center px-4"
      >
        <div
          class="pointer-events-auto flex items-center gap-1.5 rounded-full border border-(--solus-popover-border) bg-(--solus-popover-bg) px-2 py-1.5 shadow-[var(--solus-popover-shadow)]"
          role="toolbar"
          aria-label="Bulk actions"
        >
          <span class="px-1.5 text-[13px] font-medium tabular-nums">
            {selection.size} selected
          </span>
          <span
            class="h-4 w-px bg-(--solus-container-border)"
            aria-hidden="true"
          ></span>
          {#each BOARD_COLUMNS as col (col.status)}
            <button
              type="button"
              class="inline-flex cursor-pointer items-center gap-1 rounded-full border-0 bg-transparent px-2 py-1 text-[12px] font-medium text-(--solus-text-secondary) transition-colors duration-100 hover:bg-(--solus-surface-hover)"
              onclick={() => bulkSetStatus(col.status)}
              title={`Set ${col.label}`}
            >
              <span
                class="block size-2 rounded-full {STATUS_META[col.status]
                  .dotClass}"
              ></span>
              {col.label}
            </button>
          {/each}
          <span
            class="h-4 w-px bg-(--solus-container-border)"
            aria-hidden="true"
          ></span>
          <button
            type="button"
            class="inline-flex cursor-pointer items-center gap-1 rounded-full border-0 bg-transparent px-2 py-1 text-[12px] font-medium text-[#cf222e] transition-colors duration-100 hover:bg-[#cf222e]/10 [.dark_&]:text-[#f85149] [.dark_&]:hover:bg-[#f85149]/10"
            onclick={bulkDelete}
            title="Delete selected"
          >
            <TrashIcon size={12} />
            Delete
          </button>
          <span
            class="h-4 w-px bg-(--solus-container-border)"
            aria-hidden="true"
          ></span>
          <button
            type="button"
            class="cursor-pointer rounded-full border-0 bg-transparent px-2 py-1 text-[12px] font-medium text-(--solus-text-tertiary) transition-colors duration-100 hover:bg-(--solus-surface-hover)"
            onclick={() => selection.clear()}
            title="Clear selection (Esc)"
          >
            Clear
          </button>
        </div>
      </div>
    {/if}

    {#if composing}
      <TaskComposer
        {epics}
        {allowEpics}
        canPlan
        {knownLabels}
        workingDirectory={composing.context.workingDirectory}
        provider={session.settings.activeAgent}
        initialParentId={composing.parentId}
        initialStatus={composing.status}
        {onCreate}
        onCancel={() => (composing = null)}
      />
    {/if}

    {#if taskContextMenu}
      {@const menuTask = taskContextMenu.task}
      {@const linkedSessionCount = sessionsFor(menuTask.id)}
      <TaskContextMenu
        x={taskContextMenu.x}
        y={taskContextMenu.y}
        task={menuTask}
        hasLinkedSession={linkedSessionCount > 0}
        isRunning={false}
        onStart={() => onStart(menuTask)}
        onResume={linkedSessionCount > 0 ? () => onResume(menuTask) : undefined}
        onOpenTask={() => onOpen(menuTask)}
        onOpenSource={menuTask.url ? () => onOpenLink(menuTask) : undefined}
        onToggleDone={() =>
          void onSetStatus(
            menuTask,
            menuTask.status === "done" ? "todo" : "done",
          )}
        onDelete={menuTask.providerId === "local"
          ? () => onDelete(menuTask)
          : undefined}
        onClose={() => (taskContextMenu = null)}
      />
    {/if}
  </div>
{/if}
