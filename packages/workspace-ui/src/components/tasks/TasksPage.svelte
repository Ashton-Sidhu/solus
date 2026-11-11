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
  import { TASKS_AUTH_ERROR_PREFIX, type TaskMoveTarget } from "@solus/contracts/task-types";
  import type { Task } from "../../contexts/tasks/task.svelte";
  import TaskSourceSetup from "./sources/TaskSourceSetup.svelte";
  import TaskSourceSwitcher from "./TaskSourceSwitcher.svelte";
  import TasksBulkBar from "./TasksBulkBar.svelte";
  import {
    getSurfaceContext,
    getSessionSidebarStore,
    taskSourcesStore,
    runtime,
    projectsStore,
    serversStore,
    workspaceProjectsStore,
  } from "../../contexts";
  import { isRepositoryKey } from "@solus/contracts/repository-key";
  import { Button } from "../ui/button";
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
  import { ProviderTaskSearch } from "./lib/provider-search.svelte";
  import type { TaskComposerInput } from "./lib/task-composer";
  import { PAGE_PRIMARY_BTN, PAGE_SECONDARY_BTN } from "../../lib/page-chrome";
  import {
    ListEmpty,
    ListFilterBar,
    ListProjectFilter,
    ListPage,
    ListSelection,
    ListFilterGroup,
    ListSortMenu,
    ListSkeleton,
    type ListFilterSpec,
    type ListProjectOption,
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
  // row, the sidebar's live projects, and the page's close need a workspace.
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

  // ── Project scope ──
  // The page owns its scope (docs/plans/project-model.md §5): a project — a
  // repository, or a local-only folder — and one checkout of it for the facts
  // only a host holds. The tab in focus never sets it.
  const pageKey = $derived(
    session.projectPageScope.kind === "project" ? session.projectPageScope.key : null,
  );
  const pageProject = $derived(
    session.projectPageScope.kind === "project" ? session.projectPageScope.checkout : null,
  );
  // With no page scope every project's tasks show; a task made there files
  // where the input bar's project would.
  const taskContext = $derived(
    pageKey
      ? session.taskContextForProject(pageProject)
      : session.taskCreationContext,
  );
  // Host-side facts — the project's configuration and its task sources — are
  // read through one checkout on one host.
  const hostCheckout = $derived(pageProject);
  const cwd = $derived(hostCheckout?.projectRoot ?? null);
  // One row per project, never one per host.
  const projectOptions = $derived<ListProjectOption[]>(session.projectScopeOptions);
  const activeProjectOptionKey = $derived(pageKey ?? "");
  // "All projects" is the projects the session sidebar shows. A surface with
  // no sidebar — the workspace service alone — has every known project.
  const sidebarProjectKeys = $derived(
    new Set(
      sessionSidebar
        ? sessionSidebar.projectFilterChoices.map((choice) => choice.key)
        : session.logicalProjects.map((project) => project.key),
    ),
  );
  // A project's tasks: the tasks that its task sources list. Across every
  // project, the same list for each of them.
  const projectTasks = $derived(
    pageKey ? store.tasksInProject(pageKey) : store.tasksInProjects(sidebarProjectKeys),
  );
  const projectLabels = $derived(
    new Map([
      ...session.logicalProjects.map((project) => [project.key, project.label] as const),
      ...(sessionSidebar?.projectFilterChoices.map((choice) => [choice.key, choice.label] as const) ?? []),
    ]),
  );
  function projectLabelFor(taskId: string): string | null {
    if (pageKey) return null;
    // One source can be in many projects; a row has room to name one of them.
    const projectKey = store.projectKeysOf(store.get(taskId)).find((key) => projectLabels.has(key));
    return projectKey ? (projectLabels.get(projectKey) ?? null) : null;
  }
  // Across every project a card names its project, beside where it lives.
  function rowHomeFor(taskId: string): string | null {
    return [projectLabelFor(taskId), homeFor(taskId)].filter(Boolean).join(" · ") || null;
  }
  // The host of the checkout host-side facts are read through; never the
  // default host, which a bare path would have fallen back to.
  const projectServerId = $derived(hostCheckout?.serverId ?? null);

  // ── Task sources ──
  // The sources of the project on screen. Every project together has no
  // switcher: columns of different projects' sources do not line up.
  const projectSources = $derived(taskSourcesStore.sourcesOfProject(pageKey));
  // The scoped project's own answer. Null until its host answers.
  const checkoutSources = $derived(taskSourcesStore.sourcesFor(projectServerId, cwd));
  const sourcesError = $derived(taskSourcesStore.errorFor(projectServerId));
  const hasNoSource = $derived(!!hostCheckout && !!checkoutSources && projectSources.length === 0);

  // Machines that hold a checkout of the scoped project but are not connected:
  // the tasks of a source that only such a machine lists are missing from the
  // list, and the page says so rather than read as empty.
  const offlineCheckoutHosts = $derived(
    pageKey
      ? [
          ...new Set(
            projectsStore
              .checkoutsOf(pageKey)
              .filter((checkout) => serversStore.readinessFor(checkout.serverId).readiness !== "ready")
              .map((checkout) => serversStore.hostFor(checkout.serverId)?.label ?? checkout.serverId),
          ),
        ]
      : [],
  );

  // A repository becomes one of the organization's projects when a member adds
  // it (docs/plans/project-model.md §2).
  const cloudServerId = $derived(serversStore.activeCloudServerId);
  const canAddToCloud = $derived(
    !!workspace &&
      !!pageKey &&
      isRepositoryKey(pageKey) &&
      !!cloudServerId &&
      serversStore.readinessFor(cloudServerId).readiness === "ready" &&
      !workspaceProjectsStore.projectFor(cloudServerId, pageKey),
  );
  let addingToCloud = $state(false);
  async function addProjectToCloud() {
    if (!pageKey || !cloudServerId || addingToCloud) return;
    addingToCloud = true;
    try {
      await workspaceProjectsStore.add(cloudServerId, pageKey);
      toasts.success("Added to Solus Cloud", {
        description: "Every member now sees this project and its pull requests.",
      });
    } catch (error) {
      toasts.error("Couldn't add the project to Solus Cloud", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      addingToCloud = false;
    }
  }

  // A new task is created on the provider, in a source of one project.
  const createSources = $derived(
    taskContext
      ? (taskSourcesStore.sourcesFor(taskContext.serverId, taskContext.projectKey) ?? null)
      : null,
  );
  const canCreate = $derived(!!taskContext && !!createSources?.sources.length);

  // ── List-view multi-select ──
  const selection = new ListSelection();
  // The composer: open for a new task, with the column it was opened from on a
  // board. Null = closed. It creates in the page's current project, so a
  // project switch keeps the composer and its draft open for the new project.
  let composing = $state<{ columnId?: string } | null>(null);
  // Existing labels across the project, offered as composer suggestions.
  const knownLabels = $derived(
    Array.from(new Set(projectTasks.flatMap((t) => t.labels))).sort(),
  );

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
    const wake = nextTaskWake(projectTasks, now);
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
    tasks: () => projectTasks,
    sources: () => projectSources,
    now: () => now,
    runningSessionsFor,
    projectLabelFor,
    homeFor,
    showsEveryProject: () => !pageKey,
    providerSearch,
  });
  // A truncated source did not list every task, so filtering what is loaded
  // answers "of the tasks the host read" while looking like it answered "in
  // the project". The search text then goes to the provider too.
  $effect(() => {
    const target = open && view.truncated && cwd && projectServerId ? { serverId: projectServerId, cwd } : null;
    const text = view.query;
    untrack(() => {
      if (target) providerSearch.request(target.serverId, target.cwd, text);
      else providerSearch.clear();
    });
  });

  // On a source's own board the task is created in that source; else in the
  // project's default source.
  const composerSourceKey = $derived(
    view.source && createSources?.sources.some((source) => source.sourceKey === view.source?.sourceKey)
      ? view.source.sourceKey
      : createSources?.defaultSourceKey,
  );

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
    if (!splitList) session.setProjectPageScope({ kind: "all" });
  }

  const refreshing = $derived(store.loading || taskSourcesStore.refreshing);
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

  // Through the store, not the project's list: a row can be a task that only
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
  // (`composeNewTask`): open the composer when the project's sources are known.
  // A project with no source opens no composer; the page then shows the source
  // setup, which is the step that is missing.
  $effect(() => {
    if (!open || !workspace?.taskComposerRequested) return;
    if (taskContext && !createSources) return;
    workspace.taskComposerRequested = false;
    if (canCreate) composing = {};
  });

  // ── Data loading ──
  // The tasks come with each host's snapshot; the sources say which of them
  // the project shows. The scoped checkout is named, because the host's
  // project list may not hold it.
  $effect(() => {
    if (!open) return;
    const serverId = projectServerId;
    const projectRoot = cwd;
    // The reads start from this effect, but their own state is not what it
    // waits on: only the page being open and its scope start a read.
    untrack(() => {
      void store.load();
      if (serverId && projectRoot) void taskSourcesStore.loadHost(serverId, { cwd: projectRoot });
      else void taskSourcesStore.load();
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
  // The one explicit way to scope the page to the input bar's project; the tab
  // in focus never does it by itself (docs/plans/project-model.md §5).
  useKeybinding("tasks.current-project", () => {
    session.scopePageToCurrentProject();
  }, { enabled: () => open });
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
  // The global binding, taken over while this page is up: the composer must
  // target the project the header is pinned to, not the active session's.
  useKeybinding("global.new-task", () => startNewTask(), {
    enabled: () => open && canCreate,
  });
  function close() {
    workspace?.router.close("tasks");
    requestInputFocus();
  }

  // A different project is a different list, so nothing about how the old one
  // was being read survives the switch — except an open composer, which now
  // creates in the new project. The load effect keys off `cwd` and reads on
  // its own.
  function selectProject(option: ListProjectOption) {
    if (!option.available) return;
    session.scopePageToProject(option.key);
    view.clearFilters();
    view.showSource(null);
    selection.clear();
    selectedKey = null;
    openTaskId = null;
    if (composing === null) void tick().then(() => searchEl?.focus());
  }

  let observedPageScopeKey = "";
  $effect(() => {
    if (!open) return;
    const nextKey = pageKey ?? "all";
    if (observedPageScopeKey === nextKey) return;
    observedPageScopeKey = nextKey;
    view.clearFilters();
    view.showSource(null);
    selection.clear();
    selectedKey = null;
    openTaskId = null;
    if (composing === null) void tick().then(() => searchEl?.focus());
  });

  function removeProject(option: ListProjectOption) {
    void projectsStore.removeProject(option.key);
  }

  // A person's refresh: each host reads its sources from the provider again,
  // and says when the read ends.
  function refresh() {
    if (refreshing) return;
    void store.load();
    if (projectServerId && cwd) void taskSourcesStore.loadHost(projectServerId, { refresh: "force", cwd });
    else void taskSourcesStore.load({ refresh: "force" });
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

  async function onCreate(input: TaskComposerInput) {
    if (!taskContext) return;
    try {
      await store.create({ ...input, cwd: taskContext.projectKey }, taskContext.serverId);
    } catch (err) {
      toastTaskError("create the task", err);
      // Rethrow so the composer keeps the modal (and the user's draft) open; the
      // composer owns dismissal on success so "Create more" can stay open.
      throw err;
    }
  }
</script>

<!-- Where this project's tasks come from, and the one place to change it. It
     sits on the crumb line so a project that has sources can still change
     them; the empty state renders the same control, because that is the moment
     the question is actually being asked. -->
{#snippet sourceControl()}
  {#if cwd && projectServerId}
    <TaskSourceSetup serverId={projectServerId} {cwd} onChanged={() => void store.load()} />
  {/if}
  {#if canAddToCloud}
    <Button variant="ghost" size="sm" disabled={addingToCloud} onclick={() => void addProjectToCloud()}>
      Add to Solus Cloud
    </Button>
  {/if}
{/snippet}

{#snippet filterBar()}
  <ListFilterBar
    bind:query={view.query}
    bind:searchEl
    compactText
    placeholder={splitList ? "Search tasks…" : "Search tasks, labels, assignees…"}
    {filters}
    activeCount={Number(!view.boardLayout && !isOpenColumnFilter(view.columns, view.columnIds)) + Number(!splitList && !!activeProjectOptionKey)}
    onClearFilters={clearMenuFilters}
  >
    {#snippet filterContent()}
      <!-- The project list reads one project; "All projects" reads every
           project the session sidebar shows. The split rail leaves this out:
           changing project there would replace the queue the reader is
           navigating from. -->
      {#if !splitList}
        <ListProjectFilter
          projects={projectOptions}
          activeKey={activeProjectOptionKey}
          onSelect={selectProject}
          onSelectAll={() => session.setProjectPageScope({ kind: "all" })}
          onSelectCurrent={() => session.scopePageToCurrentProject()}
          onRemoveProject={workspace ? removeProject : undefined}
        />
      {/if}
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
      {#if pageKey && projectSources.length > 1 && !splitList}
        <TaskSourceSwitcher sources={projectSources} sourceKey={view.source?.sourceKey ?? null} onSelect={selectViewSource} />
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
      actions={sourceControl}
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
      filters={filterBar}
      contentOwnsScroll
      bind:contentHeight
    >
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <!-- The board owns the full scroll region and scrolls per column, so in
           that layout the body becomes a flex column the board can fill. -->
      <div
        bind:this={listEl}
        class={view.boardLayout ? "flex h-full min-h-0 flex-col" : ""}
        onkeydown={onBodyKeydown}
        role="presentation"
      >
        {#if offlineCheckoutHosts.length > 0}
          <p class="px-4 pt-2 text-workspace-chrome text-muted-foreground" role="status">
            {offlineCheckoutHosts.join(", ")}
            {offlineCheckoutHosts.length === 1 ? "is" : "are"} offline. Tasks that only
            {offlineCheckoutHosts.length === 1 ? "that machine reads" : "those machines read"} appear when
            {offlineCheckoutHosts.length === 1 ? "it reconnects" : "they reconnect"}.
          </p>
        {/if}
        <!-- A source that cannot be read, or that holds more tasks than the
             host read. Said above the rows it explains; the source setup on
             the crumb line is where a person repairs it. -->
        {#each view.notices as notice (notice.sourceKey)}
          <p
            class="px-4 pt-2 text-workspace-chrome {notice.tone === 'failure'
              ? 'text-(--failure)'
              : 'text-muted-foreground'}"
            role="status"
          >
            {notice.text}
          </p>
        {/each}
        {#if (!store.loaded && store.loading) || (!!hostCheckout && !checkoutSources && !sourcesError) || (refreshing && projectTasks.length === 0 && !hasNoSource)}
          {#if view.boardLayout}
            <TaskBoardSkeleton />
          {:else}
            <ListSkeleton identWidth={62} />
          {/if}
        {:else if displayError && projectTasks.length === 0}
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
        {:else if hasNoSource}
          <!-- GitHub and Jira own every task, so a project with no task source
               has no tasks. The empty state is the source setup. -->
          <PageEmpty icon={TaskIcon} title="No task source.">
            Tasks come from GitHub and Jira. Add a GitHub repository, a GitHub
            Project, a Jira project or a Jira board to this project.
            {#snippet actions()}
              {@render sourceControl()}
            {/snippet}
          </PageEmpty>
        {:else if projectTasks.length === 0 && view.searched.length === 0}
          <PageEmpty icon={TaskIcon} title="No tasks yet.">
            {#if !pageKey}
              Tasks from the task sources of the projects your session sidebar
              shows appear here.
            {:else if !hostCheckout}
              No connected machine has this project, so its task sources cannot
              be read.
            {:else}
              The task sources of this project list no task. Create one, then
              start a session from it to give the agent its full context.
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
              {@render sourceControl()}
            {/snippet}
          </PageEmpty>
        {:else if view.boardLayout}
          <TaskBoard
            tasks={view.visibleTasks}
            homeFor={rowHomeFor}
            view={view.board}
            projectKey={pageKey}
            canReorder={!!pageKey && view.boardUnfiltered}
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
        {:else if view.groups.length === 0}
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

    {#if composing && taskContext && createSources}
      <TaskComposer
        sources={createSources.sources}
        initialSourceKey={composerSourceKey}
        initialColumnId={view.source ? composing.columnId : undefined}
        {knownLabels}
        workingDirectory={taskContext.workingDirectory}
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
