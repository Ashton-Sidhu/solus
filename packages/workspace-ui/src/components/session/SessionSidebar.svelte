<script lang="ts">
  import { TaskOpenTrace } from "./lib/task-open-timing";
  import { serverConnections } from "@solus/client-core/server-connections";
  import TaskIcon from "../ui/TaskIcon.svelte";
  import type { PrReviewTab } from "../../contexts/prs/pr-view.svelte";
  import { localApi } from "@solus/client-core/local-api";
  import { onMount, tick } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { comboHint } from "../../lib/keybindings/manifest";
  import {
    LibraryBig as BooksIcon,
    Clock as ClockIcon,
    ChevronRight as CaretRightIcon,
    Pin as PushPinIcon,
    RefreshCw as ArrowsClockwiseIcon,
    ChartBar as ChartBarIcon,
    GitPullRequest as GitPullRequestIcon,
    Plus as PlusIcon,
    Search as MagnifyingGlassIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import type { PinnedSession } from "@solus/contracts/types";
  import type { Task, TaskStatus } from "@solus/contracts/task-types";
  import {
    getSettingsContext,
    getPullRequestsContext,
    getWorkspaceContext,
    getSessionSidebarStore,
  } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import {
    completedTasksWithinRetention,
    SIDEBAR_COMPLETED_RETENTION_CHECK_MS,
  } from "../../lib/completed-task-retention";
  import SidePanel from "../layout/SidePanel.svelte";
  import {
    SIDEBAR_MAX_WIDTH,
    SIDEBAR_MIN_WIDTH,
  } from "../layout/lib/workspace-body";
  import * as Sidebar from "../ui/sidebar";
  import TaskListSkeleton from "./TaskListSkeleton.svelte";
  import SessionContextMenu from "./SessionContextMenu.svelte";
  import TaskContextMenu from "./TaskContextMenu.svelte";
  import PrContextMenu from "./PrContextMenu.svelte";
  import TaskActionBar from "./TaskActionBar.svelte";
  import TaskRow from "./TaskRow.svelte";
  import DraftRow from "./DraftRow.svelte";
  import SessionSidebarTooltip from "./SessionSidebarTooltip.svelte";
  import SidebarAccountFooter from "./SidebarAccountFooter.svelte";
  import SnoozeTaskMenu from "./SnoozeTaskMenu.svelte";
  import {
    taskSnoozeToastLabel,
    type TaskSnoozeAnchor,
  } from "./lib/task-snooze";
  import type { DraftRow as DraftRowModel } from "./lib/draft-list";
  import { taskPrNavigation } from "./lib/pr-navigation";
  import type { SidebarSessionChild } from "../../contexts/workspace/session-sidebar.store.svelte";
  import { nextTaskAfterLeaving } from "../../contexts/workspace/session-sidebar-selection";
  import { canDriveSession } from "../../contexts/sharing/session-drive";
  import {
    filterSidebarTasks,
    prChipForChoices,
    type TaskPrChoice,
    type SidebarTask,
  } from "./lib/task-list";
  import { treeKeyIntent } from "./lib/task-tree-keys";
  import { sidebarListMotion } from "./lib/sidebar-list-motion.svelte";
  import {
    buildSidebarListItems,
    sidebarListOrderKey,
    type SidebarSection,
  } from "./lib/sidebar-list-items";
  import { useKeybinding } from "../../lib/keybindings/use-keybinding.svelte";
  import * as TooltipUI from "../ui/tooltip";
  import { ownsTask } from "../tasks/lib/task-ownership";

  interface Props {
    open?: boolean;
    managedWidth?: boolean;
    onToggleCollapse?: () => void;
    onSessionSelect?: () => void;
  }
  let {
    open = true,
    managedWidth = false,
    onToggleCollapse,
    onSessionSelect,
  }: Props = $props();

  const session = getWorkspaceContext();
  const pullRequests = getPullRequestsContext();
  const theme = getSettingsContext();
  const sidebarStore = getSessionSidebarStore();
  const needsReviewCount = $derived(
    pullRequests.needsReview.countFor(
      session.serverIdForContext(session.ctx),
      session.ctx,
    ),
  );
  $effect(() => pullRequests.needsReview.wantShown(session));
  // Works a teammate asked the reader to review, on every host.
  const reviewInboxCount = $derived(session.worksStore.reviews.inbox.length);

  let scrollEl: HTMLDivElement | undefined = $state();
  let sessionContextMenu = $state<
    | {
        kind: "tab";
        tabId: string | null;
        x: number;
        y: number;
      }
    | {
        kind: "task";
        taskId: string;
        sidebarTask?: SidebarTask;
        child?: SidebarSessionChild;
        x: number;
        y: number;
      }
    | { kind: "pinned"; pin: PinnedSession; x: number; y: number }
    | {
        kind: "pull-request";
        row: SidebarTask;
        choice: TaskPrChoice;
        x: number;
        y: number;
      }
    | null
  >(null);
  /** The row being renamed in place. One at a time: the edit replaces the label
   *  where it sits, so two open editors would be two claims on the same name.
   *  A durable row is named by its task, which outlives any session it has open
   *  — and may have none at all. */
  let renamingTabId = $state<string | null>(null);
  let renamingTaskId = $state<string | null>(null);

  function startRename(target: {
    taskId?: string;
    tabId?: string | null;
  }): void {
    // A member who may only read a shared session cannot rename it.
    const tabSession = !target.taskId && target.tabId ? session.sessionFor(target.tabId) : null;
    if (tabSession && !canDriveSession(session.serverIdFor(target.tabId!), tabSession.id)) return;
    renamingTaskId = target.taskId ?? null;
    renamingTabId = target.taskId ? null : (target.tabId ?? null);
  }

  /** Leaving the editor hands the caret back to the composer, so abandoning a
   *  rename lands you where committing one does rather than nowhere. */
  function cancelRename(): void {
    renamingTabId = null;
    renamingTaskId = null;
    requestInputFocus();
  }
  let savedSessionsOpen = $state(false);
  /** Open by default: tasks and sessions are live work, not history put away. */
  let tasksSectionOpen = $state(true);
  let sessionsSectionOpen = $state(true);
  /** Closed by default: busy rows stay out of the way until they need you. */
  let workingSectionOpen = $state(false);
  let snoozedShelfOpen = $state(false);
  let completedShelfOpen = $state(false);

  function toggleSection(section: SidebarSection) {
    if (section === "tasks") tasksSectionOpen = !tasksSectionOpen;
    else if (section === "sessions") sessionsSectionOpen = !sessionsSectionOpen;
    else if (section === "working") workingSectionOpen = !workingSectionOpen;
    else if (section === "snoozed") snoozedShelfOpen = !snoozedShelfOpen;
    else completedShelfOpen = !completedShelfOpen;
  }
  /** A snoozable row. Snoozing hides a row under the Snoozed shelf until its
   *  wake time; it says nothing about the work, so a row needs no task to have
   *  one — only a key this column can recognise it by. */
  interface SnoozeTarget {
    rowKey: string;
    title: string;
  }
  let snoozeTargets = $state<SnoozeTarget[]>([]);
  let snoozeAnchor = $state<TaskSnoozeAnchor | null>(null);
  let taskQuery = $state("");
  let sidebarNow = $state(Date.now());
  let taskSearchEl = $state<HTMLInputElement | null>(null);
  const searchedTaskRows = $derived(
    filterSidebarTasks(sidebarStore.taskRows, taskQuery),
  );
  const searchedSessionRows = $derived(
    filterSidebarTasks(sidebarStore.sessionRows, taskQuery),
  );
  const searchedWorkingRows = $derived(
    filterSidebarTasks(sidebarStore.workingRows, taskQuery),
  );
  /** Every open row in list order: tasks, sessions, then working rows.
   *  Selection ranges, bulk actions and "the next row" all read this one
   *  order. */
  const openRows = $derived([
    ...searchedTaskRows,
    ...searchedSessionRows,
    ...searchedWorkingRows,
  ]);
  const isSearching = $derived(taskQuery.trim().length > 0);
  const searchedSnoozedTasks = $derived(
    filterSidebarTasks(sidebarStore.snoozedTasks, taskQuery),
  );
  const searchedCompletedTasks = $derived(
    filterSidebarTasks(
      completedTasksWithinRetention(
        sidebarStore.completedTasks,
        theme.sidebarCompletedRetentionDays,
        sidebarNow,
      ),
      taskQuery,
    ),
  );
  /** Search results must be visible even when the user normally keeps this
   *  quiet shelf collapsed. Keep the manual preference separate so clearing
   *  the query restores the shelf to the state it had before the search. */
  const isCompletedShelfExpanded = $derived(
    completedShelfOpen || (isSearching && searchedCompletedTasks.length > 0),
  );
  /** Drafts, the Tasks section, the Sessions section, and both shelves as one
   *  list, so every change between them animates as a change of order
   *  (docs/plans/sidebar-motion.md). */
  const listItems = $derived(
    buildSidebarListItems({
      drafts: sidebarStore.draftRows,
      tasks: session.tasksStore.loaded ? searchedTaskRows : [],
      sessions: session.tasksStore.loaded ? searchedSessionRows : [],
      working: session.tasksStore.loaded ? searchedWorkingRows : [],
      snoozed: searchedSnoozedTasks,
      completed: searchedCompletedTasks,
      isTasksOpen: tasksSectionOpen || isSearching,
      isSessionsOpen: sessionsSectionOpen || isSearching,
      isWorkingOpen: workingSectionOpen || isSearching,
      isSnoozedOpen: snoozedShelfOpen,
      isCompletedOpen: isCompletedShelfExpanded,
      shelfRevealTaskId: sidebarStore.shelfRevealTaskId,
    }),
  );
  const selectedTaskIds = new SvelteSet<string>();
  let selectionAnchorId = $state<string | null>(null);
  $effect(() => {
    const visibleIds = new Set(openRows.map((task) => task.id));
    for (const taskId of selectedTaskIds) {
      if (!visibleIds.has(taskId)) selectedTaskIds.delete(taskId);
    }
  });

  useKeybinding(
    "global.focus-sidebar-task-search",
    () => taskSearchEl?.focus(),
    { enabled: () => open },
  );

  // Top-nav cluster (Workspace / Automations / …). These are static places,
  // not tasks — but they sit on the same spine: their icons occupy the 16px
  // column a task's disclosure lives in, and their labels start exactly where a
  // task title does, so the whole column reads as one list of one shape.
  // A static total, in the same muted mono as every other number in the column.
  // A filled badge here would be the brightest thing above the list and would
  // compete with the status marks, which are what the eye is meant to count.

  onMount(() => {
    const clock = window.setInterval(() => {
      sidebarNow = Date.now();
    }, SIDEBAR_COMPLETED_RETENTION_CHECK_MS);
    return () => window.clearInterval(clock);
  });

  onMount(() => {
    const revealPickedTask = (event: Event) => {
      const taskId = event instanceof CustomEvent ? event.detail : undefined;
      if (!taskId) return;
      // The picked task may sit inside a collapsed section — a finished task in
      // Completed, a sleeping one in Snoozed. Open the section that holds it so
      // the row the picker just restored and highlighted is actually on screen.
      if (sidebarStore.completedTasks.some((task) => task.id === taskId)) {
        completedShelfOpen = true;
      } else if (sidebarStore.snoozedTasks.some((task) => task.id === taskId)) {
        snoozedShelfOpen = true;
      } else if (sidebarStore.taskRows.some((task) => task.id === taskId)) {
        tasksSectionOpen = true;
      } else if (sidebarStore.sessionRows.some((task) => task.id === taskId)) {
        sessionsSectionOpen = true;
      } else if (sidebarStore.workingRows.some((task) => task.id === taskId)) {
        workingSectionOpen = true;
      }
    };
    window.addEventListener("solus:reveal-sidebar-task", revealPickedTask);
    return () =>
      window.removeEventListener("solus:reveal-sidebar-task", revealPickedTask);
  });

  /** Scoping the column produces a different list, so an offset into the old
   *  one lands nowhere. Selection is deliberately left alone: the filter is a
   *  lens on the list, not a navigation. */
  function filterToProject(projectKey: string | null) {
    sidebarStore.setProjectFilter(projectKey);
    if (scrollEl) scrollEl.scrollTop = 0;
    requestInputFocus();
  }

  function togglePrs() {
    session.togglePrs();
    requestInputFocus();
  }

  function newSession() {
    session.drafts.openSessionDraft({ freshTask: true, via: "click" });
  }

  /** The task a session's chip names, beside the session where the shell has
   *  a companion pane. The session stays on screen. */
  function openLinkedTask(taskId: string) {
    session.goToTask(taskId, "click");
  }

  function openTaskPr(choice: TaskPrChoice, tab?: PrReviewTab): void {
    const { route, sourceUrl } = taskPrNavigation(choice);
    session.openRoute(route, { sourceUrl, tab, via: "click" });
  }

  /** A draft row goes back to the composer it was left in, with the caret in it
   *  — the row is a way to resume typing, not a way to look at the text. */
  function openDraft(row: DraftRowModel) {
    sidebarStore.openDraftRow(row);
    requestInputFocus();
    onSessionSelect?.();
  }

  /** Discarding loses words the user wrote, and it is one click away on a hover
   *  action, so the toast holds them until it is dismissed. */
  function discardDraft(row: DraftRowModel) {
    const undo = sidebarStore.discardDraftRow(row);
    requestInputFocus();
    if (!undo) return;
    toasts.show({
      message: `Discarded “${row.title}”`,
      actions: [
        {
          label: "Undo",
          onAction: () => {
            undo();
            requestInputFocus();
          },
        },
      ],
    });
  }

  function scrollActiveSessionIntoView() {
    if (!scrollEl) return;
    const activeEl = scrollEl.querySelector<HTMLElement>(
      '[aria-selected="true"]',
    );
    if (!activeEl) return;

    const scrollRect = scrollEl.getBoundingClientRect();
    const activeRect = activeEl.getBoundingClientRect();
    const padding = 8;

    if (activeRect.top < scrollRect.top + padding) {
      scrollEl.scrollTop += activeRect.top - scrollRect.top - padding;
    } else if (activeRect.bottom > scrollRect.bottom - padding) {
      scrollEl.scrollTop += activeRect.bottom - scrollRect.bottom + padding;
    }
  }

  $effect(() => {
    const activeBranchKey = sidebarStore.activeBranchKey;
    void activeBranchKey;

    tick().then(() => {
      requestAnimationFrame(scrollActiveSessionIntoView);
    });
  });

  /** A row activation navigates: a task row opens its lead with the task page
   *  beside it, a session row opens its conversation. Navigation swaps the
   *  conversation, the companion pane and the focused input, and for a row
   *  with nothing mounted it waits on an IPC round trip first. It runs two
   *  frames later, so the row answers the click before the app switches. */
  function activateTask(task: SidebarTask) {
    const serverId = task.serverId ?? session.serverIdForContext(session.ctx);
    const timing = new TaskOpenTrace(task.taskId ?? null, (report) =>
      serverConnections.apiFor(serverId).tasksLogOpenTiming(report),
    );
    sidebarStore.acknowledgeRow(task);
    timing.mark("row_acknowledged");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // A fast double-click can enter rename mode before the first click's
        // deferred navigation runs. Do not let that stale navigation take the
        // caret back from the rename field.
        if (renamingTaskId || renamingTabId) {
          void timing.finish("cancelled");
          return;
        }
        timing.mark("navigation_started");
        void sidebarStore.selectTask(task, timing).then(
          () => timing.finish("completed"),
          () => timing.finish("failed"),
        );
        requestInputFocus();
        onSessionSelect?.();
      });
    });
  }

  function selectOrActivateTask(task: SidebarTask, event?: MouseEvent) {
    if (event?.metaKey || event?.ctrlKey) {
      if (!selectedTaskIds.delete(task.id)) selectedTaskIds.add(task.id);
      selectionAnchorId = task.id;
      return;
    }
    if (event?.shiftKey && selectionAnchorId) {
      const rows = openRows;
      const from = rows.findIndex((row) => row.id === selectionAnchorId);
      const to = rows.findIndex((row) => row.id === task.id);
      if (from >= 0 && to >= 0) {
        selectedTaskIds.clear();
        for (const row of rows.slice(
          Math.min(from, to),
          Math.max(from, to) + 1,
        )) {
          selectedTaskIds.add(row.id);
        }
        return;
      }
    }
    selectedTaskIds.clear();
    selectionAnchorId = null;
    activateTask(task);
  }

  function selectedTasks(): SidebarTask[] {
    return openRows.filter((task) => selectedTaskIds.has(task.id));
  }

  async function bulkComplete() {
    const rows = selectedTasks();
    const onScreenRow = rows.find((task) =>
      task.tabIds.includes(session.onScreenTabId),
    );
    const wasSelected = !!onScreenRow;
    const next = onScreenRow
      ? nextTaskAfterLeaving(openRows, onScreenRow.id, selectedTaskIds)
      : null;
    const blocked = rows.find((task) => completionBlocked(task.attention));
    if (blocked) {
      toasts.error(`“${blocked.title}” cannot be completed right now.`);
      return;
    }
    for (const row of rows) {
      try {
        // A task moves to Completed. A session with no task has no record to
        // mark, so completing it closes it.
        await sidebarStore.completeTask(row);
      } catch (error) {
        toasts.error(`Stopped after “${row.title}”`, {
          description: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }
    selectedTaskIds.clear();
    if (wasSelected) navigateAfterLifecycleMove(next);
    requestInputFocus();
  }

  async function bulkMarkUnread() {
    for (const row of selectedTasks()) {
      if (!row.taskId) continue;
      try {
        await sidebarStore.markTaskUnread(row.taskId);
      } catch (error) {
        toasts.error(`Stopped after “${row.title}”`, {
          description: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }
    selectedTaskIds.clear();
    requestInputFocus();
  }

  async function bulkDelete() {
    const rows = selectedTasks();
    const taskIds = rows.flatMap((task) => (task.taskId ? [task.taskId] : []));
    selectedTaskIds.clear();
    // The host deletes a task for its owner alone; asked first, so a row the
    // host would refuse never leaves and comes back.
    const owned = await Promise.all(taskIds.map((id) => ownsTask(session.tasksStore, id)));
    const ids = taskIds.filter((_, i) => owned[i]);
    const refused = taskIds.length - ids.length;
    if (refused) toasts.error(`Couldn't delete ${refused} task${refused === 1 ? "" : "s"}`, { description: "Only the owner can delete a task." });
    // A session with no task has no record to delete: it leaves the sidebar
    // and stays in History.
    for (const row of rows) {
      if (!row.taskId) sidebarStore.closeTask(row);
    }
    const pending = sidebarStore.deleteTasks(ids);
    if (!pending.length) return;
    toasts.undo(
      `${ids.length} task${ids.length === 1 ? "" : "s"} deleted`,
      () => session.tasksStore.restorePending(pending),
      {
        onDismiss: () =>
          void session.tasksStore.commitPending(pending).catch((error) =>
            toasts.error("Couldn't delete task", {
              description:
                error instanceof Error ? error.message : String(error),
            }),
          ),
      },
    );
  }

  function renameSidebarItem(
    task: SidebarTask,
    child: SidebarSessionChild | null,
    next: string,
  ) {
    cancelRename();
    if (!child) {
      void sidebarStore.renameTask(task, next);
    } else if (child.tabId) {
      void sidebarStore.renameSession(child.tabId, next);
    }
  }

  function selectSession(child: SidebarSessionChild) {
    void sidebarStore.selectChild(child);
    requestInputFocus();
    onSessionSelect?.();
  }

  function stopTask(task: SidebarTask) {
    for (const tabId of task.tabIds)
      session.controls.interruptTabSession(tabId);
    requestInputFocus();
  }

  /** Closing removes the mounted tab. The durable session remains resumable
   *  from the session picker. */
  function closeSession(tabId: string) {
    sidebarStore.closeSidebarTab(tabId);
    requestInputFocus();
  }

  async function setTaskStatus(taskId: string, status: TaskStatus) {
    try {
      await session.tasksStore.get(taskId).setStatus(status);
    } catch (error) {
      toasts.error("Couldn't update task status", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      requestInputFocus();
    }
  }

  /** Completion and reopening use the task's canonical workflow status.
   *  The store's command also clears the mounted conversation, the same way
   *  the row's close control does. */
  async function completeTask(task: SidebarTask) {
    try {
      await sidebarStore.completeTask(task);
      requestInputFocus();
    } catch (error) {
      toasts.error("Couldn't complete task", {
        description: error instanceof Error ? error.message : String(error),
      });
      requestInputFocus();
    }
  }

  /** Removing a session is local sidebar view state. Its task, provider run, and
   *  durable history stay unchanged and the picker can restore the row. */
  function removeChild(child: SidebarSessionChild) {
    sidebarStore.closeChild(child);
    requestInputFocus();
  }

  /** Removing a task is local sidebar view state. Its workflow status and any
   *  provider run stay unchanged; only the row and mounted tabs leave. */
  function removeTask(task: SidebarTask) {
    sidebarStore.closeTask(task);
    requestInputFocus();
  }

  /** Completing a task decides that its work is finished, so a session still
   *  running or waiting on the user has to settle first. Snooze is deliberately
   *  not in this set: deferring a row makes no claim about the work. */
  function completionBlocked(
    attention: SidebarTask["attention"] | SidebarSessionChild["attention"],
  ): boolean {
    return (
      attention === "running" ||
      attention === "awaiting" ||
      attention === "awaiting_plan" ||
      attention === "limited"
    );
  }

  /** Whether a turn is in flight for this row, so the confirmation can say
   *  that snoozing it did not stop the agent. */
  function isRunningRow(rowKey: string): boolean {
    return sidebarStore.allTasks.some(
      (row) => row.key === rowKey && row.attention === "running",
    );
  }

  function openSnooze(target: SnoozeTarget, anchor: TaskSnoozeAnchor) {
    snoozeAnchor = anchor;
    snoozeTargets = [target];
  }

  function navigateAfterLifecycleMove(next: SidebarTask | null) {
    if (next) void sidebarStore.selectTask(next);
    else newSession();
    requestInputFocus();
    onSessionSelect?.();
  }

  function wakeRow(rowKey: string) {
    sidebarStore.snoozeRow(rowKey, null);
    requestInputFocus();
  }

  function confirmSnooze(until: number, note: string) {
    const targets = snoozeTargets;
    snoozeTargets = [];
    snoozeAnchor = null;
    applySnooze(targets, until, note);
  }

  /** Shared by the snooze popover and the context menu's preset submenu, which
   *  skips the popover entirely and therefore carries no reminder note. */
  function applySnooze(targets: SnoozeTarget[], until: number, note: string) {
    if (!targets.length) return;
    const row =
      openRows.find((candidate) => candidate.key === targets[0].rowKey) ?? null;
    const leavingTaskIds = new Set(
      openRows
        .filter((task) => targets.some((target) => target.rowKey === task.key))
        .map((task) => task.id),
    );
    const next = row
      ? nextTaskAfterLeaving(openRows, row.id, leavingTaskIds)
      : null;
    const wasSelected = !!row?.tabIds.includes(session.onScreenTabId);
    for (const target of targets)
      sidebarStore.snoozeRow(target.rowKey, until, note);
    toasts.undo(
      taskSnoozeToastLabel({
        count: targets.length,
        hasNote: !!note,
        keepsRunning: targets.some((target) => isRunningRow(target.rowKey)),
      }),
      () => {
        for (const target of targets)
          sidebarStore.snoozeRow(target.rowKey, null);
      },
    );
    if (wasSelected) navigateAfterLifecycleMove(next);
    requestInputFocus();
  }

  /** The list drives itself off the DOM rather than a mirrored index: the rows
   *  it can move between are exactly the ones currently rendered, so a
   *  collapsed section or a filtered project needs no bookkeeping here. */
  function handleTreeKeydown(event: KeyboardEvent) {
    if (event.metaKey || event.ctrlKey || event.altKey || !scrollEl) return;

    const rows = [
      ...scrollEl.querySelectorAll<HTMLElement>('[role="treeitem"]'),
    ];
    const focused =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>('[role="treeitem"]')
        : null;
    const index = focused ? rows.indexOf(focused) : -1;
    if (index < 0) return;

    const taskKey = focused!.dataset.taskKey;
    // A session listed under a row has no key of its own; its parent is the
    // nearest row above it.
    const parentIndex =
      taskKey === undefined
        ? rows.findLastIndex(
            (row, at) => at < index && row.dataset.taskKey !== undefined,
          )
        : -1;

    const intent = treeKeyIntent(
      event.key,
      { index, parentIndex: parentIndex < 0 ? null : parentIndex },
      rows.length,
    );
    if (!intent) return;
    event.preventDefault();

    const task = taskKey
      ? openRows.find((item) => item.key === taskKey)
      : undefined;

    switch (intent.kind) {
      case "focus":
        rows[intent.index]?.focus();
        break;
      case "enterPane":
        requestInputFocus();
        break;
      case "close":
        // Keyboard dismissal only takes the row off the column: it never stops
        // the run and never changes task status. Ending the task itself is the
        // row's own close control.
        if (task) removeTask(task);
        else if (focused!.dataset.tabId) closeSession(focused!.dataset.tabId);
        break;
    }
  }

  /** Right-click and ⋯ open the identical menu. Durable task rows use the
   *  task-specific menu; loose session rows keep the session menu. */
  function openSessionContextMenu(
    event: MouseEvent,
    target:
      | {
          kind: "tab";
          tabId: string | null;
        }
      | { kind: "pinned"; pin: PinnedSession },
  ) {
    event.preventDefault();
    event.stopPropagation();
    sessionContextMenu = { ...target, x: event.clientX, y: event.clientY };
  }

  function closeSessionContextMenu() {
    sessionContextMenu = null;
  }

  function openTaskContextMenu(
    event: MouseEvent | PointerEvent,
    taskId: string,
    sidebarTask?: SidebarTask,
    child?: SidebarSessionChild,
  ) {
    event.preventDefault();
    event.stopPropagation();
    sessionContextMenu = {
      kind: "task",
      taskId,
      sidebarTask,
      child,
      x: event.clientX,
      y: event.clientY,
    };
  }

  function openTaskOrSessionContextMenu(
    event: MouseEvent | PointerEvent,
    task: SidebarTask,
  ) {
    if (task.taskId) {
      openTaskContextMenu(event, task.taskId, task);
      return;
    }
    // A shelved session with no conversation here has its actions on the row.
    if (!task.tabIds[0]) return;
    openSessionContextMenu(event, { kind: "tab", tabId: task.tabIds[0] });
  }

  function openChildContextMenu(
    event: MouseEvent | PointerEvent,
    child: SidebarSessionChild,
  ) {
    if (child.tabId) {
      openSessionContextMenu(event, { kind: "tab", tabId: child.tabId });
      return;
    }
    if (child.taskId) {
      openTaskContextMenu(event, child.taskId, undefined, child);
      return;
    }
    openSessionContextMenu(event, { kind: "tab", tabId: child.tabId ?? null });
  }

  async function openPinnedSessionInSplit(pin: PinnedSession) {
    const openTabId = sidebarStore.openTabIdForPinned(pin);
    const splitTabId =
      openTabId ??
      (await session.opening.resumeSession(
        {
          provider: pin.provider,
          sessionId: pin.sessionId,
          serverId: pin.serverId,
          slug: null,
          firstMessage: pin.title,
          lastTimestamp: new Date(pin.pinnedAt).toISOString(),
          size: 0,
          cwd: pin.cwd,
          projectPath: "",
        },
        { background: true },
      ));
    session.openTabAsSurface(splitTabId);
    onSessionSelect?.();
  }
</script>

{#snippet taskRow(task: SidebarTask)}
  {@const prChoices = sidebarStore.prChoicesFor(task)}
  <TaskRow
    {task}
    prChip={prChipForChoices(prChoices)}
    {prChoices}
    onPath={sidebarStore.onScreenTaskId === task.id}
    bulkSelected={selectedTaskIds.has(task.id)}
    sessions={sidebarStore.sessionsFor(task)}
    disclosedSession={sidebarStore.disclosedSession?.rowId === task.id
      ? sidebarStore.disclosedSession.session
      : null}
    {renamingTabId}
    {renamingTaskId}
    onSelect={(event) => selectOrActivateTask(task, event)}
    onStartRename={(child) =>
      startRename(
        child
          ? { tabId: child.tabId }
          : // Mirrors `renamingRow` in TaskRow: a durable row is named by its
            // task, a session's own row by its only tab.
            task.taskId
            ? { taskId: task.taskId }
            : { tabId: task.tabIds[0] },
      )}
    onRename={(child, next) => renameSidebarItem(task, child, next)}
    onRenameCancel={cancelRename}
    onMore={(event) => openTaskOrSessionContextMenu(event, task)}
    canSnooze={sidebarStore.canSnooze(task)}
    onSnooze={(anchor) =>
      openSnooze({ rowKey: task.key, title: task.title }, anchor)}
    onWake={() => wakeRow(task.key)}
    onComplete={() => completeTask(task)}
    onClose={() => removeTask(task)}
    onOpenPr={openTaskPr}
    onMorePr={(event, choice) =>
      (sessionContextMenu = {
        kind: "pull-request",
        row: task,
        choice,
        x: event.clientX,
        y: event.clientY,
      })}
    onOpenLinkedTask={() =>
      task.linkedTask && openLinkedTask(task.linkedTask.taskId)}
    onSelectSession={selectSession}
    onMoreSession={openChildContextMenu}
    onCloseSession={removeChild}
  />
{/snippet}

<SidePanel
  side="left"
  {open}
  {managedWidth}
  isElevated={false}
  minWidth={SIDEBAR_MIN_WIDTH}
  maxWidth={SIDEBAR_MAX_WIDTH}
  onAction={onToggleCollapse}
  actionTooltip={`Collapse sidebar (${comboHint("global.toggle-sidebar")})`}
  actionAriaLabel="Collapse sidebar"
  background="color-mix(in oklch, var(--card) 99%, var(--foreground))"
>
  <!-- The one filled control in the column, kept compact so it leads without
      overpowering the navigation below it. -->

  <Sidebar.Group class="flex-shrink-0 p-0">
    <Sidebar.GroupContent class="px-3.5 @max-[15rem]:px-2.5">
      <Sidebar.Menu class="gap-0.5">
        <Sidebar.MenuItem>
          <Sidebar.MenuButton
            size="sm"
            class="group flex h-7 w-full cursor-pointer items-center gap-[0.5625rem] rounded-lg bg-transparent pr-2 pl-[0.125rem] text-left text-[color-mix(in_oklch,var(--foreground)_88%,transparent)] transition-[color,background] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground {session.router.at(
              'folio',
            )
              ? 'text-foreground'
              : ''}"
            isActive={session.router.at("folio")}
            onclick={() => session.toggleFolio()}
          >
            <span class="flex shrink-0 items-center"
              ><BooksIcon size={14} /></span
            >
            <span class="flex-1 text-left text-workspace-chrome">Workspace</span
            >
            {#if reviewInboxCount > 0}
              <span
                class="shrink-0 text-xs text-muted-foreground opacity-60 tabular-nums"
                title={`${reviewInboxCount} ${reviewInboxCount === 1 ? "work needs" : "works need"} your review`}
                aria-label={`${reviewInboxCount} need your review`}
                data-testid="work-review-inbox-count"
                >{reviewInboxCount > 99 ? "99+" : reviewInboxCount}</span
              >
            {:else}
              <span
                class="shrink-0 text-xs opacity-0 transition-opacity duration-[120ms] group-hover:opacity-70"
                >{comboHint("global.toggle-workspace")}</span
              >
            {/if}
          </Sidebar.MenuButton>
        </Sidebar.MenuItem>
        <Sidebar.MenuItem>
          <Sidebar.MenuButton
            size="sm"
            class="group flex h-7 w-full cursor-pointer items-center gap-[0.5625rem] rounded-lg bg-transparent pr-2 pl-[0.125rem] text-left text-[color-mix(in_oklch,var(--foreground)_88%,transparent)] transition-[color,background] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground {session.router.at(
              'automations',
            )
              ? 'text-foreground'
              : ''}"
            isActive={session.router.at("automations")}
            onclick={() => session.toggleAutomations()}
          >
            <span class="flex shrink-0 items-center"
              ><ArrowsClockwiseIcon size={14} /></span
            >
            <span class="flex-1 text-left text-workspace-chrome"
              >Automations</span
            >
            <span
              class="shrink-0 text-xs opacity-0 transition-opacity duration-[120ms] group-hover:opacity-70"
              >{comboHint("global.toggle-automations")}</span
            >
          </Sidebar.MenuButton>
        </Sidebar.MenuItem>
        <Sidebar.MenuItem>
          <Sidebar.MenuButton
            size="sm"
            class="group flex h-7 w-full cursor-pointer items-center gap-[0.5625rem] rounded-lg bg-transparent pr-2 pl-[0.125rem] text-left text-[color-mix(in_oklch,var(--foreground)_88%,transparent)] transition-[color,background] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground {session.router.at(
              'insights',
            )
              ? 'text-foreground'
              : ''}"
            isActive={session.router.at("insights")}
            onclick={() => session.toggleInsights()}
          >
            <span class="flex shrink-0 items-center"
              ><ChartBarIcon size={14} /></span
            >
            <span class="flex-1 text-left text-workspace-chrome">Insights</span>
            <span
              class="shrink-0 font-mono text-menu-meta opacity-0 transition-opacity duration-[120ms] group-hover:opacity-70"
              >{comboHint("global.toggle-insights")}</span
            >
          </Sidebar.MenuButton>
        </Sidebar.MenuItem>
        <Sidebar.MenuItem>
          <Sidebar.MenuButton
            size="sm"
            class="group flex h-7 w-full cursor-pointer items-center gap-[0.5625rem] rounded-lg bg-transparent pr-2 pl-[0.125rem] text-left text-[color-mix(in_oklch,var(--foreground)_88%,transparent)] transition-[color,background] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground {session.router.at(
              'prs',
            )
              ? 'text-foreground'
              : ''}"
            isActive={session.router.at("prs")}
            onclick={togglePrs}
          >
            <span class="flex shrink-0 items-center"
              ><GitPullRequestIcon size={14} /></span
            >
            <span class="flex-1 text-left text-workspace-chrome"
              >Pull requests</span
            >
            {#if needsReviewCount > 0}
              <span
                class="shrink-0 text-xs text-muted-foreground opacity-60 tabular-nums"
                title={`${needsReviewCount} pull ${needsReviewCount === 1 ? "request needs" : "requests need"} your review`}
                aria-label={`${needsReviewCount} need your review`}
                >{needsReviewCount > 99 ? "99+" : needsReviewCount}</span
              >
            {/if}
          </Sidebar.MenuButton>
        </Sidebar.MenuItem>
        <Sidebar.MenuItem>
          <Sidebar.MenuButton
            size="sm"
            class="group flex h-7 w-full cursor-pointer items-center gap-[0.5625rem] rounded-lg bg-transparent pr-2 pl-[0.125rem] text-left text-[color-mix(in_oklch,var(--foreground)_88%,transparent)] transition-[color,background] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground {session.router.at(
              'tasks',
            )
              ? 'text-foreground'
              : ''}"
            isActive={session.router.at("tasks")}
            onclick={() => session.toggleTasks()}
          >
            <span class="flex shrink-0 items-center"
              ><TaskIcon size={14} /></span
            >
            <span class="flex-1 text-left text-workspace-chrome">Tasks</span>
            <span
              class="shrink-0 text-xs opacity-0 transition-opacity duration-[120ms] group-hover:opacity-70"
              >{comboHint("global.toggle-tasks")}</span
            >
          </Sidebar.MenuButton>
        </Sidebar.MenuItem>
        <Sidebar.MenuItem>
          <Sidebar.MenuButton
            size="sm"
            class="group flex h-7 w-full cursor-pointer items-center gap-[0.5625rem] rounded-lg bg-transparent pr-2 pl-[0.125rem] text-left text-[color-mix(in_oklch,var(--foreground)_88%,transparent)] transition-[color,background] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground"
            onclick={() =>
              window.dispatchEvent(
                new CustomEvent("solus:toggle-session-picker"),
              )}
          >
            <span class="flex shrink-0 items-center"
              ><ClockIcon size={14} /></span
            >
            <span class="flex-1 text-left text-workspace-chrome">History</span>
            <span
              class="shrink-0 text-xs opacity-0 transition-opacity duration-[120ms] group-hover:opacity-70"
              >{comboHint("global.session-picker")}</span
            >
          </Sidebar.MenuButton>
        </Sidebar.MenuItem>
      </Sidebar.Menu>
    </Sidebar.GroupContent>
  </Sidebar.Group>

  <!-- Separate navigation from task controls. -->
  <div
    class="mx-3.5 mt-[1.125rem] h-[0.03125rem] flex-shrink-0 bg-sidebar-border @max-[15rem]:mx-2.5"
  ></div>

  <div class="flex-shrink-0">
    {#snippet taskSearch()}
      <label
        class="group/search relative block min-w-0 rounded-lg transition-[background-color] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_4%,transparent)] focus-within:bg-[color-mix(in_oklch,var(--foreground)_4%,transparent)]"
      >
        <MagnifyingGlassIcon
          size={14}
          class="pointer-events-none absolute top-1/2 left-0.5 -translate-y-1/2 text-[color-mix(in_oklch,var(--foreground)_45%,transparent)] transition-colors duration-150 group-focus-within/search:text-[color-mix(in_oklch,var(--foreground)_70%,transparent)]"
          aria-hidden="true"
        />
        <input
          bind:this={taskSearchEl}
          bind:value={taskQuery}
          type="search"
          placeholder="Search"
          aria-label="Search sidebar tasks and sessions"
          title={`Search sidebar tasks and sessions (${comboHint("global.focus-sidebar-task-search")})`}
          class="w-full h-7 rounded-lg border-0 bg-transparent pr-8 pl-[1.5625rem] text-workspace-chrome tracking-[-0.006em] text-foreground outline-none placeholder:text-[color-mix(in_oklch,var(--foreground)_45%,transparent)] [&::-webkit-search-cancel-button]:hidden"
          onkeydown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            if (taskQuery) taskQuery = "";
            else requestInputFocus();
          }}
        />
        {#if taskQuery}
          <button
            type="button"
            class="absolute top-1/2 right-1 flex size-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-[background-color,color,scale] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_8%,transparent)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring active:scale-[0.96]"
            aria-label="Clear task search"
            onclick={() => {
              taskQuery = "";
              taskSearchEl?.focus();
            }}
          >
            <XIcon size={11} weight="bold" />
          </button>
        {:else}
          <kbd
            class="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 font-sans text-xs leading-none font-medium text-[color-mix(in_oklch,var(--foreground)_35%,transparent)] opacity-0 transition-opacity duration-150 group-hover/search:opacity-100 group-focus-within/search:opacity-0"
            aria-hidden="true"
            >{comboHint("global.focus-sidebar-task-search")}</kbd
          >
        {/if}
      </label>
    {/snippet}
    {#snippet newDraft()}
      <button
        type="button"
        class="relative flex size-6 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-[background-color,color,scale] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring active:scale-[0.96] pointer-coarse:size-7 pointer-coarse:before:absolute pointer-coarse:before:left-1/2 pointer-coarse:before:top-1/2 pointer-coarse:before:size-10 pointer-coarse:before:-translate-x-1/2 pointer-coarse:before:-translate-y-1/2 pointer-coarse:before:content-['']"
        aria-label="New draft"
        title="New draft"
        onclick={() => {
          newSession();
          requestInputFocus();
          onSessionSelect?.();
        }}
      >
        <PlusIcon size={15} class="pointer-coarse:size-[15px]" />
      </button>
    {/snippet}
    <TaskActionBar
      scopedProject={sidebarStore.scopedProject}
      projectChoices={sidebarStore.projectFilterChoices}
      onFilter={filterToProject}
      leading={taskSearch}
      trailing={newDraft}
    />
  </div>

  {#if selectedTaskIds.size > 0}
    <div
      class="mx-3.5 mb-2 flex min-h-9 items-center gap-1 rounded-lg border border-border bg-popover px-2 shadow-sm @max-[15rem]:mx-2.5"
    >
      <span class="mr-auto text-xs font-medium"
        >{selectedTaskIds.size} selected</span
      >
      <button
        type="button"
        class="rounded-lg px-2 py-1 text-xs hover:bg-accent"
        onclick={() => void bulkComplete()}>Complete</button
      >
      <button
        type="button"
        class="rounded-lg px-2 py-1 text-xs hover:bg-accent"
        onclick={(event) => {
          // A selected upstream ticket cannot be snoozed and stays where it is.
          const targets = selectedTasks()
            .filter((row) => sidebarStore.canSnooze(row))
            .map((row) => ({ rowKey: row.key, title: row.title }));
          if (!targets.length) return;
          snoozeAnchor = event.currentTarget;
          snoozeTargets = targets;
        }}>Snooze…</button
      >
      <button
        type="button"
        class="rounded-lg px-2 py-1 text-xs hover:bg-accent"
        onclick={() => void bulkMarkUnread()}>Unread</button
      >
      <button
        type="button"
        class="rounded-lg px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
        onclick={() => void bulkDelete()}>Delete</button
      >
      <button
        type="button"
        class="rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
        onclick={() => selectedTaskIds.clear()}>Clear</button
      >
    </div>
  {/if}

  <!-- Only the list scrolls; everything above it is furniture. A row moves
       only when it changes state: into Working when its agent gets busy, and
       to the top of its section when it comes back to you. A row that moves
       for any other reason costs a misclick or your place.

       The width must not move either, which is why the gutter is reserved
       rather than claimed on demand. The app's scrollbars are styled, not overlaid, so Chromium takes
       their width out of the content box the moment a scroller overflows —
       expanding one task pushed the list over that line and narrowed every row
       in the column by the bar's width, mid-click. Holding the gutter open
       costs the same 8px whether or not the bar is there, and nothing moves. -->
  <div
    bind:this={scrollEl}
    class="@container min-h-0 flex-1 overflow-y-auto px-3.5 pt-2 pb-3.5 [scrollbar-gutter:stable] @max-[15rem]:px-2.5"
    style="-webkit-overflow-scrolling:touch; overscroll-behavior-y:contain"
  >
    <!-- One list: drafts lead, then the Tasks, Sessions, Working, Snoozed and
         Completed sections with their headers as entries. A row that changes section,
         and a draft that arrives or leaves, then animate as a change of order
         (docs/plans/sidebar-motion.md, step 3). Drafts carry a pencil mark and
         a divider below them rather than a heading; a prompt on its way to
         becoming a session is not one yet. -->
    <div
      role="tree"
      tabindex="-1"
      aria-label="Tasks and sessions"
      onkeydown={handleTreeKeydown}
    >
      <div
        class="relative flex flex-col gap-[0.1875rem]"
        {@attach sidebarListMotion(
          () => sidebarListOrderKey(listItems),
          () => theme.sidebarMotionMs,
          () => scrollEl,
        )}
      >
        {#each listItems as item, index (item.key)}
          {#if item.kind === "draft"}
            <div>
              <DraftRow
                row={item.draft}
                onSelect={() => openDraft(item.draft)}
                onDiscard={() => discardDraft(item.draft)}
              />
            </div>
          {:else if item.kind === "drafts-divider"}
            <div
              class="my-[0.3125rem] h-px bg-sidebar-border/50"
              aria-hidden="true"
            ></div>
          {:else if item.kind === "header" && item.section === "snoozed"}
            <!-- The extra space sets the shelves apart from the cards above.
                 Below a closed header there are no cards, so it takes the same
                 gap as one header below another. -->
            <div
              class={listItems[index - 1]?.kind === "header" ? "mt-2" : "mt-3"}
            >
              <button
                type="button"
                class="-mx-2 flex h-7 w-[calc(100%+1rem)] cursor-pointer items-center gap-[0.5625rem] rounded-lg pr-2 pl-[0.625rem] text-chrome-shelf font-normal text-(--solus-status-unread) transition-[color,background] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_3.5%,transparent)] hover:text-[color-mix(in_oklch,var(--solus-status-unread)_78%,var(--foreground))]"
                aria-expanded={item.isOpen}
                onclick={() => toggleSection(item.section)}
              >
                Snoozed
                <span
                  class="h-px min-w-4 flex-1 bg-sidebar-border/50"
                  aria-hidden="true"
                ></span>
                <span class="tabular-nums opacity-60">{item.count}</span>
                <span class="flex size-4 shrink-0 items-center justify-center">
                  <CaretRightIcon
                    size={14}
                    class="transition-transform duration-150 {item.isOpen
                      ? 'rotate-90'
                      : ''}"
                  />
                </span>
              </button>
            </div>
          {:else if item.kind === "header"}
            <!-- Tasks and Sessions are the two live sections: a task is talked
                 to through its lead with its page beside it, a session is a
                 conversation on its own. Working holds the rows whose agent is
                 busy without you; it and Completed take the same header. A
                 section that opens the list needs no space above it. -->
            <div
              class="mt-2 first:mt-0 {item.section === 'completed' ||
              (item.section === 'working' && !item.isOpen)
                ? ''
                : 'mb-1'}"
            >
              <button
                type="button"
                class="-mx-2 flex h-7 w-[calc(100%+1rem)] cursor-pointer items-center gap-[0.5625rem] rounded-lg pr-2 pl-[0.625rem] text-chrome-shelf font-normal text-muted-foreground transition-[color,background] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_3.5%,transparent)] hover:text-foreground"
                aria-expanded={item.isOpen}
                onclick={() => toggleSection(item.section)}
              >
                {item.section === "tasks"
                  ? "Tasks"
                  : item.section === "sessions"
                    ? "Sessions"
                    : item.section === "working"
                      ? "Working"
                      : "Completed"}
                <span
                  class="h-px min-w-4 flex-1 bg-sidebar-border/50"
                  aria-hidden="true"
                ></span>
                <span class="tabular-nums opacity-60">{item.count}</span>
                <span class="flex size-4 shrink-0 items-center justify-center">
                  <CaretRightIcon
                    size={14}
                    class="transition-transform duration-150 {item.isOpen
                      ? 'rotate-90'
                      : ''}"
                  />
                </span>
              </button>
            </div>
          {:else}
            <!-- `content-visibility: auto` contains each row, so a change in
                 one row never lays out the whole window, and rows below the
                 fold skip style and layout. The intrinsic size matches the
                 row, so a row does not shift the list when it paints. The row
                 reaches past this box (`-mx-2`, hover shadow, focus ring); the
                 padding and the clip margin keep that inside paint
                 containment. -->
            <div
              class="-mx-2 px-2 [content-visibility:auto] [overflow-clip-margin:0.5rem] {item.section ===
                'tasks' ||
              item.section === 'sessions' ||
              item.section === 'working'
                ? '[contain-intrinsic-size:auto_62px]'
                : '[contain-intrinsic-size:auto_36px]'} {item.section ===
              'completed'
                ? 'opacity-80'
                : ''}"
            >
              {@render taskRow(item.task)}
            </div>
          {/if}
        {/each}
      </div>
      {#if !session.tasksStore.loaded}
        <TaskListSkeleton />
      {/if}
    </div>
  </div>

  <!-- Separate the task list from saved sessions. -->
  <div
    class="mx-3.5 h-[0.03125rem] flex-shrink-0 bg-sidebar-border @max-[15rem]:mx-2.5"
  ></div>
  <Sidebar.Footer
    class="relative flex-shrink-0 px-3.5 py-2 @max-[15rem]:px-2.5"
  >
    <Sidebar.Menu class="gap-0.5">
      {#if sidebarStore.pinnedSessions.length > 0}
        <Sidebar.MenuItem>
          <Sidebar.MenuButton
            class="group flex h-8 w-full cursor-pointer items-center gap-[0.6875rem] rounded-lg bg-transparent px-[0.625rem] text-left text-[color-mix(in_oklch,var(--foreground)_88%,transparent)] transition-[color,background] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground"
            onclick={() => (savedSessionsOpen = !savedSessionsOpen)}
          >
            <span class="flex shrink-0 items-center"
              ><PushPinIcon size={14} weight="fill" /></span
            >
            <span class="flex-1 text-left text-workspace-chrome"
              >Saved sessions</span
            >
            <span
              class="shrink-0 text-xs text-muted-foreground opacity-60 tabular-nums"
              >{sidebarStore.pinnedSessions.length}</span
            >
            <CaretRightIcon
              size={14}
              class="shrink-0 transition-transform duration-150 {savedSessionsOpen
                ? 'rotate-90'
                : ''}"
            />
          </Sidebar.MenuButton>
        </Sidebar.MenuItem>
        {#if savedSessionsOpen}
          <div class="flex flex-col gap-0.5 pb-1">
            {#each sidebarStore.pinnedSessions as pin (`${pin.serverId ?? ""}:${pin.sessionId}`)}
              {@const openTabId = sidebarStore.openTabIdForPinned(pin)}
              {@const isActive =
                !!openTabId && openTabId === session.onScreenTabId}
              <TooltipUI.Root>
                <TooltipUI.Trigger>
                  {#snippet child({ props: tooltipProps })}
                    <div
                      {...tooltipProps}
                      class="group/pin flex h-[1.875rem] cursor-pointer items-center gap-2 rounded-lg pr-1.5 pl-[2.25rem] transition-[background] duration-150 hover:bg-accent"
                      role="button"
                      tabindex="0"
                      onclick={() => {
                        void sidebarStore.openPinnedSession(pin);
                        onSessionSelect?.();
                      }}
                      onkeydown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          void sidebarStore.openPinnedSession(pin);
                          onSessionSelect?.();
                        }
                      }}
                      oncontextmenu={(event) =>
                        openSessionContextMenu(event, { kind: "pinned", pin })}
                    >
                      <span
                        class="min-w-0 flex-1 overflow-hidden text-workspace-chrome text-ellipsis whitespace-nowrap {isActive
                          ? 'font-medium text-foreground'
                          : 'text-[color-mix(in_oklch,var(--foreground)_88%,transparent)]'}"
                        >{pin.title}</span
                      >
                      <button
                        class="hidden size-5 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-[color,background] duration-[120ms] group-hover/pin:flex hover:bg-accent hover:text-foreground pointer-coarse:flex"
                        aria-label="Unpin session"
                        title="Unpin"
                        onclick={(event) => {
                          event.stopPropagation();
                          void sidebarStore.unpinSession(pin);
                          requestInputFocus();
                        }}
                      >
                        <PushPinIcon size={14} weight="fill" />
                      </button>
                    </div>
                  {/snippet}
                </TooltipUI.Trigger>
                <SessionSidebarTooltip
                  title={pin.title}
                  projectKey={pin.cwd}
                  serverId={pin.serverId}
                  provider={pin.provider}
                  modelId={pin.model}
                />
              </TooltipUI.Root>
            {/each}
          </div>
        {/if}
      {/if}
      <SidebarAccountFooter />
    </Sidebar.Menu>
  </Sidebar.Footer>
</SidePanel>

{#if sessionContextMenu}
  {#if sessionContextMenu.kind === "task"}
    {@const menuTask = session.tasksStore.tasks.find(
      (task) => task.id === sessionContextMenu.taskId,
    )}
    {@const sidebarTask = sessionContextMenu.sidebarTask}
    {@const menuChild = sessionContextMenu.child}
    {@const taskMenuPoint = { x: sessionContextMenu.x, y: sessionContextMenu.y }}
    {@const hasLinkedSession =
      !!sidebarTask?.tabIds.length ||
      !!menuChild?.tabId ||
      !!menuChild?.sessionId ||
      (menuTask
        ? session.tasksStore.get(menuTask.id).sessions.length > 0
        : false)}
    {@const menuPrChoices = sidebarTask
      ? sidebarStore.prChoicesFor(sidebarTask)
      : []}
    {#if menuTask}
      <TaskContextMenu
        x={sessionContextMenu.x}
        y={sessionContextMenu.y}
        task={menuTask}
        {hasLinkedSession}
        isRunning={sidebarTask?.status === "running" ||
          menuChild?.attention === "running"}
        onStart={() => void session.opening.openTaskSession(menuTask)}
        onResume={hasLinkedSession
          ? () => void session.opening.openTaskLinkedSession(menuTask)
          : undefined}
        onStop={sidebarTask
          ? () => stopTask(sidebarTask)
          : menuChild?.tabId
            ? () => session.controls.interruptTabSession(menuChild.tabId!)
            : undefined}
        onOpenTask={() => session.goToTask(menuTask.id)}
        onOpenSource={() => {
          if (menuTask.url) void localApi.openExternal(menuTask.url);
        }}
        prChoices={menuPrChoices}
        onOpenPr={menuPrChoices.length && sidebarTask ? openTaskPr : undefined}
        onOpenPrWeb={(choice) => {
          const url = choice.url ?? choice.pullRequest?.url;
          if (url) void localApi.openExternal(url);
        }}
        onUnlinkPr={(choice) => {
          void session.tasksStore
            .get(menuTask.id)
            .unlink("pr", String(choice.number), choice.targetScope)
            .catch((error) =>
              toasts.error("Couldn't unlink pull request", {
                description:
                  error instanceof Error ? error.message : String(error),
              }),
            );
        }}
        onStartRename={() => startRename({ taskId: menuTask.id })}
        onSetStatus={(status) => void setTaskStatus(menuTask.id, status)}
        onMarkUnread={() => void sidebarStore.markTaskUnread(menuTask.id)}
        onSnoozeCustom={sidebarTask && sidebarStore.canSnooze(sidebarTask)
          ? () =>
              openSnooze(
                { rowKey: sidebarTask.key, title: sidebarTask.title },
                taskMenuPoint,
              )
          : undefined}
        onLinkPr={() =>
          (session.ui.linkPrompt = {
            kind: "task-pull-request",
            taskId: menuTask.id,
          })}
        onRemove={undefined}
        onClose={closeSessionContextMenu}
      />
    {/if}
  {:else if sessionContextMenu.kind === "tab"}
    {@const menuTabId = sessionContextMenu.tabId}
    {@const menuPoint = { x: sessionContextMenu.x, y: sessionContextMenu.y }}
    <!-- Snooze and completion belong to a session's own row. A session listed
         under a task leaves both to the task. -->
    {@const menuRow = menuTabId ? sidebarStore.taskForTab(menuTabId) : null}
    {@const sessionRow = menuRow && !menuRow.taskId ? menuRow : null}
    <SessionContextMenu
      x={sessionContextMenu.x}
      y={sessionContextMenu.y}
      tabId={menuTabId}
      showSplit
      onStartRename={(tabId) => startRename({ tabId })}
      rowActions={{
        onStop:
          menuTabId &&
          sidebarStore.childForTab(menuTabId).attention === "running"
            ? () => session.controls.interruptTabSession(menuTabId)
            : undefined,
        done: sessionRow?.status === "done",
        onToggleDone: sessionRow
          ? () => void completeTask(sessionRow)
          : undefined,
        onSnooze:
          sessionRow &&
          sessionRow.lifecycle !== "snoozed" &&
          sidebarStore.canShelve(sessionRow)
            ? () =>
                openSnooze(
                  { rowKey: sessionRow.key, title: sessionRow.title },
                  menuPoint,
                )
            : undefined,
      }}
      onCloseTab={closeSession}
      closeTabLabel="Remove from Sidebar"
      closeTabIsDestructive={false}
      onClose={closeSessionContextMenu}
    />
  {:else if sessionContextMenu.kind === "pull-request"}
    {@const prMenu = sessionContextMenu}
    <PrContextMenu
      x={prMenu.x}
      y={prMenu.y}
      choice={prMenu.choice}
      onOpen={() => openTaskPr(prMenu.choice)}
      onOpenWeb={() => {
        const url = prMenu.choice.url ?? prMenu.choice.pullRequest?.url;
        if (url) void localApi.openExternal(url);
      }}
      onUnlink={sidebarStore.canUnlinkPullRequest(prMenu.row, prMenu.choice)
        ? () =>
            void sidebarStore
              .unlinkPullRequest(prMenu.row, prMenu.choice)
              .catch((error) =>
                toasts.error("Couldn't unlink pull request", {
                  description:
                    error instanceof Error ? error.message : String(error),
                }),
              )
        : undefined}
      onClose={closeSessionContextMenu}
    />
  {:else}
    {@const pin = sessionContextMenu.pin}
    <SessionContextMenu
      x={sessionContextMenu.x}
      y={sessionContextMenu.y}
      tabId={sidebarStore.openTabIdForPinned(pin) ?? null}
      sessionId={pin.sessionId}
      showSplit
      onRegenerateTitle={() => sidebarStore.regeneratePinnedSessionTitle(pin)}
      onOpenInSplit={() => void openPinnedSessionInSplit(pin)}
      onClose={closeSessionContextMenu}
    />
  {/if}
{/if}

{#if snoozeTargets.length > 0 && snoozeAnchor}
  <SnoozeTaskMenu
    anchor={snoozeAnchor}
    taskTitle={snoozeTargets.length === 1
      ? snoozeTargets[0].title
      : `${snoozeTargets.length} selected sessions`}
    limitResetsAt={snoozeTargets.length === 1
      ? sidebarStore.allTasks.find((row) => row.key === snoozeTargets[0].rowKey)?.limitResetsAt
      : undefined}
    onConfirm={(until, note) => void confirmSnooze(until, note)}
    onClose={() => {
      snoozeTargets = [];
      snoozeAnchor = null;
      requestInputFocus();
    }}
  />
{/if}
