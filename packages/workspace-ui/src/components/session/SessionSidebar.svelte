<script lang="ts">
  import type { PrReviewTab } from "../../contexts/prs/pr-view.svelte";
  import { onMount, tick, untrack } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { comboHint } from "../../lib/keybindings/manifest";
  import {
    Plus as PlusIcon,
    FolderPlus as FolderPlusIcon,
    Search as MagnifyingGlassIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import type { PinnedSession } from "@solus/contracts/types";
  import {
    getSettingsContext,
    getWorkspaceContext,
    getSessionSidebarStore,
    hosts,
    runtime,
  } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import {
    completedTasksWithinRetention,
    SIDEBAR_COMPLETED_RETENTION_CHECK_MS,
  } from "../../lib/completed-task-retention";
  import SidePanel from "../layout/SidePanel.svelte";
  import HistoryNavButtons from "../layout/HistoryNavButtons.svelte";
  import {
    SIDEBAR_MAX_WIDTH,
    SIDEBAR_MIN_WIDTH,
  } from "../layout/lib/workspace-body";
  import SessionContextMenu from "./SessionContextMenu.svelte";
  import TaskActionBar from "./TaskActionBar.svelte";
  import TaskRow from "./TaskRow.svelte";
  import PinnedSessionRow from "./PinnedSessionRow.svelte";
  import SessionStatusView from "./SessionStatusView.svelte";
  import SessionProjectView from "./SessionProjectView.svelte";
  import type { SidebarListShared } from "./SidebarList.svelte";
  import SidebarBrand from "./SidebarBrand.svelte";
  import SidebarPlaces from "./SidebarPlaces.svelte";
  import SidebarSky from "./SidebarSky.svelte";
  import { SKY_HEADER_DROP_REM } from "./lib/sidebar-sky";
  import SnoozeTaskMenu from "./SnoozeTaskMenu.svelte";
  import {
    taskSnoozeToastLabel,
    type TaskSnoozeAnchor,
  } from "./lib/task-snooze";
  import type { DraftRow as DraftRowModel } from "./lib/draft-list";
  import { taskPrNavigation } from "./lib/pr-navigation";
  import type { SidebarSessionChild } from "../../contexts/workspace/session-sidebar.store.svelte";
  import { nextTaskAfterLeaving } from "../../contexts/workspace/session-sidebar-selection";
  import { canDriveSession } from "../../contexts/sharing/resource-roles";
  import { sessionPullRequestsStore } from "../../contexts/prs/session-pull-requests.store.svelte";
  import { sharesStore } from "../../contexts/sharing/shares.store.svelte";
  import { sessionListStore } from "../../contexts/workspace/session-list.store.svelte";
  import { writeSessionDrag } from "../../lib/session-drag";
  import {
    referencesForRows,
    type ReferencedRow,
    type SessionReferenceSources,
  } from "./lib/session-reference";
  import { shareToast } from "../../contexts/workspace/shared-sessions";
  import { noticeUnopenableSession } from "../../contexts/sharing/unopenable-session";
  import { memberByKey } from "../users/lib/organization-people";
  import {
    filterSidebarTasks,
    prChipForChoices,
    type TaskPrChoice,
    type SidebarTask,
  } from "./lib/task-list";
  import {
    filterPinnedEntries,
    type SidebarListInput,
    type SidebarSection,
  } from "./lib/sidebar-list-items";
  import { useKeybinding } from "../../lib/keybindings/use-keybinding.svelte";
  import { isDarkSkyScene } from "../../lib/sky-scene";
  import { useSkyScene } from "../../lib/sky-scene.svelte";

  interface Props {
    open?: boolean;
    managedWidth?: boolean;
    /** Closed, the places column stays on screen (`SidePanel`). */
    staysAsColumn?: boolean;
    onToggleCollapse?: () => void;
    onSessionSelect?: () => void;
  }
  let {
    open = true,
    managedWidth = false,
    staysAsColumn = false,
    onToggleCollapse,
    onSessionSelect,
  }: Props = $props();

  const session = getWorkspaceContext();
  // A share link's guest reads only the shared session: the workspace pages are not theirs (host-sharing.md §10).
  const isGuest = $derived(hosts.runOn?.me.isGuest ?? false);
  const theme = getSettingsContext();
  const sidebarStore = getSessionSidebarStore();
  // The title bar's sky shows the scene the person chose, or the clock's.
  // Dusk and night are dark in both themes. With the sky off the title bar is
  // plain and the content keeps no room for it.
  const sky = useSkyScene(() => theme.skySceneChoice);
  const isOnDarkSky = $derived(theme.showsSidebarSky && isDarkSkyScene(sky.current));
  const canStartSession = $derived(hosts.runOn?.me.may("host.sessions.start") ?? true);

  let scrollEl: HTMLDivElement | undefined = $state();
  let sessionContextMenu = $state<
    | {
        kind: "tab";
        tabId: string | null;
        x: number;
        y: number;
      }
    | { kind: "pinned"; pin: PinnedSession; x: number; y: number }
    /** A session in the list with no conversation open here, such as a cloud
     *  record or a shared session. `row` is set for a top-level row. */
    | {
        kind: "listed";
        sessionId: string;
        serverId: string | null;
        row: SidebarTask | null;
        x: number;
        y: number;
      }
    | null
  >(null);
  /** The row being renamed in place. One at a time: the edit replaces the label
   *  where it sits, so two open editors would be two claims on the same name. */
  let renamingTabId = $state<string | null>(null);

  function startRename(tabId: string | null | undefined): void {
    // A member who may only read a shared session cannot rename it.
    const tabSession = tabId ? session.sessionFor(tabId) : null;
    if (tabSession && !canDriveSession(session.serverIdFor(tabId!), tabSession.id)) return;
    renamingTabId = tabId ?? null;
  }

  /** Leaving the editor hands the caret back to the composer, so abandoning a
   *  rename lands you where committing one does rather than nowhere. */
  function cancelRename(): void {
    renamingTabId = null;
    requestInputFocus();
  }
  /** Open by default, and opened again when a new share arrives. */
  let sharedSectionOpen = $state(true);
  /** Open by default: a pin is a session the person wants at hand. */
  let pinnedSectionOpen = $state(true);
  /** Closed by default: busy rows stay out of the way until they need you. */
  let workingSectionOpen = $state(false);
  let snoozedShelfOpen = $state(false);
  let completedShelfOpen = $state(false);

  function toggleSection(section: SidebarSection) {
    let isOpen: boolean;
    if (section === "shared") isOpen = sharedSectionOpen = !sharedSectionOpen;
    else if (section === "pinned") isOpen = pinnedSectionOpen = !pinnedSectionOpen;
    else if (section === "working") isOpen = workingSectionOpen = !workingSectionOpen;
    else if (section === "snoozed") isOpen = snoozedShelfOpen = !snoozedShelfOpen;
    else isOpen = completedShelfOpen = !completedShelfOpen;
    if (isOpen) tick().then(() => requestAnimationFrame(() => revealOpenedSection(section)));
  }
  /** A section opened at the bottom of a scrolled list puts its rows below
   *  the fold. Scroll just enough to show its last row, but never past its
   *  header. */
  function revealOpenedSection(section: SidebarSection) {
    if (!scrollEl) return;
    const header = scrollEl.querySelector<HTMLElement>(`[data-sidebar-section-header="${section}"]`);
    const rows = scrollEl.querySelectorAll<HTMLElement>(`[data-sidebar-section="${section}"]`);
    const lastRow = rows[rows.length - 1];
    if (!header || !lastRow) return;
    const padding = 8;
    const scrollRect = scrollEl.getBoundingClientRect();
    const hiddenBelow = lastRow.getBoundingClientRect().bottom - scrollRect.bottom + padding;
    if (hiddenBelow <= 0) return;
    const roomAboveHeader = header.getBoundingClientRect().top - scrollRect.top - padding;
    scrollEl.scrollTop += Math.min(hiddenBelow, Math.max(0, roomAboveHeader));
  }
  /** A snoozable row. Snoozing hides a row under the Snoozed shelf until its
   *  wake time; it says nothing about the work, so a row needs no task to have
   *  one — only a key this column can recognise it by. */
  interface SnoozeTarget {
    rowKey: string;
    title: string;
  }
  let snoozeTargets = $state<SnoozeTarget[]>([]);
  let snoozeCustomTime = $state(false);
  let snoozeAnchor = $state<TaskSnoozeAnchor | null>(null);
  let taskQuery = $state("");
  let sidebarNow = $state(Date.now());
  let taskSearchEl = $state<HTMLInputElement | null>(null);
  const searchedSessionRows = $derived(
    filterSidebarTasks(sidebarStore.sessionRows, taskQuery),
  );
  const searchedSharedRows = $derived(
    filterSidebarTasks(sidebarStore.sharedRows, taskQuery),
  );
  const searchedWorkingRows = $derived(
    filterSidebarTasks(sidebarStore.workingRows, taskQuery),
  );
  const searchedPinnedEntries = $derived(
    filterPinnedEntries(sidebarStore.pinnedEntries, taskQuery),
  );
  /** Every open row in list order: sessions, shared, pinned, then working
   *  rows. Selection ranges, bulk actions and "the next row" all read this
   *  one order. */
  const openRows = $derived([
    ...searchedSessionRows,
    ...searchedSharedRows,
    ...searchedPinnedEntries.flatMap((entry) => (entry.row ? [entry.row] : [])),
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
  /** What both views list. Each view reads only the rows it draws, and only
   *  the view on screen is mounted (docs/plans/sidebar-project-view.md). */
  const listInput: SidebarListInput = $derived({
    drafts: sidebarStore.draftRows,
    sessions: searchedSessionRows,
    shared: searchedSharedRows,
    pinned: searchedPinnedEntries,
    working: searchedWorkingRows,
    snoozed: searchedSnoozedTasks,
    completed: searchedCompletedTasks,
    isSharedOpen: sharedSectionOpen || isSearching,
    isPinnedOpen: pinnedSectionOpen || isSearching,
    isWorkingOpen: workingSectionOpen || isSearching,
    isSnoozedOpen: snoozedShelfOpen,
    isCompletedOpen: isCompletedShelfExpanded,
    shelfRevealTaskId: sidebarStore.shelfRevealTaskId,
  });
  const listShared: SidebarListShared = $derived({
    scrollEl,
    motionMs: theme.sidebarMotionMs,
    isLoading: !session.tasksStore.loaded,
    taskRow,
    pinnedRow,
    onOpenDraft: openDraft,
    onDiscardDraft: discardDraft,
    onToggleSection: toggleSection,
    onCloseRow: closeRowByKey,
    onNestedOpenChange: setNestedOpenByKey,
  });
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

  onMount(() => {
    const clock = window.setInterval(() => {
      sidebarNow = Date.now();
    }, SIDEBAR_COMPLETED_RETENTION_CHECK_MS);
    return () => window.clearInterval(clock);
  });

  /** The owner's name, as the organization's directory has it. */
  function personName(personKey: string | null): string | null {
    return personKey ? (memberByKey(sharesStore.directory, personKey)?.displayName ?? null) : null;
  }

  // A direct share opens Shared with you and says who shared what. The toast
  // takes no focus: the composer keeps the caret (docs/plans/shared-with-you.md §5).
  onMount(() =>
    sessionListStore.onNewShares((granted) => {
      sharedSectionOpen = true;
      for (const listed of granted) {
        if (!listed.share) continue;
        const { message, description } = shareToast(personName(listed.share.sharedBy), listed.title, listed.share.role);
        toasts.info(message, {
          description,
          action: {
            label: "Open",
            onAction: () => {
              void session.revealSession(listed.sessionId, listed.serverId).then((tabId) => {
                if (tabId === null) noticeUnopenableSession(listed.serverId, listed.sessionId);
                requestInputFocus();
              });
            },
          },
        });
      }
    }),
  );

  // Names on shared rows come from the organization's directory: read it once
  // there is a shared row to name.
  $effect(() => {
    if (sidebarStore.sharedRows.length > 0 && !sharesStore.directoryLoaded) {
      untrack(() => void sharesStore.loadDirectory().catch(() => {}));
    }
  });

  /** Scoping the column produces a different list, so an offset into the old
   *  one lands nowhere. Selection is deliberately left alone: the filter is a
   *  lens on the list, not a navigation. */
  function filterToProject(projectKey: string | null) {
    sidebarStore.setProjectFilter(projectKey);
    if (scrollEl) scrollEl.scrollTop = 0;
    requestInputFocus();
  }

  function newSession() {
    session.drafts.openSessionDraft({ freshTask: true, via: "click" });
  }

  /** The brand in the title bar and the New draft button both start here. */
  function startDraft() {
    newSession();
    requestInputFocus();
    onSessionSelect?.();
  }

  function openTaskPr(choice: TaskPrChoice, tab?: PrReviewTab): void {
    const { route, sourceUrl } = taskPrNavigation(choice);
    session.openRoute(route, { sourceUrl, tab, via: "click" });
  }

  function warmTaskPr(choice: TaskPrChoice): void {
    const { route, sourceUrl } = taskPrNavigation(choice);
    session.warmRoute(route, { sourceUrl });
  }

  /** Remove a pull request from the row that shows it, or null when the row
   *  only reads it from its checkout and holds no link to remove. */
  function unlinkRowPr(row: SidebarTask, choice: TaskPrChoice): (() => void) | null {
    const unlink = sidebarStore.pullRequestUnlink(row.serverId, sidebarStore.sessionIdOfRow(row), choice);
    if (!unlink) return null;
    return () =>
      void unlink().catch((error) =>
        toasts.error("Couldn't unlink pull request", {
          description: error instanceof Error ? error.message : String(error),
        }),
      );
  }

  /** Link a pull request to the row's session by its URL, or nothing when the
   *  viewer may not change that session or it has not reached its agent yet. */
  function linkRowPr(row: SidebarTask): ((url: string) => Promise<void>) | undefined {
    const sessionId = sidebarStore.sessionIdOfRow(row);
    const serverId = row.serverId;
    const tabSession = row.tabIds[0] ? session.sessionFor(row.tabIds[0]) : null;
    if (!sessionId || !serverId || (tabSession && !tabSession.agentSessionId)) return undefined;
    if (!canDriveSession(serverId, sessionId)) return undefined;
    return (url) => sessionPullRequestsStore.link(serverId, sessionId, url);
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

  /** A row activation navigates: it opens the row's conversation. Navigation
   *  swaps the conversation, the companion pane and the focused input, and for
   *  a row with nothing mounted it waits on an IPC round trip first. It runs
   *  two frames later, so the row answers the click before the app switches. */
  // A click that opens a session reorders the list under the resting pointer,
  // and the row that lands there would open its tooltip unasked. Row tooltips
  // stay shut until the pointer really moves: the browser replays a pointer
  // that a layout change passed over at the same place.
  let tooltipQuietAt = $state<{ x: number; y: number } | null>(null);
  $effect(() => {
    const from = tooltipQuietAt;
    if (!from) return;
    const move = (event: PointerEvent) => {
      if (Math.abs(event.clientX - from.x) + Math.abs(event.clientY - from.y) > 4) tooltipQuietAt = null;
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => window.removeEventListener("pointermove", move);
  });

  function activateTask(task: SidebarTask, event?: MouseEvent) {
    sidebarStore.acknowledgeRow(task);
    // The reads start now; only the switch waits for the two frames below.
    sidebarStore.prepareOpen(task);
    // `detail` is 0 for a click from the keyboard, which leaves no pointer here.
    if (event && event.detail > 0) tooltipQuietAt = { x: event.clientX, y: event.clientY };
    // Asked for now, not after the deferred switch: the composer holds its
    // shape while the keyboard is on its way back, instead of folding for the
    // two frames the switch waits and growing again.
    requestInputFocus();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // A fast double-click can enter rename mode before the first click's
        // deferred navigation runs. Do not let that stale navigation take the
        // caret back from the rename field.
        if (renamingTabId) return;
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
    activateTask(task, event);
    // A click on the row opens the drawer of sessions it started, even one
    // the person folded while reading it.
    sidebarStore.setNestedOpen(task, true);
  }

  function selectedTasks(): SidebarTask[] {
    return openRows.filter((task) => selectedTaskIds.has(task.id));
  }

  const referenceSources: SessionReferenceSources = {
    sessionFor: (tabId) => session.sessionFor(tabId),
    serverIdFor: (tabId) => session.serverIdFor(tabId),
    listed: (sessionId) => sessionListStore.listed(sessionId),
  };

  /** A row dragged onto an input bar becomes its session's chip there. A row
   *  in the selection carries every selected session. Touch has no drag: its
   *  long press opens the menu, which has "Reference in Prompt". */
  function dragSessions(event: DragEvent, rows: readonly ReferencedRow[]) {
    // A session listed under a row is its own drag, not the row's.
    event.stopPropagation();
    const references = referencesForRows(referenceSources, rows);
    if (!event.dataTransfer || references.length === 0) {
      event.preventDefault();
      return;
    }
    writeSessionDrag(event.dataTransfer, references);
  }

  function dragRow(event: DragEvent, task: SidebarTask) {
    dragSessions(event, selectedTaskIds.has(task.id) ? selectedTasks() : [task]);
  }

  function dragChild(event: DragEvent, child: SidebarSessionChild) {
    dragSessions(event, [{ tabIds: child.tabId ? [child.tabId] : [], sessionId: child.sessionId }]);
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

  /** Archive every selected session; the session picker still finds them. */
  function bulkArchive() {
    const rows = selectedTasks();
    selectedTaskIds.clear();
    for (const row of rows) sidebarStore.removeRow(row);
    requestInputFocus();
  }

  function renameSidebarItem(
    task: SidebarTask,
    child: SidebarSessionChild | null,
    next: string,
  ) {
    cancelRename();
    const tabId = child ? child.tabId : task.tabIds[0];
    if (tabId) void sidebarStore.renameSession(tabId, next);
  }

  function selectSession(child: SidebarSessionChild) {
    void sidebarStore.selectChild(child);
    requestInputFocus();
    onSessionSelect?.();
  }

  /** Closing removes the mounted tab. The session stays in the list. */
  function closeSession(tabId: string) {
    sidebarStore.closeSidebarTab(tabId);
    requestInputFocus();
  }

  /** Completion settles the session on its host. The store's command also
   *  clears the mounted conversation, the same way the row's close control
   *  does. */
  async function completeTask(task: SidebarTask) {
    try {
      await sidebarStore.completeTask(task);
      requestInputFocus();
    } catch (error) {
      toasts.error("Couldn't complete session", {
        description: error instanceof Error ? error.message : String(error),
      });
      requestInputFocus();
    }
  }

  /** A delegated session listed under a row keeps a row of its own in the
   *  store, so its X does what that row's X does. */
  function removeChild(child: SidebarSessionChild) {
    const ownRow = child.tabId ? sidebarStore.taskForTab(child.tabId) : null;
    if (ownRow) sidebarStore.removeRow(ownRow);
    requestInputFocus();
  }

  /** Removing a session's row archives the session on every device
   *  (docs/plans/session-archive.md). */
  function removeTask(task: SidebarTask) {
    sidebarStore.removeRow(task);
    requestInputFocus();
  }

  /** Completing a session decides that its work is finished, so a session still
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

  function openSnooze(target: SnoozeTarget, anchor: TaskSnoozeAnchor, customTime = false) {
    snoozeCustomTime = customTime;
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

  /** ⌫ on a row is the row's X: it never stops the run. It archives the
   *  session; a session listed under a row only closes its tab. */
  /** → and ← on a row that started sessions unfold and fold them. */
  function setNestedOpenByKey(taskKey: string, isOpen: boolean) {
    const task = openRows.find((item) => item.key === taskKey);
    if (task) sidebarStore.setNestedOpen(task, isOpen);
  }

  function closeRowByKey(target: { taskKey?: string; tabId?: string }) {
    const task = target.taskKey ? openRows.find((item) => item.key === target.taskKey) : undefined;
    if (task) removeTask(task);
    else if (target.tabId) closeSession(target.tabId);
  }

  /** Right-click and ⋯ open the identical menu. */
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

  // The menu actions below close over plain values. A menu runs its action
  // after closeSessionContextMenu, when the template's `{@const}` values would
  // read a null menu and throw.

  /** The row actions of an open tab's menu. */
  function tabRowActions(menuTabId: string | null, menuPoint: TaskSnoozeAnchor) {
    const sessionRow = menuTabId ? sidebarStore.taskForTab(menuTabId) : null;
    return {
      onStop:
        menuTabId && sidebarStore.childForTab(menuTabId).attention === "running"
          ? () => session.controls.interruptTabSession(menuTabId)
          : undefined,
      done: sessionRow?.status === "done",
      onToggleDone: sessionRow ? () => void completeTask(sessionRow) : undefined,
      onSnooze:
        sessionRow && sessionRow.lifecycle !== "snoozed" && sidebarStore.canShelve(sessionRow)
          ? (until?: number) => {
              const target = { rowKey: sessionRow.key, title: sessionRow.title };
              if (until !== undefined) applySnooze([target], until, "");
              else openSnooze(target, menuPoint, true);
            }
          : undefined,
      onArchive:
        sessionRow && sidebarStore.canArchive(sessionRow)
          ? () => removeTask(sessionRow)
          : undefined,
    };
  }

  function listedRowActions(row: SidebarTask) {
    return { onArchive: sidebarStore.canArchive(row) ? () => removeTask(row) : undefined };
  }

  function regeneratePinnedTitle(pin: PinnedSession) {
    return () => sidebarStore.regeneratePinnedSessionTitle(pin);
  }

  function openPinnedInSplit(pin: PinnedSession) {
    return () => void openPinnedSessionInSplit(pin);
  }

  function openRowContextMenu(
    event: MouseEvent | PointerEvent,
    task: SidebarTask,
  ) {
    if (task.tabIds[0]) {
      openSessionContextMenu(event, { kind: "tab", tabId: task.tabIds[0] });
      return;
    }
    // A session with no conversation here, such as a cloud record, gets the
    // menu of its session id.
    if (task.sessionId) openListedContextMenu(event, task.sessionId, task.serverId, task);
  }

  function openListedContextMenu(
    event: MouseEvent | PointerEvent,
    sessionId: string,
    serverId: string | null,
    row: SidebarTask | null,
  ) {
    event.preventDefault();
    event.stopPropagation();
    sessionContextMenu = { kind: "listed", sessionId, serverId, row, x: event.clientX, y: event.clientY };
  }

  function openChildContextMenu(
    event: MouseEvent | PointerEvent,
    child: SidebarSessionChild,
  ) {
    if (!child.tabId && child.sessionId) {
      openListedContextMenu(event, child.sessionId, child.serverId, null);
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

{#snippet pinnedRow(pin: PinnedSession)}
  {@const openTabId = sidebarStore.openTabIdForPinned(pin)}
  <PinnedSessionRow
    {pin}
    isCurrentSession={!!openTabId && openTabId === session.onScreenTabId}
    onOpen={() => {
      void sidebarStore.openPinnedSession(pin);
      onSessionSelect?.();
    }}
    onUnpin={() => {
      void sidebarStore.unpinSession(pin);
      requestInputFocus();
    }}
    onMore={(event) => openSessionContextMenu(event, { kind: "pinned", pin })}
  />
{/snippet}

{#snippet taskRow(task: SidebarTask, inFolder: boolean)}
  {@const prChoices = sidebarStore.prChoicesFor(task)}
  <TaskRow
    {task}
    shareOwner={task.share ? (memberByKey(sharesStore.directory, task.share.ownerKey) ?? null) : null}
    prChip={prChipForChoices(prChoices)}
    {prChoices}
    onPath={sidebarStore.onScreenRowId === task.id}
    bulkSelected={selectedTaskIds.has(task.id)}
    sessions={sidebarStore.sessionsFor(task)}
    {isGuest}
    nestedSessions={sidebarStore.nestedSessionsFor(task)}
    {inFolder}
    isNestedOpen={sidebarStore.isNestedOpen(task)}
    onToggleNested={() => sidebarStore.toggleNestedSessions(task)}
    onScreenTabId={session.onScreenTabId}
    {renamingTabId}
    onSelect={(event) => selectOrActivateTask(task, event)}
    isTooltipQuiet={tooltipQuietAt !== null}
    onPressStart={() => sidebarStore.prepareOpen(task)}
    onStartRename={(child) => startRename(child ? child.tabId : task.tabIds[0])}
    onRename={(child, next) => renameSidebarItem(task, child, next)}
    onRenameCancel={cancelRename}
    onMore={(event) => openRowContextMenu(event, task)}
    canSnooze={sidebarStore.canShelve(task)}
    onSnooze={(anchor) =>
      openSnooze({ rowKey: task.key, title: task.title }, anchor)}
    onWake={() => wakeRow(task.key)}
    onComplete={() => completeTask(task)}
    onClose={() => removeTask(task)}
    onOpenPr={openTaskPr}
    onWarmPr={warmTaskPr}
    onUnlinkPr={(choice) => unlinkRowPr(task, choice)}
    onLinkPr={linkRowPr(task)}
    onSelectSession={selectSession}
    onMoreSession={openChildContextMenu}
    onDragRow={runtime.isTouchDevice ? undefined : (event) => dragRow(event, task)}
    onDragSession={runtime.isTouchDevice ? undefined : dragChild}
    onCloseSession={removeChild}
  />
{/snippet}

<SidePanel
  side="left"
  {open}
  {managedWidth}
  {staysAsColumn}
  isElevated={false}
  minWidth={SIDEBAR_MIN_WIDTH}
  maxWidth={SIDEBAR_MAX_WIDTH}
  onAction={onToggleCollapse}
  actionTooltip={`Collapse sidebar (${comboHint("global.toggle-sidebar")})`}
  actionAriaLabel="Collapse sidebar"
  background="color-mix(in oklch, var(--card) 99%, var(--foreground))"
  headerOnDark={isOnDarkSky}
>
  {#snippet backdrop()}
    {#if theme.showsSidebarSky}
      <SidebarSky scene={sky.current} />
    {/if}
  {/snippet}
  {#snippet headerLeading()}
    <SidebarBrand onDarkSky={isOnDarkSky} onclick={canStartSession ? startDraft : undefined} />
  {/snippet}
  {#snippet headerActions()}
    <HistoryNavButtons />
  {/snippet}

  <!-- The places run down the left edge; the search, the bulk bar, and the
       list fill the column beside them. -->
  <div
    class="flex min-h-0 flex-1"
    style:margin-top={theme.showsSidebarSky ? `${SKY_HEADER_DROP_REM}rem` : undefined}
  >
  <SidebarPlaces />
  <!-- Closed, the list is clipped away beside the places column. The pane
       narrows it on every frame of the slide, so it fades rather than show
       its rows squeezing, and hides once the pane has closed, so its rows
       stop painting and Tab skips them. -->
  <div
    class="flex min-w-0 flex-1 flex-col {open
      ? 'transition-opacity duration-180 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none'
      : 'invisible opacity-0 [transition:opacity_180ms_cubic-bezier(0.2,0,0,1),visibility_0s_240ms] motion-reduce:transition-none'}"
    aria-hidden={!open}
  >
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
    {#snippet sidebarActions()}
      {#if !isGuest}
        <button
          type="button"
          class="relative flex size-6 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-[background-color,color,scale] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring active:scale-[0.96] pointer-coarse:size-7 pointer-coarse:before:absolute pointer-coarse:before:left-1/2 pointer-coarse:before:top-1/2 pointer-coarse:before:size-10 pointer-coarse:before:-translate-x-1/2 pointer-coarse:before:-translate-y-1/2 pointer-coarse:before:content-['']"
          aria-label="Add project"
          title="Add project"
          onclick={() => window.dispatchEvent(new CustomEvent("solus:open-project"))}
        >
          <FolderPlusIcon class="size-4" />
        </button>
      {/if}
      {#if canStartSession}
      <button
        type="button"
        class="relative flex size-6 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-[background-color,color,scale] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring active:scale-[0.96] pointer-coarse:size-7 pointer-coarse:before:absolute pointer-coarse:before:left-1/2 pointer-coarse:before:top-1/2 pointer-coarse:before:size-10 pointer-coarse:before:-translate-x-1/2 pointer-coarse:before:-translate-y-1/2 pointer-coarse:before:content-['']"
        aria-label="New draft"
        title="New draft"
        onclick={startDraft}
      >
        <PlusIcon class="size-4" />
      </button>
      {/if}
    {/snippet}
    <TaskActionBar
      scopedProject={sidebarStore.scopedProject}
      projectChoices={sidebarStore.projectFilterChoices}
      onFilter={filterToProject}
      leading={taskSearch}
      trailing={sidebarActions}
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
          // A session that has not started cannot be snoozed and stays where it is.
          const targets = selectedTasks()
            .filter((row) => sidebarStore.canShelve(row))
            .map((row) => ({ rowKey: row.key, title: row.title }));
          if (!targets.length) return;
          snoozeCustomTime = false;
          snoozeAnchor = event.currentTarget;
          snoozeTargets = targets;
        }}>Snooze…</button
      >
      <button
        type="button"
        class="rounded-lg px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
        onclick={bulkArchive}>Archive</button
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
    <!-- One list, in the view the person chose: by status (drafts, the
         sessions, Shared with you, Working, and the shelves) or by project
         (a folder per project above the same shelves). Only that view is
         mounted, so only its grouping runs (docs/plans/sidebar-project-view.md,
         docs/plans/sidebar-motion.md). -->
    {#if theme.sidebarView === "project"}
      <SessionProjectView input={listInput} list={listShared} {isSearching} {onSessionSelect} />
    {:else}
      <SessionStatusView input={listInput} list={listShared} />
    {/if}
  </div>

  </div>
  </div>
</SidePanel>

{#if sessionContextMenu}
  {#if sessionContextMenu.kind === "tab"}
    {@const menuTabId = sessionContextMenu.tabId}
    <SessionContextMenu
      x={sessionContextMenu.x}
      y={sessionContextMenu.y}
      tabId={menuTabId}
      showSplit
      onStartRename={startRename}
      rowActions={tabRowActions(menuTabId, { x: sessionContextMenu.x, y: sessionContextMenu.y })}
      onCloseTab={closeSession}
      closeTabLabel="Close Tab"
      closeTabIsDestructive={false}
      onClose={closeSessionContextMenu}
    />
  {:else if sessionContextMenu.kind === "listed"}
    {@const listedRow = sessionContextMenu.row}
    <SessionContextMenu
      x={sessionContextMenu.x}
      y={sessionContextMenu.y}
      sessionId={sessionContextMenu.sessionId}
      serverId={sessionContextMenu.serverId}
      rowActions={listedRow ? listedRowActions(listedRow) : null}
      onClose={closeSessionContextMenu}
    />
  {:else}
    {@const pin = sessionContextMenu.pin}
    <SessionContextMenu
      x={sessionContextMenu.x}
      y={sessionContextMenu.y}
      tabId={sidebarStore.openTabIdForPinned(pin) ?? null}
      sessionId={pin.sessionId}
      serverId={pin.serverId ?? null}
      showSplit
      onRegenerateTitle={regeneratePinnedTitle(pin)}
      onOpenInSplit={openPinnedInSplit(pin)}
      onClose={closeSessionContextMenu}
    />
  {/if}
{/if}

{#if snoozeTargets.length > 0 && snoozeAnchor}
  <SnoozeTaskMenu
    customTime={snoozeCustomTime}
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
