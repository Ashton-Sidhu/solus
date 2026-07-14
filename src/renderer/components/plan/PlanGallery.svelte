<script lang="ts">
  import { fly } from "svelte/transition";
  import { tick, untrack } from "svelte";
  import { Input } from "../ui/input";
  import {
    MagnifyingGlassIcon,
    XIcon,
    BookmarkSimpleIcon,
    MapTrifoldIcon,
  } from "phosphor-svelte";
  import type { PlanDescriptor } from "../../../shared/types";
  import { planKey } from "../../../shared/types";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { getPlanStore } from "../../contexts/plan.store.svelte";
  import { getWindowContext } from "../../contexts/window.context.svelte";
  import { runtime } from "../../contexts/runtime.svelte";
  import { blurActiveTextInputOnMobile } from "../../lib/inputFocus";
  import { getDateGroup, matchesOpenProjects, type DateGroup } from "../../lib/sessionUtils";
  import { useKeybinding, useScope } from "../../lib/keybindings/use-keybinding.svelte";
  import PlanCard from "./PlanCard.svelte";
  import PlanListRow from "./PlanListRow.svelte";
  import Kbd from "../ui/Kbd.svelte";
  import PageShell from "../ui/PageShell.svelte";
  import PageHeader from "../ui/PageHeader.svelte";
  import SearchField from "../ui/search-field";
  import SegmentedControl from "../ui/SegmentedControl.svelte";
  import SectionLabel from "../ui/SectionLabel.svelte";
  import SortMenu from "../ui/SortMenu.svelte";
  import { Button } from "../ui/button";

  const session = getWorkspaceContext();
  const planStore = getPlanStore();
  const windowCtx = getWindowContext();

  type StatusKind = "pending" | "accepted" | "rejected";
  type SortMode = "newest" | "title";

  const defaultStatuses = new Set<StatusKind>(["pending", "accepted"]);

  const SORT_OPTIONS: { value: SortMode; label: string }[] = [
    { value: "newest", label: "Newest" },
    { value: "title", label: "Title" },
  ];

  const isEditorMode = $derived(windowCtx.viewMode === "editor" || windowCtx.isWeb);
  const open = $derived(session.plansGalleryOpen);

  let descriptors = $state<PlanDescriptor[]>([]);
  let descriptorsKey = $state<string | null>(null);
  let loadSeq = 0;
  let loading = $state(false);
  let query = $state("");
  let statusSet = $state<Set<StatusKind>>(new Set(defaultStatuses));
  let showBookmarked = $state(false);
  let sortMode = $state<SortMode>("newest");
  let selectedIndex = $state(0);
  let searchEl: HTMLInputElement | HTMLTextAreaElement | null = $state(null);
  let scrollEl: HTMLDivElement | null = $state(null);
  let mouseHasMoved = $state(false);

  function sortPlans(a: PlanDescriptor, b: PlanDescriptor): number {
    if (sortMode === "title") return a.title.localeCompare(b.title);
    return b.timestamp - a.timestamp;
  }

  // Both galleries are scoped to the projects with open sessions in the sidebar.
  const scopeRoots = $derived(session.openProjectScopeRoots);
  const multiProject = $derived(session.openProjectKeys.length > 1);

  /** Plans whose cwd falls under an open project — the visible universe. */
  const scopedDescriptors: PlanDescriptor[] = $derived(
    descriptors.filter((d) => matchesOpenProjects(d.cwd, scopeRoots)),
  );

  async function load() {
    const ipcCtx = untrack(() => session.ctx);
    const key = planStore.descriptorCacheKey(undefined, true);
    const seq = ++loadSeq;
    if (untrack(() => descriptorsKey) !== key) {
      descriptorsKey = key;
      descriptors = [];
      selectedIndex = 0;
    }
    loading = untrack(() => descriptors.length) === 0;
    try {
      const next = await planStore.getDescriptors(undefined, true, ipcCtx);
      if (seq !== loadSeq || untrack(() => descriptorsKey) !== key) return;
      descriptors = next;
    } catch {
      if (seq !== loadSeq || untrack(() => descriptorsKey) !== key) return;
      if (untrack(() => descriptors.length) === 0) descriptors = [];
    } finally {
      if (seq === loadSeq && untrack(() => descriptorsKey) === key) loading = false;
    }
  }

  $effect(() => {
    if (open) {
      query = "";
      statusSet = new Set(defaultStatuses);
      showBookmarked = false;
      sortMode = "newest";
      selectedIndex = 0;
      mouseHasMoved = false;
      void load();
      blurActiveTextInputOnMobile();
      if (!runtime.shouldSuppressFocus) {
        tick().then(() => searchEl?.focus());
      }
    }
  });

  const allStatuses: StatusKind[] = ["pending", "accepted", "rejected"];
  const isAllSelected = $derived(allStatuses.every((s) => statusSet.has(s)));

  const counts = $derived.by(() => {
    const c = { pending: 0, accepted: 0, rejected: 0 };
    for (const d of scopedDescriptors) {
      c[d.status as StatusKind] += 1;
    }
    return c;
  });

  function toggleStatus(s: StatusKind) {
    const next = new Set(statusSet);
    if (next.has(s)) {
      if (next.size > 1) next.delete(s);
    } else {
      next.add(s);
    }
    statusSet = next;
  }

  function toggleAll() {
    statusSet = isAllSelected ? new Set(defaultStatuses) : new Set(allStatuses);
  }

  const filtered: PlanDescriptor[] = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return scopedDescriptors
      .filter((d) => {
        const passesStatus = statusSet.has(d.status as StatusKind);
        if (!passesStatus && !d.bookmarked) return false;
        if (!passesStatus && showBookmarked) return false;
        if (showBookmarked && !d.bookmarked) return false;
        if (!q) return true;
        return (
          d.title.toLowerCase().includes(q) ||
          d.excerpt.toLowerCase().includes(q)
        );
      })
      .sort(sortPlans);
  });

  const statusSegments = $derived([
    { value: "all" as const, label: "All", count: scopedDescriptors.length },
    { value: "pending" as const, label: "Pending", short: "Pend", count: counts.pending },
    { value: "accepted" as const, label: "Accepted", short: "Acc", count: counts.accepted },
    { value: "rejected" as const, label: "Rejected", short: "Rej", count: counts.rejected },
  ]);

  function onSegmentSelect(value: "all" | StatusKind) {
    if (value === "all") toggleAll();
    else toggleStatus(value);
  }

  const bookmarked: PlanDescriptor[] = $derived(
    showBookmarked
      ? []
      : filtered
          .filter((d) => d.bookmarked)
          .sort((a, b) => {
            const aTime = a.bookmarkedAt ?? a.timestamp;
            const bTime = b.bookmarkedAt ?? b.timestamp;
            return bTime - aTime;
          }),
  );

  const bookmarkedIds = $derived(
    new Set(bookmarked.map((d) => d.sessionId)),
  );

  const dateGroupOrder: DateGroup[] = [
    "Today",
    "Yesterday",
    "This week",
    "This month",
    "Older",
  ];

  const dateGroups: { label: DateGroup; items: PlanDescriptor[] }[] =
    $derived.by(() => {
      const rest = showBookmarked
        ? filtered
        : filtered.filter((d) => !bookmarkedIds.has(d.sessionId));
      const groups = new Map<DateGroup, PlanDescriptor[]>();
      for (const d of rest) {
        const g = getDateGroup(d.timestamp);
        let arr = groups.get(g);
        if (!arr) {
          arr = [];
          groups.set(g, arr);
        }
        arr.push(d);
      }
      return dateGroupOrder
        .filter((g) => groups.has(g))
        .map((g) => ({ label: g, items: groups.get(g)! }));
    });

  /** Flat list used for keyboard navigation. */
  const flat: PlanDescriptor[] = $derived([
    ...bookmarked,
    ...dateGroups.flatMap((g) => g.items),
  ]);

  $effect(() => {
    query;
    statusSet;
    showBookmarked;
    sortMode;
    selectedIndex = 0;
  });

  $effect(() => {
    if (selectedIndex >= flat.length && flat.length > 0) selectedIndex = 0;
  });

  useScope("plan-gallery", { active: () => open });

  useKeybinding("plan-gallery.close",           () => close(),                                        { enabled: () => open });
  useKeybinding("plan-gallery.focus-search",    () => searchEl?.focus(),                              { enabled: () => open && document.activeElement !== searchEl });
  useKeybinding("plan-gallery.open",            () => { const d = flat[selectedIndex]; if (d) void handleOpen(d); }, { enabled: () => open && flat.length > 0 });
  useKeybinding("plan-gallery.resume",          () => { const d = flat[selectedIndex]; if (d) void handleResume(d); }, { enabled: () => open && flat.length > 0 });
  useKeybinding("plan-gallery.toggle-bookmark", () => { const d = flat[selectedIndex]; if (d) void handleToggleBookmark(d); }, { enabled: () => open && flat.length > 0 });
  useKeybinding("plan-gallery.next",            () => { selectedIndex = (selectedIndex + 1) % flat.length; },           { enabled: () => open && flat.length > 0 && isEditorMode });
  useKeybinding("plan-gallery.prev",            () => { selectedIndex = (selectedIndex - 1 + flat.length) % flat.length; }, { enabled: () => open && flat.length > 0 && isEditorMode });
  useKeybinding("plan-gallery.down",            () => {
    if (isEditorMode) {
      const cols = getGridCols();
      const next = selectedIndex + cols;
      selectedIndex = next >= flat.length ? flat.length - 1 : next;
    } else {
      selectedIndex = Math.min(selectedIndex + 1, flat.length - 1);
    }
  }, { enabled: () => open && flat.length > 0 });
  useKeybinding("plan-gallery.up",              () => {
    if (isEditorMode) {
      const cols = getGridCols();
      const prev = selectedIndex - cols;
      selectedIndex = prev < 0 ? 0 : prev;
    } else {
      selectedIndex = Math.max(selectedIndex - 1, 0);
    }
  }, { enabled: () => open && flat.length > 0 });

  $effect(() => {
    if (!open) return;
    selectedIndex;
    flat.length;
    tick().then(() => {
      const el = scrollEl?.querySelector<HTMLElement>('[data-selected="true"]');
      el?.scrollIntoView({ block: "nearest" });
    });
  });

  function getGridCols(): number {
    if (typeof window === "undefined") return 3;
    if (window.matchMedia("(max-width: 640px)").matches) return 1;
    if (window.matchMedia("(max-width: 900px)").matches) return 2;
    return 3;
  }

  function close() {
    session.plansGalleryOpen = false;
  }

  async function handleOpen(d: PlanDescriptor) {
    await session.openPlanFromDescriptor(d);
  }

  async function handleResume(d: PlanDescriptor) {
    await session.resumeSessionFromDescriptor(d);
  }

  function handleToggleBookmark(d: PlanDescriptor) {
    const newBookmarked = !d.bookmarked;
    d.bookmarked = newBookmarked;
    d.bookmarkedAt = newBookmarked ? Date.now() : undefined;

    const pid = planKey(d.sessionId, d.planToolUseId);
    const plan = planStore.get(pid);
    if (plan) {
      plan.bookmarked = newBookmarked;
      plan.bookmarkedAt = d.bookmarkedAt;
    }

    window.solus.toggleBookmarkPlan(
      d.sessionId,
      d.projectPath,
      d.cwd,
      d.planToolUseId,
      d.title,
    );
  }

