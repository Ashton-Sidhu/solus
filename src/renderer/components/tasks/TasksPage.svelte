<script lang="ts">
  import { tick } from "svelte";
  import {
    PlusIcon,
    ArrowClockwiseIcon,
    CircleNotchIcon,
    ListChecksIcon,
    WarningCircleIcon,
    PlugIcon,
    ListIcon,
    KanbanIcon,
    TrashIcon,
  } from "phosphor-svelte";
  import { fade } from "svelte/transition";
  import {
    TASKS_AUTH_ERROR_PREFIX,
    type Task,
    type TaskStatus,
    type TaskKind,
    type TaskPriority,
    type TaskProviderId,
  } from "../../../shared/task-types";
  import { getWorkspaceContext, getProjectConfigStore, runtime, toasts } from "../../contexts";
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
    buildTaskGroups,
    relativeTime,
    STATUS_META,
    BOARD_COLUMNS,
    type StatusFilter,
    type TaskSort,
  } from "./lib/tasks-api";
  import {
    PAGE_PRIMARY_BTN,
    PAGE_ICON_BTN,
    PAGE_SECONDARY_BTN,
  } from "../../lib/page-chrome";
  import PageEmpty from "../ui/PageEmpty.svelte";
  import PageShell from "../ui/PageShell.svelte";
  import PageHeader from "../ui/PageHeader.svelte";
  import TaskFilters from "./TaskFilters.svelte";
  import TaskCard from "./TaskCard.svelte";
  import EpicGroup from "./EpicGroup.svelte";
  import TaskComposer from "./TaskComposer.svelte";
  import TaskDetail from "./TaskDetail.svelte";
  import TaskBoard from "./TaskBoard.svelte";
  import TaskBoardSkeleton from "./TaskBoardSkeleton.svelte";

  const session = getWorkspaceContext();
  const store = session.tasksStore;
  const projectConfig = getProjectConfigStore();

  const open = $derived(session.tasksOpen);
  const cwd = $derived(session.tasksProjectCwd);

  // Resolved provider (unset defaults to local). Local + GitHub support create;
  // only local owns the epic/sub-task hierarchy, so epics + add-child are local.
  let configReady = $state(false);
  const providerHealth = $derived(store.providerStatus(cwd));
  let taskLoadEpoch = 0;
  const provider = $derived<TaskProviderId | "unknown">(
    cwd ? (configReady ? (projectConfig.configFor(cwd)?.taskProvider ?? "local") : "unknown") : "local",
  );
  const canCreate = $derived(
    !!cwd && (provider === "local" || provider === "github"),
  );
  const allowEpics = $derived(provider === "local");
  // Priority/due are only persistable at create time for local tasks — a new
  // GitHub issue isn't on a Projects board yet, so those fields would be
  // silently dropped. The composer hides them rather than eating the input.
  const canPlanOnCreate = $derived(provider === "local");
  // Delete is local-only (we never delete remote tickets); both providers have a
  // comment model (GitHub issue comments, local notes).
  const canDelete = $derived(provider === "local");
  const canComment = $derived(provider === "local" || provider === "github");

  // ── List-view multi-select ── owned by a context store so the selection isn't
  // threaded through EpicGroup down to each card.
  const selection = new TasksSelectionStore();
  setTasksSelection(selection);
  // Composer state: null = closed; an object opens it (with an optional preset
  // parent epic when adding a child from an epic header, or a preset status when
  // adding into a board column).
  let composing = $state<{ parentId?: string; status?: TaskStatus } | null>(null);
  // Detail view: the task whose full ticket (body, comments, PRs) is open.
  let detailTask = $state<Task | null>(null);
  const epics = $derived(store.tasks.filter((t) => t.kind === "epic"));
  // Existing labels across the project, offered as composer suggestions.
  const knownLabels = $derived(
    Array.from(new Set(store.tasks.flatMap((t) => t.labels))).sort(),
  );

  let query = $state("");
  let statusFilter = $state<StatusFilter>("active");
  let assignedToMe = $state(false);

  function clearFilters() {
    query = "";
    statusFilter = "active";
    assignedToMe = false;
  }
  // Ordering for both list + board. `priority`/`due` answer "what's next".
  let sort = $state<TaskSort>("updated");
  // List (dense, epic-grouped) vs board (kanban by status). The board is a flat
  // status view, so it ignores the status tabs (hidden) but keeps search + Mine.
  let view = $state<"list" | "board">("list");
  let searchEl = $state<HTMLInputElement | HTMLTextAreaElement | null>(null);
  let bodyEl = $state<HTMLDivElement | null>(null);

  // GitHub's "not connected / auth" failures get a Connect affordance; anything
  // else (network, rate limit, bad remote) gets a plain retry instead. The main
  // process classifies these and prepends a stable marker (task-service), so no
  // error-prose sniffing is needed here.
  const isAuthError = $derived(
    provider === "github" && !!store.error && store.error.includes(TASKS_AUTH_ERROR_PREFIX),
  );
  const displayError = $derived(
    store.error ? store.error.replace(TASKS_AUTH_ERROR_PREFIX, "") : null,
  );

  // Tick the freshness hint so "updated 5m ago" doesn't read "just now" forever.
  let freshnessNow = $state(Date.now());
  $effect(() => {
    if (!open || store.refreshedAt === null) return;
    const interval = setInterval(() => {
      freshnessNow = Date.now();
    }, 30_000);
    return () => clearInterval(interval);
  });

  // Live refresh: any task mutation for this project (an agent tool closing the
  // ticket, a session write-back, another window/client editing) invalidates the
  // list. Debounced so a bulk operation's burst collapses into one reload.
  $effect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = window.solus.onTasksChanged((changedCwd) => {
      if (!session.tasksOpen || !session.tasksProjectCwd) return;
      if (changedCwd !== session.tasksProjectCwd) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (configReady && !store.loading) void store.load(changedCwd, { assignedToMe });
      }, 500);
    });
    return () => {
      unsub();
      clearTimeout(timer);
    };
  });

  // Counts are over the unfiltered (but assignee-scoped) list so the tab badges
  // stay stable as the user types a query.
  const counts = $derived.by(() => {
    const c: Record<StatusFilter, number> = {
      all: store.tasks.length,
      active: 0,
      open: 0,
      in_progress: 0,
      done: 0,
    };
    for (const t of store.tasks) {
      c[t.status]++;
      if (t.status === 'open' || t.status === 'in_progress') c.active++;
    }
    return c;
  });

  const groups = $derived(
    buildTaskGroups(store.tasks, { query, status: statusFilter, sort }),
  );

  // The selectable cards in render order (epic children + standalone), for Shift
  // range-select. Epics are headers, not cards, so they're excluded.
  const flatVisibleIds = $derived(groups.flatMap((g) => g.children).map((t) => t.id));

  // Keep the selection store's order in sync so Shift-range resolves correctly.
  $effect(() => {
    selection.setOrder(flatVisibleIds);
  });

  function sessionsFor(taskId: string): number {
    return store.sessionsByTask.get(taskId)?.length ?? 0;
  }

  // Load when the page opens, the project changes, or the assignee scope toggles.
  // assignedToMe is a server-side filter (the viewer identity lives in main).
  $effect(() => {
    if (!open || !cwd) {
      configReady = false;
      return;
    }
    const currentCwd = cwd;
    const mine = assignedToMe;
    const epoch = ++taskLoadEpoch;
    configReady = false;
    void (async () => {
      await projectConfig.load(currentCwd);
      const health = await store.loadProviderStatus(currentCwd);
      if (epoch !== taskLoadEpoch || !session.tasksOpen || session.tasksProjectCwd !== currentCwd) return;
      configReady = true;
      if (!health.ok) return;
      await store.load(currentCwd, { assignedToMe: mine });
    })();
  });

  $effect(() => {
    if (open) {
      query = "";
      statusFilter = "active";
      composing = null;
      if (!runtime.shouldSuppressFocus) {
        void tick().then(() => searchEl?.focus());
      }
    }
  });

  // "Go to task…" from the palette: once the list is loaded, open the requested
  // task's detail and clear the focus request (whether or not it was found).
  $effect(() => {
    const focusId = session.ui.tasksFocusId;
    if (!open || !focusId || !store.loaded) return;
    const task = store.tasks.find((t) => t.id === focusId);
    if (task) detailTask = task;
    session.ui.tasksFocusId = null;
  });

  useScope("tasks", { active: () => open });
  useKeybinding(
    "tasks.close",
    () => {
      // Esc backs out one layer at a time: detail page, then a held selection,
      // then an active search, and only then the panel itself.
      if (detailTask) detailTask = null;
      else if (selection.size > 0) selection.clear();
      else if (query) {
        query = "";
        searchEl?.focus();
      } else close();
    },
    { enabled: () => open },
  );

  function close() {
    session.tasksOpen = false;
    requestInputFocus();
  }

  // Force a live re-fetch (task-service always hits the provider first, falling
  // back to cache only on failure) — the list otherwise only loads on open.
  function refresh() {
    if (!cwd || store.loading) return;
    const currentCwd = cwd;
    void (async () => {
      await projectConfig.load(currentCwd);
      const health = await store.loadProviderStatus(currentCwd);
      if (cwd !== currentCwd) return;
      configReady = true;
      if (health.ok) await store.load(currentCwd, { assignedToMe });
    })();
  }

  function openProviderRepair(health = providerHealth) {
    if (health?.reason === "github_not_connected") {
      session.showSettings("api-access");
    }
  }

  async function switchTaskProvider(next: TaskProviderId) {
    if (!cwd) return;
    const currentCwd = cwd;
    await projectConfig.save(currentCwd, { taskProvider: next });
    await projectConfig.load(currentCwd);
    const health = await store.loadProviderStatus(currentCwd);
    if (cwd !== currentCwd) return;
    configReady = true;
    if (health.ok) {
      await store.load(currentCwd, { assignedToMe });
    } else {
      store.tasks = [];
      store.loaded = true;
      store.error = null;
      openProviderRepair(health);
    }
  }

  function onOpen(task: Task) {
    detailTask = task;
  }

  function onStart(task: Task) {
    detailTask = null;
    void session.openTaskSession(task);
    session.tasksOpen = false;
  }

  function onResume(task: Task) {
    detailTask = null;
    void session.openTaskLinkedSession(task);
    session.tasksOpen = false;
  }

  function onOpenLink(task: Task) {
    if (task.url) void window.solus.openExternal(task.url);
  }

  function toastTaskError(action: string, err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    toasts.error(`Couldn't ${action}: ${message}`);
  }

  async function onSetStatus(task: Task, status: TaskStatus) {
    if (!cwd) return;
    try {
      await store.setStatus(cwd, task.id, status);
    } catch (err) {
      toastTaskError("update status", err);
    }
  }

  async function onSaveDetail(patch: Partial<Task>): Promise<Task> {
    if (!cwd || !detailTask) throw new Error("No task open");
    try {
      return await store.update(cwd, detailTask.id, patch);
    } catch (err) {
      toastTaskError("save task", err);
      throw err;
    }
  }

  function hydrateTask(id: string): Promise<Task> {
    if (!cwd) throw new Error("No project open");
    return store.get(cwd, id);
  }

  function deleteTasks(ids: string[], label: string) {
    const currentCwd = cwd;
    if (!currentCwd || !store.softRemove(ids)) return;
    toasts.undo(label, () => store.restorePending(), {
      // commitPending restores any rows whose delete failed; surface why.
      onDismiss: () =>
        store.commitPending(currentCwd).catch((err) => toastTaskError("delete task", err)),
    });
  }

  function onDelete(task: Task) {
    detailTask = null;
    deleteTasks([task.id], "Task deleted");
  }

  async function onComment(body: string): Promise<Task> {
    if (!cwd || !detailTask) throw new Error("No task open");
    try {
      return await store.comment(cwd, detailTask.id, body);
    } catch (err) {
      toastTaskError("post comment", err);
      throw err;
    }
  }

  // ── Bulk actions over the current selection ──
  function bulkSetStatus(status: TaskStatus) {
    const ids = [...selection.ids];
    selection.clear();
    for (const id of ids) {
      const t = store.tasks.find((x) => x.id === id);
      if (t && t.status !== status) void onSetStatus(t, status);
    }
  }

  function bulkDelete() {
    const ids = [...selection.ids];
    selection.clear();
    deleteTasks(ids, `${ids.length} task${ids.length === 1 ? "" : "s"} deleted`);
  }

  // Selection is a list-view concept: drop it when switching to the board or
  // when the page closes so a stale selection can't act on a hidden view.
  $effect(() => {
    if (view === "board" || !open) selection.clear();
  });

  function onAddChild(epic: Task) {
    composing = { parentId: epic.id };
  }

  // Arrow-key navigation between cards — the page is keyboard-first, so Up/Down
  // move focus through the rendered rows without leaving the home row for a mouse.
  function onBodyKeydown(e: KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const cards = bodyEl
      ? Array.from(bodyEl.querySelectorAll<HTMLElement>("[data-task-card]"))
      : [];
    if (!cards.length) return;
    e.preventDefault();
    const active = document.activeElement as HTMLElement | null;
    const idx = active ? cards.indexOf(active) : -1;
    const next =
      e.key === "ArrowDown"
        ? cards[Math.min(idx + 1, cards.length - 1)] ?? cards[0]
        : cards[Math.max(idx - 1, 0)] ?? cards[0];
    next.focus();
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
    if (!cwd) return;
    try {
      await store.create(cwd, input, { assignedToMe });
    } catch (err) {
      toastTaskError("create task", err);
      // Rethrow so the composer keeps the modal (and the user's draft) open; the
      // composer owns dismissal on success so "Create more" can stay open.
      throw err;
    }
  }
