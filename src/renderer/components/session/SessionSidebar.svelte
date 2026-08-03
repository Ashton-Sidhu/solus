<script lang="ts">
  import { tick } from "svelte";
  import { slide } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import { SvelteSet } from "svelte/reactivity";
  import { comboHint } from "../../lib/keybindings/manifest";
  import {
    ArticleIcon,
    FileTextIcon,
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
  import {
    getWorkspaceContext,
    getSessionSidebarStore,
    toasts,
  } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import SidePanel from "../layout/SidePanel.svelte";
  import {
    SIDEBAR_MAX_WIDTH,
    SIDEBAR_MIN_WIDTH,
  } from "../layout/lib/workspace-body";
  import * as Sidebar from "../ui/sidebar";
  import SessionContextMenu from "./SessionContextMenu.svelte";
  import ProjectMark from "./ProjectMark.svelte";
  import TaskListHeader from "./TaskListHeader.svelte";
  import TaskRow from "./TaskRow.svelte";
  import type { SidebarTask } from "./lib/task-list";
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
  let headerEl: HTMLDivElement | undefined = $state();
  let sessionContextMenu = $state<
    | { kind: "tab"; tabId: string; x: number; y: number; task?: SidebarTask }
    | { kind: "pinned"; pin: PinnedSession; x: number; y: number }
    | null
  >(null);
  const expandedTasks = new SvelteSet<string>();
  /** The row being renamed in place. One at a time: the edit replaces the label
   *  where it sits, so two open editors would be two claims on the same name. */
  let renamingTabId = $state<string | null>(null);
  let savedSessionsOpen = $state(false);

  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  // Top-nav cluster (Plans / Folio / Automations / …). These are static places,
  // not tasks — but they sit on the same spine: their icons occupy the 16px
  // column a task's disclosure lives in, and their labels start exactly where a
  // task title does, so the whole column reads as one list of one shape.
  const navRow =
    "group flex h-8 w-full cursor-pointer items-center gap-[0.625rem] rounded bg-transparent px-[0.625rem] text-left text-muted-foreground transition-[color,background] duration-150 hover:bg-accent hover:text-foreground";
  const navRowActive = "text-foreground";
  const navIcon = "flex shrink-0 items-center";
  const navLabel = "flex-1 text-left text-[0.8125rem] tracking-[-0.004em]";
  const navHint =
    "shrink-0 font-mono text-[0.65625rem] opacity-0 transition-opacity duration-[120ms] group-hover:opacity-60";
  const navBeta =
    "ml-1.5 inline-flex items-center rounded px-1 py-px align-middle text-[0.53125rem] leading-none tracking-[0.02em] text-primary uppercase bg-[color-mix(in_oklch,var(--primary)_14%,transparent)]";
  // A static total, in the same muted mono as every other number in the column.
  // A filled badge here would be the brightest thing above the list and would
  // compete with the status marks, which are what the eye is meant to count.
  const navCount =
    "shrink-0 font-mono text-[0.65625rem] opacity-55 tabular-nums";

  function toggleExpand(taskKey: string) {
    if (expandedTasks.has(taskKey)) expandedTasks.delete(taskKey);
    else expandedTasks.add(taskKey);
  }

  function togglePrs() {
    session.togglePrs();
    requestInputFocus();
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

  /** ⌘⇧F puts the keyboard on the filter. There are two ways in and one way
   *  out, so it lands on whichever is live: the ✕ beside the header while a
   *  filter is on, otherwise the first project line in the list — the control
   *  that sets one. */
  function focusProjectFilter() {
    const target = sidebarStore.projectFilter
      ? headerEl?.querySelector<HTMLElement>("[data-clear-project-filter]")
      : scrollEl?.querySelector<HTMLElement>("[data-project-filter]");
    target?.focus();
  }

  /** Selection is navigation: one click shows the task in the pane, and opens
   *  its sessions with it — you asked for the task, so you get everything under
   *  it. Keyboard tree navigation can collapse the sessions again. */
  function selectTask(task: SidebarTask) {
    sidebarStore.selectBranch(task.key, task.tabIds);
    if (task.tabIds.length > 1) expandedTasks.add(task.key);
    requestInputFocus();
    onSessionSelect?.();
  }

  function renameSession(tabId: string, next: string) {
    renamingTabId = null;
    void sidebarStore.renameSession(tabId, next);
    requestInputFocus();
  }

  function selectSession(tabId: string) {
    sidebarStore.selectTab(tabId);
    requestInputFocus();
    onSessionSelect?.();
  }

  function stopTask(task: SidebarTask) {
    for (const tabId of task.tabIds) session.interruptTab(tabId);
    requestInputFocus();
  }

  function closeTabs(tabIds: string[]) {
    sidebarStore.closeTabs(tabIds);
    requestInputFocus();
  }

  /** Same rule one level down: a session still working confirms before it goes. */
  function closeSession(tabId: string) {
    const child = sidebarStore.childForTab(tabId);
    if (child.attention !== "running") {
      closeTabs([tabId]);
      return;
    }
    toasts.show({
      message: `Stop “${child.label}” and close it?`,
      actions: [
        { label: "Stop and close", onAction: () => closeTabs([tabId]) },
        { label: "Keep open", onAction: () => requestInputFocus() },
      ],
    });
  }

  /** The check is the only state the user sets themselves — it says "I am
   *  finished with this", which nothing the agent reports can stand in for. */
  function markTaskDone(task: SidebarTask) {
    sidebarStore.toggleTaskDone(task.key);
    requestInputFocus();
  }

  /** Closing an idle task is silent. Closing one with an agent still working
   *  asks first and names what it would stop, because the run cannot be got
   *  back once the tab is gone. */
  function closeTask(task: SidebarTask) {
    if (task.status !== "running") {
      sidebarStore.closeTask(task);
      requestInputFocus();
      return;
    }

    const running = task.tabIds.filter(
      (tabId) => sidebarStore.childForTab(tabId).attention === "running",
    ).length;
    toasts.show({
      message: `Stop ${running === 1 ? "the run" : `${running} runs`} in “${task.title}” and close it?`,
      actions: [
        {
          label: "Stop and close",
          onAction: () => {
            sidebarStore.closeTask(task);
            requestInputFocus();
          },
        },
        { label: "Keep open", onAction: () => requestInputFocus() },
      ],
    });
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
    // A subtask's parent is the nearest task row above it.
    const parentIndex = focused!.dataset.tabId
      ? rows.findLastIndex(
          (row, at) => at < index && row.dataset.taskKey !== undefined,
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
        if (taskKey) toggleExpand(taskKey);
        break;
      case "enterPane":
        requestInputFocus();
        break;
      case "close":
        // Both paths confirm on their own when something is still working, so
        // ⌫ never kills a run off a single keystroke.
        if (task) closeTask(task);
        else if (focused!.dataset.tabId) closeSession(focused!.dataset.tabId);
        break;
    }
  }

  /** Right-click and ⋯ open the identical menu — two paths, never a superset.
   *  A task row hands its own actions along: stop and mark-done live in here
   *  now rather than as two more glyphs appearing under the cursor. */
  function openSessionContextMenu(
    event: MouseEvent,
    target:
      | { kind: "tab"; tabId: string; task?: SidebarTask }
      | { kind: "pinned"; pin: PinnedSession },
  ) {
    event.preventDefault();
    event.stopPropagation();
    sessionContextMenu = { ...target, x: event.clientX, y: event.clientY };
  }

  function closeSessionContextMenu() {
    sessionContextMenu = null;
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
    expanded={expandedTasks.has(task.key)}
    showProjectLine={sidebarStore.showsProjectLine}
    subtasks={task.tabIds.map((tabId) => sidebarStore.childForTab(tabId))}
    selectedTabId={task.tabIds.includes(session.activeTabId)
      ? session.activeTabId
      : null}
    {renamingTabId}
    onSelect={() => selectTask(task)}
    onRename={renameSession}
    onRenameCancel={() => (renamingTabId = null)}
    onPickProject={() => sidebarStore.setProjectFilter(task.projectKey)}
    onMore={(event) =>
      openSessionContextMenu(event, {
        kind: "tab",
        tabId: task.tabIds[0],
        task,
      })}
    onClose={() => closeTask(task)}
    onSelectSub={selectSession}
    onMoreSub={(event, tabId) =>
      openSessionContextMenu(event, { kind: "tab", tabId })}
    onCloseSub={closeSession}
  />
{/snippet}

<svelte:window on:solus:focus-task-filter={focusProjectFilter} />

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
  background="color-mix(in oklch, var(--foreground) 2%, var(--card))"
>
  <!-- The one filled control in the column, and the only place terracotta
       appears outside a status mark. Its label starts on the spine. -->
  <div class="flex-shrink-0 px-3 pb-3.5">
    <button
      class="flex h-[2.125rem] w-full cursor-pointer items-center gap-[0.625rem] rounded bg-primary px-[0.625rem] text-primary-foreground transition-[background] duration-150 hover:bg-[color-mix(in_oklch,var(--primary)_92%,var(--foreground))]"
      onclick={() => {
        void session.createTab();
        requestInputFocus();
      }}
    >
      <PlusIcon size={16} class="shrink-0" />
      <span
        class="text-[0.8125rem] font-medium tracking-[-0.004em] whitespace-nowrap"
        >New task</span
      >
      <span class="ml-auto font-mono text-[0.65625rem] opacity-60"
        >{comboHint("global.new-tab")}</span
      >
    </button>
  </div>

  <Sidebar.Group class="flex-shrink-0 p-0">
    <Sidebar.GroupContent class="px-3">
      <Sidebar.Menu class="gap-px">
        <Sidebar.MenuItem>
          <Sidebar.MenuButton
            class={navRow}
            onclick={() => session.togglePlansGallery()}
          >
            <span class={navIcon}><ArticleIcon size={16} /></span>
            <span class={navLabel}>Plans</span>
            <span class={navHint}>{comboHint("global.toggle-plans")}</span>
          </Sidebar.MenuButton>
        </Sidebar.MenuItem>
        <Sidebar.MenuItem>
          <Sidebar.MenuButton
            class={navRow}
            onclick={() => session.toggleFolioGallery()}
          >
            <span class={navIcon}><FileTextIcon size={16} /></span>
            <span class={navLabel}>Folio</span>
            <span class={navHint}>{comboHint("global.toggle-folio")}</span>
          </Sidebar.MenuButton>
        </Sidebar.MenuItem>
        <Sidebar.MenuItem>
          <Sidebar.MenuButton
            class="{navRow} {session.automationsOpen ? navRowActive : ''}"
            isActive={session.automationsOpen}
            onclick={() => session.toggleAutomations()}
          >
            <span class={navIcon}><ArrowsClockwiseIcon size={16} /></span>
            <span class={navLabel}>Automations</span>
            <span class={navHint}>{comboHint("global.toggle-automations")}</span
            >
          </Sidebar.MenuButton>
        </Sidebar.MenuItem>
        <Sidebar.MenuItem>
          <Sidebar.MenuButton
            class="{navRow} {session.prsOpen ? navRowActive : ''}"
            isActive={session.prsOpen}
            onclick={togglePrs}
          >
            <span class={navIcon}><GitPullRequestIcon size={16} /></span>
            <span class={navLabel}
              >Pull requests<span class={navBeta}>Beta</span></span
            >
            {#if needsReviewCount > 0}
              <span
                class={navCount}
                title={`${needsReviewCount} pull ${needsReviewCount === 1 ? "request needs" : "requests need"} your review`}
                aria-label={`${needsReviewCount} need your review`}
                >{needsReviewCount > 99 ? "99+" : needsReviewCount}</span
              >
            {/if}
          </Sidebar.MenuButton>
        </Sidebar.MenuItem>
        <Sidebar.MenuItem>
          <Sidebar.MenuButton
            class="{navRow} {session.tasksOpen ? navRowActive : ''}"
            isActive={session.tasksOpen}
            onclick={() => session.toggleTasks()}
          >
            <span class={navIcon}><ListChecksIcon size={16} /></span>
            <span class={navLabel}>Tasks<span class={navBeta}>Beta</span></span>
            <span class={navHint}>{comboHint("global.toggle-tasks")}</span>
          </Sidebar.MenuButton>
        </Sidebar.MenuItem>
        <Sidebar.MenuItem>
          <Sidebar.MenuButton
            class={navRow}
            onclick={() =>
              window.dispatchEvent(
                new CustomEvent("solus:toggle-session-picker"),
              )}
          >
            <span class={navIcon}><ClockIcon size={16} /></span>
            <span class={navLabel}>History</span>
            <span class={navHint}>{comboHint("global.session-picker")}</span>
          </Sidebar.MenuButton>
        </Sidebar.MenuItem>
      </Sidebar.Menu>
    </Sidebar.GroupContent>
  </Sidebar.Group>

  <!-- One of the two hairlines in the whole panel. -->
  <div
    class="mx-3 mt-3.5 h-[0.03125rem] flex-shrink-0 bg-sidebar-border"
  ></div>

  <div bind:this={headerEl} class="flex-shrink-0">
    <TaskListHeader
      label="Tasks"
      count={sidebarStore.headerCount}
      mode={sidebarStore.viewMode}
      showToggle={sidebarStore.showsModeToggle}
      filtered={!!sidebarStore.projectFilter}
      onModeChange={(mode) => sidebarStore.setViewMode(mode)}
      onClearFilter={() => sidebarStore.setProjectFilter(null)}
    />
  </div>

  <!-- Only the list scrolls; everything above it is furniture. Rows hold the
       position they were created at — a row that moves under the cursor costs a
       misclick every time, and one that moves while you read costs your place. -->
  <div
    bind:this={scrollEl}
    class="@container min-h-0 flex-1 overflow-y-auto px-3 pb-2.5"
    style="scrollbar-width:thin; -webkit-overflow-scrolling:touch; overscroll-behavior-y:contain"
    role="tree"
    tabindex="-1"
    aria-label="Tasks"
    onkeydown={handleTreeKeydown}
  >
    {#if sidebarStore.visibleTasks.length === 0}
      <p class="px-[0.625rem] py-1 text-[0.8125rem] text-muted-foreground">
        {sidebarStore.projectFilter
          ? `No open tasks in ${sidebarStore.filterProjectLabel}`
          : "No open tasks"}
      </p>
    {:else if sidebarStore.viewMode === "flat"}
      <div class="flex flex-col gap-0.5">
        {#each sidebarStore.visibleTasks as task (task.key)}
          {@render taskRow(task, false)}
        {/each}
      </div>
    {:else}
      {#each sidebarStore.taskGroups as group (group.projectKey)}
        <div class="mb-4">
          <!-- A project is the level above, so it is a section header rather
               than another row: mark, small uppercase name, a hairline running
               to the count. It never competes with the task titles below it. -->
          <div
            class="mb-0.5 flex h-[1.625rem] items-center gap-[0.625rem] px-[0.625rem]"
          >
            <ProjectMark
              projectKey={group.projectKey}
              initial={group.initial}
              active={group.projectKey === sidebarStore.activeProjectKey}
              class="size-4"
              letterClass="text-[0.53125rem]"
            />
            <span
              class="shrink-0 text-[0.59375rem] font-semibold tracking-[0.1em] text-[color-mix(in_oklch,var(--foreground)_62%,transparent)] uppercase"
              >{group.projectLabel}</span
            >
            <span
              class="h-[0.03125rem] flex-1 bg-[color-mix(in_oklch,var(--foreground)_9%,transparent)]"
            ></span>
            <span
              class="shrink-0 font-mono text-[0.625rem] text-muted-foreground opacity-45 tabular-nums"
              >{group.tasks.length}</span
            >
          </div>
          <div class="flex flex-col gap-0.5">
            {#each group.tasks as task (task.key)}
              {@render taskRow(task, true)}
            {/each}
          </div>
        </div>
      {/each}
    {/if}
  </div>

  <!-- The panel's second and last hairline. -->
  <Sidebar.Footer
    class="relative flex-shrink-0 border-t border-t-sidebar-border px-3 pt-2 pb-2.5"
  >
    <Sidebar.Menu class="gap-px">
      {#if sidebarStore.pinnedSessions.length > 0}
        <Sidebar.MenuItem>
          <Sidebar.MenuButton
            class={navRow}
            onclick={() => (savedSessionsOpen = !savedSessionsOpen)}
          >
            <span class={navIcon}><PushPinIcon size={16} weight="fill" /></span>
            <span class={navLabel}>Saved sessions</span>
            <span class={navCount}>{sidebarStore.pinnedSessions.length}</span>
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
                    : 'text-muted-foreground'}">{pin.title}</span
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
          class="{navRow} {session.settingsOpen ? navRowActive : ''}"
          isActive={session.settingsOpen}
          onclick={() => session.showSettings()}
        >
          <span
            class="{navIcon} motion-safe:transition-transform motion-safe:duration-500 motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:rotate-90"
            ><GearIcon size={16} /></span
          >
          <span class={navLabel}>Settings</span>
          <span class={navHint}>{comboHint("global.settings")}</span>
        </Sidebar.MenuButton>
      </Sidebar.MenuItem>
    </Sidebar.Menu>
  </Sidebar.Footer>
</SidePanel>

{#if sessionContextMenu}
  {#if sessionContextMenu.kind === "tab"}
    {@const menuTask = sessionContextMenu.task}
    {@const menuTabId = sessionContextMenu.tabId}
    <SessionContextMenu
      x={sessionContextMenu.x}
      y={sessionContextMenu.y}
      tabId={menuTabId}
      showSplit
      onStartRename={() => (renamingTabId = menuTabId)}
      rowActions={menuTask
        ? {
            onStop:
              menuTask.status === "running"
                ? () => stopTask(menuTask)
                : undefined,
            done: menuTask.status === "done",
            onToggleDone: () => markTaskDone(menuTask),
          }
        : {
            onStop:
              sidebarStore.childForTab(menuTabId).attention === "running"
                ? () => session.interruptTab(menuTabId)
                : undefined,
          }}
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
