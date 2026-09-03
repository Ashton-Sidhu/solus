<script lang="ts">
  import { tick } from "svelte";
  import { fly } from "svelte/transition";
  import { SvelteMap, SvelteSet } from "svelte/reactivity";
  import VirtualList from "svelte-tiny-virtual-list";
  import { Search as MagnifyingGlassIcon, X as XIcon } from "@lucide/svelte";
  import { localApi } from "@solus/client-core/local-api";
  import { readSessionMeta } from "@solus/client-core/session-meta";
  import type { Task, TaskLink, TaskStatus } from "@solus/contracts/task-types";
  import type { SessionMeta } from "@solus/contracts/types";
  import {
    getSessionSidebarStore,
    getWorkspaceContext,
    runtime,
  } from "../../../contexts";
  import type { SidebarSessionChild } from "../../../contexts/workspace/session-sidebar.store.svelte";
  import { blurActiveTextInputOnMobile } from "../../../lib/inputFocus";
  import { createSessionPreviewStore } from "../../../lib/preview.svelte";
  import { toasts } from "../../../lib/toasts";
  import { getPopoverLayer } from "../../popoverLayer.svelte";
  import { portal } from "../../portal";
  import { Input } from "../../ui/input";
  import Kbd from "../../ui/Kbd.svelte";
  import { relativeTime } from "../../tasks/lib/tasks-api";
  import SessionContextMenu from "../SessionContextMenu.svelte";
  import SessionPreview from "../SessionPreview.svelte";
  import TaskContextMenu from "../TaskContextMenu.svelte";
  import PickerActionBar from "./PickerActionBar.svelte";
  import PickerPeekSheet from "./PickerPeekSheet.svelte";
  import TaskPreviewPane from "./TaskPreviewPane.svelte";
  import UnifiedPickerRow from "./UnifiedPickerRow.svelte";
  import {
    buildPickerRows,
    collapseTarget,
    expandTarget,
    pickerRowHeight,
    projectLabel,
    selectedRowIndex,
    type PickerEntry,
  } from "./lib/picker-rows";
  import { openPickerLinkedItem } from "./lib/picker-linked-actions";
  import { hasLeftPress, type PressPoint } from "./lib/picker-long-press";

  interface Props {
    open: boolean;
    onClose: () => void;
    inline?: boolean;
  }

  let { open = $bindable(), onClose, inline = false }: Props = $props();

  const session = getWorkspaceContext();
  const sidebarStore = getSessionSidebarStore();
  const layer = getPopoverLayer();
  const preview = createSessionPreviewStore();
  let query = $state("");
  let selectedKey = $state<string | null>(null);
  let revealedTaskId = $state<string | null>(null);
  let searchEl = $state<HTMLInputElement | null>(null);
  let pickerEl = $state<HTMLDivElement | null>(null);
  let listHeight = $state(0);
  let wasOpen = false;

  let taskContextMenu = $state<{ task: Task; x: number; y: number } | null>(null);
  let sessionContextMenu = $state<{
    session: SidebarSessionChild;
    x: number;
    y: number;
  } | null>(null);
  /** The long-pressed row, raised as a sheet over the list on a phone. */
  let peekTarget = $state<
    | { kind: "task"; task: Task }
    | { kind: "session"; session: SidebarSessionChild; task: Task }
    | null
  >(null);
  /** Which tasks the reader opened. A search opens its own hits on top of
   *  these without touching them, so clearing the query restores the tree. */
  const expandedTaskIds = new SvelteSet<string>();

  // Newest work first, and the row now states the date it is sorted by, so the
  // order is readable rather than something you have to take on trust.
  const tasks = $derived(
    sidebarStore.pickableTasks.toSorted(
      (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
    ),
  );
  // The sidebar already knows every session a task owns — links, mounted tabs
  // and their attention — so the picker asks it rather than keeping a second
  // model of the same tree. It asks about the *task*, not about a sidebar row:
  // most pickable tasks have no row on this client, and reading their sessions
  // through one reported every such task as empty.
  function sessionsFor(task: Task): SidebarSessionChild[] {
    return sidebarStore.sessionsForPickableTask(task);
  }
  const list = $derived(
    buildPickerRows({
      tasks, query, sessionsFor, expandedTaskIds,
      openTaskIds: new Set(sidebarStore.activeTasks.flatMap((row) => row.taskId ?? [])),
      snoozedTaskIds: new Set(sidebarStore.snoozedTasks.flatMap((row) => row.taskId ?? [])),
    }),
  );
  const selectedIndex = $derived(
    Math.max(0, list.entries.findIndex((entry) => entry.key === selectedKey)),
  );
  const selectedEntry = $derived<PickerEntry | null>(
    list.entries[Math.min(selectedIndex, list.entries.length - 1)] ?? null,
  );
  const selectedTask = $derived(selectedEntry?.task ?? null);
  const selectedSession = $derived(
    selectedEntry?.kind === "session" ? selectedEntry.session : null,
  );

  // The virtual list needs every row height before paint, at the row's window-width rung.
  const rowSizes = $derived(
    list.rows.map((row) => pickerRowHeight(row, runtime.isMobileViewport)),
  );
  // A persistent target snaps back on later row-size updates.
  let scrollTargetIndex = $state<number | undefined>(undefined);
  let scrollRequestId = 0;

  async function scrollSelectionIntoView(): Promise<void> {
    const requestId = ++scrollRequestId;
    await tick();
    if (requestId !== scrollRequestId) return;
    scrollTargetIndex = Math.max(selectedRowIndex(list.rows, selectedIndex), 0);
    await tick();
    if (requestId === scrollRequestId) scrollTargetIndex = undefined;
  }

  // A session already in a tab previews from its live transcript. A durable
  // one needs its metadata first; that read is made once per session and kept
  // for the visit, so arrowing back over a row costs nothing the second time.
  const sessionMetas = new SvelteMap<string, SessionMeta | null>();
  const metaReadsInFlight = new Set<string>();

  function metaKey(child: SidebarSessionChild): string | null {
    return child.serverId && child.sessionId ? `${child.serverId}:${child.sessionId}` : null;
  }
  $effect(() => {
    const target = selectedSession;
    if (!open || !target) {
      preview.reset();
      return;
    }
    const tabId = target.tabId;
    const tabSession = tabId ? session.sessionFor(tabId) : null;
    // An empty restored tab is not proof that its durable session has no messages.
    if (tabId && tabSession?.messages.length) {
      preview.show(
        { kind: "open", tabId, tab: session.tabs[tabId], session: tabSession },
        session.ctx,
        () => selectedSession === target,
      );
      return;
    }
    const key = metaKey(target);
    if (!key || !sessionMetas.has(key)) {
      preview.reset();
      if (key && !metaReadsInFlight.has(key)) {
        metaReadsInFlight.add(key);
        void readSessionMeta(target.serverId!, target.sessionId!).then((meta) => {
          metaReadsInFlight.delete(key);
          sessionMetas.set(key, meta);
        });
      }
      return;
    }
    const meta = sessionMetas.get(key);
    if (!meta) {
      preview.reset();
      return;
    }
    preview.show({ kind: "history", meta }, session.ctx, () => selectedSession === target);
  });

  const previewLoading = $derived.by(() => {
    const target = selectedSession;
    if (!target) return false;
    const tabId = target.tabId;
    const tabSession = tabId && session.tabs[tabId] ? session.sessionFor(tabId) : null;
    if (tabId && tabSession?.messages.length) return preview.loading;
    const key = metaKey(target);
    return preview.loading || (!!key && !sessionMetas.has(key));
  });

  $effect(() => {
    void query;
    selectedKey = null;
    revealedTaskId = null;
    if (open) void scrollSelectionIntoView();
  });

  $effect(() => {
    if (!open) {
      wasOpen = false;
      return;
    }
    if (wasOpen) return;
    wasOpen = true;
    query = "";
    selectedKey = null;
    void session.tasksStore.ensureLoaded();
    blurActiveTextInputOnMobile();
    tick().then(() => {
      selectIndex(0, true);
      if (!runtime.shouldSuppressFocus) searchEl?.focus();
      else pickerEl?.focus();
    });
  });

  function close(): void {
    taskContextMenu = null;
    sessionContextMenu = null;
    peekTarget = null;
    revealedTaskId = null;
    open = false;
    preview.reset();
    sessionMetas.clear();
    onClose();
    requestAnimationFrame(() => blurActiveTextInputOnMobile());
  }

  /** ⏎ on a task: its latest session, or a new draft if it has none. */
  function select(task: Task): void {
    window.dispatchEvent(
      new CustomEvent("solus:expand-sidebar-task", { detail: task.id }),
    );
    void sidebarStore.selectTaskRecord(task);
    close();
  }

  /** ⏎ on a session: the same move as clicking its row in the sidebar. */
  function selectSession(child: SidebarSessionChild): void {
    close();
    void sidebarStore.selectChild(child);
  }

  function startDraft(task: Task): void {
    close();
    void session.openTaskSession(task);
  }

  function toggleTask(taskId: string): void {
    if (expandedTaskIds.has(taskId)) {
      expandedTaskIds.delete(taskId);
    } else {
      expandedTaskIds.add(taskId);
    }
  }

  /** A task row reveals its sessions without committing to one of them. */
  function expandTaskEntry(entry: PickerEntry): boolean {
    if (entry.kind !== "task" || entry.sessions.length === 0) return false;
    selectIndex(entry.entryIndex);
    expandedTaskIds.add(entry.task.id);
    return true;
  }

  /** A task-row click owns both sides of its disclosure state. */
  function toggleTaskEntry(entry: PickerEntry): boolean {
    if (entry.kind !== "task" || entry.sessions.length === 0) return false;
    selectIndex(entry.entryIndex);
    toggleTask(entry.task.id);
    return true;
  }

  /** Move the cursor by row identity without changing task disclosure. */
  function selectIndex(entryIndex: number, shouldScroll = false): void {
    const boundedIndex = Math.max(0, Math.min(entryIndex, list.entries.length - 1));
    const entry = list.entries[boundedIndex];
    selectedKey = entry?.key ?? null;
    if (shouldScroll) void scrollSelectionIntoView();
  }

  // ── Managing a task without leaving the picker ──
  // Every move below is the same one the sidebar's row menu makes, on the same
  // store calls, so a task looks identical whichever surface changed it. The
  // picker stays open for status, snooze and unread — they are edits to a row
  // you are still choosing between — and closes for anything that navigates.

  function isSnoozed(task: Task): boolean {
    return sidebarStore.snoozedTasks.some((row) => row.taskId === task.id);
  }

  function openTaskPage(task: Task): void {
    const taskId = task.id;
    close();
    session.goToTask(taskId);
  }

  function resumeTask(task: Task): void {
    close();
    void session.openTaskLinkedSession(task);
  }

  function openSourceTicket(task: Task): void {
    if (!task.url) return;
    close();
    void localApi.openExternal(task.url);
  }

  function openLinkedItem(task: Task, link: TaskLink): void {
    close();
    openPickerLinkedItem(session, task, link);
  }

  function openLinkedExternal(url: string): void {
    close();
    void localApi.openExternal(url);
  }

  async function unlinkItem(link: TaskLink): Promise<void> {
    try {
      await session.tasksStore
        .get(link.taskId)
        .unlink(link.kind, link.targetKey, link.targetScope);
    } catch (error) {
      toasts.error("Couldn't unlink item", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function setStatus(task: Task, status: TaskStatus): Promise<void> {
    try {
      await session.tasksStore.get(task.id, task.projectKey ?? undefined).setStatus(status);
    } catch (error) {
      toasts.error("Couldn't update status", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function deleteTask(task: Task): void {
    const pending = session.tasksStore.softRemove([task.id]);
    if (!pending.length) return;
    toasts.undo("Task deleted", () => session.tasksStore.restorePending(pending), {
      onDismiss: () =>
        session.tasksStore.commitPending(pending).catch((error) =>
          toasts.error("Couldn't delete task", {
            description: error instanceof Error ? error.message : String(error),
          })),
    });
  }

  // Touch has no right click, and on a phone the preview column is hidden.
  // A tap raises that preview as a sheet; a long press raises the same sheet
  // without committing to the row when the timer fires.
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  /** Where the finger landed, so a move can be measured against it. */
  let longPressOrigin: PressPoint | null = null;
  let suppressNextClick = false;

  function openContextMenu(event: MouseEvent, entry: PickerEntry): void {
    event.preventDefault();
    event.stopPropagation();
    selectIndex(entry.entryIndex);
    if (entry.kind === "task") {
      sessionContextMenu = null;
      taskContextMenu = { task: entry.task, x: event.clientX, y: event.clientY };
    } else {
      taskContextMenu = null;
      sessionContextMenu = { session: entry.session, x: event.clientX, y: event.clientY };
    }
  }

  function openPeek(entry: PickerEntry): void {
    selectIndex(entry.entryIndex);
    peekTarget =
      entry.kind === "task"
        ? { kind: "task", task: entry.task }
        : { kind: "session", session: entry.session, task: entry.task };
  }

  function startLongPress(event: PointerEvent, entry: PickerEntry): void {
    if (event.pointerType !== "touch") return;
    longPressOrigin = { x: event.clientX, y: event.clientY };
    longPressTimer = setTimeout(() => {
      suppressNextClick = true;
      openPeek(entry);
    }, 500);
  }

  function cancelLongPress(): void {
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressTimer = null;
    longPressOrigin = null;
  }

  /** The finger left the glass. */
  function endPress(): void {
    cancelLongPress();
    if (!suppressNextClick) return;
    // A press that raised the sheet still emits the click of its own lift, and
    // that is the one click to swallow. Release the guard on the next frame,
    // once that click has been and gone — held open, it ate the reader's next
    // real tap instead, minutes later and on a different row.
    requestAnimationFrame(() => {
      suppressNextClick = false;
    });
  }

  // Selection follows a pointer that *moves*, not one a row scrolls under:
  // `pointerenter` fires when the keyboard scrolls the list beneath a resting
  // mouse and would steal the selection from the key that caused it.
  function hoverEntry(event: PointerEvent, entry: PickerEntry): void {
    if (event.pointerType === "touch") {
      // A held finger is never still, so only travel far enough to be a scroll
      // ends the press. Cancelling on the first move cancelled every press.
      if (longPressOrigin && hasLeftPress(longPressOrigin, event.clientX, event.clientY)) {
        cancelLongPress();
      }
      return;
    }
    cancelLongPress();
    if (selectedIndex !== entry.entryIndex) selectIndex(entry.entryIndex);
  }

  function activate(entry: PickerEntry): void {
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    // A phone has no preview column, so a tap raises the same detail and action
    // surface that desktop keeps beside the list. The sheet owns the explicit
    // Open or Resume action; desktop keeps the direct row activation promised
    // by its footer and preview pane.
    if (runtime.isMobileViewport) openPeek(entry);
    else if (entry.kind !== "task") selectSession(entry.session);
    else select(entry.task);
  }

  function clickEntry(entry: PickerEntry): void {
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    if (toggleTaskEntry(entry)) return;
    activate(entry);
  }

  function stepIn(): void {
    const target = expandTarget(selectedEntry ?? undefined);
    if (!target) return;
    if (target.action === "expand") expandedTaskIds.add(target.taskId);
    else selectIndex(selectedIndex + 1, true);
  }

  function stepOut(): void {
    const target = collapseTarget(list.entries, selectedIndex);
    if (!target) return;
    if (target.action === "select") selectIndex(target.entryIndex, true);
    else {
      expandedTaskIds.delete(target.taskId);
    }
  }

  function handleKeyDown(event: KeyboardEvent): void {
    // While the row menu or the sheet is up it owns the keyboard, including
    // the Escape that dismisses it — arrowing the list underneath would move
    // the selection away from the row the open surface is acting on.
    if (taskContextMenu || sessionContextMenu || peekTarget) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey)) {
      event.preventDefault();
      selectIndex(selectedIndex + 1, true);
    } else if (event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey)) {
      event.preventDefault();
      selectIndex(selectedIndex - 1, true);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      stepIn();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      stepOut();
    } else if (event.key === " " && selectedEntry?.kind === "task") {
      event.preventDefault();
      expandTaskEntry(selectedEntry);
    } else if (event.key === "Enter" && selectedEntry) {
      event.preventDefault();
      activate(selectedEntry);
    }
  }

  /**
   * Dismiss by the scrim, not by a document listener.
   *
   * Everything the picker opens — the row menu, the status and snooze
   * dropdowns, the sheet — portals into the popover layer and is therefore
   * outside the panel by construction, so a document-level outside-click test
   * dismisses the picker on its own menu's click. The scrim already exists to
   * be the click-away target: a press that lands on the scrim itself, and not
   * on a child, is unambiguously outside.
   */
  function handleScrimPointerDown(event: MouseEvent): void {
    if (event.target !== event.currentTarget) return;
    close();
  }

  const counts = $derived(
    `${list.taskCount} ${list.taskCount === 1 ? "task" : "tasks"} · ${list.sessionCount} ${list.sessionCount === 1 ? "session" : "sessions"}`,
  );
</script>

{#snippet pickerContent()}
  <div
    class="flex shrink-0 items-center gap-3 border-b border-[var(--hairline)] px-[18px] pt-[15px] pb-3.5 max-md:border-0 max-md:px-4 max-md:pt-2 max-md:pb-1"
  >
    <!-- The same search shape the phone uses everywhere else: a 44px card, not
         a bare rule. `display: contents` above the rung leaves the desktop row
         exactly as it was. -->
    <div
      class="contents max-md:flex max-md:h-11 max-md:flex-1 max-md:items-center max-md:gap-2.5 max-md:rounded-lg max-md:bg-card max-md:px-3 max-md:shadow-[shadow:var(--elev-ring)]"
    >
      <MagnifyingGlassIcon size={15} class="shrink-0 text-muted-foreground opacity-65" />
      <!-- The one deliberate size override on this surface: iOS Safari zooms the
           page whenever a focused field is under 16px, and no chrome rung is that
           large. Everything else here takes a named rung. -->
      <Input
        bind:ref={searchEl}
        bind:value={query}
        type="text"
        placeholder="Search work in solus…"
        class="h-auto flex-1 rounded-none border-0 bg-transparent p-0 text-workspace-chrome shadow-none focus-visible:ring-0 dark:bg-transparent max-md:text-base"
      />
    </div>
    <span class="shrink-0 text-micro tabular-nums text-muted-foreground max-md:hidden">{counts}</span>
    <button
      type="button"
      class="hidden size-9 shrink-0 cursor-pointer items-center justify-center rounded-[0.625rem] text-muted-foreground max-md:flex"
      onclick={close}
      aria-label="Close picker"
    >
      <XIcon size={16} />
    </button>
  </div>

  <div class="flex min-h-0 flex-1 overflow-hidden">
    <div
      class="flex w-[clamp(20rem,56%,33.125rem)] shrink-0 flex-col overflow-hidden border-r border-[var(--hairline)] px-2 pt-2 max-md:w-full max-md:border-0 max-md:px-3 max-md:pt-1"
    >
      <div class="min-h-0 flex-1 overflow-hidden" bind:clientHeight={listHeight} role="listbox" aria-label="Tasks and sessions">
        {#if list.entries.length === 0}
          <div class="flex h-full items-center justify-center px-5 text-center text-workspace-chrome text-muted-foreground">
            {session.tasksStore.loading ? "Loading tasks…" : `No tasks match “${query}”`}
          </div>
        {:else if listHeight > 0}
          <VirtualList
            width="100%"
            height={listHeight}
            itemCount={list.rows.length}
            itemSize={rowSizes}
            scrollToIndex={scrollTargetIndex}
            scrollToAlignment="auto"
            scrollToBehaviour="instant"
            overscanCount={6}
          >
            {#snippet item({ index, style }: { index: number; style: string })}
              <UnifiedPickerRow
                row={list.rows[index]}
                {style}
                {selectedIndex}
                {query}
                onActivate={clickEntry}
                onHover={hoverEntry}
                onToggle={toggleTask}
                onContextMenu={openContextMenu}
                onPressStart={startLongPress}
                onPressEnd={endPress}
                mobile={runtime.isMobileViewport}
                {revealedTaskId}
                onRevealChange={(taskId) => (revealedTaskId = taskId)}
                onSetStatus={(task, status) => void setStatus(task, status)}
              />
            {/snippet}
          </VirtualList>
        {/if}
      </div>
    </div>

    <!-- The preview scrolls; the action bar under it does not, so what you can
         do to the row is always one reach away however long its body runs. -->
    <div class="flex min-w-0 flex-1 flex-col max-md:hidden">
      <div class="min-h-0 flex-1 overflow-hidden">
        {#if selectedSession && selectedTask}
          <SessionPreview
            preview={preview.snapshot}
            loading={previewLoading}
            title={selectedSession.label}
            byline={selectedTask.title}
            timeAgo={relativeTime(selectedSession.lastActivityAt || selectedTask.updatedAt)}
            hiddenCount={preview.hiddenCount}
            attention={selectedSession.attention}
            {query}
          />
        {:else if selectedTask}
          <div class="h-full overflow-y-auto px-6 pt-[22px] pb-4">
            <TaskPreviewPane
              task={selectedTask}
              sessions={sessionsFor(selectedTask)}
              onSelectSession={selectSession}
              onOpenLink={(link) => openLinkedItem(selectedTask, link)}
              onOpenExternal={openLinkedExternal}
              onUnlink={(link) => void unlinkItem(link)}
            />
          </div>
        {/if}
      </div>
      {#if selectedSession && selectedTask}
        {@const picked = selectedSession}
        <div class="shrink-0 border-t border-[var(--hairline)] px-3.5 py-2.5">
          <PickerActionBar
            task={selectedTask}
            portalTarget={layer.el}
            primaryLabel="Resume"
            onPrimary={() => selectSession(picked)}
            onOpenTask={openTaskPage}
            onOpenSource={openSourceTicket}
          />
        </div>
      {:else if selectedTask}
        {@const picked = selectedTask}
        {@const hasSessions = sessionsFor(picked).length > 0}
        <div class="shrink-0 border-t border-[var(--hairline)] px-3.5 py-2.5">
          <PickerActionBar
            task={picked}
            portalTarget={layer.el}
            primaryLabel={hasSessions ? "Resume latest" : "Open new draft"}
            onPrimary={() => select(picked)}
            secondaryLabel={hasSessions ? "New draft" : undefined}
            onSecondary={hasSessions ? () => startDraft(picked) : undefined}
            onOpenTask={openTaskPage}
            onOpenSource={openSourceTicket}
          />
        </div>
      {/if}
    </div>
  </div>

  <div class="flex shrink-0 items-center gap-5 border-t border-[var(--hairline)] bg-[var(--wash-1)] px-4 py-2.5 text-chrome-shelf text-muted-foreground max-md:hidden">
    <span class="inline-flex items-center gap-1.5"><Kbd variant="keycap">↑↓</Kbd> navigate</span>
    {#if selectedSession}
      <span class="inline-flex items-center gap-1.5"><Kbd variant="keycap">←</Kbd> back to task</span>
      <span class="inline-flex items-center gap-1.5"><Kbd variant="keycap">⏎</Kbd> resume</span>
    {:else}
      <span class="inline-flex items-center gap-1.5"><Kbd variant="keycap">→</Kbd> expand sessions</span>
      <span class="inline-flex items-center gap-1.5"><Kbd variant="keycap">Space</Kbd> expand sessions</span>
      <span class="inline-flex items-center gap-1.5"><Kbd variant="keycap">⏎</Kbd> {selectedTask && sessionsFor(selectedTask).length ? "resume latest" : "open new draft"}</span>
    {/if}
    <span class="flex-1" aria-hidden="true"></span>
    <span class="tabular-nums">{counts}</span>
  </div>
{/snippet}

{#if open && taskContextMenu}
  {@const menuTask = taskContextMenu.task}
  {@const hasSessions = sessionsFor(menuTask).length > 0}
  <TaskContextMenu
    x={taskContextMenu.x}
    y={taskContextMenu.y}
    task={menuTask}
    hasLinkedSession={hasSessions}
    isRunning={false}
    onStart={() => select(menuTask)}
    onResume={hasSessions ? () => resumeTask(menuTask) : undefined}
    onOpenTask={() => openTaskPage(menuTask)}
    onOpenSource={menuTask.url ? () => openSourceTicket(menuTask) : undefined}
    onSetStatus={(status) => void setStatus(menuTask, status)}
    onSnoozeUntil={isSnoozed(menuTask) ? undefined : (until) => sidebarStore.snoozeRow(menuTask.id, until)}
    onWake={isSnoozed(menuTask) ? () => sidebarStore.snoozeRow(menuTask.id, null) : undefined}
    onMarkUnread={() => void sidebarStore.markTaskUnread(menuTask.id)}
    onDelete={menuTask.providerId === "local" ? () => deleteTask(menuTask) : undefined}
    portalTarget={layer.el}
    onClose={() => (taskContextMenu = null)}
  />
{/if}

{#if open && sessionContextMenu}
  {@const menuSession = sessionContextMenu.session}
  <SessionContextMenu
    x={sessionContextMenu.x}
    y={sessionContextMenu.y}
    tabId={menuSession.tabId ?? null}
    sessionId={menuSession.sessionId ?? null}
    showSplit
    rowActions={{
      onStop: menuSession.attention === "running" && menuSession.tabId
        ? () => session.interruptTabSession(menuSession.tabId!)
        : undefined,
    }}
    portalTarget={layer.el}
    onClose={() => (sessionContextMenu = null)}
  />
{/if}

{#if open && peekTarget}
  <PickerPeekSheet
    target={peekTarget}
    sessions={sessionsFor(peekTarget.task)}
    sessionPreview={preview.snapshot}
    {previewLoading}
    hiddenCount={preview.hiddenCount ?? 0}
    messageCount={preview.messageCount}
    {query}
    projectLabel={projectLabel(peekTarget.task)}
    portalTarget={layer.el}
    onClose={() => (peekTarget = null)}
    onStartDraft={startDraft}
    onOpenTask={openTaskPage}
    onOpenSource={openSourceTicket}
    onSelectSession={selectSession}
    onOpenLink={openLinkedItem}
    onOpenExternal={openLinkedExternal}
    onUnlink={(link) => void unlinkItem(link)}
  />
{/if}

{#if open && inline}
  <div bind:this={pickerEl} class="flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-transparent outline-none" role="dialog" aria-label="Task picker" tabindex="-1" onkeydown={handleKeyDown} transition:fly={{ y: 8, duration: 160 }}>
    {@render pickerContent()}
  </div>
{:else if open && layer.el}
  <div use:portal={layer.el} class="pointer-events-auto fixed inset-0 z-[200] flex items-center justify-center overflow-hidden overscroll-contain bg-[color-mix(in_srgb,var(--solus-modal-scrim)_55%,transparent)] motion-safe:animate-[backdrop-fade_140ms_ease-out]" role="presentation" onmousedown={handleScrimPointerDown}>
    <div bind:this={pickerEl} class="flex h-[70%] w-[76%] max-w-full origin-top flex-col overflow-hidden overscroll-contain rounded-3xl text-workspace-chrome bg-popover text-popover-foreground shadow-[var(--solus-popover-shadow),0_0_0_0.5px_var(--hairline-strong),inset_0_0.0625rem_0_rgba(255,255,255,0.14)] outline-none motion-safe:animate-[picker-enter_180ms_cubic-bezier(0.22,1,0.36,1)_backwards] md:pointer-fine:[.is-laptop-display_&]:h-[74%] md:pointer-fine:[.is-laptop-display_&]:w-[89%] max-md:h-[100dvh] max-md:max-h-none max-md:w-full max-md:rounded-none max-md:bg-background max-md:shadow-none" role="dialog" aria-label="Task picker" tabindex="-1" onkeydown={handleKeyDown}>
      {@render pickerContent()}
    </div>
  </div>
{/if}