</script>

{#if open}
  <div
    class="@container relative flex min-h-0 flex-1 flex-col overflow-hidden bg-(--solus-container-bg) focus:outline-none"
    role="dialog"
    aria-label="Tasks"
    tabindex="-1"
  >
    {#if detailTask}
      <!-- ── Full-page task detail / editor ── -->
      {#key detailTask.id}
        <TaskDetail
          task={detailTask}
          canEdit={provider === "local" || provider === "github"}
          canEditExtras={!!detailTask.canEditPlanningFields}
          canEditWork={provider === "local"}
          {canDelete}
          {canComment}
          linkedSessions={cwd ? (store.sessionsByTask.get(detailTask.id) ?? []) : []}
          {onStart}
          {onOpenLink}
          {onSetStatus}
          onResumeSession={onResume}
          onSave={onSaveDetail}
          {onDelete}
          {onComment}
          hydrate={hydrateTask}
          onDone={() => (detailTask = null)}
        />
      {/key}
    {:else}
    {#snippet tasksSubtitle()}
      {provider === "github"
        ? "Issues from the project's GitHub remote."
        : "The project's task board."}
      {#if store.loaded && !store.error}
        {#if store.fromCache}
          <span
            class="text-[#9a6700] [.dark_&]:text-[#d29922]"
            title="The live fetch failed — this is the last list fetched from the provider"
            >· offline copy{store.refreshedAt
              ? ` from ${relativeTime(store.refreshedAt, freshnessNow)}`
              : ""}</span
          >
        {:else if store.refreshedAt}
          <span title="When this list was last fetched from the provider"
            >· updated {relativeTime(store.refreshedAt, freshnessNow)}</span
          >
        {/if}
        {#if store.truncated}
          <span
            title="The provider caps this list — older items exist but are not shown"
            >· most recent {store.tasks.length}</span
          >
        {/if}
      {/if}
    {/snippet}
    <PageShell onClose={close}>
      <PageHeader title="Tasks" subtitle={tasksSubtitle}>
        {#snippet icon()}
          <ListChecksIcon size={18} weight="fill" />
        {/snippet}
        {#snippet actions()}
          <!-- List | Board view toggle -->
          <div
            class="flex items-center gap-0.5 rounded-full bg-(--solus-surface-hover) p-0.5"
            role="group"
            aria-label="View"
          >
            <button
              type="button"
              class="grid size-6 cursor-pointer place-items-center rounded-full border-0 transition-[background-color,color] duration-100 ease-in-out {view ===
              'list'
                ? 'bg-(--solus-input-pill-bg) text-(--solus-text-primary) shadow-[0_0.0625rem_0.1875rem_rgba(0,0,0,0.08)] ring-1 ring-black/5 dark:shadow-none dark:ring-white/10'
                : 'bg-transparent text-(--solus-text-tertiary) hover:text-(--solus-text-secondary)'}"
              onclick={() => (view = "list")}
              aria-pressed={view === "list"}
              aria-label="List view"
              title="List view"
            >
              <ListIcon size={13} weight="bold" />
            </button>
            <button
              type="button"
              class="grid size-6 cursor-pointer place-items-center rounded-full border-0 transition-[background-color,color] duration-100 ease-in-out {view ===
              'board'
                ? 'bg-(--solus-input-pill-bg) text-(--solus-text-primary) shadow-[0_0.0625rem_0.1875rem_rgba(0,0,0,0.08)] ring-1 ring-black/5 dark:shadow-none dark:ring-white/10'
                : 'bg-transparent text-(--solus-text-tertiary) hover:text-(--solus-text-secondary)'}"
              onclick={() => (view = "board")}
              aria-pressed={view === "board"}
              aria-label="Board view"
              title="Board view"
            >
              <KanbanIcon size={13} weight="bold" />
            </button>
          </div>
          <button
            type="button"
            class={PAGE_ICON_BTN}
            onclick={refresh}
            disabled={!cwd || !configReady || store.loading}
            aria-label="Refresh tasks"
            title="Refresh"
          >
            <ArrowClockwiseIcon
              size={14}
              class={store.loading ? "animate-spin [animation-duration:0.9s]" : ""}
            />
          </button>
          {#if canCreate}
            <button
              type="button"
              class={PAGE_PRIMARY_BTN}
              onclick={() => (composing = { parentId: undefined })}
            >
              <PlusIcon size={13} weight="bold" />
              <span>New</span>
            </button>
          {/if}
        {/snippet}
      </PageHeader>

      <TaskFilters
        bind:query
        bind:status={statusFilter}
        bind:assignedToMe
        bind:sort
        bind:searchEl
        {counts}
        showStatus={view === "list"}
      />

    <!-- Body -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      bind:this={bodyEl}
      onkeydown={onBodyKeydown}
    >
      {#if !cwd}
        <div class="flex flex-col items-center justify-center gap-2 px-4 py-16 text-center">
          <p class="text-base font-semibold text-(--solus-text-primary)">
            Open a project to see its tasks.
          </p>
          <p class="max-w-[25rem] text-[0.8125rem] leading-[1.55] text-(--solus-text-tertiary)">
            Tasks come from the active project's provider — GitHub Issues, or the
            built-in local task list.
          </p>
        </div>
      {:else if !configReady || (!store.loaded && store.loading)}
        {#if view === "board"}
          <TaskBoardSkeleton />
        {:else}
          <div class="flex flex-col items-center justify-center gap-[0.4375rem] px-4 py-16 text-center">
            <CircleNotchIcon
              size={20}
              class="animate-spin text-(--solus-text-tertiary) [animation-duration:0.9s]"
            />
          </div>
        {/if}
      {:else if providerHealth && !providerHealth.ok}
        <div class="flex flex-col items-center justify-center gap-2 px-4 py-16 text-center">
          <WarningCircleIcon size={28} class="text-(--solus-text-tertiary)" />
          <p class="text-balance text-base font-semibold text-(--solus-text-primary)">
            {providerHealth.reason === "github_not_connected"
              ? "Connect GitHub to see tasks."
              : "Finish task setup for this project."}
          </p>
          <p class="max-w-[25rem] text-[0.8125rem] leading-[1.55] text-(--solus-text-tertiary)">
            {providerHealth.message}
          </p>
          <button
            type="button"
            class="mt-2 inline-flex cursor-pointer items-center gap-1.5 rounded-[0.4375rem] border-0 bg-(--solus-accent-light) px-3 py-[0.4375rem] text-xs font-semibold text-(--solus-accent) hover:bg-[color-mix(in_srgb,var(--solus-accent-light)_100%,var(--solus-accent)_14%)] focus-visible:outline-none"
            onclick={providerHealth.reason === "github_not_connected"
              ? () => openProviderRepair()
              : refresh}
          >
            {#if providerHealth.reason === "github_not_connected"}
              <PlugIcon size={13} weight="bold" />
              Connect GitHub
            {:else}
              <ArrowClockwiseIcon size={13} />
              Retry
            {/if}
          </button>
        </div>
      {:else if store.error}
        <PageEmpty
          icon={isAuthError ? PlugIcon : WarningCircleIcon}
          tone={isAuthError ? "accent" : "muted"}
          title={isAuthError ? "Connect GitHub to see tasks." : "Couldn't load tasks."}
        >
          {isAuthError
            ? "This project reads issues from its GitHub remote. Connect your account to browse and update them."
            : displayError}
          {#snippet actions()}
            {#if isAuthError}
              <button
                type="button"
                class={PAGE_PRIMARY_BTN}
                onclick={() => session.showSettings("api-access")}
              >
                <PlugIcon size={13} weight="bold" />
                Connect GitHub
              </button>
            {:else}
              <button type="button" class={PAGE_SECONDARY_BTN} onclick={refresh}>
                <ArrowClockwiseIcon size={13} />
                Retry
              </button>
            {/if}
          {/snippet}
        </PageEmpty>
      {:else if store.tasks.length === 0}
        {#if canCreate}
          <PageEmpty icon={ListChecksIcon} title="No tasks yet.">
            Create {allowEpics ? "a task or epic" : "a task"}, then start a
            session from it to give the agent its full context.
            {#snippet actions()}
              <button
                type="button"
                class={PAGE_PRIMARY_BTN}
                onclick={() => (composing = { parentId: undefined })}
              >
                <PlusIcon size={13} weight="bold" />
                <span>{provider === "github" ? "New issue" : "New task"}</span>
              </button>
              {#if provider === "local"}
                <button
                  type="button"
                  class={PAGE_SECONDARY_BTN}
                  onclick={() => void switchTaskProvider("github")}
                >
                  <PlugIcon size={13} weight="bold" />
                  <span>Connect a task provider</span>
                </button>
              {/if}
            {/snippet}
          </PageEmpty>
        {:else}
          <PageEmpty icon={ListChecksIcon} title="No tasks yet.">
            When this project's provider has tickets, they'll show up here —
            start a session from any one to give the agent its full context.
          </PageEmpty>
        {/if}
      {:else if view === "board"}
        <TaskBoard
          tasks={store.tasks}
          {query}
          {sort}
          {onOpen}
          {onStart}
          {onOpenLink}
          {onSetStatus}
          onResume={onResume}
          {sessionsFor}
          onAddInColumn={canCreate
            ? (status) => (composing = { status })
            : undefined}
        />
      {:else if groups.length === 0}
        <PageEmpty title="No tasks match.">
          Try a different search or filter.
          {#snippet actions()}
            <button type="button" class={PAGE_SECONDARY_BTN} onclick={clearFilters}>
              Clear filters
            </button>
          {/snippet}
        </PageEmpty>
      {:else}
        {#each groups as group (group.epic?.id ?? "__standalone")}
          {#if group.epic}
            <EpicGroup
              epic={group.epic}
              childTasks={group.children}
              {onOpen}
              onOpenEpic={onOpen}
              {onStart}
              {onOpenLink}
              {onSetStatus}
              {onResume}
              {sessionsFor}
              {canCreate}
              {onAddChild}
              selectable
            />
          {:else}
            <ul class="flex flex-col gap-0" role="list" aria-label="Tasks">
              {#each group.children as task (task.id)}
                <li out:fade={{ duration: 120 }}>
                  <TaskCard
                    {task}
                    {onOpen}
                    {onStart}
                    {onOpenLink}
                    {onSetStatus}
                    {onResume}
                    activeSessions={sessionsFor(task.id)}
                    selectable
                  />
                </li>
              {/each}
            </ul>
          {/if}
        {/each}
      {/if}
    </div>
    </PageShell>

    <!-- Bulk action bar (list view) — floats over the list while a selection is held -->
    {#if view === "list" && selection.size > 0}
      <div
        class="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center px-4"
      >
        <div
          class="pointer-events-auto flex items-center gap-1.5 rounded-full border border-(--solus-popover-border) bg-(--solus-popover-bg) px-2 py-1.5 shadow-[var(--solus-popover-shadow)]"
          role="toolbar"
          aria-label="Bulk actions"
        >
          <span class="px-1.5 text-[0.75rem] font-semibold text-(--solus-text-primary) tabular-nums">
            {selection.size} selected
          </span>
          <span class="h-4 w-px bg-(--solus-container-border)" aria-hidden="true"></span>
          {#each BOARD_COLUMNS as col (col.status)}
            <button
              type="button"
              class="inline-flex cursor-pointer items-center gap-1 rounded-full border-0 bg-transparent px-2 py-1 text-[0.6875rem] font-medium text-(--solus-text-secondary) transition-colors duration-100 hover:bg-(--solus-surface-hover)"
              onclick={() => bulkSetStatus(col.status)}
              title={`Set ${col.label}`}
            >
              <span class="block size-2 rounded-full {STATUS_META[col.status].dotClass}"></span>
              {col.label}
            </button>
          {/each}
          {#if canDelete}
            <span class="h-4 w-px bg-(--solus-container-border)" aria-hidden="true"></span>
            <button
              type="button"
              class="inline-flex cursor-pointer items-center gap-1 rounded-full border-0 bg-transparent px-2 py-1 text-[0.6875rem] font-medium text-[#cf222e] transition-colors duration-100 hover:bg-[#cf222e]/10 [.dark_&]:text-[#f85149] [.dark_&]:hover:bg-[#f85149]/10"
              onclick={bulkDelete}
              title="Delete selected"
            >
              <TrashIcon size={12} />
              Delete
            </button>
          {/if}
          <span class="h-4 w-px bg-(--solus-container-border)" aria-hidden="true"></span>
          <button
            type="button"
            class="cursor-pointer rounded-full border-0 bg-transparent px-2 py-1 text-[0.6875rem] font-medium text-(--solus-text-tertiary) transition-colors duration-100 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-secondary)"
            onclick={() => selection.selectAllVisible()}
            title="Select all visible"
          >
            All
          </button>
          <button
            type="button"
            class="cursor-pointer rounded-full border-0 bg-transparent px-2 py-1 text-[0.6875rem] font-medium text-(--solus-text-tertiary) transition-colors duration-100 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-secondary)"
            onclick={() => selection.clear()}
            title="Clear selection (Esc)"
          >
            Clear
          </button>
        </div>
      </div>
    {/if}
    {/if}

    {#if composing}
      <TaskComposer
        {epics}
        {allowEpics}
        canPlan={canPlanOnCreate}
        {knownLabels}
        workingDirectory={cwd ?? undefined}
        provider={session.settings.activeAgent}
        initialParentId={composing.parentId}
        initialStatus={composing.status}
        {onCreate}
        onCancel={() => (composing = null)}
      />
    {/if}
  </div>
{/if}
