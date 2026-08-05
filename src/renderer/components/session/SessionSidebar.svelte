<script lang="ts">
  import { tick } from "svelte";
  import { slide } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
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
  import { getWorkspaceContext, getSessionSidebarStore } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import SidePanel from "../layout/SidePanel.svelte";
  import {
    SIDEBAR_MAX_WIDTH,
    SIDEBAR_MIN_WIDTH,
  } from "../layout/lib/workspace-body";
  import * as Sidebar from "../ui/sidebar";
  import TaskListSkeleton from "./TaskListSkeleton.svelte";
  import SessionContextMenu from "./SessionContextMenu.svelte";
  import ProjectMark from "./ProjectMark.svelte";
  import TaskContextMenu from "./TaskContextMenu.svelte";
  import TaskListHeader from "./TaskListHeader.svelte";
  import TaskRow from "./TaskRow.svelte";
  import type { SidebarSessionChild } from "../../contexts/workspace/session-sidebar.store.svelte";
  import { hasDisclosure, type SidebarTask } from "./lib/task-list";
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
    session.prsStore.needsReviewCountFor(session.ctx),
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
  const collapsedProjectKeys = new SvelteSet<string>();
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

  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

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

  function toggleProject(projectKey: string) {
    if (collapsedProjectKeys.has(projectKey)) {
      collapsedProjectKeys.delete(projectKey);
    } else {
      collapsedProjectKeys.add(projectKey);
    }
  }

  function projectGroupId(projectKey: string) {
    return `sidebar-project-${encodeURIComponent(projectKey)}`;
  }

  function togglePrs() {
    session.togglePrs();
    requestInputFocus();
  }

  function newTask() {
    void session.createDraftTab(undefined, { freshTask: true, via: "click" });
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
    if (hasDisclosure(sidebarStore.sessionsFor(task))) toggleExpand(task.id);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        void sidebarStore.selectTask(task);
        requestInputFocus();
        onSessionSelect?.();
      });
    });
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
    for (const tabId of task.tabIds) session.interruptTab(tabId);
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

  /** Completion writes the lifecycle status, then clears the row exactly the way
   * the remove action does — the task and its subtasks leave the column and
   * their mounted conversations unload. Nothing about the status hides a row, so
   * reopening any of those sessions brings the task back like any other. */
  async function completeTask(task: SidebarTask) {
    try {
      if (task.taskId) await session.tasksStore.setStatus(task.taskId, "done");
      else sidebarStore.toggleTaskDone(task.id);
      expandedTaskIds.delete(task.id);
      sidebarStore.closeTask(task);
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
      if (child.taskId)
        await session.tasksStore.setStatus(child.taskId, "done");
      else if (child.tabId) sidebarStore.toggleTaskDone(child.tabId);
      sidebarStore.closeChild(child);
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
    const projectKey = focused!.dataset.projectKey;
    const task = taskKey
      ? sidebarStore.visibleTasks.find((item) => item.key === taskKey)
      : undefined;

    switch (intent.kind) {
      case "focus":
        rows[intent.index]?.focus();
        break;
      case "expand":
      case "collapse":
        if (projectKey) toggleProject(projectKey);
        else if (task) toggleExpand(task.id);
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
    event: MouseEvent,
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

  function openTaskOrSessionContextMenu(event: MouseEvent, task: SidebarTask) {
    if (task.taskId) {
      openTaskContextMenu(event, task.taskId, task);
      return;
    }
    openSessionContextMenu(event, {
      kind: "tab",
      tabId: task.tabIds[0] ?? null,
    });
  }

  function openChildContextMenu(event: MouseEvent, child: SidebarSessionChild) {
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

{#snippet taskRow(task: SidebarTask, grouped: boolean)}
  <TaskRow
    {task}
    {grouped}
    prChip={sidebarStore.prChipFor(task)}
    onPath={task.tabIds.includes(session.activeTabId)}
    expanded={expandedTaskIds.has(task.id)}
    showProjectLine={sidebarStore.showsProjectLine}
    sessions={sidebarStore.sessionsFor(task)}
    selectedTabId={task.tabIds.includes(session.activeTabId)
      ? session.activeTabId
      : null}
    {renamingTabId}
    {renamingTaskId}
    onSelect={() => activateTask(task)}
    onRename={(child, next) => renameSidebarItem(task, child, next)}
    onRenameCancel={cancelRename}
    onMore={(event) => openTaskOrSessionContextMenu(event, task)}
    onComplete={() => completeTask(task)}
    onClose={() => closeTask(task)}
    onSelectSession={selectSession}
    onMoreSession={openChildContextMenu}
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
  <div class="flex-shrink-0 px-3.5 pt-0.5 pb-2.5">
    <button
      class="relative flex h-[2.375rem] w-full cursor-pointer items-center gap-[0.4375rem] rounded-[0.5625rem] bg-[color-mix(in_oklch,var(--primary)_92%,var(--card))] px-2.5 text-primary-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_3px_10px_-8px_color-mix(in_oklch,var(--primary)_72%,transparent)] transition-[filter,scale] before:absolute before:inset-x-0 before:-inset-y-px before:content-[''] hover:brightness-105 active:scale-[0.96]"
      onclick={newTask}
    >
      <PlusIcon size={14} class="shrink-0" />
      <span
        class="text-[0.78125rem] font-medium tracking-[-0.004em] whitespace-nowrap"
        >New task</span
      >
      <span
        class="ml-auto rounded-[0.3125rem] bg-white/10 px-1.5 py-0.5 font-mono text-[0.625rem]"
        >{comboHint("global.new-task")}</span
      >
    </button>
  </div>

  <Sidebar.Group class="flex-shrink-0 p-0">
    <Sidebar.GroupContent class="px-3.5">
      <Sidebar.Menu class="gap-0.5">
        <Sidebar.MenuItem>
          <Sidebar.MenuButton
            class="group flex h-8 w-full cursor-pointer items-center gap-[0.6875rem] rounded-[0.5625rem] bg-transparent px-[0.625rem] text-left text-[color-mix(in_oklch,var(--foreground)_88%,transparent)] transition-[color,background] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground {session.router.at('folio') ? 'text-foreground' : ''}"
            isActive={session.router.at("folio")}
            onclick={() => session.toggleFolio()}
          >
            <span class="flex shrink-0 items-center"><BooksIcon size={16} /></span>
            <span class="flex-1 text-left text-[0.84375rem] tracking-[-0.006em]">Workspace</span>
            <span class="shrink-0 font-mono text-[0.65625rem] opacity-0 transition-opacity duration-[120ms] group-hover:opacity-70">{comboHint("global.toggle-workspace")}</span>
          </Sidebar.MenuButton>
        </Sidebar.MenuItem>
        <Sidebar.MenuItem>
          <Sidebar.MenuButton
            class="group flex h-8 w-full cursor-pointer items-center gap-[0.6875rem] rounded-[0.5625rem] bg-transparent px-[0.625rem] text-left text-[color-mix(in_oklch,var(--foreground)_88%,transparent)] transition-[color,background] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground {session.router.at('automations') ? 'text-foreground' : ''}"
            isActive={session.router.at("automations")}
            onclick={() => session.toggleAutomations()}
          >
            <span class="flex shrink-0 items-center"><ArrowsClockwiseIcon size={16} /></span>
            <span class="flex-1 text-left text-[0.84375rem] tracking-[-0.006em]">Automations</span>
            <span class="shrink-0 font-mono text-[0.65625rem] opacity-0 transition-opacity duration-[120ms] group-hover:opacity-70">{comboHint("global.toggle-automations")}</span
            >
          </Sidebar.MenuButton>
        </Sidebar.MenuItem>
        <Sidebar.MenuItem>
          <Sidebar.MenuButton
            class="group flex h-8 w-full cursor-pointer items-center gap-[0.6875rem] rounded-[0.5625rem] bg-transparent px-[0.625rem] text-left text-[color-mix(in_oklch,var(--foreground)_88%,transparent)] transition-[color,background] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground {session.router.at('prs') ? 'text-foreground' : ''}"
            isActive={session.router.at("prs")}
            onclick={togglePrs}
          >
            <span class="flex shrink-0 items-center"><GitPullRequestIcon size={16} /></span>
            <span class="flex-1 text-left text-[0.84375rem] tracking-[-0.006em]"
              >Pull requests<span class="ml-1.5 inline-flex items-center rounded-[0.3125rem] px-[0.3125rem] py-0.5 align-middle font-mono text-[0.5625rem] leading-none font-medium tracking-[0.07em] text-[color-mix(in_oklch,var(--primary)_68%,var(--foreground))] uppercase bg-[color-mix(in_oklch,var(--primary)_13%,transparent)]">Beta</span></span
            >
            {#if needsReviewCount > 0}
              <span
                class="shrink-0 font-mono text-[0.6875rem] text-muted-foreground opacity-60 tabular-nums"
                title={`${needsReviewCount} pull ${needsReviewCount === 1 ? "request needs" : "requests need"} your review`}
                aria-label={`${needsReviewCount} need your review`}
                >{needsReviewCount > 99 ? "99+" : needsReviewCount}</span
              >
            {/if}
          </Sidebar.MenuButton>
        </Sidebar.MenuItem>
        <Sidebar.MenuItem>
          <Sidebar.MenuButton
            class="group flex h-8 w-full cursor-pointer items-center gap-[0.6875rem] rounded-[0.5625rem] bg-transparent px-[0.625rem] text-left text-[color-mix(in_oklch,var(--foreground)_88%,transparent)] transition-[color,background] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground {session.router.at('tasks') ? 'text-foreground' : ''}"
            isActive={session.router.at("tasks")}
            onclick={() => session.toggleTasks()}
          >
            <span class="flex shrink-0 items-center"><ListChecksIcon size={16} /></span>
            <span class="flex-1 text-left text-[0.84375rem] tracking-[-0.006em]">Tasks<span class="ml-1.5 inline-flex items-center rounded-[0.3125rem] px-[0.3125rem] py-0.5 align-middle font-mono text-[0.5625rem] leading-none font-medium tracking-[0.07em] text-[color-mix(in_oklch,var(--primary)_68%,var(--foreground))] uppercase bg-[color-mix(in_oklch,var(--primary)_13%,transparent)]">Beta</span></span>
            <span class="shrink-0 font-mono text-[0.65625rem] opacity-0 transition-opacity duration-[120ms] group-hover:opacity-70">{comboHint("global.toggle-tasks")}</span>
          </Sidebar.MenuButton>
        </Sidebar.MenuItem>
        <Sidebar.MenuItem>
          <Sidebar.MenuButton
            class="group flex h-8 w-full cursor-pointer items-center gap-[0.6875rem] rounded-[0.5625rem] bg-transparent px-[0.625rem] text-left text-[color-mix(in_oklch,var(--foreground)_88%,transparent)] transition-[color,background] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground"
            onclick={() =>
              window.dispatchEvent(
                new CustomEvent("solus:toggle-session-picker"),
              )}
          >
            <span class="flex shrink-0 items-center"><ClockIcon size={16} /></span>
            <span class="flex-1 text-left text-[0.84375rem] tracking-[-0.006em]">History</span>
            <span class="shrink-0 font-mono text-[0.65625rem] opacity-0 transition-opacity duration-[120ms] group-hover:opacity-70">{comboHint("global.session-picker")}</span>
          </Sidebar.MenuButton>
        </Sidebar.MenuItem>
      </Sidebar.Menu>
    </Sidebar.GroupContent>
  </Sidebar.Group>

  <!-- One of the two hairlines in the whole panel. -->
  <div
    class="mx-3.5 mt-[1.125rem] h-[0.03125rem] flex-shrink-0 bg-sidebar-border"
  ></div>

  <div class="flex-shrink-0">
    <TaskListHeader
      label="Tasks"
      count={sidebarStore.headerCount}
      mode={sidebarStore.viewMode}
      onModeChange={(mode) => sidebarStore.setViewMode(mode)}
    />
  </div>

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
    role="tree"
    tabindex="-1"
    aria-label="Tasks"
    onkeydown={handleTreeKeydown}
  >
    {#if !session.tasksStore.loaded}
      <TaskListSkeleton />
    {:else if sidebarStore.visibleTasks.length === 0}
      <p class="px-[0.625rem] py-1 text-[0.8125rem] text-muted-foreground">
        No open tasks
      </p>
    {:else if sidebarStore.viewMode === "flat"}
      <div class="flex flex-col gap-[0.1875rem]">
        {#each sidebarStore.visibleTasks as task (task.id)}
          {@render taskRow(task, false)}
        {/each}
      </div>
    {:else}
      {#each sidebarStore.taskGroups as group (group.projectKey)}
        <div class="mb-4">
          <!-- A project is the level above, so it is a section header rather
               than another row: mark, small uppercase name, a hairline running
               to the count. The whole divider is its disclosure target. -->
          <button
            type="button"
            role="treeitem"
            aria-selected="false"
            data-project-key={group.projectKey}
            class="mb-0.5 flex h-8 w-full cursor-pointer items-center gap-[0.625rem] rounded px-[0.625rem] text-left transition-[color,background] duration-150 hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
            aria-expanded={!collapsedProjectKeys.has(group.projectKey)}
            aria-controls={projectGroupId(group.projectKey)}
            onclick={() => toggleProject(group.projectKey)}
          >
            <ProjectMark
              projectKey={group.projectKey}
              initial={group.initial}
              active={group.projectKey === sidebarStore.activeProjectKey}
              class="size-4"
              letterClass="text-[0.53125rem]"
            />
            <span
              class="shrink-0 text-[0.59375rem] font-semibold tracking-[0.1em] text-[color-mix(in_oklch,var(--foreground)_68%,transparent)] uppercase"
              >{group.projectLabel}</span
            >
            <span
              class="h-[0.03125rem] flex-1 bg-[color-mix(in_oklch,var(--foreground)_12%,transparent)]"
            ></span>
            <span
              class="shrink-0 font-mono text-[0.625rem] text-muted-foreground opacity-45 tabular-nums"
              >{group.tasks.length}</span
            >
            <CaretRightIcon
              size={11}
              class="shrink-0 text-muted-foreground transition-transform duration-150 {collapsedProjectKeys.has(
                group.projectKey,
              )
                ? ''
                : 'rotate-90'}"
            />
          </button>
          {#if !collapsedProjectKeys.has(group.projectKey)}
            <div
              id={projectGroupId(group.projectKey)}
              class="flex flex-col gap-[0.1875rem]"
              transition:slide={{
                duration: reduceMotion ? 0 : 120,
                easing: cubicOut,
              }}
            >
              {#each group.tasks as task (task.id)}
                {@render taskRow(task, true)}
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    {/if}
  </div>

  <!-- The panel's second and last hairline. -->
  <Sidebar.Footer
    class="relative flex-shrink-0 border-t border-t-sidebar-border px-3.5 pt-2.5 pb-3.5"
  >
    <Sidebar.Menu class="gap-0.5">
      {#if sidebarStore.pinnedSessions.length > 0}
        <Sidebar.MenuItem>
          <Sidebar.MenuButton
            class="group flex h-8 w-full cursor-pointer items-center gap-[0.6875rem] rounded-[0.5625rem] bg-transparent px-[0.625rem] text-left text-[color-mix(in_oklch,var(--foreground)_88%,transparent)] transition-[color,background] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground"
            onclick={() => (savedSessionsOpen = !savedSessionsOpen)}
          >
            <span class="flex shrink-0 items-center"><PushPinIcon size={16} weight="fill" /></span>
            <span class="flex-1 text-left text-[0.84375rem] tracking-[-0.006em]">Saved sessions</span>
            <span class="shrink-0 font-mono text-[0.6875rem] text-muted-foreground opacity-60 tabular-nums">{sidebarStore.pinnedSessions.length}</span>
            <CaretRightIcon
              size={11}
              class="shrink-0 transition-transform duration-150 {savedSessionsOpen
                ? 'rotate-90'
                : ''}"
            />
          </Sidebar.MenuButton>
        </Sidebar.MenuItem>
        {#if savedSessionsOpen}
          <div
            class="flex flex-col gap-0.5 pb-1"
            transition:slide={{
              duration: reduceMotion ? 0 : 160,
              easing: cubicOut,
            }}
          >
            {#each sidebarStore.pinnedSessions as pin (pin.sessionId)}
              {@const openTabId = sidebarStore.openTabIdForPinned(pin)}
              {@const isActive =
                !!openTabId && openTabId === session.activeTabId}
              <div
                class="group/pin flex h-[1.875rem] cursor-pointer items-center gap-2 rounded pr-1.5 pl-[2.25rem] transition-[background] duration-150 hover:bg-accent"
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
                  class="min-w-0 flex-1 overflow-hidden text-[0.78125rem] text-ellipsis whitespace-nowrap {isActive
                    ? 'font-[560] text-foreground'
                    : 'text-[color-mix(in_oklch,var(--foreground)_88%,transparent)]'}"
                  >{pin.title}</span
                >
                <button
                  class="hidden size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-[color,background] duration-[120ms] group-hover/pin:flex hover:bg-accent hover:text-foreground"
                  aria-label="Unpin session"
                  title="Unpin"
                  onclick={(event) => {
                    event.stopPropagation();
                    void sidebarStore.unpinSession(pin);
                    requestInputFocus();
                  }}
                >
                  <PushPinIcon size={12} weight="fill" />
                </button>
              </div>
            {/each}
          </div>
        {/if}
      {/if}
      <Sidebar.MenuItem>
        <Sidebar.MenuButton
          class="group flex h-8 w-full cursor-pointer items-center gap-[0.6875rem] rounded-[0.5625rem] bg-transparent px-[0.625rem] text-left text-[color-mix(in_oklch,var(--foreground)_88%,transparent)] transition-[color,background] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground {session.router.at('settings') ? 'text-foreground' : ''}"
          isActive={session.router.at("settings")}
          onclick={() => session.showSettings()}
        >
          <span
            class="flex shrink-0 items-center motion-safe:transition-transform motion-safe:duration-500 motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:rotate-90"
            ><GearIcon size={16} /></span
          >
          <span class="flex-1 text-left text-[0.84375rem] tracking-[-0.006em]">Settings</span>
          <span class="shrink-0 font-mono text-[0.65625rem] opacity-0 transition-opacity duration-[120ms] group-hover:opacity-70">{comboHint("global.settings")}</span>
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
    {@const sidebarTask = sessionContextMenu.sidebarTask}
    {@const menuChild = sessionContextMenu.child}
    {@const hasLinkedSession =
      !!sidebarTask?.tabIds.length ||
      !!menuChild?.tabId ||
      !!menuChild?.sessionId ||
      (menuTask
        ? (session.tasksStore.sessionsByTask.get(menuTask.id)?.length ?? 0) > 0
        : false)}
    {#if menuTask}
      <TaskContextMenu
        x={sessionContextMenu.x}
        y={sessionContextMenu.y}
        task={menuTask}
        {hasLinkedSession}
        isRunning={sidebarTask?.status === "running" ||
          menuChild?.attention === "running"}
        onStart={() => void session.openTaskSession(menuTask)}
        onResume={hasLinkedSession
          ? () => void session.openTaskLinkedSession(menuTask)
          : undefined}
        onStop={sidebarTask
          ? () => stopTask(sidebarTask)
          : menuChild?.tabId
            ? () => session.interruptTab(menuChild.tabId!)
            : undefined}
        onOpenTask={() => session.goToTask(menuTask.id)}
        onOpenSource={() => {
          if (menuTask.url) void window.solus.openExternal(menuTask.url);
        }}
        onStartRename={() => startRename({ taskId: menuTask.id })}
        onToggleDone={() => {
          if (menuTask.status === "done") markTaskDone(menuTask.id);
          else if (sidebarTask) completeTask(sidebarTask);
          else if (menuChild?.isSubtask) completeChild(menuChild);
          else markTaskDone(menuTask.id);
        }}
        onRemove={sidebarTask
          ? () => closeTask(sidebarTask)
          : menuChild
            ? () => closeChild(menuChild)
            : undefined}
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
            ? () => session.interruptTab(menuTabId)
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