</script>

{#snippet searchBox(showEsc)}
  <div class="gallery-search">
    <MagnifyingGlassIcon
      size={15}
      class="text-(--solus-text-tertiary) flex-shrink-0"
    />
    <Input
      bind:ref={searchEl}
      bind:value={query}
      type="text"
      class="h-auto rounded-none border-0 bg-transparent p-0 text-[0.8438rem] shadow-none focus-visible:ring-0 dark:bg-transparent"
      placeholder="Search plans…"
      onkeydown={(e) => {
        if (e.key === 'Enter' && runtime.isMobileViewport) {
          e.stopPropagation();
          e.preventDefault();
          (e.target as HTMLInputElement)?.blur();
        }
      }}
    />
    {#if showEsc}
      <Kbd variant="standalone">ESC</Kbd>
    {/if}
  </div>
{/snippet}

{#snippet filterControls()}
  <div class="gallery-filters">
    <div class="status-tabs">
      <button
        type="button"
        class="status-tab"
        class:active={isAllSelected}
        onclick={toggleAll}
        aria-pressed={isAllSelected}
        aria-label={`All plans (${scopedDescriptors.length})`}
      >
        All <span class="tab-count">{scopedDescriptors.length}</span>
      </button>
      <button
        type="button"
        class="status-tab"
        class:active={statusSet.has("pending")}
        onclick={() => toggleStatus("pending")}
        aria-pressed={statusSet.has("pending")}
        aria-label={`Pending plans (${counts.pending})`}
      >
        <span class="dot dot-pending"></span>
        <span class="status-label-full">Pending</span>
        <span class="status-label-short" aria-hidden="true">Pend</span>
        <span class="tab-count">{counts.pending}</span>
      </button>
      <button
        type="button"
        class="status-tab"
        class:active={statusSet.has("accepted")}
        onclick={() => toggleStatus("accepted")}
        aria-pressed={statusSet.has("accepted")}
        aria-label={`Accepted plans (${counts.accepted})`}
      >
        <span class="dot dot-accepted">✓</span>
        <span class="status-label-full">Accepted</span>
        <span class="status-label-short" aria-hidden="true">Acc</span>
        <span class="tab-count">{counts.accepted}</span>
      </button>
      <button
        type="button"
        class="status-tab"
        class:active={statusSet.has("rejected")}
        onclick={() => toggleStatus("rejected")}
        aria-pressed={statusSet.has("rejected")}
        aria-label={`Rejected plans (${counts.rejected})`}
      >
        <span class="dot dot-rejected">✗</span>
        <span class="status-label-full">Rejected</span>
        <span class="status-label-short" aria-hidden="true">Rej</span>
        <span class="tab-count">{counts.rejected}</span>
      </button>
    </div>
    <div class="collection-chips">
      <button
        type="button"
        class="collection-chip"
        class:active={showBookmarked}
        onclick={() => (showBookmarked = !showBookmarked)}
        aria-pressed={showBookmarked}
        aria-label="Bookmarked plans"
        title="Bookmarked plans"
      >
        <BookmarkSimpleIcon
          size={11}
          weight={showBookmarked ? "fill" : "regular"}
        />
        <span class="collection-chip-label">Bookmarked</span>
      </button>
    </div>
  </div>
{/snippet}

{#snippet header()}
  {@render searchBox(true)}
  {@render filterControls()}
{/snippet}

{#snippet emptyState()}
  <div class="empty">
    <p class="empty-title">No plans yet.</p>
    <p class="empty-sub">
      Plans appear here after the agent runs ExitPlanMode.
    </p>
  </div>
{/snippet}

{#snippet editorGrid()}
  <div bind:this={scrollEl} class="outline-none" role="listbox" tabindex="-1" onmousemove={() => { mouseHasMoved = true; }}>
    {#if loading && descriptors.length === 0}
      <div class="empty"><p class="empty-sub">Loading plans…</p></div>
    {:else if filtered.length === 0}
      {@render emptyState()}
    {:else}
      {#if bookmarked.length > 0}
        <SectionLabel label="Bookmarked" count={bookmarked.length}>
          {#snippet icon()}
            <BookmarkSimpleIcon
              size={12}
              weight="fill"
              class="text-(--solus-accent)"
            />
          {/snippet}
        </SectionLabel>
        <div class="card-grid">
          {#each bookmarked as d, i (d.sessionId)}
            <PlanCard
              descriptor={d}
              selected={i === selectedIndex}
              showProject={multiProject}
              onOpen={() => handleOpen(d)}
              onResume={() => handleResume(d)}
              onToggleBookmark={() => handleToggleBookmark(d)}
              onHover={() => { if (mouseHasMoved) selectedIndex = i; }}
            />
          {/each}
        </div>
      {/if}
      {#each dateGroups as group}
        {@const groupOffset =
          bookmarked.length +
          dateGroups
            .slice(0, dateGroups.indexOf(group))
            .reduce((n, g) => n + g.items.length, 0)}
        <SectionLabel
          label={showBookmarked ? "Bookmarked" : group.label}
          count={group.items.length}
        />
        <div class="card-grid">
          {#each group.items as d, j (d.sessionId)}
            {@const i = groupOffset + j}
            <PlanCard
              descriptor={d}
              selected={i === selectedIndex}
              showProject={multiProject}
              onOpen={() => handleOpen(d)}
              onResume={() => handleResume(d)}
              onToggleBookmark={() => handleToggleBookmark(d)}
              onHover={() => { if (mouseHasMoved) selectedIndex = i; }}
            />
          {/each}
        </div>
      {/each}
    {/if}
  </div>
{/snippet}

{#snippet pillList()}
  <div
    bind:this={scrollEl}
    class="gallery-scroll pill-scroll"
    role="listbox"
    tabindex="-1"
    onmousemove={() => { mouseHasMoved = true; }}
  >
    {#if loading && descriptors.length === 0}
      <div class="empty"><p class="empty-sub">Loading plans…</p></div>
    {:else if filtered.length === 0}
      {@render emptyState()}
    {:else}
      {#if bookmarked.length > 0}
        <div class="pill-section-header">
          <BookmarkSimpleIcon
            size={11}
            weight="fill"
            class="text-(--solus-accent)"
          />
          <span>Bookmarked</span>
        </div>
        {#each bookmarked as d, i (d.sessionId)}
          <PlanListRow
            descriptor={d}
            selected={i === selectedIndex}
            showProject={multiProject}
            onOpen={() => handleOpen(d)}
            onResume={() => handleResume(d)}
            onToggleBookmark={() => handleToggleBookmark(d)}
            onHover={() => { if (mouseHasMoved) selectedIndex = i; }}
          />
        {/each}
        {#if dateGroups.length > 0}
          <div class="pill-divider"></div>
        {/if}
      {/if}
      {#each dateGroups as group, gi}
        {@const groupOffset =
          bookmarked.length +
          dateGroups.slice(0, gi).reduce((n, g) => n + g.items.length, 0)}
        <div class="pill-section-header">
          <span>{group.label}</span>
        </div>
        {#each group.items as d, j (d.sessionId)}
          {@const i = groupOffset + j}
          <PlanListRow
            descriptor={d}
            selected={i === selectedIndex}
            showProject={multiProject}
            onOpen={() => handleOpen(d)}
            onResume={() => handleResume(d)}
            onToggleBookmark={() => handleToggleBookmark(d)}
            onHover={() => { if (mouseHasMoved) selectedIndex = i; }}
          />
        {/each}
        {#if gi < dateGroups.length - 1}
          <div class="pill-divider"></div>
        {/if}
      {/each}
    {/if}
  </div>
{/snippet}

{#if open && isEditorMode}
  <div
    class="gallery-inline relative flex flex-col flex-1 min-h-0"
    role="dialog"
    aria-label="Plans gallery"
    tabindex="-1"
  >
    <PageShell onClose={close}>
      <PageHeader
        title="Plans"
        subtitle="Plans the agent proposed — review, bookmark, resume."
      >
        {#snippet icon()}
          <MapTrifoldIcon size={18} weight="fill" />
        {/snippet}
      </PageHeader>

      <!-- ── Command bar: search + status segments + bookmarked + sort ── -->
      <div class="flex flex-wrap items-center gap-2 pb-4">
        <SearchField
          bind:ref={searchEl}
          bind:value={query}
          placeholder="Search plans…"
          onkeydown={(e) => {
            if (e.key === "Enter" && runtime.isMobileViewport) {
              e.stopPropagation();
              e.preventDefault();
              (e.target as HTMLInputElement)?.blur();
            }
          }}
        />
        <SegmentedControl
          options={statusSegments}
          isActive={(v) => (v === "all" ? isAllSelected : statusSet.has(v))}
          onSelect={onSegmentSelect}
          ariaLabel="Filter by status"
        />
        <div class="ml-auto flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            class="[@media(pointer:coarse)]:size-10 {showBookmarked
              ? 'bg-(--solus-accent-light) text-(--solus-accent)'
              : 'text-(--solus-text-tertiary) hover:text-(--solus-text-secondary)'}"
            onclick={() => (showBookmarked = !showBookmarked)}
            aria-pressed={showBookmarked}
            aria-label="Bookmarked plans"
            title="Bookmarked plans"
          >
            <BookmarkSimpleIcon
              size={13}
              weight={showBookmarked ? "fill" : "regular"}
            />
          </Button>
          <SortMenu
            bind:value={sortMode}
            options={SORT_OPTIONS}
            ariaLabel="Sort plans"
          />
        </div>
      </div>

      {@render editorGrid()}
    </PageShell>
  </div>
{/if}

{#if open && !isEditorMode}
  <div
    class="gallery-inline-pill flex flex-col flex-1 min-h-0"
    style="max-height:var(--pill-body-max)"
    transition:fly={{ y: 8, duration: 160 }}
    role="dialog"
    aria-label="Plans gallery"
    tabindex="-1"
  >
    <div class="gallery-top">
      <div class="flex items-center justify-between px-4 pt-3 pb-2">
        <span class="gallery-title">Plans</span>
        <div class="flex items-center gap-1">
          <Kbd variant="standalone">⌥⇧L</Kbd>
          <Button
            variant="ghost"
            size="icon-xs"
            class="text-(--solus-text-tertiary) hover:text-(--solus-text-primary)"
            onclick={close}
            aria-label="Close"
          >
            <XIcon size={14} />
          </Button>
        </div>
      </div>
      {@render header()}
    </div>
    {@render pillList()}
  </div>
{/if}

<style>
  .gallery-inline {
    background: var(--solus-container-bg);
    overflow: hidden;
    /* Query container so the command bar responds to the pane's own width
       (e.g. a split pane on desktop), not just the viewport. */
    container: plans-gallery / inline-size;
  }
  .gallery-inline-pill {
    overflow: hidden;
  }

  .gallery-top {
    flex-shrink: 0;
    border-bottom: 0.0625rem solid var(--solus-popover-border);
  }
  .gallery-title {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--solus-text-primary);
  }
  /* Search row (pill mode): its own gutter. */
  .gallery-search {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    min-width: 0;
    padding: 0.25rem 1rem 0.625rem 1rem;
  }

  .gallery-filters {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.625rem;
    padding: 0 1rem 0.625rem 1rem;
    flex-wrap: wrap;
  }
  .status-tabs {
    display: flex;
    gap: 0.125rem;
    min-width: 0;
  }
  .status-tab {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.6875rem;
    padding: 0.25rem 0.5625rem;
    border-radius: 0.5rem;
    border: none;
    background: transparent;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    white-space: nowrap;
    transition:
      background 0.1s ease,
      color 0.1s ease;
  }
  .status-tab:hover {
    background: var(--solus-surface-hover);
    color: var(--solus-text-secondary);
  }
  .status-tab.active {
    background: var(--solus-accent-light);
    color: var(--solus-accent);
  }
  .tab-count {
    font-variant-numeric: tabular-nums;
    opacity: 0.7;
  }
  .status-label-short {
    display: none;
  }

  .collection-chips {
    display: flex;
    gap: 0.25rem;
    flex-shrink: 0;
  }
  .collection-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.6875rem;
    padding: 0.25rem 0.5rem;
    border-radius: 0.5rem;
    border: 0.0625rem solid var(--solus-container-border);
    background: transparent;
    color: var(--solus-text-secondary);
    cursor: pointer;
    white-space: nowrap;
    transition:
      background 0.1s ease,
      color 0.1s ease,
      border-color 0.1s ease;
  }
  .collection-chip:hover {
    background: var(--solus-accent-light);
    color: var(--solus-text-primary);
  }
  .collection-chip.active {
    background: var(--solus-accent-light);
    color: var(--solus-accent);
    border-color: var(--solus-accent-border);
  }

  .dot {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 0.5625rem;
    height: 0.5625rem;
    font-size: 0.5625rem;
    line-height: 1;
  }
  .dot-pending {
    border-radius: 624.9375rem;
    background: var(--solus-accent);
  }
  .dot-accepted {
    color: var(--solus-status-complete);
  }
  .dot-rejected {
    color: var(--solus-text-muted);
  }

  .gallery-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 1rem;
    scrollbar-width: thin;
    overscroll-behavior-y: contain;
  }
  .pill-scroll {
    padding: 0.375rem 0.375rem;
  }
  .pill-divider {
    height: 0.0625rem;
    margin: 0.375rem 0.625rem;
    background: var(--solus-container-border);
  }
  .pill-section-header {
    display: flex;
    align-items: center;
    gap: 0.3125rem;
    font-size: 0.6563rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--solus-text-tertiary);
    padding: 0.5rem 0.875rem 0.25rem 0.875rem;
  }

  .card-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.5rem;
    margin-bottom: 0.25rem;
  }
  /* Column count tracks the pane's own width (container), so a narrow split
     pane on desktop drops to fewer columns instead of cramming three in. */
  @container plans-gallery (max-width: 56.25rem) {
    .card-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  @container plans-gallery (max-width: 40rem) {
    .card-grid {
      grid-template-columns: 1fr;
    }
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 3rem 1rem;
    gap: 0.25rem;
  }
  .empty-title {
    font-size: 0.8125rem;
    color: var(--solus-text-secondary);
    font-weight: 500;
  }
  .empty-sub {
    font-size: 0.75rem;
    color: var(--solus-text-tertiary);
  }

  /* Touch devices zoom the viewport when focusing an input under 16px — pin the
     search to 16px so focusing it never triggers that jump. */
  @media (pointer: coarse) {
    :global(.gallery-search .inp) {
      font-size: 16px;
    }
  }

  /* ── Mobile (pill mode) ── */
  @media (max-width: 767px) {
    .gallery-search {
      gap: 0.5rem;
      padding: 0.25rem 0.625rem 0.625rem 0.625rem;
    }
    .gallery-filters {
      flex-wrap: nowrap;
      gap: 0.375rem;
      padding: 0 0.625rem 0.625rem 0.625rem;
    }
    .status-tabs {
      flex: 1 1 auto;
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 0.125rem;
    }
    .status-tab {
      justify-content: center;
      gap: 0.1875rem;
      min-width: 0;
      padding: 0.25rem 0.1875rem;
      border-radius: 0.4375rem;
      font-size: 0.6563rem;
    }
    .status-label-full {
      display: none;
    }
    .status-label-short {
      display: inline;
    }
    .collection-chip {
      justify-content: center;
      width: 1.875rem;
      padding: 0.25rem 0;
      border-radius: 0.4375rem;
    }
    .collection-chip-label {
      display: none;
    }
    .dot {
      width: 0.5rem;
      height: 0.5rem;
      font-size: 0.5rem;
    }
  }
</style>
