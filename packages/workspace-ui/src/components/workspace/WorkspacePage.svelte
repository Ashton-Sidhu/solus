<script lang="ts">
  import { serverConnections } from "@solus/client-core/server-connections";
  import { tick, untrack } from "svelte";
  import {
    LibraryBig as BooksIcon,
    ChevronDown as CaretDownIcon,
    ChevronRight as CaretRightIcon,
    FileText as FileTextIcon,
    Network as ArchitectureIcon,
    Search as MagnifyingGlassIcon,
    Plus as PlusIcon,
    Pin as PushPinIcon,
    PanelLeft as SidebarSimpleIcon,
    SlidersHorizontal as SlidersIcon,
    Upload as UploadSimpleIcon,
    Link2 as LinkIcon,
  } from "@lucide/svelte";
  import type { PlanDescriptor, Work } from "@solus/contracts/types";
  import {
    getWorkspaceContext,
    getPlanStore,
    getWindowContext,
    runtime,
    projectCatalog,
    mergeProjectOptions,
    projectRefKey,
    serversStore,
    type ProjectRef,
  } from "../../contexts";
  import { blurActiveTextInputOnMobile } from "../../lib/inputFocus";
  import { projectDirLabel } from "../../lib/paths";
  import { liveSessionTitle } from "../../lib/sessionUtils";
  import { SessionUnavailableError } from "../../contexts/workspace/session-errors";
  import {
    useKeybinding,
    useScope,
  } from "../../lib/keybindings/use-keybinding.svelte";
  import { PAGE_PRIMARY_BTN, PAGE_SECONDARY_BTN } from "../../lib/page-chrome";
  import {
    ListProjectSwitcher,
    PageCrumbLine,
    syncStamp,
    FILTER_CHIP,
    FILTER_CHIP_COUNT,
    FILTER_CHIP_OFF,
    FILTER_CHIP_ON,
    FILTER_SORT_CHIP,
    type ListIcon,
    type ListProjectOption,
  } from "../ui/list-page";
  import { BottomSheet } from "../ui/bottom-sheet";
  import { frameChrome } from "../layout/frame-chrome.store.svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import PageEmpty from "../ui/PageEmpty.svelte";
  import SortMenu from "../ui/SortMenu.svelte";
  import WorkspaceRow from "./WorkspaceRow.svelte";
  import WorkspaceItemContextMenu from "./WorkspaceItemContextMenu.svelte";
  import WorkspacePeek from "./WorkspacePeek.svelte";
  import ImportDocDialog from "../work/ImportDocDialog.svelte";
  import { docProviderLabel } from "../work/lib/work-publish";
  import type { DocProviderId, DocProviderStatus } from "@solus/contracts/docs";
  import WorkspaceSearchField from "./WorkspaceSearchField.svelte";
  import { PeekHover } from "./lib/peek-hover.svelte";
  import { isStackedPane, observePaneWidth } from "../../lib/pane-width";
  import { SessionLabels } from "./lib/session-labels.svelte";
  import type {
    SortOrder,
    StatusFilter,
    TimeFilter,
    TypeFilter,
    WorkspaceFilter,
    WorkspaceItem,
  } from "./lib/workspace-items";
  import {
    DEFAULT_FILTER,
    applyFilter,
    bucketFor,
    buildWorkspaceItems,
    groupItems,
    isDefaultFilter,
    projectsForWorkspaceScope,
    sortItems,
  } from "./lib/workspace-items";

  const session = getWorkspaceContext();
  const planStore = getPlanStore();
  const windowCtx = getWindowContext();

  const PINNED_PREVIEW = 6;
  const RENDER_PAGE = 80;
  const PINNED_COLLAPSED_KEY = "solus.workspace.pinned-collapsed";

  const isEditorMode = $derived(
    windowCtx.viewMode === "editor" || windowCtx.isWeb,
  );
  const open = $derived(session.router.at("folio"));

  // ── Data ──
  const descriptorsKey = planStore.descriptorCacheKey(undefined, true);
  const descriptors: PlanDescriptor[] = $derived(
    planStore.cachedDescriptorKey === descriptorsKey
      ? planStore.cachedDescriptors
      : [],
  );
  const worksList: Work[] = $derived(
    Object.values(session.worksStore.works).filter(
      (w) => session.worksStore.pendingWorkDelete?.id !== w.id,
    ),
  );
  // ── Project scope. The workspace captures the visible surface before this
  //    page replaces it, then this page owns the shared page scope. ──
  const projectScope = $derived<ProjectRef | null>(
    session.projectPageScope.kind === "project"
      ? session.projectPageScope.project
      : null,
  );
  // The project catalog is the page's durable project source. Open tabs are not:
  // closing or focusing a session must not alter this page while it is open.
  const projectOptions = $derived(
    mergeProjectOptions(
      [projectCatalog.entries],
      (serverId) => serversStore.statusFor(serverId) !== "offline",
      (serverId) => serversStore.hostFor(serverId)?.label ?? serverId,
    ).map<ListProjectOption>((option) => ({
      key: option.key,
      projectKey: option.projectRoot,
      serverId: option.serverId,
      label: option.label,
      available: option.available,
      historyOnly: true,
    })),
  );
  const scopedProject = $derived.by(() => {
    if (!projectScope) return null;
    const catalogMatch = projectOptions.find(
      (option) => option.key === projectRefKey(projectScope),
    );
    return {
      key: projectScope.projectRoot,
      label:
        catalogMatch?.label ??
        projectDirLabel(projectScope.projectRoot, session.staticInfo?.workspacePath),
    };
  });
  const catalogProjects = $derived(
    projectOptions.map((option) => ({
      key: option.projectKey,
      label: option.label,
      roots: [option.projectKey],
    })),
  );
  const workspaceProjects = $derived(
    projectsForWorkspaceScope(catalogProjects, scopedProject),
  );
  const allItems: WorkspaceItem[] = $derived(
    buildWorkspaceItems(descriptors, worksList, workspaceProjects),
  );
  // Plans are the slow half of the ledger (each split plan is read off disk), so
  // works can land long before them. Track each source: an empty ledger gets the
  // skeleton, a populated one still says which half is catching up.
  const plansLoading = $derived(planStore.isDescriptorLoading(descriptorsKey));
  const worksLoading = $derived(session.worksStore.listLoading);
  const anyLoading = $derived(plansLoading || worksLoading);
  const loading = $derived(allItems.length === 0 && anyLoading);
  const backgroundLoading = $derived(!loading && anyLoading);
  // Plans are read off disk one split file at a time, so they routinely land
  // long after the works do. The head's refresh chip says "syncing…" for the
  // whole of it, and the ledger's own tail placeholders say which rows are
  // still coming — neither needs to name the slow half in the head.
  const synced = syncStamp(() => anyLoading);
  const items: WorkspaceItem[] = $derived(
    scopedProject
      ? allItems.filter((item) => item.projectKey === scopedProject.key)
      : allItems,
  );
  // The switcher and page scope keep the same host-qualified identity. Artifact
  // rows still carry a path because that is what persisted plans and works own.
  const activeProjectOptionKey = $derived(
    projectScope ? projectRefKey(projectScope) : null,
  );
  /** A row names its project only when the ledger spans more than one. */
  const showProject = $derived(!scopedProject && workspaceProjects.length > 1);
  const scopeLabel = $derived(scopedProject?.label ?? "all projects");

  function selectProject(option: ListProjectOption | null) {
    session.setProjectPageScope(
      option
        ? {
            kind: "project",
            project: { serverId: option.serverId, projectRoot: option.projectKey },
          }
        : { kind: "all" },
    );
    // Switching keeps the facets — they partition any project — and clears the
    // search, which was written against the project being left.
    filter.text = "";
    resetLedgerSelection();
  }

  function removeProjectHistory(option: { serverId: string; projectKey: string }) {
    projectCatalog.remove({
      serverId: option.serverId,
      projectRoot: option.projectKey,
    });
  }

  async function refreshCatalogFromRecents(serverId: string) {
    const recentProjects = await serversStore.recentProjectsFor(serverId);
    for (const project of recentProjects) {
      projectCatalog.record(
        { serverId, projectRoot: project.path },
        project.folderName,
      );
    }
  }

  function refreshRecentProjects() {
    for (const host of serversStore.servers) {
      void refreshCatalogFromRecents(host.id);
    }
  }

  function load() {
    const ipcCtx = untrack(() => session.ctx);
    void planStore.getDescriptors(undefined, true, ipcCtx).catch(() => {});
    void session.worksStore.loadAll(projectScope?.projectRoot ?? "~");
  }

  // ── Filter + view state ──
  const filter = $state<WorkspaceFilter>({ ...DEFAULT_FILTER });
  let sort = $state<SortOrder>("recent");
  let pinnedCollapsed = $state(
    localStorage.getItem(PINNED_COLLAPSED_KEY) === "true",
  );
  let pinnedExpanded = $state(false);
  let selectedIndex = $state(0);
  let renderLimit = $state(RENDER_PAGE);
  let searchEl: HTMLInputElement | null = $state(null);
  let scrollEl: HTMLDivElement | null = $state(null);
  let itemContextMenu = $state<{
    item: WorkspaceItem;
    x: number;
    y: number;
  } | null>(null);

  /** The hover peek — the ledger's only preview. It is deliberately not the
   *  selection: peeking must never lose your place in a 400-row ledger. */
  const peek = new PeekHover();

  // ── The stacked rung ──
  // The rows reflow into records in CSS, but two decisions here are not
  // expressible as a container query: whether a tap previews or opens, and
  // which shell the peek takes — the peek is portalled to the body, so no
  // container query reaches it. Both read the page's own box, at the same
  // 30rem the stylesheet uses, so the layout and the behaviour cannot disagree.
  let rootEl = $state<HTMLDivElement | null>(null);
  let paneWidth = $state(0);
  $effect(() => {
    if (!rootEl) return;
    return observePaneWidth(rootEl, (width) => (paneWidth = width));
  });
  const stacked = $derived(isStackedPane(paneWidth));
  /** The record's filter sheet — time, status, the saved views and sort, which
   *  the chip row has no width for. */
  let filterSheetOpen = $state(false);
  /** Names for the sessions the rows link back to. */
  const sessionLabels = new SessionLabels();

  const searching = $derived(!isDefaultFilter(filter));

  function togglePinnedCollapsed() {
    pinnedCollapsed = !pinnedCollapsed;
    localStorage.setItem(PINNED_COLLAPSED_KEY, String(pinnedCollapsed));
  }

  function clearFilters() {
    filter.type = "all";
    filter.status = "any";
    filter.pinnedOnly = false;
    filter.time = "all";
    filter.text = "";
  }

  function resetLedgerSelection() {
    selectedIndex = 0;
    renderLimit = RENDER_PAGE;
    pinnedExpanded = false;
  }

  $effect(() => {
    if (!open) return;
    // The shell captured the visible project before this route replaced it.
    // Changes to hidden tabs and sessions after this point cannot retarget it.
    untrack(() => {
      if (projectScope) {
        projectCatalog.record(
          projectScope,
          projectDirLabel(projectScope.projectRoot, session.staticInfo?.workspacePath),
        );
      }
      refreshRecentProjects();
      clearFilters();
      resetLedgerSelection();
      peek.close();
      load();
      blurActiveTextInputOnMobile();
      if (!runtime.shouldSuppressFocus) {
        tick().then(() => searchEl?.focus());
      }
    });
  });

  let observedProjectScopeKey = "";
  $effect(() => {
    if (!open) return;
    const nextKey = projectScope ? projectRefKey(projectScope) : "all";
    if (!observedProjectScopeKey) {
      observedProjectScopeKey = nextKey;
      return;
    }
    if (observedProjectScopeKey === nextKey) return;
    observedProjectScopeKey = nextKey;
    filter.text = "";
    resetLedgerSelection();
    load();
    void tick().then(() => searchEl?.focus());
  });

  $effect(() =>
    serverConnections.onPhaseChange((serverId, phase) => {
      if (phase !== "connected" || !open) return;
      void refreshCatalogFromRecents(serverId);
      const ipcCtx = session.ctx;
      void planStore.refreshAllDescriptors(ipcCtx).catch(() => {});
      void session.worksStore.loadAll(projectScope?.projectRoot ?? "~");
    }),
  );

  // ── Derived ledger ──
  const filtered: WorkspaceItem[] = $derived(
    sortItems(applyFilter(items, filter), sort),
  );
  const grouped = $derived(groupItems(filtered));
  const pinnedShown: WorkspaceItem[] = $derived(
    pinnedCollapsed
      ? []
      : pinnedExpanded
        ? grouped.pinned
        : grouped.pinned.slice(0, PINNED_PREVIEW),
  );
  const pinnedOverflow = $derived(
    pinnedCollapsed ? 0 : Math.max(0, grouped.pinned.length - PINNED_PREVIEW),
  );
  const renderedGroups = $derived.by(() => {
    let budget = renderLimit;
    const out: {
      key: string;
      label: string;
      total: number;
      items: WorkspaceItem[];
    }[] = [];
    for (const group of grouped.groups) {
      if (budget <= 0) break;
      const slice = group.items.slice(0, budget);
      budget -= slice.length;
      out.push({
        key: group.key,
        label: group.label,
        total: group.items.length,
        items: slice,
      });
    }
    return out;
  });
  /** What the keyboard walks — exactly the rendered rows, in visual order. */
  const flat: WorkspaceItem[] = $derived([
    ...pinnedShown,
    ...renderedGroups.flatMap((g) => g.items),
  ]);
  const hasMoreRows = $derived(
    renderedGroups.reduce((n, g) => n + g.items.length, 0) <
      grouped.groups.reduce((n, g) => n + g.items.length, 0),
  );
  const selectedItem: WorkspaceItem | null = $derived(
    flat[selectedIndex] ?? null,
  );

  // ── Facet counts: each axis counted with its own facet released, so the
  //    numbers stay live against the rest of the filter. ──
  const typeCounts = $derived.by(() => {
    const base = applyFilter(items, { ...filter, type: "all" });
    const c = { all: base.length, plan: 0, doc: 0, diagram: 0 };
    for (const item of base) c[item.type]++;
    return c;
  });
  const timeCounts = $derived.by(() => {
    const base = applyFilter(items, { ...filter, time: "all" });
    const c = { today: 0, yesterday: 0, week: 0, older: 0 };
    const now = new Date();
    for (const item of base) {
      const key = bucketFor(item.timestamp, now).key;
      if (key === "today" || key === "yesterday" || key === "week") c[key]++;
      else c.older++;
    }
    return c;
  });
  const pinnedCount = $derived(
    applyFilter(items, { ...filter, pinnedOnly: false }).filter((i) => i.pinned)
      .length,
  );
  const needsReviewCount = $derived(
    applyFilter(items, { ...filter, status: "any", type: "all" }).filter(
      (i) => i.status === "pending",
    ).length,
  );
  /** Matches that exist outside the active facets (same text, no facets). */
  const outsideCount = $derived(
    applyFilter(items, { ...DEFAULT_FILTER, text: filter.text }).length,
  );

  const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
    { value: "any", label: "Any status" },
    { value: "pending", label: "Pending" },
    { value: "accepted", label: "Accepted" },
    { value: "rejected", label: "Rejected" },
  ];

  const SORT_OPTIONS: { value: SortOrder; label: string }[] = [
    { value: "recent", label: "Recent" },
    { value: "oldest", label: "Oldest" },
  ];

  /** Type and Time were the rail's two axes. They partition the whole set, so
   *  each is one menu carrying its own live counts — the same filter state the
   *  `type:` / `time:` search tokens write. */
  const TYPE_OPTIONS = $derived<{ value: TypeFilter; label: string; count: number }[]>([
    { value: "all", label: "Everything", count: typeCounts.all },
    { value: "plan", label: "Plans", count: typeCounts.plan },
    { value: "doc", label: "Docs", count: typeCounts.doc },
    { value: "diagram", label: "Diagrams", count: typeCounts.diagram },
  ]);

  const TIME_OPTIONS = $derived<{ value: TimeFilter; label: string; count?: number }[]>([
    { value: "all", label: "Any time" },
    { value: "today", label: "Today", count: timeCounts.today },
    { value: "yesterday", label: "Yesterday", count: timeCounts.yesterday },
    { value: "week", label: "This week", count: timeCounts.week },
    { value: "older", label: "Older", count: timeCounts.older },
  ]);

  const needsReviewActive = $derived(filter.status === "pending");

  /** Whether anything the record's chip row cannot show is narrowing the ledger.
   *  Without it the Filters chip would look inert while a status the reader
   *  cannot see is hiding rows. */
  const narrowedBeyondType = $derived(
    filter.status !== DEFAULT_FILTER.status ||
      filter.time !== DEFAULT_FILTER.time ||
      filter.pinnedOnly !== DEFAULT_FILTER.pinnedOnly ||
      sort !== "recent",
  );

  /** The rail's two saved views, now toggle chips. "Needs review" is pending
   *  plans — the only type that has a status — so it narrows both axes. */
  function toggleNeedsReview() {
    if (needsReviewActive) {
      filter.status = "any";
    } else {
      filter.status = "pending";
      filter.type = "plan";
    }
  }

  // ── Selection bookkeeping ──
  $effect(() => {
    void filter.type;
    void filter.status;
    void filter.pinnedOnly;
    void filter.time;
    void filter.text;
    void sort;
    // Project changes reset explicitly in `selectProject`. The implicit scope
    // can be reconstructed as sessions hydrate, which must not move selection.
    resetLedgerSelection();
  });

  $effect(() => {
    if (selectedIndex >= flat.length && flat.length > 0) selectedIndex = 0;
  });

  $effect(() => {
    if (!open) return;
    void selectedIndex;
    void flat.length;
    void tick().then(() => {
      const el = scrollEl?.querySelector<HTMLElement>('[data-selected="true"]');
      el?.scrollIntoView({ block: "nearest" });
    });
  });

  // Only the rows that are actually rendered are looked up — the ledger pages
  // in 80 at a time, so scrolling resolves the next batch rather than the whole
  // history up front.
  /** The host that owns an artifact's origin session: the plan descriptor's
   *  stamp (or the plan store's side map), or the work's owner host. */
  function originServerId(item: WorkspaceItem): string | null {
    return item.source.kind === "plan"
      ? (item.source.descriptor.serverId ?? planStore.hostFor(item.id))
      : session.worksStore.hostFor(item.source.work.id);
  }

  $effect(() => {
    sessionLabels.ensure(
      flat.map((item) => ({
        sessionId: item.sessionId,
        serverId: originServerId(item),
      })),
    );
  });

  /** What to call the session an artifact came from. A session open in a tab
   *  knows its own name; the index answers for everything else. */
  function originLabel(item: WorkspaceItem): string | null {
    if (!item.sessionId) return null;
    return (
      liveSessionTitle(item.sessionId, originServerId(item), session) ??
      sessionLabels.get(item.sessionId)
    );
  }

  /** The row the keyboard cursor is on — what the peek anchors to when it is
   *  opened or moved from the keyboard. */
  function selectedRowEl(): HTMLElement | null {
    return scrollEl?.querySelector<HTMLElement>('[data-selected="true"]') ?? null;
  }

  // An open peek follows the cursor: the same card, new contents, no delay and
  // no second animation.
  $effect(() => {
    void selectedIndex;
    if (!untrack(() => peek.open)) return;
    void tick().then(() => {
      const item = untrack(() => selectedItem);
      if (item) peek.follow(item, selectedRowEl());
    });
  });

  // Scroll, click, or any keypress dismisses the card immediately — except the
  // keys that drive it: ⇧ pins it, and the arrows swap its contents.
  $effect(() => {
    if (!peek.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Shift") {
        peek.pin();
        return;
      }
      if (["ArrowDown", "ArrowUp", " ", "Escape"].includes(e.key)) return;
      peek.close();
    };
    const onPointer = () => peek.close();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onPointer, true);
    };
  });

  function handleLedgerScroll() {
    peek.close();
    const el = scrollEl;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 400) {
      const total = grouped.groups.reduce((n, g) => n + g.items.length, 0);
      if (renderLimit < total) renderLimit += RENDER_PAGE;
    }
  }

  // ── Keyboard ──
  useScope("workspace", { active: () => open });

  // Escape closes the peek before it closes the page — dismissing what is on
  // top is what Escape means here.
  useKeybinding(
    "workspace.close",
    () => {
      if (peek.open) peek.close();
      else close();
    },
    { enabled: () => open },
  );
  useKeybinding(
    "workspace.peek",
    () => {
      const row = selectedRowEl();
      if (selectedItem && row) peek.toggle(selectedItem, row);
    },
    { enabled: () => open && flat.length > 0 },
  );
  useKeybinding("workspace.focus-search", () => searchEl?.focus(), {
    enabled: () => open && document.activeElement !== searchEl,
  });
  useKeybinding(
    "workspace.open",
    () => {
      if (selectedItem) void openItem(selectedItem);
    },
    { enabled: () => open && flat.length > 0 },
  );
  useKeybinding(
    "workspace.resume",
    () => {
      if (selectedItem) void resumeItem(selectedItem);
    },
    { enabled: () => open && flat.length > 0 },
  );
  useKeybinding(
    "workspace.next",
    () => {
      selectedIndex = Math.min(selectedIndex + 1, flat.length - 1);
    },
    { enabled: () => open && flat.length > 0 },
  );
  useKeybinding(
    "workspace.prev",
    () => {
      selectedIndex = Math.max(selectedIndex - 1, 0);
    },
    { enabled: () => open && flat.length > 0 },
  );
  useKeybinding(
    "workspace.toggle-pin",
    () => {
      if (selectedItem) togglePin(selectedItem);
    },
    { enabled: () => open && flat.length > 0 },
  );

  // ── Actions ──
  function close() {
    session.router.close("folio");
  }

  async function openItem(item: WorkspaceItem) {
    if (item.source.kind === "plan")
      await session.openPlanFromDescriptor(item.source.descriptor);
    else await session.openWorkModal(item.id);
  }

  async function openItemInSplit(item: WorkspaceItem) {
    if (item.source.kind !== "work") return;
    await session.openWorkModal(item.id, undefined, { secondary: true });
  }

  async function resumeItem(item: WorkspaceItem) {
    if (item.source.kind === "plan") {
      await session.resumeSessionFromDescriptor(item.source.descriptor);
      return;
    }
    const work = item.source.work;
    if (work.sessionIds?.length || work.sessionId) {
      await session.openChatForWork(item.id, "resume");
    }
  }

  /** The origin session beside the ledger rather than in place of it. Resuming
   *  in the background hands back the tab without stealing the pane, so the
   *  Workspace stays put and the conversation opens as its companion. */
  async function openSessionInSplit(item: WorkspaceItem) {
    if (!item.sessionId) return;
    const descriptor = item.source.kind === "plan" ? item.source.descriptor : null;
    const work = item.source.kind === "work" ? item.source.work : null;
    if (descriptor?.sessionAvailable === false) {
      session.notifySessionUnavailable(descriptor.provider);
      return;
    }
    let tabId: string;
    try {
      tabId = await session.resumeSession(
        {
          serverId: descriptor?.serverId ?? (work ? session.worksStore.hostFor(work.id) ?? undefined : undefined),
          provider: descriptor?.provider ?? work?.agentProvider ?? session.settings.activeAgent,
          sessionId: item.sessionId,
          slug: null,
          firstMessage: item.title,
          lastTimestamp: new Date(item.timestamp).toISOString(),
          size: 0,
          cwd: item.cwd,
          projectPath: descriptor?.projectPath ?? "",
        },
        { background: true },
      );
    } catch (error) {
      if (!(error instanceof SessionUnavailableError)) throw error;
      session.notifySessionUnavailable(descriptor?.provider);
      return;
    }
    const resumed = tabId ? session.sessionFor(tabId) : undefined;
    if (resumed) session.openSplitChat(resumed.id);
  }

  function togglePin(item: WorkspaceItem) {
    if (item.source.kind === "work") {
      void session.worksStore.setPinned(item.id, !item.pinned);
      return;
    }
    const d = item.source.descriptor;
    void planStore.toggleBookmarkDescriptor(d);
  }

  /** Works only — a plan is a session artifact and has no delete. */
  function deleteItem(item: WorkspaceItem) {
    if (item.source.kind !== "work") return;
    session.requestWorkDelete(item.source.work);
    void tick().then(() => searchEl?.focus());
  }

  function openItemContextMenu(event: MouseEvent, item: WorkspaceItem) {
    event.preventDefault();
    event.stopPropagation();
    peek.close();
    const index = flat.indexOf(item);
    if (index >= 0) selectedIndex = index;
    itemContextMenu = { item, x: event.clientX, y: event.clientY };
  }

  function createNew(type: "doc" | "diagram") {
    void session.createBlankWork(type);
  }

  let importInput: HTMLInputElement | null = $state(null);
  /** Paste-a-link import of a Confluence page or Google Doc. */
  let importDocOpen = $state(false);
  /** The provider the user picked in "Import from", or undefined when the
   *  dialog was opened without naming one. */
  let importDocProvider = $state<DocProviderId | undefined>(undefined);
  let newMenuOpen = $state(false);
  let docProviders = $state<DocProviderStatus[]>([]);
  let docProvidersLoading = $state(false);

  // Which providers exist is a host fact the user can change in Settings while
  // this page stays mounted, so it is re-read each time the menu opens.
  $effect(() => {
    if (!newMenuOpen) return;
    docProvidersLoading = true;
    void session.worksStore
      .loadDocProviders()
      .then((statuses) => (docProviders = statuses))
      .finally(() => (docProvidersLoading = false));
  });

  function openImportDialog(provider: DocProviderId) {
    importDocProvider = provider;
    importDocOpen = true;
  }

  /** A provider the user could sign in to is a route, not a dead end. */
  function openProviderSettings() {
    newMenuOpen = false;
    session.showSettings("providers");
  }

  async function onImportFile(e: Event) {
    if (!(e.target instanceof HTMLInputElement)) return;
    const input = e.target;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    const text = await file.text();
    const title =
      file.name.replace(/\.(md|markdown|txt)$/i, "") || "Imported document";
    await session.createWorkFromContent(title, "doc", text);
  }
