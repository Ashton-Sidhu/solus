<script lang="ts">
  import { localApi } from "@client-core/local-api";
  import { serverConnections } from "@client-core/server-connections";
  import { tick } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { comboHint } from "../../lib/keybindings/manifest";
  import {
    BooksIcon,
    ClockIcon,
    CaretRightIcon,
    PushPinIcon,
    GearIcon,
    ArrowsClockwiseIcon,
    ListChecksIcon,
    GitPullRequestIcon,
    PlusIcon,
  } from "phosphor-svelte";
  import type { PinnedSession } from "../../../shared/types";
  import type { Task } from "../../../shared/task-types";
  import { getWorkspaceContext, getSessionSidebarStore } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { routeForHref } from "../../lib/agent-links";
  import SidePanel from "../layout/SidePanel.svelte";
  import {
    SIDEBAR_MAX_WIDTH,
    SIDEBAR_MIN_WIDTH,
  } from "../layout/lib/workspace-body";
  import * as Sidebar from "../ui/sidebar";
  import TaskListSkeleton from "./TaskListSkeleton.svelte";
  import SessionContextMenu from "./SessionContextMenu.svelte";
  import TaskContextMenu from "./TaskContextMenu.svelte";
  import TaskListHeader from "./TaskListHeader.svelte";
  import TaskRow from "./TaskRow.svelte";
  import DraftRow from "./DraftRow.svelte";
  import SnoozeTaskMenu from "./SnoozeTaskMenu.svelte";
  import type { TaskSnoozeAnchor } from "./lib/task-snooze";
  import type { DraftRow as DraftRowModel } from "./lib/draft-list";
  import { prNavigationTarget } from "./lib/pr-navigation";
  import type { SidebarSessionChild } from "../../contexts/workspace/session-sidebar.store.svelte";
  import {
    hasDisclosure,
    type PrChip,
    type SidebarTask,
  } from "./lib/task-list";
  import { treeKeyIntent } from "./lib/task-tree-keys";

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
  const sidebarStore = getSessionSidebarStore();
  const needsReviewCount = $derived(
    session.prsStore.needsReviewCountFor(
      session.serverIdForContext(session.ctx),
      session.ctx,
    ),
  );

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
    | null
  >(null);
  const expandedTaskIds = new SvelteSet<string>();
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
  let snoozedShelfOpen = $state(false);
  let completedShelfOpen = $state(false);
  let snoozeTargets = $state<Task[]>([]);
  let snoozeAnchor = $state<TaskSnoozeAnchor | null>(null);
  const selectedTaskIds = new SvelteSet<string>();
  let selectionAnchorId = $state<string | null>(null);
  $effect(() => {
    const visibleIds = new Set(
      sidebarStore.visibleTasks.map((task) => task.id),
    );
    for (const taskId of selectedTaskIds) {
      if (!visibleIds.has(taskId)) selectedTaskIds.delete(taskId);
    }
  });

  // Top-nav cluster (Workspace / Automations / …). These are static places,
  // not tasks — but they sit on the same spine: their icons occupy the 16px
  // column a task's disclosure lives in, and their labels start exactly where a
  // task title does, so the whole column reads as one list of one shape.
  // A static total, in the same muted mono as every other number in the column.
  // A filled badge here would be the brightest thing above the list and would
  // compete with the status marks, which are what the eye is meant to count.

  function toggleExpand(taskId: string) {
    if (expandedTaskIds.has(taskId)) expandedTaskIds.delete(taskId);
    else expandedTaskIds.add(taskId);
  }

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

  function newTask() {
    session.openSessionDraft({ freshTask: true, via: "click" });
  }

  function openTaskPr(task: SidebarTask, chip: PrChip): void {
    const linkedPr = session.tasksStore.prLinkFor(task.taskId);
    const linkedRoute = linkedPr ? routeForHref(linkedPr.url) : null;
    const linkedParams =
      linkedRoute?.name === "prReview" ? linkedRoute.params : null;
    const number = linkedParams?.number ?? chip.number;
    const pullRequest = session.prsStore.items.find(
      (item) => item.number === number,
    );
    const clientApi = serverConnections.primaryApi();
    const target = prNavigationTarget({
      clientServerId: serverConnections.serverIdForApi(clientApi),
      projectDirectory: task.projectKey,
      taskServerId: session.tasksStore.hostFor(task.taskId),
      attemptServerId: task.serverId,
    });
    void session.enterPrReview(number, pullRequest?.title, {
      ctx: session.ctxForDirectory(target.projectDirectory),
      serverId: target.serverId,
      expectedRepo: linkedParams?.expectedRepo,
      target: target.paneTarget,
      via: "click",
    });
  }

  /** A draft row goes back to the composer it was left in, with the caret in it
   *  — the row is a way to resume typing, not a way to look at the text. */
  function openDraft(row: DraftRowModel) {
    session.openDraft(row.draftId);
    requestInputFocus();
    onSessionSelect?.();
  }

  /** Discarding loses words the user wrote, and it is one click away on a hover
   *  action, so the toast holds them until it is dismissed. */
  function discardDraft(row: DraftRowModel) {
    const discarded = session.discardSessionDraft(row.draftId);
    requestInputFocus();
    if (!discarded) return;
    toasts.show({
      message: `Discarded “${row.title}”`,
      actions: [
        {
          label: "Undo",
          onAction: () => {
            session.restoreSessionDrafts({
              order: [row.draftId],
              drafts: { [row.draftId]: discarded },
            });
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

  /** A task-row activation has two explicit effects: toggle its disclosure,
   *  then navigate to its best session. The stable task id keeps the first
   *  effect independent from any branch/session changes caused by the second.
   *
   *  The two are also worlds apart in cost. Disclosure is a few rows in this
   *  column; navigation swaps the conversation, the diff pane and the focused
   *  input, and for a task with nothing mounted it waits on an IPC round trip
   *  first. Run in the same tick they land in one paint, so the caret appears
   *  only once the whole app has finished switching — which is what made the
   *  tree feel slow. The disclosure gets its own frame, and navigation follows
   *  on the next one, by which time the row has already answered the click. */
  function activateTask(task: SidebarTask) {
    if (task.taskId) void session.tasksStore.markRead(task.taskId, true);
    if (hasDisclosure(sidebarStore.sessionsFor(task))) toggleExpand(task.id);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        void sidebarStore.selectTask(task);
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
      const rows = sidebarStore.visibleTasks;
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
    return sidebarStore.visibleTasks.filter((task) =>
      selectedTaskIds.has(task.id),
    );
  }

  async function bulkComplete() {
    const rows = selectedTasks();
    const wasSelected = rows.some((task) =>
      task.tabIds.includes(session.onScreenTabId),
    );
    const next =
      sidebarStore.visibleTasks.find((task) => !selectedTaskIds.has(task.id)) ??
      null;
    const blocked = rows.find(
      (task) => lifecycleBlocked(task.attention) || !task.taskId,
    );
    if (blocked) {
      toasts.error(`“${blocked.title}” cannot be completed right now.`);
      return;
    }
    for (const row of rows) {
      try {
        await session.tasksStore.setStatus(row.taskId!, "done");
      } catch (error) {
        toasts.error(
          `Stopped after “${row.title}”: ${error instanceof Error ? error.message : String(error)}`,
        );
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
        await session.tasksStore.markRead(row.taskId, false);
      } catch (error) {
        toasts.error(
          `Stopped after “${row.title}”: ${error instanceof Error ? error.message : String(error)}`,
        );
        break;
      }
    }
    selectedTaskIds.clear();
    requestInputFocus();
  }

  function bulkDelete() {
    const ids = selectedTasks().flatMap((task) =>
      task.taskId ? [task.taskId] : [],
    );
    selectedTaskIds.clear();
    const pending = session.tasksStore.softRemove(ids);
    if (!pending.length) return;
    toasts.undo(
      `${ids.length} task${ids.length === 1 ? "" : "s"} deleted`,
      () => session.tasksStore.restorePending(pending),
      {
        onDismiss: () =>
          void session.tasksStore
            .commitPending(pending)
            .catch((error) =>
              toasts.error(
                `Couldn't delete task: ${error instanceof Error ? error.message : String(error)}`,
              ),
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
    if (child.taskId) void session.tasksStore.markRead(child.taskId, true);
    void sidebarStore.selectChild(child);
    requestInputFocus();
    onSessionSelect?.();
  }

  function stopTask(task: SidebarTask) {
    for (const tabId of task.tabIds) session.interruptTabSession(tabId);
    requestInputFocus();
  }

  /** Closing removes the mounted tab. The durable session remains resumable
   *  from the session picker. */
  function closeSession(tabId: string) {
    sidebarStore.closeSidebarTab(tabId);
    requestInputFocus();
  }

  /** The check is the only state the user sets themselves — it says "I am
   *  finished with this", which nothing the agent reports can stand in for. */
  function markTaskDone(taskId: string) {
    sidebarStore.toggleTaskDone(taskId);
    requestInputFocus();
  }

  /** Completion and reopening use the task's canonical workflow status. */
  async function completeTask(task: SidebarTask) {
    try {
      if (task.taskId)
        await session.tasksStore.setStatus(
          task.taskId,
          task.status === "done" ? "todo" : "done",
        );
      else sidebarStore.toggleTaskDone(task.id);
      requestInputFocus();
    } catch (error) {
      toasts.error(
        `Couldn't complete task: ${error instanceof Error ? error.message : String(error)}`,
      );
      requestInputFocus();
    }
  }

  function removeChild(child: SidebarSessionChild) {
    sidebarStore.closeChild(child);
    requestInputFocus();
  }

  async function completeChild(child: SidebarSessionChild) {
    try {
      if (child.taskId) {
        const task = session.tasksStore.taskForId(child.taskId);
        await session.tasksStore.setStatus(
          child.taskId,
          task?.status === "done" ? "todo" : "done",
        );
      } else if (child.tabId) sidebarStore.toggleTaskDone(child.tabId);
      requestInputFocus();
    } catch (error) {
      toasts.error(
        `Couldn't complete subtask: ${error instanceof Error ? error.message : String(error)}`,
      );
      requestInputFocus();
    }
  }

  function closeChild(child: SidebarSessionChild) {
    removeChild(child);
  }

  function removeTask(task: SidebarTask) {
    expandedTaskIds.delete(task.id);
    sidebarStore.closeTask(task);
    requestInputFocus();
  }

  /** Closing a task unloads its mounted sessions. Their durable history remains
   *  available from the session picker and task page. */
  function closeTask(task: SidebarTask) {
    removeTask(task);
  }

  function lifecycleBlocked(
    attention: SidebarTask["attention"] | SidebarSessionChild["attention"],
  ): boolean {
    return (
      attention === "running" ||
      attention === "awaiting" ||
      attention === "awaiting_plan" ||
      attention === "queued"
    );
  }

  function openSnooze(
    taskId: string | null | undefined,
    attention: SidebarTask["attention"] | SidebarSessionChild["attention"],
    anchor: TaskSnoozeAnchor,
  ) {
    if (!taskId) return;
    const task = session.tasksStore.taskForId(taskId);
    if (!task || task.status === "done" || task.status === "dropped") return;
    if (lifecycleBlocked(attention)) {
      toasts.error(
        "This task cannot be snoozed while it is running or waiting for input.",
      );
      requestInputFocus();
      return;
    }
    snoozeAnchor = anchor;
    snoozeTargets = [task];
  }

  function nextActiveTaskAfter(taskId: string): SidebarTask | null {
    const tasks = sidebarStore.visibleTasks;
    const index = tasks.findIndex((task) => task.id === taskId);
    if (index < 0) return null;
    return tasks[index + 1] ?? tasks[index - 1] ?? null;
  }

  function navigateAfterLifecycleMove(next: SidebarTask | null) {
    if (next) void sidebarStore.selectTask(next);
    else newTask();
    requestInputFocus();
    onSessionSelect?.();
  }

  async function wakeTask(task: Task) {
    try {
      await session.tasksStore.snooze(task.id, { until: null });
    } catch (error) {
      toasts.error(
        `Couldn't wake task: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      requestInputFocus();
    }
  }

  async function confirmSnooze(until: number, note: string) {
    const targets = snoozeTargets;
    snoozeTargets = [];
    snoozeAnchor = null;
    if (!targets.length) return;
    const task = targets[0];
    const row =
      sidebarStore.visibleTasks.find(
        (candidate) => candidate.taskId === task.id,
      ) ?? null;
    const next = row ? nextActiveTaskAfter(row.id) : null;
    const wasSelected = !!row?.tabIds.includes(session.onScreenTabId);
    try {
      for (const target of targets)
        await session.tasksStore.snooze(target.id, { until, note });
      const label = `${targets.length === 1 ? "Task" : `${targets.length} tasks`} snoozed${note ? " with a reminder" : ""}`;
      toasts.undo(label, () => {
        void Promise.all(
          targets.map((target) =>
            session.tasksStore.snooze(target.id, { until: null }),
          ),
        ).catch((error) =>
          toasts.error(
            `Couldn't undo snooze: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      });
      if (wasSelected) navigateAfterLifecycleMove(next);
    } catch (error) {
      toasts.error(
        `Couldn't snooze task: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      requestInputFocus();
    }
  }

  /** The tree drives itself off the DOM rather than a mirrored index: the rows
   *  it can move between are exactly the ones currently rendered, so a
   *  collapsed task or a filtered project needs no bookkeeping here. */
  function handleTreeKeydown(event: KeyboardEvent) {
    if (event.metaKey || event.ctrlKey || event.altKey || !scrollEl) return;

    const rows = [
      ...scrollEl.querySelectorAll<HTMLElement>('[role="treeitem"]'),
    ];
    const focused = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      '[role="treeitem"]',
    );
    const index = focused ? rows.indexOf(focused) : -1;
    if (index < 0) return;

    const expandedAttr = focused!.getAttribute("aria-expanded");
    // A session's parent is the nearest task row above it.
    const parentIndex =
      focused!.dataset.tabId ||
      (focused!.dataset.taskId && focused!.dataset.taskKey === undefined)
        ? rows.findLastIndex(
            (row, at) => at < index && row.dataset.taskKey !== undefined,
          )
        : focused!.dataset.taskKey
          ? rows.findLastIndex(
              (row, at) => at < index && row.dataset.projectKey !== undefined,
            )
          : -1;

    const intent = treeKeyIntent(
      event.key,
      {
        index,
        expanded: expandedAttr === null ? undefined : expandedAttr === "true",
        parentIndex: parentIndex < 0 ? null : parentIndex,
      },
      rows.length,
    );
    if (!intent) return;
    event.preventDefault();

    const taskKey = focused!.dataset.taskKey;
    const task = taskKey
      ? sidebarStore.visibleTasks.find((item) => item.key === taskKey)
      : undefined;

    switch (intent.kind) {
      case "focus":
        rows[intent.index]?.focus();
        break;
      case "expand":
      case "collapse":
        if (task) toggleExpand(task.id);
        break;
      case "enterPane":
        requestInputFocus();
        break;
      case "close":
        // Sidebar dismissal never stops the run, so keyboard and pointer paths
        // have the same presentation-only behavior.
        if (task) closeTask(task);
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
    openSessionContextMenu(event, {
      kind: "tab",
      tabId: task.tabIds[0] ?? null,
    });
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
      (await session.resumeSession(
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
    session.openTabInSplit(splitTabId);
    onSessionSelect?.();
  }
</script>

{#snippet taskRow(task: SidebarTask)}
  <TaskRow
    {task}
    prChip={sidebarStore.prChipFor(task)}
    onPath={task.tabIds.includes(session.onScreenTabId)}
    bulkSelected={selectedTaskIds.has(task.id)}
    expanded={expandedTaskIds.has(task.id)}
    onFilterProject={() => filterToProject(task.projectKey)}
    sessions={sidebarStore.sessionsFor(task)}
    selectedTabId={task.tabIds.includes(session.onScreenTabId)
      ? session.onScreenTabId
      : null}
    {renamingTabId}
    {renamingTaskId}
    onSelect={(event) => selectOrActivateTask(task, event)}
    onRename={(child, next) => renameSidebarItem(task, child, next)}
    onRenameCancel={cancelRename}
    onMore={(event) => openTaskOrSessionContextMenu(event, task)}
    onSnooze={(anchor) => openSnooze(task.taskId, task.attention, anchor)}
    onWake={() => {
      if (!task.taskId) return;
      const record = session.tasksStore.taskForId(task.taskId);
      if (record) void wakeTask(record);
    }}
    onComplete={() => completeTask(task)}
    onClose={() => closeTask(task)}
    onOpenPr={() => {
      const chip = sidebarStore.prChipFor(task);
      if (chip) openTaskPr(task, chip);
    }}
    onSelectSession={selectSession}
    onMoreSession={openChildContextMenu}
    onSnoozeSession={(child, anchor) =>
      openSnooze(child.taskId, child.attention, anchor)}
    onCompleteSession={completeChild}
    onCloseSession={closeChild}
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
    <Sidebar.GroupContent class="px-3.5">
      <Sidebar.Menu class="gap-0.5">
        <Sidebar.MenuItem>
          <Sidebar.MenuButton
            class="group flex h-8 w-full cursor-pointer items-center gap-[0.6875rem] rounded-lg bg-transparent px-[0.625rem] text-left text-[color-mix(in_oklch,var(--foreground)_88%,transparent)] transition-[color,background] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground {session.router.at(
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
            <span class="flex-1 text-left text-sm">Workspace</span>
            <span
              class="shrink-0 font-mono text-xs opacity-0 transition-opacity duration-[120ms] group-hover:opacity-70"
              >{comboHint("global.toggle-workspace")}</span
            >
          </Sidebar.MenuButton>
        </Sidebar.MenuItem>
        <Sidebar.MenuItem>
          <Sidebar.MenuButton
            class="group flex h-8 w-full cursor-pointer items-center gap-[0.6875rem] rounded-lg bg-transparent px-[0.625rem] text-left text-[color-mix(in_oklch,var(--foreground)_88%,transparent)] transition-[color,background] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground {session.router.at(
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
            <span class="flex-1 text-left text-sm">Automations</span>
            <span
              class="shrink-0 font-mono text-xs opacity-0 transition-opacity duration-[120ms] group-hover:opacity-70"
              >{comboHint("global.toggle-automations")}</span
            >
          </Sidebar.MenuButton>
        </Sidebar.MenuItem>
        <Sidebar.MenuItem>
          <Sidebar.MenuButton
            class="group flex h-8 w-full cursor-pointer items-center gap-[0.6875rem] rounded-lg bg-transparent px-[0.625rem] text-left text-[color-mix(in_oklch,var(--foreground)_88%,transparent)] transition-[color,background] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground {session.router.at(
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
            <span class="flex-1 text-left text-sm">Pull requests</span>
            {#if needsReviewCount > 0}
              <span
                class="shrink-0 font-mono text-xs text-muted-foreground opacity-60 tabular-nums"
                title={`${needsReviewCount} pull ${needsReviewCount === 1 ? "request needs" : "requests need"} your review`}
                aria-label={`${needsReviewCount} need your review`}
                >{needsReviewCount > 99 ? "99+" : needsReviewCount}</span
              >
            {/if}
          </Sidebar.MenuButton>
        </Sidebar.MenuItem>
        <Sidebar.MenuItem>
          <Sidebar.MenuButton
            class="group flex h-8 w-full cursor-pointer items-center gap-[0.6875rem] rounded-lg bg-transparent px-[0.625rem] text-left text-[color-mix(in_oklch,var(--foreground)_88%,transparent)] transition-[color,background] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground {session.router.at(
              'tasks',
            )
              ? 'text-foreground'
              : ''}"
            isActive={session.router.at("tasks")}
            onclick={() => session.toggleTasks()}
          >
            <span class="flex shrink-0 items-center"
              ><ListChecksIcon size={14} /></span
            >
            <span class="flex-1 text-left text-sm">Tasks</span>
            <span
              class="shrink-0 font-mono text-xs opacity-0 transition-opacity duration-[120ms] group-hover:opacity-70"
              >{comboHint("global.toggle-tasks")}</span
            >
          </Sidebar.MenuButton>
        </Sidebar.MenuItem>
        <Sidebar.MenuItem>
          <Sidebar.MenuButton
            class="group flex h-8 w-full cursor-pointer items-center gap-[0.6875rem] rounded-lg bg-transparent px-[0.625rem] text-left text-[color-mix(in_oklch,var(--foreground)_88%,transparent)] transition-[color,background] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground"
            onclick={() =>
              window.dispatchEvent(
                new CustomEvent("solus:toggle-session-picker"),
              )}
          >
            <span class="flex shrink-0 items-center"
              ><ClockIcon size={14} /></span
            >
            <span class="flex-1 text-left text-sm">History</span>
            <span
              class="shrink-0 font-mono text-xs opacity-0 transition-opacity duration-[120ms] group-hover:opacity-70"
              >{comboHint("global.session-picker")}</span
            >
          </Sidebar.MenuButton>
        </Sidebar.MenuItem>
      </Sidebar.Menu>
    </Sidebar.GroupContent>
  </Sidebar.Group>

  <!-- One of the two hairlines in the whole panel. -->
  <div
    class="mx-3.5 mt-[1.125rem] h-[0.03125rem] flex-shrink-0 bg-sidebar-border"
  ></div>

  <!-- Drafts are their own section above the tasks, not rows inside that list:
       a prompt on its way to becoming a task is not one yet, and filing it under
       the Tasks heading would say it is. The section is absent until something
       is written, and it caps its own height so a run of drafts scrolls within
       itself rather than pushing the task column off the bottom of the panel. -->
  {#if sidebarStore.draftRows.length > 0}
    <div class="flex max-h-[10.5rem] flex-shrink-0 flex-col">
      <TaskListHeader label="Drafts" count={sidebarStore.draftRows.length} />
      <div
        class="min-h-0 overflow-y-auto px-3.5 pb-1 [scrollbar-gutter:stable]"
        style="overscroll-behavior-y:contain"
      >
        <div
          class="flex flex-col gap-[0.1875rem]"
          role="listbox"
          aria-label="Drafts"
        >
          {#each sidebarStore.draftRows as row (row.draftId)}
            <DraftRow
              {row}
              onSelect={() => openDraft(row)}
              onDiscard={() => discardDraft(row)}
            />
          {/each}
        </div>
      </div>
    </div>
  {/if}

  <div class="flex-shrink-0">
    <TaskListHeader
      label="Tasks"
      count={sidebarStore.headerCount}
      scopedProject={sidebarStore.scopedProject}
      projectChoices={sidebarStore.projectFilterChoices}
      onFilter={filterToProject}
      showLabel={false}
    />
  </div>

  {#if selectedTaskIds.size > 0}
    <div
      class="mx-3.5 mb-2 flex min-h-9 items-center gap-1 rounded-lg border border-border bg-popover px-2 shadow-sm"
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
          const tasks = selectedTasks()
            .filter((row) => row.taskId && !lifecycleBlocked(row.attention))
            .map((row) => session.tasksStore.taskForId(row.taskId!))
            .filter((task): task is Task => !!task);
          if (tasks.length !== selectedTaskIds.size) {
            toasts.error("Every selected task must be idle before snoozing.");
            return;
          }
          snoozeAnchor = event.currentTarget;
          snoozeTargets = tasks;
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
        onclick={bulkDelete}>Delete</button
      >
      <button
        type="button"
        class="rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
        onclick={() => selectedTaskIds.clear()}>Clear</button
      >
    </div>
  {/if}

  <!-- Only the list scrolls; everything above it is furniture. Rows hold the
       position they were created at — a row that moves under the cursor costs a
       misclick every time, and one that moves while you read costs your place.

       That last part is why the gutter is reserved rather than claimed on
       demand. The app's scrollbars are styled, not overlaid, so Chromium takes
       their width out of the content box the moment a scroller overflows —
       expanding one task pushed the list over that line and narrowed every row
       in the column by the bar's width, mid-click. Holding the gutter open
       costs the same 8px whether or not the bar is there, and nothing moves. -->
  <div
    bind:this={scrollEl}
    class="@container min-h-0 flex-1 overflow-y-auto px-3.5 pb-3.5 [scrollbar-gutter:stable]"
    style="-webkit-overflow-scrolling:touch; overscroll-behavior-y:contain"
  >
    <div
      role="tree"
      tabindex="-1"
      aria-label="Tasks"
      onkeydown={handleTreeKeydown}
    >
      {#if !session.tasksStore.loaded}
        <TaskListSkeleton />
      {:else if sidebarStore.visibleTasks.length === 0}
        <!-- A scoped list that comes back empty says which project it looked
             in, and stays scoped: clearing the filter for the user hides the
             fact that the project has nothing open. -->
        <p class="py-1 pl-[0.125rem] text-[0.8125rem] text-muted-foreground">
          {sidebarStore.scopedProject
            ? `No open tasks in ${sidebarStore.scopedProject.label}`
            : "No open tasks"}
        </p>
      {:else}
        <div class="flex flex-col gap-[0.1875rem]">
          {#each sidebarStore.visibleTasks as task (task.id)}
            {@render taskRow(task)}
          {/each}
        </div>
      {/if}
      {#if sidebarStore.snoozedTasks.length > 0}
        <div class="mt-3">
          <button
            type="button"
            class="-mr-1 flex h-7 w-[calc(100%+0.25rem)] cursor-pointer items-center gap-[0.5625rem] rounded-lg pr-2 pl-[0.125rem] text-xs font-medium text-(--solus-status-unread) transition-[color,background] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_3.5%,transparent)] hover:text-[color-mix(in_oklch,var(--solus-status-unread)_78%,var(--foreground))]"
            aria-expanded={snoozedShelfOpen}
            onclick={() => (snoozedShelfOpen = !snoozedShelfOpen)}
          >
            Snoozed
            <span class="ml-auto font-mono tabular-nums opacity-60"
              >{sidebarStore.snoozedTasks.length}</span
            >
            <span class="flex size-4 shrink-0 items-center justify-center">
              <CaretRightIcon
                size={14}
                class="transition-transform duration-150 {snoozedShelfOpen
                  ? 'rotate-90'
                  : ''}"
              />
            </span>
          </button>
          {#if snoozedShelfOpen}
            <div class="flex flex-col gap-[0.1875rem]">
              {#each sidebarStore.snoozedTasks as task (task.id)}
                {@render taskRow(task)}
              {/each}
            </div>
          {/if}
        </div>
      {/if}
      {#if sidebarStore.completedTasks.length > 0}
        <div class="mt-2">
          <button
            type="button"
            class="-mr-1 flex h-7 w-[calc(100%+0.25rem)] cursor-pointer items-center gap-[0.5625rem] rounded-lg pr-2 pl-[0.125rem] text-xs font-medium text-muted-foreground transition-[color,background] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_3.5%,transparent)] hover:text-foreground"
            aria-expanded={completedShelfOpen}
            onclick={() => (completedShelfOpen = !completedShelfOpen)}
          >
            Completed
            <span class="ml-auto font-mono tabular-nums opacity-60"
              >{sidebarStore.completedTasks.length}</span
            >
            <span class="flex size-4 shrink-0 items-center justify-center">
              <CaretRightIcon
                size={14}
                class="transition-transform duration-150 {completedShelfOpen
                  ? 'rotate-90'
                  : ''}"
              />
            </span>
          </button>
          {#if completedShelfOpen}
            <div class="flex flex-col gap-[0.1875rem] opacity-80">
              {#each sidebarStore.completedTasks as task (task.id)}
                {@render taskRow(task)}
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </div>

  <!-- The panel's second and last hairline. -->
  <Sidebar.Footer
    class="relative flex-shrink-0 border-t border-t-sidebar-border px-3.5 pt-2.5 pb-3.5"
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
            <span class="flex-1 text-left text-sm">Saved sessions</span>
            <span
              class="shrink-0 font-mono text-xs text-muted-foreground opacity-60 tabular-nums"
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
              <div
                class="group/pin flex h-[1.875rem] cursor-pointer items-center gap-2 rounded-lg pr-1.5 pl-[2.25rem] transition-[background] duration-150 hover:bg-accent"
                role="button"
                tabindex="0"
                title={pin.title}
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
                  class="min-w-0 flex-1 overflow-hidden text-[0.8125rem] text-ellipsis whitespace-nowrap {isActive
                    ? 'font-medium text-foreground'
                    : 'text-[color-mix(in_oklch,var(--foreground)_88%,transparent)]'}"
                  >{pin.title}</span
                >
                <button
                  class="hidden size-5 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-[color,background] duration-[120ms] group-hover/pin:flex hover:bg-accent hover:text-foreground"
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
            {/each}
          </div>
        {/if}
      {/if}
      <Sidebar.MenuItem>
        <Sidebar.MenuButton
          class="group flex h-8 w-full cursor-pointer items-center gap-[0.6875rem] rounded-lg bg-transparent px-[0.625rem] text-left text-[color-mix(in_oklch,var(--foreground)_88%,transparent)] transition-[color,background] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground {session.router.at(
            'settings',
          )
            ? 'text-foreground'
            : ''}"
          isActive={session.router.at("settings")}
          onclick={() => session.showSettings()}
        >
          <span
            class="flex shrink-0 items-center motion-safe:transition-transform motion-safe:duration-500 motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:rotate-90"
            ><GearIcon size={14} /></span
          >
          <span class="flex-1 text-left text-sm">Settings</span>
          <span
            class="shrink-0 font-mono text-xs opacity-0 transition-opacity duration-[120ms] group-hover:opacity-70"
            >{comboHint("global.settings")}</span
          >
        </Sidebar.MenuButton>
      </Sidebar.MenuItem>
    </Sidebar.Menu>
  </Sidebar.Footer>
</SidePanel>

{#if sessionContextMenu}
  {#if sessionContextMenu.kind === "task"}
    {@const menuTask = session.tasksStore.tasks.find(
      (task) => task.id === sessionContextMenu.taskId,
    )}
    {@const menuPoint = { x: sessionContextMenu.x, y: sessionContextMenu.y }}
    {@const sidebarTask = sessionContextMenu.sidebarTask}
    {@const menuChild = sessionContextMenu.child}
    {@const hasLinkedSession =
      !!sidebarTask?.tabIds.length ||
      !!menuChild?.tabId ||
      !!menuChild?.sessionId ||
      (menuTask
        ? (session.tasksStore.sessionsByTask.get(menuTask.id)?.length ?? 0) > 0
        : false)}
    <!-- A task with no nested subtasks is a single session wearing a task's row,
         so it earns the session menu items a loose session row gets. -->
    {@const leafSessions = sidebarTask
      ? sidebarStore.sessionsFor(sidebarTask)
      : []}
    {@const leafSession = !hasDisclosure(leafSessions)
      ? leafSessions[0]
      : undefined}
    {@const leafTabId = leafSession?.tabId ?? null}
    {@const leafSess = leafTabId ? session.sessionFor(leafTabId) : null}
    {#if menuTask}
      <TaskContextMenu
        x={sessionContextMenu.x}
        y={sessionContextMenu.y}
        task={menuTask}
        {hasLinkedSession}
        isRunning={sidebarTask?.status === "running" ||
          menuChild?.attention === "running"}
        lifecycleBlocked={lifecycleBlocked(
          sidebarTask?.attention ?? menuChild?.attention ?? null,
        )}
        onStart={() => void session.openTaskSession(menuTask)}
        onResume={hasLinkedSession
          ? () => void session.openTaskLinkedSession(menuTask)
          : undefined}
        onStop={sidebarTask
          ? () => stopTask(sidebarTask)
          : menuChild?.tabId
            ? () => session.interruptTabSession(menuChild.tabId!)
            : undefined}
        onOpenTask={() => session.goToTask(menuTask.id)}
        onOpenSource={() => {
          if (menuTask.url) void localApi.openExternal(menuTask.url);
        }}
        onStartRename={() => startRename({ taskId: menuTask.id })}
        onToggleDone={() => {
          if (menuTask.status === "done") markTaskDone(menuTask.id);
          else if (sidebarTask) completeTask(sidebarTask);
          else if (menuChild?.isSubtask) completeChild(menuChild);
          else markTaskDone(menuTask.id);
        }}
        onSnooze={menuTask.status === "done" ||
        (menuTask.snoozedUntil ?? 0) > Date.now()
          ? undefined
          : () => {
              snoozeAnchor = menuPoint;
              snoozeTargets = [menuTask];
            }}
        onWake={(menuTask.snoozedUntil ?? 0) > Date.now()
          ? () => void wakeTask(menuTask)
          : undefined}
        onMarkUnread={() =>
          void session.tasksStore.markRead(menuTask.id, false)}
        onRemove={undefined}
        sessionId={leafSession?.sessionId ?? null}
        onFork={leafTabId && leafSess?.agentSessionId
          ? () => void session.forkTab(leafTabId)
          : undefined}
        onContinueWorktree={leafTabId &&
        leafSess?.agentSessionId &&
        !leafSess?.run.gitContext?.worktreePath
          ? () => void session.continueInWorktree(leafTabId)
          : undefined}
        isContinuingWorktree={leafTabId
          ? session.isContinuingInWorktree(leafTabId)
          : false}
        isSplit={!!leafTabId && leafTabId === session.splitChatTabId}
        onOpenInSplit={leafTabId
          ? () => session.openTabInSplit(leafTabId)
          : undefined}
        onCloseSplit={leafTabId ? () => session.closeSplitChat() : undefined}
        onClose={closeSessionContextMenu}
      />
    {/if}
  {:else if sessionContextMenu.kind === "tab"}
    {@const menuTabId = sessionContextMenu.tabId}
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
            ? () => session.interruptTabSession(menuTabId)
            : undefined,
      }}
      onCloseTab={closeSession}
      closeTabLabel="Remove from Sidebar"
      closeTabIsDestructive={false}
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
      : `${snoozeTargets.length} selected tasks`}
    onConfirm={(until, note) => void confirmSnooze(until, note)}
    onClose={() => {
      snoozeTargets = [];
      snoozeAnchor = null;
      requestInputFocus();
    }}
  />
{/if}
