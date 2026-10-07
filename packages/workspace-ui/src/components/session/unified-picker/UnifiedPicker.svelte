<script lang="ts">
  import { isSolusApiId } from "@solus/contracts/uplink";
  import { tick } from "svelte";
  import { fly } from "svelte/transition";
  import { SvelteMap, SvelteSet } from "svelte/reactivity";
  import VirtualList from "../../ui/list-page/VirtualList.svelte";
  import { Search as MagnifyingGlassIcon } from "@lucide/svelte";
  import { localApi } from "@solus/client-core/local-api";
  import { serverConnections } from "@solus/client-core/server-connections";
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
  import { useKeybinding, useScope } from "../../../lib/keybindings/use-keybinding.svelte";
  import { createSessionPreviewStore } from "../../../lib/preview.svelte";
  import { boundHitWindow } from "../../../lib/sessionPreviewMessages";
  import type { PickerEntry as PreviewSource } from "../../../lib/sessionUtils";
  import { toasts } from "../../../lib/toasts";
  import { getPopoverLayer } from "../../popoverLayer.svelte";
  import { portal } from "../../portal";
  import { Input } from "../../ui/input";
  import { relativeTime } from "../../tasks/lib/tasks-api";
  import SessionContextMenu from "../SessionContextMenu.svelte";
  import SessionPreview from "../SessionPreview.svelte";
  import TaskContextMenu from "../TaskContextMenu.svelte";
  import PickerActionBar from "./PickerActionBar.svelte";
  import PickerResultMenu from "./PickerResultMenu.svelte";
  import { PICKER_RESULT_LABELS } from "./lib/picker-preferences";
  import PickerSearchOptions from "./PickerSearchOptions.svelte";
  import TaskPreviewPane from "./TaskPreviewPane.svelte";
  import UnifiedPickerRow from "./UnifiedPickerRow.svelte";
  import { ListProjectSwitcher } from "../../ui/list-page";
  import { resolvePickerScope, scopeForChoice } from "./lib/picker-scope";
  import { PickerSearches } from "./lib/conversation-search.svelte";
  import { mergeSessionHomes, type SessionHomeHosts } from "../lib/session-home";
  import { serversStore } from "../../../contexts";
  import type { PickerSearchMode, PickerSort } from "./lib/picker-search";
  import type { PickerFilters } from "./lib/picker-filters";
  import {
    buildPickerRows,
    collapseTarget,
    conversationProjectLabel,
    conversationTitle,
    expandTarget,
    pickerRowHeight,
    previewHitTarget,
    pickerSessionActivity,
    selectedRowIndex,
    isTaskGroup,
    type PickerEntry,
  } from "./lib/picker-rows";
  import { openPickerLinkedItem } from "./lib/picker-linked-actions";
  import { ownsTask } from "../../tasks/lib/task-ownership";

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
  // What was said, not just what things are called, and every session while
  // the box is empty. The title match is instant and local; the hosts' answer
  // lands a beat later.
  const searches = new PickerSearches();
  let query = $state("");
  let selectedKey = $state<string | null>(null);
  let searchEl = $state<HTMLInputElement | null>(null);
  let pickerEl = $state<HTMLDivElement | null>(null);
  let listHeight = $state(0);
  let wasOpen = false;
  let scopeMenuOpen = $state(false);
  let searchOptionsOpen = $state(false);
  let resultMenuOpen = $state(false);

  let taskContextMenu = $state<{ task: Task; x: number; y: number } | null>(null);
  let sessionContextMenu = $state<{
    session: SidebarSessionChild;
    x: number;
    y: number;
  } | null>(null);
  /** Which tasks the reader opened. A search opens its own hits on top of
   *  these without touching them, so clearing the query restores the tree. */
  const expandedTaskIds = new SvelteSet<string>();

  // Newest work first, and the row now states the date it is sorted by, so the
  // order is readable rather than something you have to take on trust.
  const tasks = $derived(
    session.tasksStore.tasks.toSorted(
      (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
    ),
  );
  // One row per session across its homes (session-home.ts): a hit from the
  // cloud record and the same session from its connected runner are one
  // conversation, and the runner is the one that can open it.
  const sessionHomes: SessionHomeHosts = {
    isSolusApi: isSolusApiId,
    isConnected: (serverId) => !!serverId && serverConnections.statusFor(serverId) === "connected",
  };
  const conversationHits = $derived(
    mergeSessionHomes(
      searches.sessions.results.map((result) => ({
        sessionId: result.session.sessionId,
        serverId: result.session.serverId ?? null,
        result,
      })),
      sessionHomes,
    ).map((row) => row.result),
  );
  const recentSessionMetas = $derived(
    mergeSessionHomes(
      searches.everySession.sessions.map((meta) => ({ sessionId: meta.sessionId, serverId: meta.serverId ?? null, meta })),
      sessionHomes,
    ).map((row) => row.meta),
  );
  // The sidebar already knows every session a task owns — links, mounted tabs
  // and their attention — so the picker asks it rather than keeping a second
  // model of the same tree. It asks about the *task*, not about a sidebar row:
  // most pickable tasks have no row on this client, and reading their sessions
  // through one reported every such task as empty.
  function sessionsFor(task: Task): SidebarSessionChild[] {
    return sidebarStore.sessionsForPickableTask(task);
  }
  // The picker opens where the user already is. Without this it listed every
  // root task on every connected host, so ⌘P from a project's own composer
  // answered with everyone else's work. `currentProjectKey` is the same rule
  // the sidebar uses to decide what project a draft belongs to.
  const currentProjectKey = $derived(sidebarStore.currentProjectKey);
  const scopeProjectKey = $derived(resolvePickerScope(session.ui.pickerScope, currentProjectKey));
  // One row per project, built by the same rule as every other project list.
  const projectOptions = $derived(sidebarStore.pickerProjectOptions);
  const scopeProject = $derived(
    projectOptions.find((option) => option.key === scopeProjectKey) ?? null,
  );
  const list = $derived(
    buildPickerRows({
      tasks, query, sessionsFor, expandedTaskIds,
      resultType: session.ui.pickerResultType,
      projectKey: scopeProjectKey,
      projectKeyOf: (task) => session.tasksStore.projectKeyOf(task),
      sort: session.ui.pickerSort,
      openTaskIds: new Set(sidebarStore.activeTasks.flatMap((row) => row.taskId ?? [])),
      conversations: conversationHits,
      conversationsRemaining: searches.sessions.remaining,
      recentSessions: recentSessionMetas,
      commentPassages: searches.comments.passages,
      filters: session.ui.pickerFilters,
    }),
  );
  const selectedIndex = $derived(
    Math.max(0, list.entries.findIndex((entry) => entry.key === selectedKey)),
  );
  const selectedEntry = $derived<PickerEntry | null>(
    list.entries[Math.min(selectedIndex, list.entries.length - 1)] ?? null,
  );
  const selectedConversation = $derived(
    selectedEntry?.kind === "conversation" ? selectedEntry : null,
  );
  const selectedTask = $derived(
    selectedEntry && selectedEntry.kind !== "conversation" ? selectedEntry.task : null,
  );
  const selectedSession = $derived(
    selectedEntry?.kind === "session" ? selectedEntry.session : null,
  );

  // The virtual list needs every row height before paint.
  const rowSizes = $derived(list.rows.map(pickerRowHeight));
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
  /**
   * What a session row's ordinary preview reads from: its live tab when it
   * has one with messages, else its durable metadata once that has been read.
   * Null while the read is in flight — this starts it — or when it failed.
   */
  function previewSourceFor(target: SidebarSessionChild): PreviewSource | null {
    const tabId = target.tabId;
    const tabSession = tabId ? session.sessionFor(tabId) : null;
    // An empty restored tab is not proof that its durable session has no messages.
    if (tabId && tabSession?.messages.length) {
      return { kind: "open", tabId, tab: session.tabs[tabId], session: tabSession };
    }
    const key = metaKey(target);
    if (!key) return null;
    if (!sessionMetas.has(key)) {
      if (!metaReadsInFlight.has(key)) {
        metaReadsInFlight.add(key);
        void readSessionMeta(target.serverId!, target.sessionId!).then((meta) => {
          metaReadsInFlight.delete(key);
          sessionMetas.set(key, meta);
        });
      }
      return null;
    }
    const meta = sessionMetas.get(key);
    return meta ? { kind: "history", meta } : null;
  }

  $effect(() => {
    const entry = selectedEntry;
    if (!open || !entry || entry.kind === "task") {
      preview.reset();
      return;
    }
    const stillSelected = () => selectedEntry === entry;
    // The hit already carries the session's metadata, host stamped.
    const source =
      entry.kind === "conversation"
        ? ({ kind: "history", meta: entry.meta } satisfies PreviewSource)
        : previewSourceFor(entry.session);
    // A row found by its words opens on those words; the session's ends are
    // only the fallback for a passage the index has since dropped.
    const hit = previewHitTarget(entry);
    if (hit) preview.showHit(hit, source, session.ctx, stillSelected);
    else if (source) preview.show(source, session.ctx, stillSelected);
    else preview.reset();
  });

  const previewLoading = $derived.by(() => {
    const entry = selectedEntry;
    if (!entry || entry.kind === "task") return false;
    if (entry.kind === "conversation" || entry.hit) return preview.loading;
    const target = entry.session;
    const tabId = target.tabId;
    const tabSession = tabId && session.tabs[tabId] ? session.sessionFor(tabId) : null;
    if (tabId && tabSession?.messages.length) return preview.loading;
    const key = metaKey(target);
    return preview.loading || (!!key && !sessionMetas.has(key));
  });
  // Bounded against the live query, so the marks follow what is in the box.
  const previewHitWindow = $derived(
    preview.hitWindow ? boundHitWindow(preview.hitWindow, query) : null,
  );

  $effect(() => {
    void query;
    void session.ui.pickerResultType;
    selectedKey = null;
    if (open) void scrollSelectionIntoView();
  });

  // The scope, the mode and the filters are read here too, so a change to any
  // of them asks the hosts again. The keywords mode asks for names only.
  $effect(() => {
    if (!open) return;
    searches.update({
      query,
      scope: scopeProjectKey,
      resultType: session.ui.pickerResultType,
      mode: session.ui.pickerSearchMode,
      filters: session.ui.pickerFilters,
      now: Date.now(),
    });
  });

  // Read on open and on a new scope, not on each keystroke: a query lists
  // what it found instead.
  $effect(() => {
    if (open) searches.loadEverySession(scopeProjectKey, session.ui.pickerResultType);
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
    scopeMenuOpen = false;
    searchOptionsOpen = false;
    resultMenuOpen = false;
    open = false;
    preview.reset();
    searches.reset();
    sessionMetas.clear();
    onClose();
    requestAnimationFrame(() => blurActiveTextInputOnMobile());
  }

  // Not exclusive: the picker's own navigation keys are handled on its dialog
  // element, and the global bindings behind it stay live as they already were.
  // The scope exists so this one binding outranks the ⌥A a review surface
  // underneath the picker also claims.
  useScope("task-picker", { active: () => open });
  useKeybinding("task-picker.choose-project", () => (scopeMenuOpen = true), {
    enabled: () => open && projectOptions.length > 0,
  });
  useKeybinding("task-picker.result-type", () => (resultMenuOpen = true), { enabled: () => open });
  useKeybinding("task-picker.search-options", () => (searchOptionsOpen = true), {
    enabled: () => open,
  });

  /** The order and the search mode are held on the workspace, like the scope,
   *  so every mounted picker reads the same choice. Both re-run the list, so
   *  the cursor returns to the top of what is now the best row. */
  function chooseSort(sort: PickerSort): void {
    session.ui.pickerSort = sort;
    selectedKey = null;
    void scrollSelectionIntoView();
    searchEl?.focus();
  }

  function chooseSearchMode(mode: PickerSearchMode): void {
    session.ui.pickerSearchMode = mode;
    selectedKey = null;
    void scrollSelectionIntoView();
    searchEl?.focus();
  }

  function chooseFilters(filters: PickerFilters): void {
    session.ui.pickerFilters = filters;
    selectedKey = null;
    void scrollSelectionIntoView();
    searchEl?.focus();
  }

  /** The chosen scope is held on the workspace, so it survives a close and
   *  every other mounted picker. Landing back on the composer's own project
   *  resumes following it rather than pinning it — see `scopeForChoice`. */
  function chooseProject(projectKey: string | null): void {
    session.ui.pickerScope = scopeForChoice(projectKey, currentProjectKey);
    scopeMenuOpen = false;
    selectedKey = null;
    void scrollSelectionIntoView();
    searchEl?.focus();
  }

  /** ⏎ on a task: the same move as clicking its row in the sidebar. */
  function select(task: Task): void {
    window.dispatchEvent(
      new CustomEvent("solus:reveal-sidebar-task", { detail: task.id }),
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
    void session.opening.openTaskSession(task);
  }

  /** ⏎ on a conversation: resume it where it ran, task or no task. */
  function resumeConversation(meta: SessionMeta): void {
    close();
    session.opening.resumeSession(meta).catch((error) => {
      toasts.error("Couldn't resume session", {
        description: error instanceof Error ? error.message : String(error),
      });
    });
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
  // picker stays open for status and unread — they are edits to a row
  // you are still choosing between — and closes for anything that navigates.

  function openTaskPage(task: Task): void {
    const taskId = task.id;
    close();
    session.goToTask(taskId);
  }

  function resumeTask(task: Task): void {
    close();
    void session.opening.openTaskLinkedSession(task);
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

  async function deleteTask(task: Task): Promise<void> {
    // The host deletes a task for its owner alone.
    if (!(await ownsTask(session.tasksStore, task.id))) {
      toasts.error("Couldn't delete task", { description: "Only the owner can delete a task." });
      return;
    }
    const pending = sidebarStore.deleteTasks([task.id]);
    if (!pending.length) return;
    toasts.undo("Task deleted", () => session.tasksStore.restorePending(pending), {
      onDismiss: () =>
        session.tasksStore.commitPending(pending).catch((error) =>
          toasts.error("Couldn't delete task", {
            description: error instanceof Error ? error.message : String(error),
          })),
    });
  }

  function openContextMenu(event: MouseEvent, entry: PickerEntry): void {
    event.preventDefault();
    event.stopPropagation();
    selectIndex(entry.entryIndex);
    if (entry.kind === "task") {
      sessionContextMenu = null;
      taskContextMenu = { task: entry.task, x: event.clientX, y: event.clientY };
    } else if (entry.kind === "session") {
      taskContextMenu = null;
      sessionContextMenu = { session: entry.session, x: event.clientX, y: event.clientY };
    }
  }

  // Selection follows a pointer that *moves*, not one a row scrolls under:
  // `pointerenter` fires when the keyboard scrolls the list beneath a resting
  // mouse and would steal the selection from the key that caused it.
  function hoverEntry(event: PointerEvent, entry: PickerEntry): void {
    if (event.pointerType === "touch") return;
    if (selectedIndex !== entry.entryIndex) selectIndex(entry.entryIndex);
  }

  function activate(entry: PickerEntry): void {
    if (entry.kind === "conversation") resumeConversation(entry.meta);
    else if (entry.kind === "session") selectSession(entry.session);
    else select(entry.task);
  }

  function clickEntry(entry: PickerEntry): void {
    if (entry.kind === "task" && !isTaskGroup(entry) && entry.sessions[0]) {
      selectSession(entry.sessions[0]);
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
    // While a row menu is up it owns the keyboard, including the Escape that
    // dismisses it — arrowing the list underneath would move the selection
    // away from the row the open surface is acting on.
    if (taskContextMenu || sessionContextMenu || scopeMenuOpen || searchOptionsOpen || resultMenuOpen) return;
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
    } else if (event.key === " " && selectedEntry?.kind === "task" && event.target !== searchEl) {
      // Space expands the selected task only from the list. The keydown from
      // the search field bubbles up to this dialog too; claiming it there
      // would eat every space the user types into the query.
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

  const counts = $derived.by(() => {
    const sessions = `${list.sessionCount} ${list.sessionCount === 1 ? "session" : "sessions"}`;
    const base = session.ui.pickerResultType === "sessions"
      ? sessions
      : session.ui.pickerResultType === "tasks" ? `${list.taskCount} ${list.taskCount === 1 ? "task" : "tasks"}`
      : `${list.taskCount} ${list.taskCount === 1 ? "task" : "tasks"} · ${sessions}`;
    // What the scope withheld, so widening it is a known quantity.
    return scopeProject && list.hiddenTaskCount > 0
      ? `${base} · ${list.hiddenTaskCount} more in other projects`
      : base;
  });
  const isSearchingConversations = $derived(!!query.trim() && searches.sessions.loading);
  /** A host answered while still reading its sessions for the first time. */
  const isIndexingConversations = $derived(!!query.trim() && !searches.sessions.loading && searches.sessions.indexing);

  /** An empty list has to say *why* it is empty, because the project scope is
   *  the most likely reason and ⌥A is the answer. */
  const emptyMessage = $derived.by(() => {
    if (session.tasksStore.loading) return "Loading tasks…";
    if (!query.trim() && searches.everySession.loading && session.ui.pickerResultType !== "tasks") return "Loading sessions…";
    // An empty list must not claim there is nothing when a host did not answer.
    if (!query.trim() && session.ui.pickerResultType !== "tasks" && searches.everySession.error) return `Could not read sessions: ${searches.everySession.error}`;
    if (!query.trim() && session.ui.pickerResultType !== "tasks" && searches.everySession.asked === 0) return "No host to read sessions from";
    if (!query.trim() && session.ui.pickerResultType !== "tasks" && searches.everySession.asked && searches.everySession.passedOver === searches.everySession.asked) {
      return `No connected host has a checkout of ${scopeProject?.label ?? "this project"}`;
    }
    const where = scopeProject ? ` in ${scopeProject.label}` : "";
    if (isSearchingConversations) return "Searching conversations…";
    if (isIndexingConversations && session.ui.pickerResultType !== "tasks") return "Indexing sessions… Search again in a moment";
    if (session.ui.pickerResultType === "sessions") {
      return query.trim() ? `No sessions match “${query}”${where}` : `No sessions${where} yet`;
    }
    if (session.ui.pickerResultType === "tasks") {
      return query.trim() ? `No tasks match “${query}”${where}` : `No tasks${where} yet`;
    }
    if (query.trim()) return `No tasks or conversations match “${query}”${where}`;
    return `No tasks or sessions${where} yet`;
  });
</script>

{#snippet pickerContent()}
  <!-- The same band the command palette opens with: one 53px line, the field
       leading, the one control that acts on it at the far end. -->
  <div
    class="flex h-[3.3125rem] shrink-0 items-center gap-3 border-b border-(--solus-menu-hairline) px-5"
  >
    <!-- The scope leads the search the way a project crumb leads a page title:
         `<project> | search`. The same control every list page scopes with,
         in its crumb form, which opens its menu from its own left edge — the
         chip form hangs its menu to the right and the card clipped it. Hidden
         only when there is no project to offer, where it would do nothing. -->
    {#if projectOptions.length > 0}
      <!-- The crumb yields width to its neighbours, and the search field takes
           every pixel it is offered, so unboxed the label shrank to two letters.
           A box that will not shrink gives the name its full width, capped so
           a long folder name cannot push the search field off the row. -->
      <div class="max-w-56 shrink-0">
        <ListProjectSwitcher
          projects={projectOptions}
          activeKey={scopeProjectKey ?? undefined}
          emptyLabel="All projects"
          onSelect={(option) => chooseProject(option.key)}
          onSelectAll={() => chooseProject(null)}
          footerNote="Switching keeps your search"
          bind:menuOpen={scopeMenuOpen}
        />
      </div>
      <span class="h-4 w-px shrink-0 bg-[var(--hairline-strong)]" aria-hidden="true"></span>
    {/if}
    <MagnifyingGlassIcon size={14} class="shrink-0 text-(--solus-text-tertiary) opacity-65" />
    <!-- The field inherits the surface's `text-menu` rung. -->
    <Input
      bind:ref={searchEl}
      bind:value={query}
      type="text"
      placeholder={session.ui.pickerResultType === "sessions" ? "Search sessions…" : session.ui.pickerResultType === "tasks" ? "Search tasks…" : "Search work in solus…"}
      class="h-auto flex-1 rounded-none border-0 bg-transparent p-0 caret-(--solus-accent) shadow-none placeholder:text-(--solus-text-tertiary) focus-visible:ring-0 dark:bg-transparent"
    />
    <!-- The order and the mode, last on the row, at the far end of the box
         they act on. The counts live under the list alone. -->
    <PickerResultMenu
      value={session.ui.pickerResultType}
      onChange={(value) => { session.ui.pickerResultType = value; }}
      portalTarget={layer.el}
      bind:open={resultMenuOpen}
    />
    <PickerSearchOptions
      sort={session.ui.pickerSort}
      mode={session.ui.pickerSearchMode}
      filters={session.ui.pickerFilters}
      onSort={chooseSort}
      onMode={chooseSearchMode}
      onFilters={chooseFilters}
      portalTarget={layer.el}
      bind:open={searchOptionsOpen}
    />
  </div>

  <div class="flex min-h-0 flex-1 overflow-hidden">
    <!-- Half the card each: the list and the preview of the row it is on. -->
    <div
      class="flex w-1/2 shrink-0 flex-col overflow-hidden border-r border-(--solus-menu-hairline) px-2 pt-2"
    >
      <div class="min-h-0 flex-1 overflow-hidden" bind:clientHeight={listHeight} role="listbox" aria-label={PICKER_RESULT_LABELS[session.ui.pickerResultType]}>
        {#if list.entries.length === 0}
          <div class="flex h-full items-center justify-center px-5 text-center text-workspace-chrome text-muted-foreground">
            {emptyMessage}
          </div>
        {:else if listHeight > 0}
          <VirtualList
            items={list.rows}
            height={listHeight}
            itemSize={(index) => rowSizes[index]}
            keyOf={(row) => row.key}
            activeKey={scrollTargetIndex === undefined ? null : (list.rows[scrollTargetIndex]?.key ?? null)}
            showScrollbar
          >
            {#snippet children(row, _index, style)}
              <UnifiedPickerRow
                {row}
                {style}
                {selectedIndex}
                {query}
                onActivate={clickEntry}
                onHover={hoverEntry}
                onToggle={toggleTask}
                onContextMenu={openContextMenu}
                onReachEnd={() => void searches.sessions.loadMore()}
              />
            {/snippet}
          </VirtualList>
        {/if}
      </div>
      <!-- The hosts answer a beat after the title matches paint. Say so, or a
           list that then grows a section looks like it changed its mind. -->
      {#if isSearchingConversations && list.entries.length > 0}
        <div class="shrink-0 px-2.5 py-1.5 text-micro text-muted-foreground" aria-live="polite">
          Searching conversations…
        </div>
      {:else if isIndexingConversations && list.entries.length > 0}
        <!-- A machine's first index sweep: its hits are real but not all of them. -->
        <div class="shrink-0 px-2.5 py-1.5 text-micro text-muted-foreground" aria-live="polite">
          Indexing sessions… Some conversations may be missing
        </div>
      {:else if list.entries.length > 0}
        <!-- The total sits under the list it counts, in the same line the
             search notices use while they have something to say. -->
        <div class="shrink-0 px-2.5 py-1.5 text-micro text-muted-foreground tabular-nums">
          {counts}
        </div>
      {/if}
    </div>

    <!-- The preview scrolls; the action bar under it does not, so what you can
         do to the row is always one reach away however long its body runs. -->
    <div class="flex min-w-0 flex-1 flex-col">
      <div class="min-h-0 flex-1 overflow-hidden">
        {#if selectedConversation}
          {@const conversation = selectedConversation}
          <SessionPreview
            preview={preview.snapshot}
            hitWindow={previewHitWindow}
            additionalMatches={selectedEntry?.kind !== "task" ? selectedEntry?.additionalMatches : []}
            loading={previewLoading}
            title={conversationTitle(conversation.meta)}
            byline={conversationProjectLabel(conversation.meta)}
            timeAgo={relativeTime(pickerSessionActivity(conversation))}
            {query}
          />
        {:else if selectedEntry?.kind === "session" && selectedTask}
          {@const picked = selectedEntry}
          <!-- Dated by the hit when there is one, as the row is. -->
          <SessionPreview
            preview={preview.snapshot}
            hitWindow={previewHitWindow}
            additionalMatches={selectedEntry?.kind !== "task" ? selectedEntry?.additionalMatches : []}
            loading={previewLoading}
            title={picked.session.label}
            byline={selectedTask.title}
            timeAgo={relativeTime(pickerSessionActivity(picked))}
            attention={picked.session.attention}
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
              {query}
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
    onMarkUnread={() => void sidebarStore.markTaskUnread(menuTask.id)}
    onDelete={menuTask.providerId === "local" ? () => void deleteTask(menuTask) : undefined}
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
        ? () => session.controls.interruptTabSession(menuSession.tabId!)
        : undefined,
    }}
    portalTarget={layer.el}
    onClose={() => (sessionContextMenu = null)}
  />
{/if}

{#if open && inline}
  <div bind:this={pickerEl} class="flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-transparent text-menu outline-none" role="dialog" aria-label="Task picker" tabindex="-1" onkeydown={handleKeyDown} transition:fly={{ y: 8, duration: 160 }}>
    {@render pickerContent()}
  </div>
{:else if open && layer.el}
  <div use:portal={layer.el} class="pointer-events-auto fixed inset-0 z-[200] flex items-center justify-center overflow-hidden overscroll-contain picker-backdrop motion-safe:animate-[backdrop-fade_140ms_ease-out]" role="presentation" onmousedown={handleScrimPointerDown}>
    <!-- `text-menu`, not the chrome rung, for the same reason the command
         palette holds it: this is a decision surface. -->
    <div bind:this={pickerEl} class="flex h-[70%] w-[76%] max-w-full origin-top flex-col overflow-hidden overscroll-contain rounded-3xl text-menu bg-popover text-popover-foreground shadow-[var(--solus-popover-shadow),0_0_0_0.5px_var(--hairline-strong),inset_0_0.0625rem_0_rgba(255,255,255,0.14)] outline-none motion-safe:animate-[picker-enter_180ms_cubic-bezier(0.22,1,0.36,1)_backwards]" role="dialog" aria-label="Task picker" tabindex="-1" onkeydown={handleKeyDown}>
      {@render pickerContent()}
    </div>
  </div>
{/if}
