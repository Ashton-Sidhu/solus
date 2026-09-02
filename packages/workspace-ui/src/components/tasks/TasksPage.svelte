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
    type TaskKind,
    type TaskPriority,
  } from "@solus/contracts/task-types";
  import type { ProjectConfig } from "@solus/contracts/types";
  import type { InboxInvolvement } from "@solus/contracts/inbox-types";
  import TaskProviderPicker from "./provider/TaskProviderPicker.svelte";
  import type { TaskProviderChoice } from "./provider/lib/task-provider";
  import {
    atlassianStore,
    getWorkspaceContext,
    getProjectConfigStore,
    getSessionSidebarStore,
    runtime,
    projectCatalog,
    mergeProjectOptions,
    projectRefKey,
    serversStore,
    inboxStore,
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
  import { comboHint } from "../../lib/keybindings/manifest";
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
    ListRailRow,
    ListRow,
    ListScopeMenu,
    ListSkeleton,
    ListStatusMenu,
    VirtualList,
    FILTER_SORT_CHIP,
    LIST_GROUP_HEADER_HEIGHT,
    inboxRowHeight,
    listRowHeight,
    inInboxScope,
    virtualGroupItems,
    type ListFilterSpec,
    type ListPageView,
    type ListProjectOption,
    type ListStatusOption,
  } from "../ui/list-page";
  import { isStackedPane } from "../../lib/pane-width";
  import PageEmpty from "../ui/PageEmpty.svelte";
  import SortMenu from "../ui/SortMenu.svelte";
  import TaskComposer from "./TaskComposer.svelte";
  import TaskListRow from "./TaskListRow.svelte";
  import TaskBoard from "./TaskBoard.svelte";
  import TaskBoardSkeleton from "./TaskBoardSkeleton.svelte";
  import TaskPage from "./task-page/TaskPage.svelte";
  import TaskContextMenu from "../session/TaskContextMenu.svelte";
  import InboxImportHomeDialog from "./InboxImportHomeDialog.svelte";
  import type {
    InboxRowLocation,
    MergedInboxPullRequest,
  } from "./lib/inbox-merge";
  import { inboxScopeOptions } from "./lib/inbox-scope";
  import { paneActions } from "../ui/lib/pane-actions.svelte";
  import type { InlinePageProps } from "../ui/lib/pane-surface";

  let { paneId }: InlinePageProps = $props();

  const session = getWorkspaceContext();
  const pane = paneActions(() => paneId);
  const store = session.tasksStore;
  const projectConfig = getProjectConfigStore();
  const sessionSidebar = getSessionSidebarStore();
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const open = $derived(session.router.at("tasks"));

  // ── Project scope ──
  // The page receives a host-qualified scope before navigation replaces the
  // draft or chat that supplied it. From then on the page owns the scope.
  const pageProject = $derived(
    session.projectPageScope.kind === "project"
      ? session.projectPageScope.project
      : null,
  );
  const taskContext = $derived(
    pageProject
      ? taskCreationContextFor(pageProject.projectRoot, null)
      : session.taskCreationContext,
  );
  const cwd = $derived(taskContext?.projectKey ?? null);
  // The switcher shows the deduplicated union of the sidebar's live projects
  // (the selected host only) and every project the catalog has ever recorded,
  // across every host — a project closed today still shows up here. The inbox
  // fans out across the same list.
  const sidebarServerId = $derived(serverConnections.defaultServerId());
  const projectOptions = $derived<ListProjectOption[]>(
    mergeProjectOptions(
      [
        // With no default host there is nothing to attribute a sidebar project
        // to; the catalog still carries its own host per entry.
        sidebarServerId
          ? sessionSidebar.projectSummaries
              .filter((project) => project.projectKey !== "~")
              .map((project) => ({
                serverId: sidebarServerId,
                projectRoot: project.projectKey,
                label: project.label,
              }))
          : [],
        projectCatalog.entries,
      ],
      (serverId) => serversStore.statusFor(serverId) !== "offline",
      (serverId) => serversStore.hostFor(serverId)?.label ?? serverId,
    ).map((option) => ({
      key: option.key,
      projectKey: option.projectRoot,
      serverId: option.serverId,
      label: option.label,
      available: option.available,
      historyOnly: !sessionSidebar.projectSummaries.some(
        (project) => project.projectKey === option.projectRoot,
      ),
    })),
  );
  // The pin is a bare path (TasksStore looks tasks up by path only), so when a
  // path is unique across the catalog this recovers the exact option; when two
  // hosts share the path it falls back to the current session's host, which is
  // the same project TasksStore would have resolved either way.
  const activeProjectOptionKey = $derived(
    pageProject
      ? projectRefKey(pageProject)
      : cwd
        ? (projectOptions.find((option) => option.projectKey === cwd)?.key ??
          (sidebarServerId
            ? projectRefKey({ serverId: sidebarServerId, projectRoot: cwd })
            : ""))
      : "",
  );
  const projectTasks = $derived(store.tasksForProject(cwd));
  const inboxTasksSource = $derived([
    ...store.tasks.filter(
      (task) => task.providerId === "local" && task.status === "inbox",
    ),
    ...inboxStore.tickets.map((entry) => entry.task),
  ]);
  const inboxTicketByTask = $derived(
    new Map(inboxStore.tickets.map((entry) => [entry.task, entry])),
  );
  function inboxTaskKey(task: Task): string {
    return inboxTicketByTask.get(task)?.key ??
      `${task.projectKey ?? "~"}\0${task.providerId}\0${task.id}`;
  }
  const inboxTaskByKey = $derived(
    new Map(inboxTasksSource.map((task) => [inboxTaskKey(task), task])),
  );
  const projectLabels = $derived(
    new Map(projectOptions.map((option) => [option.projectKey, option.label])),
  );
  // Narrowing the cross-project inbox to a few repos is a filter, not a move:
  // the page is still the cross-project one, so this lives on the narrowing row
  // and the crumb keeps saying "All projects". Empty is every project.
  let inboxProjectKeys = $state<string[]>([]);
  // Every project a row can be attributed to. One upstream ticket merged from
  // two clones of the same repo belongs to both.
  function inboxProjectKeysFor(task: Task): string[] {
    const locations = inboxTicketByTask.get(task)?.locations;
    if (locations?.length)
      return locations.map((location) => location.projectKey);
    return task.projectKey ? [task.projectKey] : [];
  }
  const inboxScopeChoices = $derived(
    inboxScopeOptions(
      [
        ...inboxTasksSource.map((task) => ({
          projectKeys: inboxProjectKeysFor(task),
        })),
        ...inboxStore.pullRequests.map((entry) => ({
          projectKeys: entry.locations.map((location) => location.projectKey),
        })),
      ],
      (projectKey) => projectLabels.get(projectKey) ?? projectKey,
      inboxProjectKeys,
    ),
  );
  const scopedInboxTasks = $derived(
    inboxTasksSource.filter((task) =>
      inInboxScope(inboxProjectKeysFor(task), inboxProjectKeys),
    ),
  );
  const scopedInboxPullRequests = $derived(
    inboxStore.pullRequests.filter((entry) =>
      inInboxScope(
        entry.locations.map((location) => location.projectKey),
        inboxProjectKeys,
      ),
    ),
  );
  const projectServerId = $derived(
    pageProject?.serverId ??
      store.hostForProject(cwd) ??
      serverConnections.defaultServerId(),
  );
  const projectHost = $derived(
    projectServerId
      ? {
          serverId: projectServerId,
          api: serverConnections.apiFor(projectServerId),
        }
      : null,
  );

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
  // The task the plain "New task" flow just created, handed off to its own page
  // once the composer closes. The inline flows (adding into a board column, or a
  // sub-task under an epic header) stay on the list, so they leave this null.
  let createdForNavigation: string | null = null;
  // Detail view: the task whose full ticket (body, comments, PRs) is open.
  const epics = $derived(projectTasks.filter((t) => t.kind === "epic"));
  // Existing labels across the project, offered as composer suggestions.
  const knownLabels = $derived(
    Array.from(new Set(projectTasks.flatMap((t) => t.labels))).sort(),
  );

  // ── View state ──
  // The page's two views (spec Part A): the grouped global list, and the
  // personal inbox. `layout` re-plots either view as a kanban board.
  let view = $state<ListPageView>("global");
  let layout = $state<"list" | "board">("list");
  const boardLayout = $derived(layout === "board");
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
  let listEl = $state<HTMLDivElement | null>(null);
  let contentHeight = $state(0);
  let pageWidth = $state(0);
  let selectedKey = $state<string | null>(null);
  let openTaskId = $state<string | null>(null);
  let collapsedGroups = $state<Record<string, boolean>>({});
  let taskContextMenu = $state<{
    task: Task;
    x: number;
    y: number;
  } | null>(null);
  let pendingInboxHome = $state<{
    task: Task;
    locations: InboxRowLocation[];
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

  const INVOLVEMENT_OPTIONS: { value: InboxInvolvement; label: string }[] = [
    { value: "assigned", label: "Assigned to me" },
    { value: "review_requested", label: "Review requested" },
    { value: "mentioned", label: "Mentioned" },
    { value: "authored", label: "Authored by me" },
    { value: "all", label: "All in bound scopes" },
  ];

  const providerStatus = $derived(store.providerStatus(cwd));
  const upstreamError = $derived(
    cwd ? (store.upstreamErrorByProject.get(cwd) ?? null) : null,
  );
  const refreshing = $derived(
    store.loading ||
      (view === "inbox"
        ? inboxStore.loading
        : !!(cwd && store.upstreamLoadingByProject.get(cwd))),
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
    if (!open || view !== "global" || !cwd) return;
    if (!upstreamTruncated && !upstreamQuery) return;
    store.searchUpstream(cwd, query);
  });
  const displayError = $derived(
    (store.error ?? upstreamError ??
      (view === "inbox"
        ? (inboxStore.hostErrors.values().next().value ??
          inboxStore.scopes.find((scope) => scope.ticketError || scope.pullRequestError)?.ticketError ??
          inboxStore.scopes.find((scope) => scope.ticketError || scope.pullRequestError)?.pullRequestError)
        : null))?.replace(TASKS_AUTH_ERROR_PREFIX, "") ??
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

  const reachableInboxProjectsKey = $derived(
    serverConnections.connectedServerIds()
      .filter((serverId) => serverConnections.phaseFor(serverId) === "connected")
      .join("\n"),
  );

  // One RPC per connected host performs the project/scope fan-out. The client
  // only merges hosts; it never issues one provider read per project.
  $effect(() => {
    if (!open || view !== "inbox" || !reachableInboxProjectsKey) return;
    void inboxStore.load();
  });

  function sessionsFor(taskId: string): number {
    return store.get(taskId).sessions.length;
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
  const inboxGroups = $derived.by(() => {
    const ticketGroups = taskInboxGroups(
      scopedInboxTasks,
      sessionsFor,
      now,
      {
        open: onOpen,
        start: onStart,
        resume: onResume,
        markDone: (task) => void onSetStatus(task, "done"),
      },
      statuses,
      inboxTaskKey,
    );
    const groups = ticketGroups.map((group) => ({
      ...group,
      rows: group.rows.map((row) => {
        const task = inboxTaskByKey.get(row.key);
        const projectLabel = task?.projectKey
          ? projectLabels.get(task.projectKey)
          : undefined;
        return projectLabel
          ? { ...row, context: `${projectLabel} · ${row.context}` }
          : row;
      }),
    }));
    if (statuses.has("in_review") && scopedInboxPullRequests.length > 0) {
      groups.unshift({
        key: "pull-requests",
        label: "Pull requests",
        note: "live upstream",
        accent: true,
        rows: scopedInboxPullRequests.map((entry) => ({
          key: entry.key,
          ident: `PR #${entry.pullRequest.number}`,
          title: entry.pullRequest.title,
          context: entry.locations.length === 1
            ? entry.locations[0].projectLabel
            : `${entry.locations[0]?.projectLabel ?? entry.pullRequest.externalKey} · ${entry.locations.length} homes`,
          actor: {
            id: entry.pullRequest.author,
            initials: entry.pullRequest.author.slice(0, 2).toUpperCase(),
            name: entry.pullRequest.author,
            avatarUrl: entry.pullRequest.authorAvatarUrl,
          },
          time: relativeTime(Date.parse(entry.pullRequest.updatedAt), now),
          timeTitle: new Date(entry.pullRequest.updatedAt).toLocaleString(),
          unread: true,
          primary: {
            label: "Review",
            shortcut: "⏎",
            run: () => openInboxPullRequest(entry),
          },
        })),
      });
    }
    return groups;
  });
  const inboxTasks = $derived.by(() => {
    const inboxTaskIds = new Set(
      inboxGroups.flatMap((group) => group.rows.map((row) => row.key)),
    );
    return inboxTasksSource.filter((task) => inboxTaskIds.has(inboxTaskKey(task)));
  });
  const boardTasks = $derived(view === "inbox" ? inboxTasks : visibleTasks);
  const inboxVirtualItems = $derived(
    virtualGroupItems(
      inboxGroups,
      (row) => row.key,
      (group) => !collapsedGroups[`inbox:${group.key}`],
    ),
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
    inboxGroups
      .filter((group) => group.key === "needs" || group.key === "pull-requests")
      .reduce((count, group) => count + group.rows.length, 0),
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
      count: (view === "global" ? searched : inboxTasksSource).filter((task) =>
        group.statuses.includes(task.status),
      ).length,
    })),
  );

  // Running, open and closed-this-week used to be restated here; the list's own
  // section headers already say all three and are clickable, so the counts kept
  // their filtering job and lost only the duplicate. What the headers cannot
  // say is that the answer behind these rows is incomplete — that note stays,
  // on the narrowing row, beside the search it explains. The inbox reads a set
  // of scopes rather than one list, so it names how many fell short.
  const truncationNote = $derived.by(() => {
    if (view === "inbox") {
      const stale = inboxStore.scopes.filter((scope) => scope.fromCache).length;
      if (stale > 0) return `${stale} stale scope${stale === 1 ? "" : "s"}`;
      const partial = inboxStore.scopes.filter(
        (scope) => scope.ticketError || scope.pullRequestError,
      ).length + inboxStore.hostErrors.size;
      return partial > 0 ? `${partial} partial scope${partial === 1 ? "" : "s"}` : null;
    }
    // Says where the rows came from: these are the provider's matches for the
    // search, not the slice of the list that happens to be loaded.
    if (upstreamQuery) return `searched ${providerStatus?.scopeLabel ?? "upstream"}`;
    return upstreamTruncated ? `most recent ${projectTasks.length}` : null;
  });

  // The selectable rows in the active view's render order, for Shift
  // range-select, arrow navigation, and detail-panel stepping.
  const flatVisibleIds = $derived(
    (view === "inbox" ? inboxGroups : groups)
      .flatMap((group) => group.rows)
      .map((row) => row.key),
  );
  $effect(() => {
    selection.setOrder(flatVisibleIds);
  });

  function taskById(id: string): Task | undefined {
    if (view === "inbox") {
      return inboxTaskByKey.get(id) ?? inboxTasksSource.find((task) => task.id === id);
    }
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
    options: { parentId?: string; status?: TaskStatus } = {},
  ) {
    if (!taskContext) return;
    createdForNavigation = null;
    composing = { ...options, context: taskContext };
  }

  // ── Data loading ──
  $effect(() => {
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
        store.loadUpstream(currentCwd),
        // Names the provider on the header control, and is what tells a Jira
        // project it is bound to a site the host is no longer connected to.
        store.loadProviderStatus(currentCwd, {
          serverId: currentServerId ?? undefined,
        }),
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
    session.router.close("tasks");
    requestInputFocus();
  }

  // A different project is a different list, so nothing about how the old one
  // was being read survives the switch. The load effect keys off `cwd` and
  // refetches on its own. Picking the input bar's own project unpins, so the
  // list goes back to following it.
  // Moving between the project list and the inbox is a move, so nothing about
  // how the old scope was being read survives it. The board plots one project's
  // statuses as columns, which the inbox has no notion of.
  function setView(next: ListPageView) {
    if (next === view) return;
    selection.clear();
    view = next;
    if (next === "inbox") {
      layout = "list";
      session.setProjectPageScope({ kind: "all" });
    }
    selectedKey = null;
    openTaskId = null;
  }

  function selectProject(option: ListProjectOption) {
    if (!option.available) return;
    // Picking a project out of the inbox's crumb is how you leave the inbox for
    // that project's tasks — the crumb stays a path you can walk back up.
    setView("global");
    session.setProjectPageScope({
      kind: "project",
      project: { serverId: option.serverId, projectRoot: option.projectKey },
    });
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
    const nextKey = pageProject ? projectRefKey(pageProject) : "all";
    if (observedPageScopeKey === nextKey) return;
    observedPageScopeKey = nextKey;
    view = pageProject ? "global" : "inbox";
    if (!pageProject) layout = "list";
    clearFilters();
    selection.clear();
    selectedKey = null;
    openTaskId = null;
    collapsedGroups = {};
    composing = null;
    void tick().then(() => searchEl?.focus());
  });

  function removeProjectHistory(option: ListProjectOption) {
    projectCatalog.remove({
      serverId: option.serverId,
      projectRoot: option.projectKey,
    });
  }

  // Re-read native tasks and explicitly poll the active scope. The inbox fans
  // the same refresh across every reachable project.
  function refresh() {
    if (refreshing) return;
    if (view === "inbox") {
      void store.load();
      void inboxStore.load();
      return;
    }
    if (!cwd) return;
    const currentCwd = cwd;
    configReady = true;
    void Promise.all([
      store.load(),
      store.loadUpstream(currentCwd),
    ]);
  }

  function changeInvolvement(involvement: InboxInvolvement) {
    inboxStore.setInvolvement(involvement);
    void inboxStore.load();
  }

  function openInboxPullRequest(entry: MergedInboxPullRequest) {
    const location = entry.locations[0];
    if (!location) {
      void localApi.openExternal(entry.pullRequest.url);
      return;
    }
    const [owner, repo] = entry.pullRequest.externalKey.split("/");
    void session.openPullRequest({
      number: entry.pullRequest.number,
      title: entry.pullRequest.title,
      url: entry.pullRequest.url,
      baseRepo: owner && repo ? { host: "github.com", owner, repo } : undefined,
    }, {
      ctx: session.ctxForDirectory(location.projectKey),
      serverId: location.serverId,
    });
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
      store.loadUpstream(currentCwd),
    ]);
  }

  function onOpen(task: Task) {
    const key = view === "inbox" ? inboxTaskKey(task) : task.id;
    if (view === "inbox" && task.providerId !== "local") {
      const entry = inboxTicketByTask.get(task);
      const location = entry?.locations[0];
      if (location) {
        task = store.get(task.id).hydrate(task, location.serverId).placeIn(location);
      }
    }
    selectedKey = key;
    openTaskId = key;
  }

  async function startInboxTaskAt(task: Task, location: InboxRowLocation) {
    pendingInboxHome = null;
    try {
      const promoted = await store
        .get(task.id)
        .hydrate(task, location.serverId)
        .placeIn(location)
        .promote();
      await session.openTaskSession(promoted);
      void inboxStore.load();
    } catch (error) {
      toastTaskError("start task", error);
    }
  }

  function onStart(task: Task) {
    if (task.providerId === "local") {
      void session.openTaskSession(task);
      return;
    }
    const entry = inboxTicketByTask.get(task);
    if (!entry || entry.locations.length === 0) {
      toastTaskError("start task", "No reachable project owns this ticket.");
      return;
    }
    if (entry.locations.length === 1) {
      void startInboxTaskAt(task, entry.locations[0]);
      return;
    }
    pendingInboxHome = { task, locations: entry.locations };
  }

  function onResume(task: Task) {
    void session.openTaskLinkedSession(task);
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
    selectedKey = view === "inbox" ? inboxTaskKey(task) : task.id;
    taskContextMenu = { task, x: event.clientX, y: event.clientY };
  }

  function toastTaskError(action: string, err: Parameters<typeof String>[0]) {
    const message = err instanceof Error ? err.message : String(err);
    toasts.error(`Couldn't ${action}`, { description: message });
  }

  async function onSetStatus(task: Task, status: TaskStatus) {
    try {
      if (view === "inbox" && task.providerId !== "local") {
        const entry = inboxTicketByTask.get(task);
        const location = entry?.locations[0];
        if (!location) throw new Error("No reachable host can update this ticket.");
        await store
          .get(task.id)
          .hydrate(task, location.serverId)
          .placeIn(location)
          .update({ status });
        await inboxStore.load();
      } else {
        await store.get(task.id, task.projectKey ?? undefined).setStatus(status);
      }
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
    kind: TaskKind;
    parentId?: string;
    dueDate?: string;
    priority?: TaskPriority;
    status?: TaskStatus;
    labels?: string[];
  }) {
    if (!composing) return;
    const inline = !!composing.parentId || !!composing.status;
    try {
      const created = await store.create({
        ...input,
        projectKey: composing.context.projectKey,
      });
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
{/snippet}

{#snippet layoutToggle()}
  <!-- The layout control re-plots the active task view rather than replacing
       it, so it is presentation and sits after the divider with sort. -->
  {#if !splitList}
    <div
      class="flex shrink-0 items-center gap-0.5 rounded-full bg-[var(--wash-2)] p-0.5 @max-[30rem]/pane:h-8 @max-[30rem]/pane:p-1"
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
        <ListIcon size={14} weight="bold" />
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
    placeholder={view === "global"
      ? splitList
        ? "Search tasks…"
        : "Search tasks, labels, assignees…"
      : "Search your inbox…"}
    filters={view === "global" && !splitList ? filters : []}
  >
    {#snippet trailing()}
      {#if view === "inbox"}
        <!-- Wanting "just these two repos" narrows the inbox without moving the
             page, so it is a filter and sits with the others. -->
        <ListScopeMenu
          options={inboxScopeChoices}
          selected={inboxProjectKeys}
          onChange={(next) => (inboxProjectKeys = next)}
          compactText
        />
      {/if}
      <!-- The board plots every status as a column of its own, so a status
           filter there would only ever empty one. -->
      {#if !boardLayout}
        <ListStatusMenu
          options={statusOptions}
          selected={statusKeys}
          onChange={(next) => (statusKeys = next)}
          ariaLabel="Filter tasks by status"
          compactText
        />
      {/if}
      {#if truncationNote}
        <!-- Why the list is short, said where the narrowing is done. -->
        <span
          class="shrink-0 text-xs whitespace-nowrap text-muted-foreground @max-[44rem]:hidden"
          >{truncationNote}</span
        >
      {/if}
      {#if !splitList}
        <!-- Sort and layout are presentation, not membership — hence the
             divider. The split rail shows neither, so it shows no divider. -->
        <span
          class="mx-0.5 h-[18px] w-px shrink-0 bg-[color-mix(in_oklch,var(--foreground)_12%,transparent)]"
          aria-hidden="true"
        ></span>
      {/if}
      {#if view === "global" && !splitList}
        <SortMenu
          bind:value={sort}
          options={SORT_OPTIONS}
          ariaLabel="Sort tasks"
          class="{FILTER_SORT_CHIP} text-xs"
        />
      {/if}
      {#if view === "inbox"}
        <SortMenu
          bind:value={() => inboxStore.involvement, changeInvolvement}
          options={INVOLVEMENT_OPTIONS}
          ariaLabel="Filter inbox involvement"
          contentClass="w-[180px]"
          class="{FILTER_SORT_CHIP} text-workspace-chrome"
        />
      {/if}
      {@render layoutToggle()}
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
    <!-- The switcher scopes the project list. The inbox is cross-project, so it
         reads "All projects" there rather than losing the crumb: a first crumb
         that vanished would strand the reader with no path back up. -->
    <ListPage
      split={splitList}
      hideHeader={splitList}
      projects={projectOptions}
      activeProjectKey={view === "global" ? activeProjectOptionKey : ""}
      emptyProjectLabel={view === "global" ? "No project" : "All projects"}
      onSelectProject={selectProject}
      onRemoveProjectHistory={removeProjectHistory}
      page="tasks"
      title={view === "inbox" ? "Inbox" : undefined}
      actions={providerControl}
      {view}
      onViewChange={setView}
      globalLabel="Project"
      inboxLabel="Inbox"
      compactViewSwitcherText
      {unreadCount}
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
      compactPrimaryActionText
      onMoveAcross={pane.inPane ? pane.moveAcross : undefined}
      isLeading={pane.isLeading}
      onClose={close}
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
        {#if view === "global" && !cwd}
          <PageEmpty
            icon={ListChecksIcon}
            title="Open a project to see its tasks."
          >
            Tasks are per-project records. Open a project and its list appears
            here.
          </PageEmpty>
        {:else if (view === "global" && !configReady) || (!store.loaded && store.loading) || (refreshing && (view === "inbox" ? inboxTasksSource.length === 0 : projectTasks.length === 0))}
          {#if boardLayout}
            <TaskBoardSkeleton />
          {:else}
            <ListSkeleton identWidth={62} />
          {/if}
        {:else if (displayError && (view === "inbox" ? inboxGroups.length === 0 : projectTasks.length === 0)) || (view === "global" && upstreamError && projectTasks.length === 0)}
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
        {:else if view === "global" && projectTasks.length === 0}
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
            tasks={boardTasks}
            projectKey={cwd}
            canReorder={view === "global" && boardUnfiltered}
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
                inboxVirtualItems[index].kind === "header"
                  ? LIST_GROUP_HEADER_HEIGHT
                  : inboxRowHeight(recordRows)}
              keyOf={(item) => item.key}
              activeKey={inboxActiveKey}
            >
              {#snippet children(item, _index, style)}
                <div {style}>
                  {#if item.kind === "header"}
                    <ListGroup
                      label={item.group.label}
                      count={item.group.rows.length}
                      open={!collapsedGroups[`inbox:${item.group.key}`]}
                      onToggle={() => {
                        const groupKey = `inbox:${item.group.key}`;
                        collapsedGroups[groupKey] = !collapsedGroups[groupKey];
                      }}
                      note={item.group.note}
                      accent={item.group.accent}
                    >
                      {#snippet children()}{/snippet}
                    </ListGroup>
                  {:else}
                    <InboxRow
                      row={item.row}
                      hot={!!item.group.accent}
                      responsiveTitle
                      selected={selectedKey === item.row.key ||
                        selection.has(item.row.key)}
                      onSelect={() => {
                        selectedKey = item.row.key;
                        const task = taskById(item.row.key);
                        if (task) onOpen(task);
                        else item.row.primary?.run();
                      }}
                      onContextMenu={(event) => {
                        const task = taskById(item.row.key);
                        if (task) openTaskContextMenu(event, task);
                      }}
                    >
                      {#snippet leading()}
                        {#if taskById(item.row.key)}
                          {@render rowCheckbox(item.row.key)}
                        {/if}
                      {/snippet}
                    </InboxRow>
                  {/if}
                </div>
              {/snippet}
            </VirtualList>
          {/if}
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
            serverId:
              store.get(openTask.id).serverId ??
              store.hostForProject(openTask.projectKey) ??
              undefined,
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
            <button
              type="button"
              class="inline-flex cursor-pointer items-center gap-1 rounded-full border-0 bg-transparent px-2 py-1 text-xs font-medium whitespace-nowrap text-(--solus-text-secondary) transition-colors duration-100 hover:bg-(--solus-surface-hover) @max-[30rem]/pane:h-9 @max-[30rem]/pane:gap-1.5 @max-[30rem]/pane:px-2.5 @max-[30rem]/pane:text-workspace-chrome"
              onclick={() => void bulkMarkUnread()}
              ><DotOutlineIcon size={14} weight="fill" class="shrink-0" />Unread</button
            >
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
        {epics}
        {allowEpics}
        canPlan
        {knownLabels}
        workingDirectory={composing.context.workingDirectory}
        provider={session.settings.activeAgent}
        initialParentId={composing.parentId}
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
        onSetStatus={(status) => void onSetStatus(menuTask, status)}
        onMarkUnread={() => void sessionSidebar.markTaskUnread(menuTask.id)}
        onDelete={menuTask.providerId === "local"
          ? () => onDelete(menuTask)
          : undefined}
        onClose={() => (taskContextMenu = null)}
      />
    {/if}
    {#if pendingInboxHome}
      <InboxImportHomeDialog
        title={pendingInboxHome.task.title}
        locations={pendingInboxHome.locations}
        onChoose={(location) => void startInboxTaskAt(pendingInboxHome!.task, location)}
        onCancel={() => (pendingInboxHome = null)}
      />
    {/if}
  </div>
{/if}