</script>

<!-- The saved views, in the list pages' toggle-chip skin: brand fill while on,
     and the count only while off — once it is on, the number is the ledger. -->
{#snippet toggleChip(
  label: string,
  count: number,
  active: boolean,
  onclick: () => void,
  Icon: ListIcon,
)}
  <button
    type="button"
    class="{FILTER_CHIP} [.is-laptop-display_&]:h-6.5 {active
      ? FILTER_CHIP_ON
      : `${FILTER_CHIP_OFF} hover:bg-[var(--wash-2)] hover:text-foreground`}"
    {onclick}
    aria-pressed={active}
  >
    <Icon size={11} class="shrink-0 opacity-75" />
    {label}
    {#if !active}
      <span class={FILTER_CHIP_COUNT}>{count}</span>
    {/if}
  </button>
{/snippet}

{#snippet ledgerRow(item: WorkspaceItem, index: number)}
  <WorkspaceRow
    {item}
    selected={index === selectedIndex}
    {showProject}
    query={filter.text}
    onOpen={() => (stacked ? peek.raise(item) : openItem(item))}
    onTogglePin={() => togglePin(item)}
    onDelete={item.source.kind === "work" ? () => deleteItem(item) : undefined}
    sessionLabel={originLabel(item)}
    onOpenSession={item.sessionId ? () => resumeItem(item) : undefined}
    onOpenSessionSplit={item.sessionId ? () => openSessionInSplit(item) : undefined}
    onPeek={(row) => peek.enter(item, row)}
    onPeekLeave={() => peek.leave()}
    onContextMenu={(event) => openItemContextMenu(event, item)}
  />
{/snippet}

<!-- The Tasks group header exactly: 30px tall, 11px chevron, 9.5px uppercase
     label, mono count, then a hairline to the right edge. Each pins to the top
     of the scroll area on an opaque background, so the current bucket is always
     named, even 300 rows down. -->
{#snippet groupHeader(label: string, count: number)}
  <span
    class="text-xs font-normal text-muted-foreground uppercase"
  >
    {label}
  </span>
  <span
    class="text-xs tabular-nums text-muted-foreground opacity-70"
    >{count}</span
  >
  <span class="h-px flex-1 bg-[var(--hairline)]"></span>
{/snippet}

<!-- The page's one creating action. One definition, two homes: nearest the
     ledger it adds to on a wide pane, and in the header on a record, where the
     filter row is a search field and a chip scroller with no room beside them.
     One `newMenuOpen` means only one of the two may ever be mounted, which is
     what the `stacked` branch at each call site guarantees. -->
{#snippet newMenu(triggerClass: string, iconSize: number)}
  <DropdownMenu.Root bind:open={newMenuOpen}>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
              <button
                {...props}
                type="button"
                class={triggerClass}
                data-testid="workspace-new"
              >
                <PlusIcon size={iconSize} weight="bold" class="shrink-0" />
                <span>New</span>
                <CaretDownIcon size={9} class="shrink-0 opacity-80" />
              </button>
      {/snippet}
    </DropdownMenu.Trigger>
    <!-- Width is declared by the menu, not by the longest row: a
         fixed 160px wrapped "Import from URL…" onto two lines. -->
    <DropdownMenu.Content
      align="end"
      sideOffset={6}
      collisionPadding={8}
      class="w-auto min-w-56 max-w-[min(20rem,calc(100vw-2rem))] whitespace-nowrap"
    >
      <DropdownMenu.Label>Create</DropdownMenu.Label>
      <DropdownMenu.Item
        class="text-workspace-chrome"
        onSelect={() => createNew("doc")}
      >
        <FileTextIcon size={14} /><span class="flex-1 text-left"
          >Document</span
        >
      </DropdownMenu.Item>
      <DropdownMenu.Item
        class="text-workspace-chrome"
        onSelect={() => createNew("diagram")}
      >
        <ArchitectureIcon size={14} /><span class="flex-1 text-left"
          >Diagram</span
        >
      </DropdownMenu.Item>
      <DropdownMenu.Separator />
      <DropdownMenu.Item
        class="text-workspace-chrome"
        onSelect={() => importInput?.click()}
      >
        <UploadSimpleIcon size={14} /><span class="flex-1 text-left"
          >Import .md…</span
        >
      </DropdownMenu.Item>
      <DropdownMenu.Sub>
        <DropdownMenu.SubTrigger
          class="text-workspace-chrome"
          data-testid="workspace-import-doc"
        >
          <LinkIcon size={14} /><span class="flex-1 text-left"
            >Import from</span
          >
        </DropdownMenu.SubTrigger>
        <DropdownMenu.SubContent
          class="w-auto min-w-52 max-w-[min(20rem,calc(100vw-2rem))] whitespace-nowrap"
        >
          {#if docProvidersLoading}
            <DropdownMenu.Item disabled class="text-workspace-chrome"
              >Checking connections…</DropdownMenu.Item
            >
          {:else if docProviders.length === 0}
            <DropdownMenu.Item disabled class="text-workspace-chrome"
              >No document provider is available.</DropdownMenu.Item
            >
          {:else}
            <!-- Every provider is listed, connected or not: an absent
                 row reads as "Solus cannot import from there" and
                 sends the user looking in the wrong place. -->
            {#each docProviders as status (status.provider)}
              {#if status.connected}
                <DropdownMenu.Item
                  class="text-workspace-chrome"
                  data-testid={`import-from-${status.provider}`}
                  onSelect={() => openImportDialog(status.provider)}
                >
                  <LinkIcon size={14} /><span class="flex-1 text-left"
                    >{docProviderLabel(status.provider)}…</span
                  >
                </DropdownMenu.Item>
              {:else if status.connectable}
                <DropdownMenu.Item
                  class="h-auto py-1.5 text-workspace-chrome"
                  data-testid={`connect-${status.provider}`}
                  onSelect={openProviderSettings}
                >
                  <LinkIcon size={14} />
                  <span
                    class="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
                  >
                    <span>{docProviderLabel(status.provider)}</span>
                    <span
                      class="max-w-full whitespace-normal text-(--solus-text-tertiary)"
                    >
                      {status.reason} Connect in Settings…
                    </span>
                  </span>
                </DropdownMenu.Item>
              {:else}
                <DropdownMenu.Item
                  class="h-auto py-1.5 text-workspace-chrome"
                  data-testid={`unavailable-${status.provider}`}
                  disabled
                >
                  <LinkIcon size={14} />
                  <span
                    class="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
                  >
                    <span>{docProviderLabel(status.provider)}</span>
                    <span
                      class="max-w-full whitespace-normal text-(--solus-text-tertiary)"
                      >{status.reason}</span
                    >
                  </span>
                </DropdownMenu.Item>
              {/if}
            {/each}
          {/if}
        </DropdownMenu.SubContent>
      </DropdownMenu.Sub>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/snippet}

{#if open}
  <div
    bind:this={rootEl}
    class="workspace-root relative flex min-h-0 flex-1 flex-col bg-background text-workspace-chrome text-foreground"
    style={isEditorMode ? "" : "max-height:var(--pill-body-max)"}
    role="dialog"
    aria-label="Workspace"
    tabindex="-1"
  >
    <div class="flex min-h-0 flex-1">
      <div class="flex min-w-0 flex-1 flex-col">
        {#if stacked}
          <!-- ── The record head ──
               A phone has no crumb line: the drawer control is the way back to
               everything else, the page names itself, and the counts the wide
               head spends a sync chip on are stated as the fact they are. -->
          <div class="flex h-[60px] shrink-0 items-center gap-1.5 px-2.5">
            {#if frameChrome.openNavigationDrawer}
              <button
                type="button"
                class="relative flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-foreground active:bg-[var(--wash-2)] [-webkit-tap-highlight-color:transparent]"
                onclick={frameChrome.openNavigationDrawer}
                aria-label="Open navigation"
              >
                <SidebarSimpleIcon size={19} />
                {#if frameChrome.navigationHasUnseen}
                  <span
                    class="absolute top-1.5 right-1.5 size-[7px] rounded-full bg-primary shadow-[0_0_0_2px_var(--background)]"
                    aria-hidden="true"
                  ></span>
                {/if}
              </button>
            {/if}
            <span class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span
                class="text-base/[1.15] font-semibold tracking-[-0.016em]"
                >Workspace</span
              >
              <span
                class="flex items-center gap-[7px] text-xs text-muted-foreground"
              >
                <span class="font-medium text-foreground"
                  >{items.length}
                  {items.length === 1 ? "artifact" : "artifacts"}</span
                >
                <span class="opacity-35" aria-hidden="true">·</span>
                <span>{typeCounts.plan} plans</span>
                <span class="opacity-35" aria-hidden="true">·</span>
                <span>{typeCounts.doc} docs</span>
              </span>
            </span>
            {@render newMenu(
              "flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border-0 bg-primary px-[13px] font-semibold text-primary-foreground [-webkit-tap-highlight-color:transparent]",
              14,
            )}
          </div>

          <!-- ── The record's filter band ──
               Search on its own line, then one scrolling row of chips: the
               project the ledger is pointed at, then the type facet as chips
               rather than a menu, because type is the axis a reader changes.
               Time, status, the saved views and sort are one axis further out
               and live in the sheet the last chip raises. -->
          <div
            class="flex shrink-0 flex-col gap-2.5 border-b border-[var(--hairline)] px-4 pt-0.5 pb-2.5"
          >
            <WorkspaceSearchField
              {filter}
              totalCount={items.length}
              {scopeLabel}
              matches={searching ? filtered.length : null}
              bind:ref={searchEl}
            />
            <!-- The switcher stays out of the scroller. Its menu is absolutely
                 positioned against the trigger, and `overflow-x: auto` forces
                 `overflow-y: auto` with it — so inside the scroller the menu
                 opened into a clipped box and nothing appeared to happen. -->
            <div class="flex items-center gap-[7px]">
              <ListProjectSwitcher
                variant="chip"
                projects={projectOptions}
                activeKey={activeProjectOptionKey ?? undefined}
                emptyLabel="All projects"
                onSelect={(option) => selectProject(option)}
                onRemoveHistory={removeProjectHistory}
                onSelectAll={() => selectProject(null)}
                footerNote="Switching keeps facets, clears search"
              />
              <span
                class="h-[18px] w-px shrink-0 bg-[var(--hairline-strong)]"
                aria-hidden="true"
              ></span>
              <div
                class="flex min-w-0 flex-1 items-center gap-[7px] overflow-x-auto [scrollbar-width:none] [mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)] [&::-webkit-scrollbar]:hidden"
              >
              {#each TYPE_OPTIONS as option (option.value)}
                <button
                  type="button"
                  class="{FILTER_CHIP} {filter.type === option.value
                    ? FILTER_CHIP_ON
                    : FILTER_CHIP_OFF}"
                  onclick={() => (filter.type = option.value)}
                  aria-pressed={filter.type === option.value}
                >
                  {option.label}
                  {#if filter.type !== option.value}
                    <span class={FILTER_CHIP_COUNT}>{option.count}</span>
                  {/if}
                </button>
              {/each}
              </div>
              <span
                class="h-[18px] w-px shrink-0 bg-[var(--hairline-strong)]"
                aria-hidden="true"
              ></span>
              <!-- Pinned at the trailing edge, never in the scroller. It is the
                   only way to the axes the chip row cannot show, so a chip that
                   scrolls off the pane is a dead end. -->
              <button
                type="button"
                class="{FILTER_CHIP} {narrowedBeyondType
                  ? FILTER_CHIP_ON
                  : FILTER_CHIP_OFF}"
                onclick={() => (filterSheetOpen = true)}
                aria-haspopup="dialog"
                aria-expanded={filterSheetOpen}
              >
                <SlidersIcon size={13} class="shrink-0 opacity-75" />
                Filters
              </button>
            </div>
          </div>
        {:else}
          <!-- ── Row 1: `<project> / Workspace`, and the controls that act on the
               window. It keeps one fixed top measure when the session sidebar
               opens or closes. ── -->
          <div
            class="workspace-titlebar mx-auto flex w-full max-w-[72rem] shrink-0 items-center px-8 pt-[42px] pb-[13px] @min-[90rem]:max-w-[82rem] @min-[110rem]:max-w-[94rem] @max-[44rem]:px-5 @max-[34rem]:px-4 [.is-laptop-display_&]:pt-8 [.is-laptop-display_&]:pb-2.5"
          >
            <PageCrumbLine
              page="folio"
              projects={projectOptions}
              activeProjectKey={activeProjectOptionKey ?? ""}
              emptyProjectLabel="All projects"
              onSelectProject={(option) => selectProject(option)}
              onSelectAllProjects={() => selectProject(null)}
              onRemoveProjectHistory={removeProjectHistory}
              projectSwitchNote="Switching keeps facets, clears search"
              onRefresh={load}
              refreshing={anyLoading}
              syncedAt={synced.at}
              onClose={close}
            />
          </div>

          <!-- ── Row 2: search · type · time · status · saved views · sort · New ── -->
          <div
            class="mx-auto flex w-full max-w-[72rem] shrink-0 flex-wrap items-center gap-2 px-8 pb-[14px] text-chrome-dense @min-[90rem]:max-w-[82rem] @min-[110rem]:max-w-[94rem] @max-[44rem]:px-5 @max-[34rem]:px-4 [.is-laptop-display_&]:pb-3"
          >
          <WorkspaceSearchField
            {filter}
            totalCount={items.length}
            {scopeLabel}
            matches={searching ? filtered.length : null}
            bind:ref={searchEl}
          />
          <!-- The filter menus wear the chip skin the list pages use. The
               colour carries the `color:` hint so tailwind-merge classifies it
               and drops the trigger's own default rather than leaving both in
               the sheet. -->
          <SortMenu
            bind:value={filter.type}
            options={TYPE_OPTIONS}
            ariaLabel="Filter by type"
            class="{FILTER_SORT_CHIP} [.is-laptop-display_&]:h-6.5"
          />
          <SortMenu
            bind:value={filter.time}
            options={TIME_OPTIONS}
            ariaLabel="Filter by time"
            class="{FILTER_SORT_CHIP} [.is-laptop-display_&]:h-6.5"
          />
          <SortMenu
            bind:value={filter.status}
            options={STATUS_OPTIONS}
            ariaLabel="Filter by status"
            class="{FILTER_SORT_CHIP} [.is-laptop-display_&]:h-6.5"
          />
          {@render toggleChip(
            "Pinned",
            pinnedCount,
            filter.pinnedOnly,
            () => (filter.pinnedOnly = !filter.pinnedOnly),
            PushPinIcon,
          )}
          {@render toggleChip(
            "Needs review",
            needsReviewCount,
            needsReviewActive,
            toggleNeedsReview,
            MagnifyingGlassIcon,
          )}
          <SortMenu
            bind:value={sort}
            options={SORT_OPTIONS}
            ariaLabel="Sort"
            class="{FILTER_SORT_CHIP} [.is-laptop-display_&]:h-6.5"
          />

          <span
            class="mx-0.5 h-[18px] w-px shrink-0 bg-[color-mix(in_oklch,var(--foreground)_12%,transparent)]"
            aria-hidden="true"
          ></span>
          {@render newMenu(
            "flex h-[30px] shrink-0 cursor-pointer items-center gap-[7px] rounded-lg border-0 bg-primary px-[13px] font-medium text-primary-foreground shadow-[0_1px_2px_rgba(24,20,16,.14)] transition-colors duration-150 hover:bg-[color-mix(in_oklab,var(--primary)_90%,black)] [.is-laptop-display_&]:h-[26px] [.is-laptop-display_&]:px-2.5",
            12,
          )}
          </div>
        {/if}

        <!-- ── Ledger ── -->
        <div
          bind:this={scrollEl}
          class="min-h-0 flex-1 overflow-y-auto overscroll-y-contain pb-5 outline-none [scrollbar-width:none] [&::-webkit-scrollbar]:w-0 mx-auto w-full max-w-[72rem] @min-[90rem]:max-w-[82rem] @min-[110rem]:max-w-[94rem] px-8 @max-[44rem]:px-5 @max-[34rem]:px-4"
          role="listbox"
          aria-label="Workspace items"
          tabindex="-1"
          onscroll={handleLedgerScroll}
        >
          {#if loading}
            <div class="flex flex-col gap-1 pt-2" aria-hidden="true">
              {#each Array(8) as _, i (i)}
                <div
                  class="h-11 animate-pulse rounded-lg bg-[var(--wash-2)]"
                  style="opacity:{1 - i * 0.1}"
                ></div>
              {/each}
            </div>
          {:else if items.length === 0}
            <PageEmpty icon={BooksIcon} title="Nothing here yet.">
              Plans, docs and diagrams your agents produce land here.
              {#snippet actions()}
                <button
                  type="button"
                  class={PAGE_PRIMARY_BTN}
                  onclick={() => createNew("doc")}
                >
                  <PlusIcon size={13} weight="bold" />
                  <span>New document</span>
                </button>
                <button
                  type="button"
                  class={PAGE_SECONDARY_BTN}
                  onclick={() => createNew("diagram")}
                >
                  New diagram
                </button>
              {/snippet}
            </PageEmpty>
          {:else if filtered.length === 0}
            <PageEmpty title="No matches in this filter.">
              {#if filter.text.trim() && outsideCount > 0}
                {outsideCount}
                {outsideCount === 1 ? "match" : "matches"} outside the active filters.
              {:else}
                Try a different search or filter.
              {/if}
              {#snippet actions()}
                <button
                  type="button"
                  class={PAGE_SECONDARY_BTN}
                  onclick={clearFilters}
                >
                  Clear filters
                </button>
              {/snippet}
            </PageEmpty>
          {:else}
            <!-- A pinned item is *moved* here, not copied: its date group's
                 count drops accordingly and no title appears twice. -->
            {#if grouped.pinned.length > 0}
              <div
                class="sticky top-0 z-[1] flex h-[30px] items-center gap-2.5 bg-background px-1.5 @max-[30rem]/pane:h-auto @max-[30rem]/pane:px-1.5 @max-[30rem]/pane:pt-4 @max-[30rem]/pane:pb-1.5"
              >
                <button
                  type="button"
                  class="flex shrink-0 cursor-pointer items-center border-0 bg-transparent p-0 text-muted-foreground opacity-60 transition-transform duration-200 {pinnedCollapsed
 ? ''
 : 'rotate-90'}"
                  onclick={togglePinnedCollapsed}
                  aria-label={pinnedCollapsed
                    ? "Expand pinned"
                    : "Collapse pinned"}
                  aria-expanded={!pinnedCollapsed}
                >
                  <CaretRightIcon size={11} />
                </button>
                {@render groupHeader("Pinned", grouped.pinned.length)}
                {#if pinnedOverflow > 0 || pinnedExpanded}
                  <button
                    type="button"
                    class="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-xs text-muted-foreground opacity-80 hover:text-foreground"
                    onclick={() => (pinnedExpanded = !pinnedExpanded)}
                  >
                    {pinnedExpanded ? "Show less" : "Show all"}
                  </button>
                {/if}
              </div>
              <!-- On a wide pane the rows are the ledger's own children, so the
                   wrapper is `display: contents` and changes nothing. On a
                   record they become one card per group with a hairline between
                   rows, which is what turns a run of 44px lines into a bucket a
                   thumb can tell from the bucket above it. -->
              <div
                class="contents @max-[30rem]/pane:block @max-[30rem]/pane:overflow-hidden @max-[30rem]/pane:rounded-xl @max-[30rem]/pane:bg-card @max-[30rem]/pane:shadow-[shadow:var(--elev-ring)] @max-[30rem]/pane:[&>*+*]:border-t @max-[30rem]/pane:[&>*+*]:border-[var(--hairline)]"
              >
                {#each pinnedShown as item, i (item.rowKey)}
                  {@render ledgerRow(item, i)}
                {/each}
              </div>
              {#if pinnedOverflow > 0}
                <button
                  type="button"
                  class="flex h-[30px] w-full cursor-pointer items-center gap-[9px] rounded-lg border-0 bg-transparent pr-3 pl-2.5 text-xs text-muted-foreground transition-shadow duration-150 hover:shadow-[inset_0_0_0_999px_var(--wash-1)]"
                  onclick={() => (pinnedExpanded = true)}
                >
                  <span class="flex w-4 shrink-0 justify-center opacity-60">
                    <CaretDownIcon size={11} />
                  </span>
                  {pinnedOverflow} more pinned
                </button>
              {/if}
            {/if}

            {#each renderedGroups as group (group.key)}
              {@const groupOffset =
                pinnedShown.length +
                renderedGroups
                  .slice(0, renderedGroups.indexOf(group))
                  .reduce((n, g) => n + g.items.length, 0)}
              <div
                class="sticky top-0 z-[1] mt-1.5 flex h-[30px] items-center gap-2.5 bg-background px-1.5 @max-[30rem]/pane:h-auto @max-[30rem]/pane:pt-4 @max-[30rem]/pane:pb-1.5"
              >
                <span class="w-[11px] shrink-0"></span>
                {@render groupHeader(group.label, group.total)}
              </div>
              <div
                class="contents @max-[30rem]/pane:block @max-[30rem]/pane:overflow-hidden @max-[30rem]/pane:rounded-xl @max-[30rem]/pane:bg-card @max-[30rem]/pane:shadow-[shadow:var(--elev-ring)] @max-[30rem]/pane:[&>*+*]:border-t @max-[30rem]/pane:[&>*+*]:border-[var(--hairline)]"
              >
                {#each group.items as item, j (item.rowKey)}
                  {@render ledgerRow(item, groupOffset + j)}
                {/each}
              </div>
            {/each}

            <!-- Rows still on their way in: only at the true tail of the ledger,
                 where more items would actually appear. -->
            {#if backgroundLoading && !searching && !hasMoreRows}
              <div class="flex flex-col gap-1 pt-1" aria-hidden="true">
                {#each Array(2) as _, i (i)}
                  <div
                    class="h-11 animate-pulse rounded-lg bg-[var(--wash-2)]"
                    style="opacity:{0.55 - i * 0.25}"
                  ></div>
                {/each}
              </div>
            {/if}
          {/if}
        </div>
      </div>

    </div>

    {#if itemContextMenu}
      {@const menuItem = itemContextMenu.item}
      <WorkspaceItemContextMenu
        x={itemContextMenu.x}
        y={itemContextMenu.y}
        item={menuItem}
        onOpen={() => void openItem(menuItem)}
        onOpenSplit={menuItem.source.kind === "work"
          ? () => void openItemInSplit(menuItem)
          : undefined}
        onTogglePin={() => togglePin(menuItem)}
        onOpenSession={menuItem.sessionId
          ? () => void resumeItem(menuItem)
          : undefined}
        onOpenSessionSplit={menuItem.sessionId
          ? () => void openSessionInSplit(menuItem)
          : undefined}
        onDelete={menuItem.source.kind === "work"
          ? () => deleteItem(menuItem)
          : undefined}
        onClose={() => (itemContextMenu = null)}
      />
    {/if}

    <!-- The axes the record's chip row has no width for, at 54px a row. Same
         filter state as the wide pane's menus, so a facet set here is the facet
         the search field's token writes. -->
    {#if stacked && filterSheetOpen}
      <BottomSheet
        label="Workspace filters"
        onClose={() => (filterSheetOpen = false)}
      >
        {#snippet header()}
          <div class="flex items-center justify-between">
            <span class="text-base font-semibold tracking-[-0.012em]"
              >Filters</span
            >
            <button
              type="button"
              class="h-8 cursor-pointer rounded-full border-0 bg-[var(--wash-2)] px-[13px] font-medium text-foreground [-webkit-tap-highlight-color:transparent]"
              onclick={() => (filterSheetOpen = false)}
            >
              Done
            </button>
          </div>
        {/snippet}
        <div class="flex flex-col gap-3.5">
          <div
            class="overflow-hidden rounded-xl bg-card shadow-[shadow:var(--elev-ring)] [&>*+*]:border-t [&>*+*]:border-[var(--hairline)]"
          >
            <div class="flex h-[54px] items-center gap-[11px] px-3.5">
              <span class="flex-1 text-muted-foreground">Time</span>
              <SortMenu
                bind:value={filter.time}
                options={TIME_OPTIONS}
                ariaLabel="Filter by time"
                class="h-8 gap-1.5 rounded-full bg-transparent px-2.5 py-0 font-medium text-[color:var(--foreground)]"
              />
            </div>
            <div class="flex h-[54px] items-center gap-[11px] px-3.5">
              <span class="flex-1 text-muted-foreground">Status</span>
              <SortMenu
                bind:value={filter.status}
                options={STATUS_OPTIONS}
                ariaLabel="Filter by status"
                class="h-8 gap-1.5 rounded-full bg-transparent px-2.5 py-0 font-medium text-[color:var(--foreground)]"
              />
            </div>
            <div class="flex h-[54px] items-center gap-[11px] px-3.5">
              <span class="flex-1 text-muted-foreground">Sort</span>
              <SortMenu
                bind:value={sort}
                options={SORT_OPTIONS}
                ariaLabel="Sort"
                class="h-8 gap-1.5 rounded-full bg-transparent px-2.5 py-0 font-medium text-[color:var(--foreground)]"
              />
            </div>
          </div>

          <div class="flex flex-col gap-[7px]">
            <span
              class="pl-1 text-xs font-medium tracking-[0.12em] text-muted-foreground uppercase"
              >Saved views</span
            >
            <div class="flex gap-[7px]">
              {@render toggleChip(
                "Pinned",
                pinnedCount,
                filter.pinnedOnly,
                () => (filter.pinnedOnly = !filter.pinnedOnly),
                PushPinIcon,
              )}
              {@render toggleChip(
                "Needs review",
                needsReviewCount,
                needsReviewActive,
                toggleNeedsReview,
                MagnifyingGlassIcon,
              )}
            </div>
          </div>
        </div>
        {#snippet footer()}
          <button
            type="button"
            class="h-[50px] w-full cursor-pointer rounded-lg border-0 bg-[var(--wash-2)] font-medium text-foreground [-webkit-tap-highlight-color:transparent]"
            onclick={clearFilters}
          >
            Clear filters
          </button>
        {/snippet}
      </BottomSheet>
    {/if}

    <!-- The preview: a transient card over the row, never a reserved column.
         On a stacked pane it is the same card raised as a sheet, because there
         the tap that would have opened the artifact previews it instead — so
         the sheet is where Open actually lives. -->
    {#if peek.item && stacked}
      <WorkspacePeek
        item={peek.item}
        query={filter.text}
        pinned={peek.pinned}
        variant="sheet"
        onOpen={() => {
          const target = peek.item;
          if (!target) return;
          if (target.source.kind === "work") {
            // The sheet already hydrated this work for its preview. Route it
            // directly instead of blocking the only mobile open action on a
            // second remote load before any visible navigation occurs.
            session.openWork(target.id);
            peek.close();
            return;
          }
          void openItem(target).then(() => peek.close());
        }}
        onTogglePin={() => {
          const target = peek.item;
          if (target) togglePin(target);
        }}
        onDelete={peek.item.source.kind === "work"
          ? () => {
              const target = peek.item;
              peek.close();
              if (target) deleteItem(target);
            }
          : undefined}
        onClose={() => peek.close()}
      />
    {:else if peek.item && peek.anchor && scrollEl}
      <WorkspacePeek
        item={peek.item}
        anchor={peek.anchor}
        ledger={scrollEl}
        query={filter.text}
        pinned={peek.pinned}
      />
    {/if}
  </div>

  <ImportDocDialog
  open={importDocOpen}
  provider={importDocProvider}
  onClose={() => {
    importDocOpen = false;
    importDocProvider = undefined;
  }}
/>

  <input
    bind:this={importInput}
    type="file"
    accept=".md,.markdown,.txt,text/markdown,text/plain"
    class="sr-only"
    onchange={onImportFile}
    tabindex="-1"
    aria-hidden="true"
  />
{/if}

<style>
  .workspace-root {
    overflow: hidden;
    /* Query container so the head and filter row respond to the pane's own
       width (a split pane, the pill, mobile web), not the viewport. */
    container: workspace-page / inline-size;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    border: 0;
  }
</style>
