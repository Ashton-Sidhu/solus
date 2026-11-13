<script lang="ts">
  import { isSolusApiId } from "@solus/contracts/uplink";
  import { sessionSearchNavigation } from "@solus/client-core/session-search-navigation";
  import { tick, untrack } from "svelte";
  import { fly } from "svelte/transition";
  import VirtualList from "../../ui/list-page/VirtualList.svelte";
  import { Search as MagnifyingGlassIcon, X as CloseIcon } from "@lucide/svelte";
  import { localApi } from "@solus/client-core/local-api";
  import { serverConnections } from "@solus/client-core/server-connections";
  import type { Task, TaskLink } from "@solus/contracts/task-types";
  import type { SessionMeta } from "@solus/contracts/types";
  import {
    getPullRequestsContext,
    getSessionSidebarStore,
    getWorkspaceContext,
    hosts,
    projectsStore,
    runtime,
    serversStore,
  } from "../../../contexts";
  import type { SidebarSessionChild } from "../../../contexts/workspace/session-sidebar.store.svelte";
  import { blurActiveTextInputOnMobile, requestInputFocus } from "../../../lib/inputFocus";
  import { comboHint } from "../../../lib/keybindings/manifest";
  import { useKeybinding, useScope } from "../../../lib/keybindings/use-keybinding.svelte";
  import type { AttentionState } from "../../../lib/sessionUtils";
  import { toasts } from "../../../lib/toasts";
  import { automationProjectKey } from "../../automations/lib/automation-projects";
  import { getPopoverLayer } from "../../popoverLayer.svelte";
  import { portal } from "../../portal";
  import { prProjectTargets } from "../../prs/lib/pr-cross-project";
  import { Button } from "../../ui/button";
  import { Input } from "../../ui/input";
  import PickerKeyHints from "./PickerKeyHints.svelte";
  import PickerListSkeleton from "./PickerListSkeleton.svelte";
  import PickerPreviewColumn from "./PickerPreviewColumn.svelte";
  import PickerRowMenus from "./PickerRowMenus.svelte";
  import PickerSearchOptions from "./PickerSearchOptions.svelte";
  import PickerTypeTabs from "./PickerTypeTabs.svelte";
  import UnifiedPickerRow from "./UnifiedPickerRow.svelte";
  import { ListProjectSwitcher } from "../../ui/list-page";
  import { resolvePickerScope, scopeForChoice } from "./lib/picker-scope";
  import { PickerSearches } from "./lib/conversation-search.svelte";
  import { mergeSessionHomes, type SessionHomeHosts } from "../lib/session-home";
  import type { PickerSearchMode, PickerSort } from "./lib/picker-search";
  import type { PickerFilters } from "./lib/picker-filters";
  import { pickerEmptyMessage, pickerListLoading, type PickerEmptyState } from "./lib/picker-empty";
  import {
    adjacentResultType,
    GUEST_PICKER_RESULT_TYPES,
    listsRecords,
    PICKER_RESULT_LABELS,
    PICKER_RESULT_PLACEHOLDERS,
    PICKER_RESULT_TYPES,
    typeStepOf,
    type PickerResultType,
  } from "./lib/picker-result-types";
  import type { PickerAction, PickerRecord } from "./lib/picker-records";
  import { automationRecords, entryOpenLabel, hasActionBar, workRecords } from "./lib/picker-record-view";
  import { openPickerRecord } from "./lib/picker-record-actions";
  import { hasRowMenu, rowMenuFor, type PickerRowMenu } from "./lib/picker-row-menu";
  import type { PullRequestSearchProject } from "./lib/pull-request-search.svelte";
  import {
    buildPickerRows,
    pickerCountLabel,
    pickerRowHeight,
    selectedRowIndex,
    type PickerEntry,
    type PickerRow,
  } from "./lib/picker-rows";
  import { openPickerLinkedItem } from "./lib/picker-linked-actions";
  import { pickedEvent } from "./lib/picker-pick-stats";
  import { track } from "../../../lib/analytics";
  import type { Via } from "@solus/contracts/analytics-events";

  /**
   * The search (docs/plans/unified-search.md): one box over sessions, tasks,
   * works, pull requests, automations and projects, with a tab for each type,
   * the list on the left and the preview of the row the cursor is on beside it.
   */
  interface Props {
    open: boolean;
    onClose: () => void;
    inline?: boolean;
  }

  let { open = $bindable(), onClose, inline = false }: Props = $props();

  const session = getWorkspaceContext();
  const sidebarStore = getSessionSidebarStore();
  const pullRequests = getPullRequestsContext();
  const layer = getPopoverLayer();
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
  /** The menu of a row's own actions, opened by a right click or by its key. */
  let rowMenu = $state<PickerRowMenu | null>(null);

  // A share link's guest reads only the shared session: the works, pull
  // requests, automations and projects are not theirs (host-sharing.md §10).
  const isGuest = $derived(hosts.runOn?.me.isGuest ?? false);
  const resultTypes = $derived(isGuest ? GUEST_PICKER_RESULT_TYPES : PICKER_RESULT_TYPES);
  const resultType = $derived(session.ui.pickerResultType);
  const isQueried = $derived(!!query.trim());

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
    isConnected: (serverId) => !!serverId && serverConnections.readinessFor(serverId).readiness === "ready",
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
  // The sidebar already knows every session linked to a task — links, mounted
  // tabs and their attention — so the picker asks it rather than keeping a
  // second model of the same tree.
  function sessionsFor(task: Task): SidebarSessionChild[] {
    return sidebarStore.sessionsForPickableTask(task);
  }
  // A session row's live state, so a running session reads as running in
  // every row shape. A session no task claims has no sidebar child, so the
  // sidebar answers for it by its host and id.
  function rowAttention(row: PickerRow): AttentionState {
    if (row.kind === "session") return row.session.attention;
    if (row.kind === "conversation") return sidebarStore.sessionAttention(row.meta.serverId ?? null, row.meta.sessionId);
    return null;
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

  // ── Records: works, pull requests, automations, projects ──
  // Each kind is read from its own store, in the scope, and only for a type
  // that lists it. None depends on the box, so a keystroke builds none again;
  // the pull requests alone follow the query, because the code host answers it.
  const workRecordsInScope = $derived(
    isGuest || !listsRecords(resultType, "works")
      ? []
      : workRecords(
          session.worksStore.visibleWorks.filter((work) => session.worksStore.pendingWorkDelete?.id !== work.id),
          {
            keyOf: (work) => {
              const serverId = session.worksStore.hostFor(work.id);
              return serverId && work.cwd ? projectsStore.projectKeyFor(serverId, work.cwd) : work.cwd;
            },
            optionsFor: (projectKeys) => session.projectOptionsFor(projectKeys),
          },
          {
            summaryOf: (workId) => session.worksStore.reviews.summaries.get(workId),
            awaitsMe: (workId) => !!session.worksStore.reviews.inboxItem(workId),
          },
          scopeProjectKey,
        ),
  );
  const automationRecordsInScope = $derived(
    isGuest || !listsRecords(resultType, "automations")
      ? []
      : automationRecords(
          session.automationsStore.visibleItems,
          (automation) =>
            automationProjectKey(
              automation.action.cwd,
              session.automationsStore.hostFor(automation.id),
              (serverId, path) => projectsStore.projectKeyFor(serverId, path),
            ),
          scopeProjectKey,
        ),
  );
  const projectRecords = $derived<PickerRecord[]>(
    isGuest || !listsRecords(resultType, "projects")
      ? []
      : projectOptions.map((project) => ({ type: "project", project })),
  );
  const pullRequestRecords = $derived.by((): PickerRecord[] => {
    const hostMatched = searches.pullRequests.answers(query);
    return searches.pullRequests.results.map((found) => ({ type: "pullRequest", found, hostMatched }));
  });
  const records = $derived([
    ...workRecordsInScope,
    ...pullRequestRecords,
    ...automationRecordsInScope,
    ...projectRecords,
  ]);
  /** The projects of the scope whose pull requests a connected host can read,
   *  each asked through the pull request context. A local-only project has
   *  none. The Solus API serves records, not repositories, so it is never that
   *  host. */
  function pullRequestProjects(): PullRequestSearchProject[] {
    if (isGuest) return [];
    const options = scopeProject ? [scopeProject] : scopeProjectKey ? [] : projectOptions;
    return prProjectTargets(options.filter((option) => !option.localOnly), {
      isOnlineCheckout: (serverId) => !isSolusApiId(serverId) && serversStore.readinessFor(serverId).readiness === "ready",
      apiFor: (serverId) => serverConnections.apiFor(serverId),
      ctxFor: (projectRoot) => session.ctxForDirectory(projectRoot),
    }).map((target) => ({
      serverId: target.serverId,
      projectRoot: target.projectRoot,
      label: target.label,
      query: (filter) => pullRequests.projects.get(target.api, target.serverId, target.ctx).query(filter),
    }));
  }
  const actions = $derived<PickerAction[]>(
    isGuest
      ? []
      : [
          {
            id: "new-session",
            label: "New session",
            hint: comboHint("global.new-session"),
            run: () => {
              session.drafts.openSessionDraft({ freshTask: true, via: "palette" });
              requestInputFocus();
            },
          },
        ],
  );

  const list = $derived(
    buildPickerRows({
      tasks, query, sessionsFor,
      resultType,
      sort: session.ui.pickerSort,
      conversations: conversationHits,
      conversationsRemaining: searches.sessions.remaining,
      recentSessions: recentSessionMetas,
      commentPassages: searches.comments.passages,
      records,
      actions,
      filters: session.ui.pickerFilters,
    }),
  );
  const selectedIndex = $derived(
    Math.max(0, list.entries.findIndex((entry) => entry.key === selectedKey)),
  );
  const selectedEntry = $derived<PickerEntry | null>(
    list.entries[Math.min(selectedIndex, list.entries.length - 1)] ?? null,
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

  $effect(() => {
    void query;
    void session.ui.pickerResultType;
    selectedKey = null;
    if (open) void scrollSelectionIntoView();
  });

  // The hosts are asked by the commands that change what a search names, not
  // by an effect: a search writes its own results, and an effect that read
  // them asked again on every answer. The keywords mode asks for names only.
  function searchHosts(): void {
    searches.update({
      query,
      scope: scopeProjectKey,
      resultType: session.ui.pickerResultType,
      mode: session.ui.pickerSearchMode,
      filters: session.ui.pickerFilters,
      now: Date.now(),
      pullRequestProjects: pullRequestProjects(),
    });
  }

  function setQuery(value: string): void {
    query = value;
    searchHosts();
  }

  $effect(() => {
    if (!open) {
      wasOpen = false;
      return;
    }
    if (wasOpen) return;
    wasOpen = true;
    query = "";
    selectedKey = null;
    untrack(() => {
      // A type is a choice for one visit: the search opens on every type.
      session.ui.pickerResultType = "all";
      searchHosts();
      // Every session of the scope: Recents and the Sessions type list them,
      // and a query matches their names. Read on open and on a new scope, not
      // on each keystroke.
      void searches.everySession.load(scopeProjectKey);
      if (!isGuest) {
        session.worksStore.ensureListed();
        void session.automationsStore.loadAll();
      }
    });
    void session.tasksStore.ensureLoaded();
    blurActiveTextInputOnMobile();
    tick().then(() => {
      // The cursor is not pinned to a row here: until the reader moves it, it
      // stays on the first row while the hosts' answers arrive above it.
      void scrollSelectionIntoView();
      if (!runtime.shouldSuppressFocus) searchEl?.focus();
      else pickerEl?.focus();
    });
  });

  function close(): void {
    rowMenu = null;
    scopeMenuOpen = false;
    searchOptionsOpen = false;
    open = false;
    searches.reset();
    onClose();
    requestAnimationFrame(() => blurActiveTextInputOnMobile());
  }

  // Not exclusive: the picker's own navigation keys are handled on its dialog
  // element, and the global bindings behind it stay live as they already were.
  // The scope exists so this one binding outranks the ⌥A a review surface
  // underneath the picker also claims.
  useScope("task-picker", { active: () => open });
  useKeybinding("task-picker.choose-project", () => { scopeMenuOpen = true; }, {
    enabled: () => open && projectOptions.length > 0,
  });
  useKeybinding("task-picker.search-options", () => { searchOptionsOpen = true; }, {
    enabled: () => open,
  });
  useKeybinding("task-picker.row-actions", openRowActions, {
    enabled: () => open && hasRowMenu(selectedEntry),
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
    searchHosts();
    selectedKey = null;
    void scrollSelectionIntoView();
    searchEl?.focus();
  }

  function chooseFilters(filters: PickerFilters): void {
    session.ui.pickerFilters = filters;
    searchHosts();
    selectedKey = null;
    void scrollSelectionIntoView();
    searchEl?.focus();
  }

  /** The chosen scope is held on the workspace, so it survives a close and
   *  every other mounted picker. Landing back on the composer's own project
   *  resumes following it rather than pinning it — see `scopeForChoice`. */
  function chooseProject(projectKey: string | null): void {
    session.ui.pickerScope = scopeForChoice(projectKey, currentProjectKey);
    searchHosts();
    // For every type: the reader can change the type after the scope, and must
    // not find the sessions of the scope they left.
    void searches.everySession.load(scopeProjectKey);
    scopeMenuOpen = false;
    selectedKey = null;
    void scrollSelectionIntoView();
    searchEl?.focus();
  }

  /** The type keeps the query: the same words, read against another kind.
   *  Every session of the scope was read when the search opened, and each
   *  type that lists sessions reads that one list. */
  function chooseResultType(type: PickerResultType): void {
    session.ui.pickerResultType = type;
    searchHosts();
    searchEl?.focus();
  }

  /** ⏎ on a task: open its task page. */
  function select(task: Task): void {
    session.goToTask(task.id, "click");
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

  /** Move the cursor by row identity. */
  function selectIndex(entryIndex: number, shouldScroll = false): void {
    const boundedIndex = Math.max(0, Math.min(entryIndex, list.entries.length - 1));
    const entry = list.entries[boundedIndex];
    selectedKey = entry?.key ?? null;
    if (shouldScroll) void scrollSelectionIntoView();
  }

  function openTaskPage(task: Task): void {
    const taskId = task.id;
    close();
    session.goToTask(taskId);
  }

  function resumeTask(task: Task): void {
    close();
    void session.opening.openTaskLinkedSession(task);
  }

  function openOnProvider(task: Task): void {
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

  function openContextMenu(event: MouseEvent, entry: PickerEntry): void {
    event.preventDefault();
    event.stopPropagation();
    selectIndex(entry.entryIndex);
    rowMenu = rowMenuFor(entry, event.clientX, event.clientY);
  }

  /** The row's menu from the keyboard, hung under the row the cursor is on. */
  function openRowActions(): void {
    const entry = selectedEntry;
    const rowEl = pickerEl?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
    if (!entry || !rowEl) return;
    const box = rowEl.getBoundingClientRect();
    rowMenu = rowMenuFor(entry, box.left + 24, box.bottom);
  }

  // Selection follows a pointer that *moves*, not one a row scrolls under:
  // `pointerenter` fires when the keyboard scrolls the list beneath a resting
  // mouse and would steal the selection from the key that caused it.
  function hoverEntry(event: PointerEvent, entry: PickerEntry): void {
    if (event.pointerType === "touch") return;
    if (selectedIndex !== entry.entryIndex) selectIndex(entry.entryIndex);
  }

  function recordPick(entry: PickerEntry, via: Via): void {
    const event = pickedEvent({ list, entry, query, sort: session.ui.pickerSort, via, storage: localStorage, now: Date.now() });
    if (event) track("session_search_picked", event);
  }

  function activate(entry: PickerEntry, via: Via): void {
    recordPick(entry, via);
    if (entry.kind === "record") {
      close();
      openPickerRecord(session, entry.record, via);
      return;
    }
    if (entry.kind !== "task" && entry.reason?.field === "messages" && entry.hit?.target) {
      const serverId = entry.kind === "conversation" ? entry.meta.serverId : entry.session.serverId;
      const sessionId = entry.kind === "conversation" ? entry.meta.sessionId : entry.session.sessionId;
      if (serverId && sessionId) sessionSearchNavigation.request(serverId, sessionId, { target: entry.hit.target, query });
    }
    if (entry.kind === "conversation") resumeConversation(entry.meta);
    else if (entry.kind === "session") selectSession(entry.session);
    else select(entry.task);
  }

  /** A click on a task that has sessions resumes its latest one, as its
   *  action bar says. ⏎ opens the task's page. */
  function clickEntry(entry: PickerEntry): void {
    if (entry.kind === "task" && entry.sessions[0]) {
      recordPick(entry, "click");
      selectSession(entry.sessions[0]);
      return;
    }
    activate(entry, "click");
  }

  function handleKeyDown(event: KeyboardEvent): void {
    // While a menu is up it owns the keyboard, including the Escape that
    // dismisses it — arrowing the list underneath would move the selection
    // away from the row the open surface is acting on.
    if (rowMenu || scopeMenuOpen || searchOptionsOpen) return;
    const typeStep = typeStepOf(event);
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey)) {
      event.preventDefault();
      selectIndex(selectedIndex + 1, true);
    } else if (event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey)) {
      event.preventDefault();
      selectIndex(selectedIndex - 1, true);
    } else if (typeStep) {
      event.preventDefault();
      chooseResultType(adjacentResultType(resultTypes, resultType, typeStep));
    } else if (event.key === "Enter" && !event.altKey && selectedEntry) {
      event.preventDefault();
      activate(selectedEntry, "keybinding");
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

  const counts = $derived(pickerCountLabel(list, resultType, isQueried));
  const isSearchingHosts = $derived(
    isQueried && (searches.sessions.loading || (listsRecords(resultType, "pullRequests") && searches.pullRequests.loading)),
  );
  /** A host answered while still reading its sessions for the first time. */
  const isIndexingConversations = $derived(isQueried && !searches.sessions.loading && searches.sessions.indexing);

  // The reads behind the list, for a list that is empty: placeholder rows
  // while one of them can still fill it, then the reason it is empty.
  const emptyState = $derived<PickerEmptyState>({
    type: resultType,
    query,
    scopeLabel: scopeProject?.label ?? null,
    tasksLoading: session.tasksStore.loading,
    everySession: searches.everySession,
    sessionSearch: {
      loading: searches.sessions.loading,
      hasErrors: searches.sessions.errors.length > 0,
      indexing: searches.sessions.indexing,
    },
    worksLoading: session.worksStore.listLoading,
    automationsLoading: session.automationsStore.loading,
    pullRequests: {
      loading: searches.pullRequests.loading,
      error: searches.pullRequests.error,
      projectCount: untrack(pullRequestProjects).length,
    },
  });
  const isListLoading = $derived(list.entries.length === 0 && pickerListLoading(emptyState));
  const emptyMessage = $derived(pickerEmptyMessage(emptyState));
</script>

{#snippet pickerContent()}
  <!-- The same band the command palette opens with: one 53px line, the field
       leading, the controls that act on it at the far end. -->
  <div class="flex h-[3.3125rem] shrink-0 items-center gap-3 px-5">
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
      bind:value={() => query, setQuery}
      type="text"
      placeholder={PICKER_RESULT_PLACEHOLDERS[resultType]}
      aria-label="Search"
      class="h-auto flex-1 rounded-none border-0 bg-transparent p-0 caret-(--solus-accent) shadow-none placeholder:text-(--solus-text-tertiary) focus-visible:ring-0 dark:bg-transparent"
    />
    <!-- The order, the mode and the filters, at the far end of the box they
         act on. The counts live under the list alone. -->
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
    {#if !inline}
      <Button variant="ghost" size="icon-sm" class="shrink-0 text-muted-foreground" aria-label="Close search" onclick={close}>
        <CloseIcon size={16} />
      </Button>
    {/if}
  </div>
  <!-- The types, under the box: what kind of thing the words are read against. -->
  <div class="flex shrink-0 items-center border-b border-(--solus-menu-hairline) px-4 pb-2.5">
    <PickerTypeTabs types={resultTypes} value={resultType} onChange={chooseResultType} />
  </div>

  <div class="flex min-h-0 flex-1 overflow-hidden">
    <!-- Half the card each: the list and the preview of the row it is on. -->
    <div
      class="flex w-1/2 shrink-0 flex-col overflow-hidden border-r border-(--solus-menu-hairline) px-2 pt-2"
    >
      <div class="min-h-0 flex-1 overflow-hidden" bind:clientHeight={listHeight} role="listbox" aria-label={PICKER_RESULT_LABELS[resultType]}>
        {#if isListLoading}
          <PickerListSkeleton label={isQueried ? "Searching" : `Loading ${PICKER_RESULT_LABELS[resultType].toLowerCase()}`} />
        {:else if list.entries.length === 0}
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
                attention={rowAttention(row)}
                onActivate={clickEntry}
                onHover={hoverEntry}
                onContextMenu={openContextMenu}
                onReachEnd={() => void searches.sessions.loadMore()}
              />
            {/snippet}
          </VirtualList>
        {/if}
      </div>
      <!-- The foot of the list: the keys that work on it, and at its end the
           total, or what the hosts are still doing. The hosts answer a beat
           after the title matches paint. Say so, or a list that then grows a
           section looks like it changed its mind. -->
      <div class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 px-2.5 pt-2 pb-3 text-micro text-muted-foreground">
        <PickerKeyHints
          hasRowActions={hasRowMenu(selectedEntry)}
          hasProjects={projectOptions.length > 0}
          openLabel={selectedEntry && !hasActionBar(selectedEntry) ? entryOpenLabel(selectedEntry) : ""}
        />
        {#if list.entries.length > 0}
          <span class="ml-auto shrink-0 whitespace-nowrap tabular-nums" aria-live="polite">
            {#if isSearchingHosts}
              Searching the hosts…
            {:else if isIndexingConversations}
              <!-- A machine's first index sweep: its hits are real but not all of them. -->
              Indexing sessions… Some may be missing
            {:else}
              {counts}
            {/if}
          </span>
        {/if}
      </div>
    </div>

    <PickerPreviewColumn
      entry={selectedEntry}
      loading={isListLoading}
      {query}
      {sessionsFor}
      portalTarget={layer.el}
      onActivate={(entry) => activate(entry, "click")}
      onSelectSession={selectSession}
      onSelectTask={select}
      onStartDraft={startDraft}
      onOpenTaskPage={openTaskPage}
      onOpenSource={openOnProvider}
      onOpenLink={openLinkedItem}
      onOpenExternal={openLinkedExternal}
      onUnlink={(link) => void unlinkItem(link)}
    />
  </div>
{/snippet}

{#if open}
  <PickerRowMenus
    bind:menu={rowMenu}
    {sessionsFor}
    portalTarget={layer.el}
    onStart={select}
    onResume={resumeTask}
    onOpenTask={openTaskPage}
    onOpenSource={openOnProvider}
  />
{/if}

{#if open && inline}
  <div bind:this={pickerEl} class="flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-transparent text-menu outline-none" role="dialog" aria-label="Search" tabindex="-1" onkeydown={handleKeyDown} transition:fly={{ y: 8, duration: 160 }}>
    {@render pickerContent()}
  </div>
{:else if open && layer.el}
  <div use:portal={layer.el} class="pointer-events-auto fixed inset-0 z-[200] flex items-center justify-center overflow-hidden overscroll-contain modal-backdrop motion-safe:animate-[backdrop-fade_140ms_ease-out]" role="presentation" onmousedown={handleScrimPointerDown}>
    <!-- `text-menu`, not the chrome rung, for the same reason the command
         palette holds it: this is a decision surface. -->
    <div bind:this={pickerEl} class="flex h-[70%] w-[76%] max-w-full origin-top flex-col overflow-hidden overscroll-contain rounded-3xl text-menu bg-popover text-popover-foreground shadow-[var(--solus-popover-shadow),0_0_0_0.5px_var(--hairline-strong),inset_0_0.0625rem_0_rgba(255,255,255,0.14)] outline-none motion-safe:animate-[picker-enter_180ms_cubic-bezier(0.22,1,0.36,1)_backwards]" role="dialog" aria-label="Search" tabindex="-1" onkeydown={handleKeyDown}>
      {@render pickerContent()}
    </div>
  </div>
{/if}
