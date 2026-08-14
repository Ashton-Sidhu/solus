<script lang="ts">
  import { tick, untrack } from "svelte";
  import {
    BooksIcon,
    CaretDownIcon,
    CaretRightIcon,
    CircleNotchIcon,
    FileTextIcon,
    GraphIcon,
    MagnifyingGlassIcon,
    PlusIcon,
    PushPinIcon,
    UploadSimpleIcon,
    XIcon,
  } from "phosphor-svelte";
  import type { PlanDescriptor, Work } from "../../../shared/types";
  import {
    getWorkspaceContext,
    getPlanStore,
    getWindowContext,
    runtime,
  } from "../../contexts";
  import { blurActiveTextInputOnMobile } from "../../lib/inputFocus";
  import { liveSessionTitle } from "../../lib/sessionUtils";
  import {
    useKeybinding,
    useScope,
  } from "../../lib/keybindings/use-keybinding.svelte";
  import {
    PAGE_ICON_BTN,
    PAGE_PRIMARY_BTN,
    PAGE_SECONDARY_BTN,
  } from "../../lib/page-chrome";
  import { statTintColor, type ListIcon } from "../ui/list-page/list-page";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import PageEmpty from "../ui/PageEmpty.svelte";
  import SortMenu from "../ui/SortMenu.svelte";
  import WorkspaceRow from "./WorkspaceRow.svelte";
  import WorkspaceItemContextMenu from "./WorkspaceItemContextMenu.svelte";
  import WorkspacePeek from "./WorkspacePeek.svelte";
  import WorkspaceProjectSwitcher from "./WorkspaceProjectSwitcher.svelte";
  import WorkspaceSearchField from "./WorkspaceSearchField.svelte";
  import { PeekHover } from "./lib/peek-hover.svelte";
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
    sortItems,
  } from "./lib/workspace-items";

  const session = getWorkspaceContext();
  const planStore = getPlanStore();
  const windowCtx = getWindowContext();

  const PINNED_PREVIEW = 6;
  const RENDER_PAGE = 80;
  const PINNED_COLLAPSED_KEY = "solus.workspace.pinned-collapsed";
  const PROJECT_SCOPE_KEY = "solus.workspace.project";

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
  const openProjects = $derived(session.openProjects);
  const allItems: WorkspaceItem[] = $derived(
    buildWorkspaceItems(descriptors, worksList, openProjects),
  );
  // Plans are the slow half of the ledger (each split plan is read off disk), so
  // works can land long before them. Track each source: an empty ledger gets the
  // skeleton, a populated one still says which half is catching up.
  const plansLoading = $derived(planStore.isDescriptorLoading(descriptorsKey));
  const worksLoading = $derived(session.worksStore.listLoading);
  const anyLoading = $derived(plansLoading || worksLoading);
  const loading = $derived(allItems.length === 0 && anyLoading);
  const backgroundLoading = $derived(!loading && anyLoading);
  /** What is still on its way in. Plans are read off disk one split file at a
   *  time, so they routinely land long after the works do — naming the slow
   *  half is the difference between "the page is stuck" and "the plans are
   *  still coming". */
  const loadingLabel = $derived(
    plansLoading && worksLoading
      ? "plans and documents"
      : plansLoading
        ? "plans"
        : "documents",
  );

  // ── Project scope: which open project the ledger is showing (null = all).
  //    It sits above the filters — every facet count is counted inside it — and
  //    persists, so reopening the Workspace lands back in the same project. ──
  let projectScope = $state<string | null>(
    localStorage.getItem(PROJECT_SCOPE_KEY),
  );
  // With a single project open, "all projects" *is* that project — name it,
  // rather than making the scope read wider than it is.
  const scopedProject = $derived(
    openProjects.find((project) => project.key === projectScope) ??
      (openProjects.length === 1 ? openProjects[0] : null),
  );
  const items: WorkspaceItem[] = $derived(
    scopedProject
      ? allItems.filter((item) => item.projectKey === scopedProject.key)
      : allItems,
  );
  const projectOptions = $derived(
    openProjects.map((project) => ({
      key: project.key,
      label: project.label,
      count: allItems.filter((item) => item.projectKey === project.key).length,
    })),
  );
  /** A row names its project only when the ledger spans more than one. */
  const showProject = $derived(!scopedProject && openProjects.length > 1);
  const scopeLabel = $derived(scopedProject?.label ?? "all projects");

  function selectProject(key: string | null) {
    projectScope = key;
    if (key) localStorage.setItem(PROJECT_SCOPE_KEY, key);
    else localStorage.removeItem(PROJECT_SCOPE_KEY);
    // Switching keeps the facets — they partition any project — and clears the
    // search, which was written against the project being left.
    filter.text = "";
    resetLedgerSelection();
  }

  function load() {
    const ipcCtx = untrack(() => session.ctx);
    void planStore.getDescriptors(undefined, true, ipcCtx).catch(() => {});
    void session.worksStore.loadAll(session.galleryProjectPath);
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
    // Opening the page is the only trigger for this setup. Loading reads the
    // active project's path, which can change while the Workspace stays open;
    // do not let that incidental dependency reset the user's selection.
    untrack(() => {
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

  /** The head's summary line describes the scope, not the filter: the lead
   *  statistic is the only coloured text on the page head. */
  const scopeStats = $derived.by(() => {
    const c = { plan: 0, doc: 0, diagram: 0, pending: 0 };
    for (const item of items) {
      c[item.type]++;
      if (item.status === "pending") c.pending++;
    }
    return c;
  });

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

  /** The filter bar's two menus share the chip skin the list pages use. The
   *  colour carries the `color:` hint so tailwind-merge classifies it and drops
   *  the trigger's own default rather than leaving both in the sheet. */
  const FILTER_CHIP =
    "h-7 shrink-0 gap-1.5 rounded-lg bg-transparent px-2.5 py-0 text-[0.8125rem] font-normal text-[color:var(--muted-foreground)] shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)] hover:bg-[var(--wash-2)] hover:text-foreground";

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
  $effect(() => {
    sessionLabels.ensure(flat.map((item) => item.sessionId));
  });

  /** What to call the session an artifact came from. A session open in a tab
   *  knows its own name; the index answers for everything else. */
  function originLabel(item: WorkspaceItem): string | null {
    if (!item.sessionId) return null;
    return (
      liveSessionTitle(item.sessionId, session) ??
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
    const tabId = await session.resumeSession(
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

<!-- What the ledger is still waiting on — the same spinner Tasks and Pull
     requests use while they refresh, in brand colour so it reads as work in
     progress rather than as an error. It is a live region: the ledger fills in
     underneath it without moving focus, so this is the only thing that
     announces the change. -->
{#snippet loadingNote()}
  <span class="flex items-center gap-[7px]" role="status" aria-live="polite">
    <CircleNotchIcon
      size={11}
      class="shrink-0 animate-spin text-primary [animation-duration:0.9s] motion-reduce:animate-none"
      aria-hidden="true"
    />
    <span>Loading {loadingLabel}…</span>
  </span>
{/snippet}

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
    class="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border-0 px-2.5 text-[0.8125rem] transition-colors duration-150 {active
 ? 'bg-[color-mix(in_oklch,var(--primary)_13%,transparent)] text-[color-mix(in_oklch,var(--primary)_82%,var(--foreground))]'
 : 'bg-transparent text-muted-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)] hover:bg-[var(--wash-2)] hover:text-foreground'}"
    {onclick}
    aria-pressed={active}
  >
    <Icon size={11} class="shrink-0 opacity-75" />
    {label}
    {#if !active}
      <span class="font-mono text-xs tabular-nums opacity-60">{count}</span>
    {/if}
  </button>
{/snippet}

{#snippet ledgerRow(item: WorkspaceItem, index: number)}
  <WorkspaceRow
    {item}
    selected={index === selectedIndex}
    {showProject}
    query={filter.text}
    onOpen={() => openItem(item)}
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
    class="font-mono text-xs tabular-nums text-muted-foreground opacity-70"
    >{count}</span
  >
  <span class="h-px flex-1 bg-[var(--hairline)]"></span>
{/snippet}

{#if open}
  <div
    class="workspace-root relative flex min-h-0 flex-1 flex-col bg-background text-[0.8125rem] text-foreground"
    style={isEditorMode ? "" : "max-height:var(--pill-body-max)"}
    role="dialog"
    aria-label="Workspace"
    tabindex="-1"
  >
    <div class="flex min-h-0 flex-1">
      <div class="flex min-w-0 flex-1 flex-col">
        <!-- ── Head: title block + the two actions. It keeps one fixed top
             measure when the session sidebar opens or closes. ── -->
        <div
          class="workspace-titlebar flex shrink-0 items-end justify-between gap-6 pt-[42px] pb-3.5 mx-auto w-full max-w-[72rem] @min-[90rem]:max-w-[82rem] @min-[110rem]:max-w-[94rem] px-8 @max-[44rem]:px-5 @max-[34rem]:px-4"
        >
          <div class="flex min-w-0 flex-col gap-[7px]">
            <h1 class="m-0 text-[1.5rem] font-medium ">
              Workspace
            </h1>
            <!-- While the ledger is still empty the stats are all zero, which
                 reads as "nothing here" rather than "not counted yet" — so the
                 summary is the loading note until there is something to sum.
                 Once rows are on screen the note joins the stats instead, and
                 the numbers keep climbing beside it. -->
            <div
              class="flex items-center gap-2 text-xs text-muted-foreground"
            >
              {#if loading}
                {@render loadingNote()}
              {:else}
                <span
                  class="font-medium tabular-nums"
                  style="color: {statTintColor('running')}"
                >
                  {scopeStats.pending} need review
                </span>
                <span class="opacity-35" aria-hidden="true">·</span>
                <span class="tabular-nums">{scopeStats.plan} plans</span>
                <span class="opacity-35" aria-hidden="true">·</span>
                <span class="tabular-nums">{scopeStats.doc} docs</span>
                <span class="opacity-35" aria-hidden="true">·</span>
                <span class="tabular-nums">{scopeStats.diagram} diagrams</span>
                {#if backgroundLoading}
                  <span class="opacity-35" aria-hidden="true">·</span>
                  {@render loadingNote()}
                {/if}
              {/if}
            </div>
          </div>

          <div class="flex shrink-0 items-center gap-2">
            <!-- The scope control heads the action cluster, exactly where Tasks
                 and Pull requests keep theirs. -->
            <WorkspaceProjectSwitcher
              options={projectOptions}
              value={scopedProject?.key ?? null}
              allCount={allItems.length}
              onSelect={selectProject}
            />
            <DropdownMenu.Root>
              <DropdownMenu.Trigger>
                {#snippet child({ props })}
                  <button
                    {...props}
                    type="button"
                    class="flex h-[30px] cursor-pointer items-center gap-[7px] rounded-lg border-0 bg-primary px-[13px] text-[0.8125rem] font-medium text-primary-foreground shadow-[0_1px_2px_rgba(24,20,16,.14)] transition-colors duration-150 hover:bg-[color-mix(in_oklab,var(--primary)_90%,black)]"
                    data-testid="workspace-new"
                  >
                    <PlusIcon size={12} weight="bold" class="shrink-0" />
                    <span>New</span>
                    <CaretDownIcon size={9} class="shrink-0 opacity-80" />
                  </button>
                {/snippet}
              </DropdownMenu.Trigger>
              <DropdownMenu.Content
                align="end"
                sideOffset={6}
                class="w-[160px]"
              >
                <DropdownMenu.Item onSelect={() => createNew("doc")}>
                  <FileTextIcon size={14} /> Document
                </DropdownMenu.Item>
                <DropdownMenu.Item onSelect={() => createNew("diagram")}>
                  <GraphIcon size={14} /> Diagram
                </DropdownMenu.Item>
                <DropdownMenu.Item onSelect={() => importInput?.click()}>
                  <UploadSimpleIcon size={14} /> Import .md…
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Root>

            <button
              type="button"
              class={PAGE_ICON_BTN}
              onclick={close}
              aria-label="Close"
            >
              <XIcon size={14} />
            </button>
          </div>
        </div>

        <!-- ── Filter bar: search · type · time · status · saved views · sort ── -->
        <div
          class="flex shrink-0 flex-wrap items-center gap-2 pb-3.5 mx-auto w-full max-w-[72rem] @min-[90rem]:max-w-[82rem] @min-[110rem]:max-w-[94rem] px-8 @max-[44rem]:px-5 @max-[34rem]:px-4"
        >
          <WorkspaceSearchField
            {filter}
            totalCount={items.length}
            {scopeLabel}
            matches={searching ? filtered.length : null}
            bind:ref={searchEl}
          />
          <SortMenu
            bind:value={filter.type}
            options={TYPE_OPTIONS}
            ariaLabel="Filter by type"
            class={FILTER_CHIP}
          />
          <SortMenu
            bind:value={filter.time}
            options={TIME_OPTIONS}
            ariaLabel="Filter by time"
            class={FILTER_CHIP}
          />
          <SortMenu
            bind:value={filter.status}
            options={STATUS_OPTIONS}
            ariaLabel="Filter by status"
            class={FILTER_CHIP}
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
            class={FILTER_CHIP}
          />
        </div>

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
                class="sticky top-0 z-[1] flex h-[30px] items-center gap-2.5 bg-background px-1.5"
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
              {#each pinnedShown as item, i (item.id)}
                {@render ledgerRow(item, i)}
              {/each}
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
                class="sticky top-0 z-[1] mt-1.5 flex h-[30px] items-center gap-2.5 bg-background px-1.5"
              >
                <span class="w-[11px] shrink-0"></span>
                {@render groupHeader(group.label, group.total)}
              </div>
              {#each group.items as item, j (item.id)}
                {@render ledgerRow(item, groupOffset + j)}
              {/each}
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

    <!-- The preview: a transient card over the row, never a reserved column. -->
    {#if peek.item && peek.anchor && scrollEl}
      <WorkspacePeek
        item={peek.item}
        anchor={peek.anchor}
        ledger={scrollEl}
        query={filter.text}
        pinned={peek.pinned}
      />
    {/if}
  </div>

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
