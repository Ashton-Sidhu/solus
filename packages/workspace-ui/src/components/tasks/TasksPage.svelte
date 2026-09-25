<script lang="ts">
  import { serverConnections } from "@solus/client-core/server-connections";
  import { localApi } from "@solus/client-core/local-api";
  import { tick } from "svelte";
  import { fly } from "svelte/transition";
  import {
    RotateCw as ArrowClockwiseIcon,
    CalendarX as CalendarXIcon,
    Columns3Cog as KanbanIcon,
    ListChecks as ListChecksIcon,
    List as ListIcon,
    Plus as PlusIcon,
    Activity as PulseIcon,
    Trash2 as TrashIcon,
    CircleAlert as WarningCircleIcon,
    Dot as DotOutlineIcon,
    Check as CheckIcon,
    CircleDashed as CircleDashedIcon,
    ChevronDown as CaretDownIcon,
  } from "@lucide/svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import {
    TASKS_AUTH_ERROR_PREFIX,
    type Task,
    type TaskStatus,
    type TaskPriority,
  } from "@solus/contracts/task-types";
  import type { ProjectConfig } from "@solus/contracts/types";
  import TaskProviderPicker from "./provider/TaskProviderPicker.svelte";
  import type { TaskProviderChoice } from "./provider/lib/task-provider";
  import {
    atlassianStore,
    getSurfaceContext,
    getProjectConfigStore,
    getSessionSidebarStore,
    runtime,
    projectsStore,
    serversStore,
    workspaceProjectsStore,
  } from "../../contexts";
  import { isRepositoryKey } from "@solus/contracts/repository-key";
  import { Button } from "../ui/button";
  import { toasts } from "../../lib/toasts";
  import {
    TasksSelectionStore,
    setTasksSelection,
  } from "./tasks-selection.store.svelte";
  import {
    useKeybinding,
    useScope,
  } from "../../lib/keybindings/use-keybinding.svelte";
  import { comboHint } from "../../lib/keybindings/manifest";
  import { requestInputFocus } from "../../lib/inputFocus";
  import {
    STATUS_META,
    BOARD_COLUMNS,
    DEFAULT_TASK_SORT,
    sortTasks,
    type TaskSort,
  } from "./lib/tasks-api";
  import {
    OPEN_TASK_STATUS_KEYS,
    TASK_STATUS_GROUPS,
    taskGroups,
    taskStatusesFor,
  } from "./lib/tasks-list-view";
  import { PAGE_PRIMARY_BTN, PAGE_SECONDARY_BTN } from "../../lib/page-chrome";
  import {
    ListEmpty,
    ListFilterBar,
    ListProjectFilter,
    ListGroup,
    ListPage,
    ListRailRow,
    ListRow,
    ListFilterGroup,
    ListSortMenu,
    ListSkeleton,
    VirtualList,
    LIST_GROUP_HEADER_HEIGHT,
    listRowHeight,
    virtualGroupItems,
    type ListFilterSpec,
    type ListProjectOption,
    type ListRowPlace,
    type ListStatusOption,
  } from "../ui/list-page";
  import { isStackedPane } from "../../lib/pane-width";
  import PageEmpty from "../ui/PageEmpty.svelte";
  import TaskComposer from "./TaskComposer.svelte";
  import TaskListRow from "./TaskListRow.svelte";
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
  const projectConfig = getProjectConfigStore();
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
      ? session.taskContextForProject(pageKey, pageProject)
      : session.taskCreationContext,
  );
  // Host-side facts — the project's configuration, its task provider, its
  // provider tickets — are read through one checkout on one host.
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
        ? sessionSidebar.projectFilterChoices.map((choice) => choice.projectKey)
        : session.logicalProjects.map((project) => project.key),
    ),
  );
  // A project's tasks: its cloud tasks and the host tasks of every checkout of
  // it, on any host. Across every project, the same list for each of them.
  const projectTasks = $derived(
    pageKey ? store.tasksInProject(pageKey) : store.tasksInProjects(sidebarProjectKeys),
  );
  const projectLabels = $derived(
    new Map([
      ...(sessionSidebar?.projectFilterChoices.map((choice) => [choice.projectKey, choice.label] as const) ?? []),
      ...session.logicalProjects.map((project) => [project.key, project.label] as const),
    ]),
  );
  function projectLabelFor(taskId: string): string | null {
    if (pageKey) return null;
    const projectKey = store.projectKeyOf(store.get(taskId));
    return projectKey ? (projectLabels.get(projectKey) ?? null) : null;
  }
  // Across every project a card names its project, beside where it lives.
  function rowHomeFor(taskId: string): string | null {
    return [projectLabelFor(taskId), homeFor(taskId)].filter(Boolean).join(" · ") || null;
  }
  // The host of the checkout host-side facts are read through; never the
  // default host, which a bare path would have fallen back to.
  const projectServerId = $derived(hostCheckout?.serverId ?? null);
  const projectHost = $derived(
    projectServerId
      ? {
          serverId: projectServerId,
          api: serverConnections.apiFor(projectServerId),
        }
      : null,
  );

  // Machines that hold a checkout of the scoped project but are not connected:
  // their host-only tasks are missing from the list, and the page says so
  // rather than read as empty (docs/plans/project-model.md §4).
  const offlineCheckoutHosts = $derived(
    pageKey
      ? [
          ...new Set(
            projectsStore
              .checkoutsOf(pageKey)
              .filter((checkout) => serversStore.statusFor(checkout.serverId) !== "online")
              .map((checkout) => serversStore.hostFor(checkout.serverId)?.label ?? checkout.serverId),
          ),
        ]
      : [],
  );

  // A repository becomes one of the organization's projects when a member adds
  // it (docs/plans/project-model.md §2); its new tasks then live in the cloud.
  const cloudServerId = $derived(serversStore.activeCloudServerId);
  const canAddToCloud = $derived(
    !!workspace &&
      !!pageKey &&
      isRepositoryKey(pageKey) &&
      !!cloudServerId &&
      serversStore.statusFor(cloudServerId) === "online" &&
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

  let configReady = $state(false);
  let taskLoadEpoch = 0;
  const canCreate = $derived(!!taskContext);

  // ── List-view multi-select ── owned by a context store so the selection isn't
  // threaded through the row components.
  const selection = new TasksSelectionStore();
  setTasksSelection(selection);
  // Composer state: null = closed; an object opens it (with an optional preset
  // status when adding into a board column).
  let composing = $state<{
    status?: TaskStatus;
    context: NonNullable<typeof taskContext>;
  } | null>(null);
  // The task the plain "New task" flow just created, handed off to its own page
  // once the composer closes. The inline flow (adding into a board column) stays
  // on the list, so it leaves this null.
  let createdForNavigation: string | null = null;
  // Detail view: the task whose full ticket (body, comments, PRs) is open.
  // Existing labels across the project, offered as composer suggestions.
  const knownLabels = $derived(
    Array.from(new Set(projectTasks.flatMap((t) => t.labels))).sort(),
  );

  // ── View state ──
  // One grouped list, for one project or every project. `layout` re-plots it
  // as a kanban board.
  let layout = $state<"list" | "board">("list");
  const boardLayout = $derived(layout === "board");
  let query = $state("");
  let sort = $state<TaskSort>(DEFAULT_TASK_SORT);
  let runningOnly = $state(false);
  let overdueOnly = $state(false);
  let assignedOnly = $state(false);
  // Which lifecycle states the list is showing. Opens on live
  // work only, so finished and dropped tasks stay out of the way until asked
  // for. The board is exempt — its columns *are* this filter, and a kanban
  // whose last column is always empty reads as broken.
  let statusKeys = $state<string[]>([...OPEN_TASK_STATUS_KEYS]);
  const statuses = $derived(taskStatusesFor(statusKeys));
  let searchEl = $state<HTMLInputElement | null>(null);
  let listEl = $state<HTMLDivElement | null>(null);
  let contentHeight = $state(0);
  let pageWidth = $state(0);
  let selectedKey = $state<string | null>(null);
  let revealedTaskId = $state<string | null>(null);
  let openTaskId = $state<string | null>(null);
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
    { value: "created", label: "Created" },
    { value: "updated", label: "Updated" },
    { value: "priority", label: "Priority" },
    { value: "due", label: "Due" },
  ];

  const providerStatus = $derived(store.providerStatus(cwd));
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
  // The provider search the loaded rows answer, if any.
  const upstreamQuery = $derived(
    cwd ? (store.upstreamQueryByProject.get(cwd) ?? "") : "",
  );
  // Once the provider list is capped, filtering what is loaded answers "of the
  // 200 most recent" while looking like it answered "in the project". Send the
  // text to the provider instead — and keep doing so until the search is
  // cleared, or clearing it would leave the search results on screen.
  $effect(() => {
    if (!open || !cwd) return;
    if (!upstreamTruncated && !upstreamQuery) return;
    if (projectServerId) store.searchUpstream(projectServerId, cwd, query);
  });
  const displayError = $derived(
    (store.error ?? upstreamError)?.replace(TASKS_AUTH_ERROR_PREFIX, "") ?? null,
  );

  // Tick the clock so relative row times ("12m") age instead of freezing at the
  // moment the list loaded.
  let now = $state(Date.now());
  $effect(() => {
    if (!open) return;
    const interval = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(interval);
  });

  // Running, not linked: a link outlives the agent that worked on it.
  function runningSessionsFor(taskId: string): number {
    const task = store.get(taskId);
    return task.sessions.filter((link) =>
      store.isAttemptRunning(link, task.serverId, (sessionId, serverId) =>
        session.sessionForAgentSession(sessionId, serverId),
      ),
    ).length;
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
    if (runningOnly) rows = rows.filter((task) => runningSessionsFor(task.id) > 0);
    if (overdueOnly) rows = rows.filter(isOverdue);
    if (assignedOnly) rows = rows.filter((task) => !!task.assignee);
    return sortTasks(rows, sort);
  });

  // The board's manual order renumbers the column a card lands in, so it only
  // means anything when `visibleTasks` *is* the board. (The status filter is
  // exempt — the board already ignores it.)
  const boardUnfiltered = $derived(
    !query.trim() && !runningOnly && !overdueOnly && !assignedOnly,
  );

  // The list is a table: project and host take one column of their own. The
  // column is drawn only when some row has something to put in it, and then on
  // every row, so the cells stay on one x.
  const showPlaceColumn = $derived(
    !pageKey || visibleTasks.some((task) => homeFor(task.id) !== null),
  );
  function rowPlaceFor(taskId: string): ListRowPlace | undefined {
    if (!showPlaceColumn) return undefined;
    return { project: projectLabelFor(taskId), host: homeFor(taskId) };
  }
  const groups = $derived(taskGroups(visibleTasks, runningSessionsFor, now, rowPlaceFor));
  const globalVirtualItems = $derived(
    virtualGroupItems(
      groups,
      (row) => row.key,
      (group) => !collapsedGroups[group.key],
    ),
  );
  const globalActiveKey = $derived(
    globalVirtualItems.find(
      (item) => item.kind === "row" && item.row.key === selectedKey,
    )?.key ?? null,
  );

  const filters = $derived<ListFilterSpec[]>([
    {
      key: "running",
      label: "Agent running",
      icon: PulseIcon,
      count: searched.filter((task) => runningSessionsFor(task.id) > 0).length,
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
      count: searched.filter((task) =>
        group.statuses.includes(task.status),
      ).length,
    })),
  );

  // Running, open and closed-this-week used to be restated here; the list's own
  // section headers already say all three and are clickable, so the counts kept
  // their filtering job and lost only the duplicate. What the headers cannot
  // say is that the answer behind these rows is incomplete — that note stays,
  // on the narrowing row, beside the search it explains.
  const truncationNote = $derived.by(() => {
    // Says where the rows came from: these are the provider's matches for the
    // search, not the slice of the list that happens to be loaded.
    if (upstreamQuery) return `searched ${providerStatus?.scopeLabel ?? "upstream"}`;
    return upstreamTruncated ? `most recent ${projectTasks.length}` : null;
  });

  // The selectable rows in render order, for Shift range-select, arrow
  // navigation, and detail-panel stepping.
  const flatVisibleIds = $derived(
    groups
      .flatMap((group) => group.rows)
      .map((row) => row.key),
  );
  $effect(() => {
    selection.setOrder(flatVisibleIds);
  });

  function taskById(id: string): Task | undefined {
    return projectTasks.find((task) => task.id === id);
  }

  const openTask = $derived(openTaskId ? (taskById(openTaskId) ?? null) : null);
  const panelOpen = $derived(openTask !== null);
  const roomForSplit = $derived(pageWidth >= 1040);
  // The record rung, for the one decision a container query cannot make: the
  // virtualiser is told a row's height as a number. Same 30rem the stylesheet
  // uses, so the layout and the positions cannot disagree.
  const recordRows = $derived(isStackedPane(pageWidth));
  const boardPanel = $derived(panelOpen && boardLayout);
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
    if (!openTaskId || flatVisibleIds.length === 0) return;
    const index = flatVisibleIds.indexOf(openTaskId);
    if (index === -1) return;
    const nextId =
      flatVisibleIds[
        (index + delta + flatVisibleIds.length) % flatVisibleIds.length
      ];
    if (!nextId) return;
    selectedKey = nextId;
    openTaskId = nextId;
  }

  function beginComposing(
    options: { status?: TaskStatus } = {},
  ) {
    if (!taskContext) return;
    createdForNavigation = null;
    composing = { ...options, context: taskContext };
  }

  // ── Data loading ──
  $effect(() => {
    if (open && !hostCheckout) {
      // Every project, or a cloud project no known host holds: no one host's
      // configuration applies, and the tasks already held are the whole list.
      configReady = true;
      void store.load();
      return;
    }
    if (!open || !cwd || !projectHost) {
      configReady = false;
      return;
    }
    const currentCwd = cwd;
    const currentHost = projectHost;
    const currentServerId = projectServerId;
    const epoch = ++taskLoadEpoch;
    configReady = false;
    void (async () => {
      await projectConfig.load(currentHost, currentCwd);
      if (
        epoch !== taskLoadEpoch ||
        !open ||
        cwd !== currentCwd ||
        projectServerId !== currentServerId
      )
        return;
      configReady = true;
      await Promise.all([
        store.load(),
        store.loadUpstream(currentCwd, { serverId: currentHost.serverId }),
        // Names the provider on the header control, and is what tells a Jira
        // project it is bound to a site the host is no longer connected to.
        store.loadProviderStatus(currentCwd, { serverId: currentHost.serverId }),
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
      else if (query) {
        query = "";
        searchEl?.focus();
      } else close();
    },
    { enabled: () => open },
  );
  // The global binding, taken over while this page is up: the composer must
  // target the project the header is pinned to, not the active session's.
  useKeybinding("global.create-task", () => beginComposing(), {
    enabled: () => open && canCreate,
  });
  function close() {
    workspace?.router.close("tasks");
    requestInputFocus();
  }

  // A different project is a different list, so nothing about how the old one
  // was being read survives the switch. The load effect keys off `cwd` and
  // refetches on its own. Picking the input bar's own project unpins, so the
  // list goes back to following it.
  function selectProject(option: ListProjectOption) {
    if (!option.available) return;
    session.scopePageToProject(option.key);
    clearFilters();
    selection.clear();
    selectedKey = null;
    openTaskId = null;
    collapsedGroups = {};
    composing = null;
    void tick().then(() => searchEl?.focus());
  }

  let observedPageScopeKey = "";
  $effect(() => {
    if (!open) return;
    const nextKey = pageKey ?? "all";
    if (observedPageScopeKey === nextKey) return;
    observedPageScopeKey = nextKey;
    clearFilters();
    selection.clear();
    selectedKey = null;
    openTaskId = null;
    collapsedGroups = {};
    composing = null;
    void tick().then(() => searchEl?.focus());
  });

  function removeProjectHistory(option: ListProjectOption) {
    projectsStore.removeProject(option.key);
  }

  // Re-read native tasks and explicitly poll the active scope.
  function refresh() {
    if (refreshing) return;
    if (!cwd || !projectServerId) {
      void store.load();
      return;
    }
    const currentCwd = cwd;
    configReady = true;
    void Promise.all([
      store.load(),
      store.loadUpstream(currentCwd, { serverId: projectServerId }),
    ]);
  }

  async function switchTaskProvider(choice: TaskProviderChoice) {
    if (!cwd || !projectHost) return;
    const currentCwd = cwd;
    const currentHost = projectHost;
    // A Jira binding is provider *and* project: saving one without the other
    // leaves a configuration that cannot sync and cannot explain why.
    const patch: Partial<ProjectConfig> = { taskProvider: choice.provider };
    if (choice.provider === "jira") {
      const providerConfig = {
        ...projectConfig.configFor(currentHost.serverId, currentCwd)
          ?.taskProviderConfig,
        projectKey: choice.projectKey,
      };
      // Pinned at bind time, so the `<cloudId>/<projectKey>` keys already
      // written keep pointing at the site they were written for.
      const cloudId = atlassianStore.status(currentHost.serverId)?.cloudId;
      if (cloudId) providerConfig.cloudId = cloudId;
      patch.taskProviderConfig = providerConfig;
    } else if (choice.provider === "github") {
      const detectedRepo = providerStatus?.detectedRepo;
      if (!detectedRepo) {
        toasts.error("Couldn't bind GitHub", {
          description: "Add a GitHub origin remote to this project first.",
        });
        return;
      }
      patch.taskProviderConfig = {
        ...projectConfig.configFor(currentHost.serverId, currentCwd)
          ?.taskProviderConfig,
        owner: detectedRepo.owner,
        repo: detectedRepo.repo,
      };
    }
    await projectConfig.save(currentHost, currentCwd, patch);
    await projectConfig.load(currentHost, currentCwd);
    void store.loadProviderStatus(currentCwd, { serverId: currentHost.serverId });
    if (cwd !== currentCwd || projectServerId !== currentHost.serverId) return;
    configReady = true;
    await Promise.all([
      store.load(),
      store.loadUpstream(currentCwd, { serverId: currentHost.serverId }),
    ]);
  }

  function onOpen(task: Task) {
    selectedKey = task.id;
    openTaskId = task.id;
  }

  // A provider ticket becomes a native task before a session can be bound to
  // it, the same as the input bar's task picker does.
  async function onStart(task: Task) {
    if (!workspace) return;
    try {
      const native = task.providerId === "local"
        ? task
        : await store.get(task.id, task.projectKey ?? undefined).promote();
      await workspace.opening.openTaskSession(native);
    } catch (error) {
      toastTaskError("start task", error);
    }
  }

  function onResume(task: Task) {
    void workspace?.opening.openTaskLinkedSession(task);
  }

  function openTaskRoute(task: Task) {
    openTaskId = null;
    session.goToTask(task.id, "click", pane.isLeading ? "leading" : "secondary");
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

  async function onSetStatus(task: Task, status: TaskStatus) {
    try {
      await store.get(task.id, task.projectKey ?? undefined).setStatus(status);
    } catch (err) {
      toastTaskError("update status", err);
    }
  }

  function deleteTasks(ids: string[], label: string) {
    const localIds = ids.filter((id) => taskById(id)?.providerId === "local");
    const pending = store.softRemove(localIds);
    if (!pending.length) return;
    toasts.undo(label, () => store.restorePending(pending), {
      // commitPending restores any rows whose delete failed; surface why.
      onDismiss: () =>
        store
          .commitPending(pending)
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


  async function bulkComplete() {
    const tasks = [...selection.ids]
      .map((id) => taskById(id))
      .filter((task): task is Task => !!task);
    selection.clear();
    for (const task of tasks) {
      try {
        await store.get(task.id).setStatus("done");
      } catch (error) {
        toastTaskError(`complete “${task.title}”`, error);
        break;
      }
    }
  }

  async function bulkMarkUnread() {
    const tasks = [...selection.ids]
      .map((id) => taskById(id))
      .filter((task): task is Task => !!task);
    selection.clear();
    if (!sessionSidebar) return;
    for (const task of tasks) await sessionSidebar.markTaskUnread(task.id);
  }

  // The board is a single-selection surface. Both list views share this one
  // selection store and the same bulk-action bar.
  $effect(() => {
    if (layout === "board" || !open) selection.clear();
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
    dueDate?: string;
    priority?: TaskPriority;
    status?: TaskStatus;
    labels?: string[];
  }) {
    if (!composing) return;
    const inline = !!composing.status;
    try {
      const created = await store.create(
        { ...input, projectKey: composing.context.projectKey },
        composing.context.serverId,
      );
      createdForNavigation = inline ? null : created.id;
    } catch (err) {
      toastTaskError("create task", err);
      // Rethrow so the composer keeps the modal (and the user's draft) open; the
      // composer owns dismissal on success so "Create more" can stay open.
      throw err;
    }
  }
</script>

<!-- Where this project files its tasks, and the only way to change it. It sits
     on the crumb line rather than the empty state so a project that already has
     tasks can still be moved — and moved back; the empty state renders the same
     control, because that is the moment the question is actually being asked. -->
{#snippet providerControl()}
  {#if cwd}
    <TaskProviderPicker
      provider={providerStatus?.provider ?? "local"}
      scopeLabel={providerStatus?.scopeLabel ?? null}
      serverId={projectServerId}
      detectedRepo={providerStatus?.detectedRepo ?? null}
      onSelect={(choice) => void switchTaskProvider(choice)}
    />
  {/if}
  {#if canAddToCloud}
    <Button variant="ghost" size="sm" disabled={addingToCloud} onclick={() => void addProjectToCloud()}>
      Add to Solus Cloud
    </Button>
  {/if}
{/snippet}

{#snippet layoutToggle()}
  <!-- The layout control re-plots the active task view rather than replacing
       it, so it stays visible beside sort. -->
  {#if !splitList}
    <div
      class="flex h-8 shrink-0 items-center gap-0.5 rounded-lg bg-[var(--wash-2)] p-1 @max-[30rem]/pane:h-10"
      role="group"
      aria-label="Layout"
    >
      <button
        type="button"
        class="grid size-6 cursor-pointer place-items-center rounded-md border-0 transition-colors @max-[30rem]/pane:size-8 {layout ===
        'list'
          ? 'bg-card text-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_12%,transparent)]'
          : 'bg-transparent text-muted-foreground hover:text-foreground'}"
        onclick={() => (layout = "list")}
        aria-pressed={layout === "list"}
        aria-label="List layout"
        title="List"
      >
        <ListIcon size={14} weight="bold" />
      </button>
      <button
        type="button"
        class="grid size-6 cursor-pointer place-items-center rounded-md border-0 transition-colors @max-[30rem]/pane:size-8 {layout ===
        'board'
          ? 'bg-card text-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_12%,transparent)]'
          : 'bg-transparent text-muted-foreground hover:text-foreground'}"
        onclick={() => (layout = "board")}
        aria-pressed={layout === "board"}
        aria-label="Board layout"
        title="Board"
      >
        <KanbanIcon size={14} weight="bold" />
      </button>
    </div>
  {/if}
{/snippet}

{#snippet filterBar()}
  <ListFilterBar
    bind:query
    bind:searchEl
    compactText
    placeholder={splitList ? "Search tasks…" : "Search tasks, labels, assignees…"}
    {filters}
    activeCount={Number(!boardLayout && statusKeys.length !== statusOptions.length) + Number(!splitList && !!activeProjectOptionKey)}
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
          onRemoveHistory={workspace ? removeProjectHistory : undefined}
        />
      {/if}
      <!-- The board plots every status as a column of its own, so a status
           filter there would only ever empty one. -->
      {#if !boardLayout}
        <ListFilterGroup label="Status" icon={CircleDashedIcon} options={statusOptions} selected={statusKeys} onChange={(next) => (statusKeys = next)} multiple showAll emptyLabel="None" />
      {/if}
    {/snippet}
    {#snippet trailing()}
      {#if truncationNote}
        <!-- Why the list is short, said where the narrowing is done. -->
        <span
          class="shrink-0 text-xs whitespace-nowrap text-muted-foreground @max-[44rem]:hidden"
          >{truncationNote}</span
        >
      {/if}
      {@render layoutToggle()}
      {#if !splitList}
        <ListSortMenu
          bind:value={sort}
          options={SORT_OPTIONS}
          ariaLabel="Sort tasks"
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
      class="mr-2 grid size-4 shrink-0 cursor-pointer place-items-center rounded border-0 text-xs transition-opacity {selection.has(
        taskId,
      )
        ? 'bg-primary text-primary-foreground opacity-100'
        : 'bg-[var(--wash-3)] text-transparent opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100'}"
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
      actions={providerControl}
      onRefresh={refresh}
      {refreshing}
      syncedAt={upstreamRefreshedAt}
      syncFromCache={upstreamFromCache}
      primaryAction={canCreate && !splitList
        ? {
            label: "New task",
            shortcut: comboHint("global.create-task"),
            run: () => beginComposing(),
          }
        : undefined}
      onMoveAcross={pane.inPane ? pane.moveAcross : undefined}
      isLeading={pane.isLeading}
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
        class={boardLayout ? "flex h-full min-h-0 flex-col" : ""}
        onkeydown={onBodyKeydown}
        role="presentation"
      >
        {#if offlineCheckoutHosts.length > 0}
          <p class="px-4 pt-2 text-workspace-chrome text-muted-foreground" role="status">
            {offlineCheckoutHosts.join(", ")}
            {offlineCheckoutHosts.length === 1 ? "is" : "are"} offline. Tasks kept only on
            {offlineCheckoutHosts.length === 1 ? "that machine" : "those machines"} appear when
            {offlineCheckoutHosts.length === 1 ? "it reconnects" : "they reconnect"}.
          </p>
        {/if}
        {#if !configReady || (!store.loaded && store.loading) || (refreshing && projectTasks.length === 0)}
          {#if boardLayout}
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
        {:else if projectTasks.length === 0}
          <PageEmpty icon={ListChecksIcon} title="No tasks yet.">
            {#if !pageKey}
              Tasks in the projects your session sidebar shows appear here.
            {:else if !hostCheckout}
              A task made in the workspace, or by an agent on a machine linked to
              this organization, appears here for everyone.
            {:else}
              Create a task, then start a
              session from it to give the agent its full context.
            {/if}
            {#snippet actions()}
              {#if canCreate}
                <button
                  type="button"
                  class={PAGE_PRIMARY_BTN}
                  onclick={() => beginComposing()}
                >
                  <PlusIcon size={14} weight="bold" />
                  <span>New task</span>
                </button>
                <!-- The same control the header carries. The old button here
                     filed in GitHub unconditionally, which a checkout with no
                     GitHub origin cannot do and a Jira project should not. -->
                {@render providerControl()}
              {/if}
            {/snippet}
          </PageEmpty>
        {:else if boardLayout}
          <TaskBoard
            tasks={visibleTasks}
            homeFor={rowHomeFor}
            projectKey={cwd}
            canReorder={!!pageKey && boardUnfiltered}
            {selectedKey}
            onOpen={(task) => {
              selectedKey = task.id;
              onOpen(task);
            }}
            {onSetStatus}
            {runningSessionsFor}
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
              globalVirtualItems[index].kind === "header"
                ? LIST_GROUP_HEADER_HEIGHT
                : listRowHeight({
                    record: recordRows,
                    split: splitList,
                    drawerRow: true,
                  })}
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
                  {#if recordRows}
                    <!-- The drawer row, not the three-line record: a task's
                         title is nearly the whole row, and a fixed height is
                         what keeps the painted row inside the slot the
                         virtualiser gave it. -->
                    {@const recordTask = taskById(item.row.key)}
                    <TaskListRow
                      row={item.row}
                      status={recordTask?.status ?? "todo"}
                      selected={selectedKey === item.row.key ||
                        selection.has(item.row.key)}
                      onSelect={() => {
                        if (recordTask) onOpen(recordTask);
                      }}
                      onSetStatus={(status) => {
                        revealedTaskId = null;
                        if (recordTask) void onSetStatus(recordTask, status);
                      }}
                      revealed={revealedTaskId === item.row.key}
                      onRevealChange={(revealed) =>
                        (revealedTaskId = revealed ? item.row.key : null)}
                      onContextMenu={(event) => {
                        if (recordTask) openTaskContextMenu(event, recordTask);
                      }}
                    >
                      {#snippet leading()}
                        {@render rowCheckbox(item.row.key)}
                      {/snippet}
                    </TaskListRow>
                  {:else if splitList}
                    <ListRailRow
                      row={item.row}
                      fallbackAvatar="solus"
                      responsiveTitle
                      showTime={false}
                      selected={selectedKey === item.row.key ||
                        selection.has(item.row.key)}
                      onSelect={() => {
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
                    </ListRailRow>
                  {:else}
                    <ListRow
                      row={item.row}
                      identWidth={62}
                      fallbackAvatar="solus"
                      responsiveTitle
                      selected={selectedKey === item.row.key ||
                        selection.has(item.row.key)}
                      onSelect={() => {
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
                {/if}
              </div>
            {/snippet}
          </VirtualList>
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
          onRequestPrevious={flatVisibleIds.length > 1
            ? () => stepPanel(-1)
            : null}
          onRequestNext={flatVisibleIds.length > 1 ? () => stepPanel(1) : null}
        />
      </div>
    {/if}

    <!-- Bulk action bar — floats over the list while a selection is held.
         ── The record rung (`@max-[30rem]/pane`) ──
         Eleven controls on one line is a desktop pill. At 393px it was wider
         than the pane, so it clipped at both edges, wrapped "In progress" onto
         two lines, and painted over the row underneath with no inset for the
         home indicator. The ladder: the count and Clear take a line of their
         own, the four status buttons collapse into one Status menu, and the
         remaining actions wrap rather than clip — a control that does not fit
         gets its own line, it never loses its label. -->
    {#if layout === "list" && selection.size > 0 && !panelOpen}
      <div
        class="pointer-events-none absolute inset-x-0 bottom-14 z-10 flex justify-center px-4 @max-[30rem]/pane:bottom-0 @max-[30rem]/pane:px-2 @max-[30rem]/pane:pb-[max(0.5rem,env(safe-area-inset-bottom,0px))]"
      >
        <div
          class="pointer-events-auto flex items-center gap-1.5 rounded-full border border-(--solus-popover-border) bg-(--solus-popover-bg) px-2 py-1.5 shadow-[var(--solus-popover-shadow)] @max-[30rem]/pane:w-full @max-[30rem]/pane:flex-col @max-[30rem]/pane:items-stretch @max-[30rem]/pane:gap-2 @max-[30rem]/pane:rounded-2xl @max-[30rem]/pane:p-2.5"
          role="toolbar"
          aria-label="Bulk actions"
        >
          <!-- `contents` keeps the wide pill one flat line; at the rung this
               becomes the header line, with Clear held to the right by the
               `order-last` that also puts it at the end of the pill. -->
          <div
            class="contents @max-[30rem]/pane:flex @max-[30rem]/pane:items-center @max-[30rem]/pane:justify-between"
          >
            <span class="px-1.5 font-medium tabular-nums whitespace-nowrap">
              {selection.size} selected
            </span>
            <button
              type="button"
              class="order-last cursor-pointer rounded-full border-0 bg-transparent px-2 py-1 text-xs font-medium whitespace-nowrap text-(--solus-text-tertiary) transition-colors duration-100 hover:bg-(--solus-surface-hover) @max-[30rem]/pane:h-9 @max-[30rem]/pane:px-3 @max-[30rem]/pane:text-workspace-chrome"
              onclick={() => selection.clear()}
              title="Clear selection (Esc)"
            >
              Clear
            </button>
          </div>
          <span
            class="h-4 w-px bg-(--solus-container-border) @max-[30rem]/pane:hidden"
            aria-hidden="true"
          ></span>
          <div
            class="contents @max-[30rem]/pane:flex @max-[30rem]/pane:flex-wrap @max-[30rem]/pane:items-center @max-[30rem]/pane:gap-1.5"
          >
            <button
              type="button"
              class="inline-flex cursor-pointer items-center gap-1 rounded-full border-0 bg-transparent px-2 py-1 text-xs font-medium whitespace-nowrap text-(--solus-text-secondary) transition-colors duration-100 hover:bg-(--solus-surface-hover) @max-[30rem]/pane:h-9 @max-[30rem]/pane:gap-1.5 @max-[30rem]/pane:px-2.5 @max-[30rem]/pane:text-workspace-chrome"
              onclick={() => void bulkComplete()}
              ><CheckIcon size={14} class="shrink-0" />Complete</button
            >
            {#if sessionSidebar}
              <button
                type="button"
                class="inline-flex cursor-pointer items-center gap-1 rounded-full border-0 bg-transparent px-2 py-1 text-xs font-medium whitespace-nowrap text-(--solus-text-secondary) transition-colors duration-100 hover:bg-(--solus-surface-hover) @max-[30rem]/pane:h-9 @max-[30rem]/pane:gap-1.5 @max-[30rem]/pane:px-2.5 @max-[30rem]/pane:text-workspace-chrome"
                onclick={() => void bulkMarkUnread()}
                ><DotOutlineIcon size={14} weight="fill" class="shrink-0" />Unread</button
              >
            {/if}
            <span
              class="h-4 w-px bg-(--solus-container-border) @max-[30rem]/pane:hidden"
              aria-hidden="true"
            ></span>
            {#each BOARD_COLUMNS as col (col.status)}
              <button
                type="button"
                class="inline-flex cursor-pointer items-center gap-1 rounded-full border-0 bg-transparent px-2 py-1 text-xs font-medium whitespace-nowrap text-(--solus-text-secondary) transition-colors duration-100 hover:bg-(--solus-surface-hover) @max-[30rem]/pane:hidden"
                onclick={() => bulkSetStatus(col.status)}
                title={`Set ${col.label}`}
              >
                <span
                  class="block size-2 shrink-0 rounded-full {STATUS_META[
                    col.status
                  ].dotClass}"
                ></span>
                {col.label}
              </button>
            {/each}
            <!-- Four statuses are four labels the rung has no room for, so they
                 become one menu. The label still says which four they are. -->
            <DropdownMenu.Root>
              <DropdownMenu.Trigger>
                {#snippet child({ props })}
                  <button
                    {...props}
                    type="button"
                    class="hidden cursor-pointer items-center gap-1.5 rounded-full border-0 bg-transparent px-2.5 text-xs font-medium whitespace-nowrap text-(--solus-text-secondary) transition-colors duration-100 hover:bg-(--solus-surface-hover) @max-[30rem]/pane:inline-flex @max-[30rem]/pane:h-9 @max-[30rem]/pane:text-workspace-chrome"
                    aria-label="Set status on the selected tasks"
                  >
                    <CircleDashedIcon size={14} class="shrink-0 opacity-75" />
                    Status
                    <CaretDownIcon size={9} class="shrink-0 opacity-60" />
                  </button>
                {/snippet}
              </DropdownMenu.Trigger>
              <DropdownMenu.Content
                side="top"
                align="start"
                sideOffset={6}
                class="w-[190px]"
              >
                {#each BOARD_COLUMNS as col (col.status)}
                  <DropdownMenu.Item onSelect={() => bulkSetStatus(col.status)}>
                    <span
                      class="mr-2 block size-2 shrink-0 rounded-full {STATUS_META[
                        col.status
                      ].dotClass}"
                    ></span>
                    <span class="flex-1">{col.label}</span>
                  </DropdownMenu.Item>
                {/each}
              </DropdownMenu.Content>
            </DropdownMenu.Root>
            <span
              class="h-4 w-px bg-(--solus-container-border) @max-[30rem]/pane:hidden"
              aria-hidden="true"
            ></span>
            <button
              type="button"
              class="inline-flex cursor-pointer items-center gap-1 rounded-full border-0 bg-transparent px-2 py-1 text-xs font-medium whitespace-nowrap text-[#cf222e] transition-colors duration-100 hover:bg-[#cf222e]/10 @max-[30rem]/pane:h-9 @max-[30rem]/pane:gap-1.5 @max-[30rem]/pane:px-2.5 @max-[30rem]/pane:text-workspace-chrome [.dark_&]:text-[#f85149] [.dark_&]:hover:bg-[#f85149]/10"
              onclick={bulkDelete}
              title="Delete selected"
            >
              <TrashIcon size={14} class="shrink-0" />
              Delete
            </button>
          </div>
        </div>
      </div>
    {/if}


    {#if composing}
      <TaskComposer
        canSetStatus
        canPlan
        {knownLabels}
        workingDirectory={composing.context.workingDirectory}
        provider={session.settings.activeAgent}
        initialStatus={composing.status}
        {onCreate}
        onCreated={() => {
          if (createdForNavigation)
            session.goToTask(createdForNavigation, "click");
        }}
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
        onSetStatus={(status) => void onSetStatus(menuTask, status)}
        onMarkUnread={sessionSidebar ? () => void sessionSidebar.markTaskUnread(menuTask.id) : undefined}
        onDelete={menuTask.providerId === "local"
          ? () => onDelete(menuTask)
          : undefined}
        onClose={() => (taskContextMenu = null)}
      />
    {/if}
  </div>
{/if}
