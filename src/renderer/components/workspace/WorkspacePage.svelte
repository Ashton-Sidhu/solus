<script lang="ts">
  import { tick, untrack } from "svelte";
  import {
    BooksIcon,
    CaretDownIcon,
    FileTextIcon,
    GraphIcon,
    ListIcon,
    PlusIcon,
    RowsIcon,
    UploadSimpleIcon,
    XIcon,
  } from "phosphor-svelte";
  import type { PlanDescriptor, Work } from "../../../shared/types";
  import { planKey } from "../../../shared/types";
  import { getWorkspaceContext, getPlanStore, getWindowContext, runtime } from "../../contexts";
  import { blurActiveTextInputOnMobile } from "../../lib/inputFocus";
  import { useKeybinding, useScope } from "../../lib/keybindings/use-keybinding.svelte";
  import { PAGE_ICON_BTN, PAGE_PRIMARY_BTN, PAGE_SECONDARY_BTN } from "../../lib/page-chrome";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import PageEmpty from "../ui/PageEmpty.svelte";
  import Kbd from "../ui/Kbd.svelte";
  import SortMenu from "../ui/SortMenu.svelte";
  import WorkspaceRail from "./WorkspaceRail.svelte";
  import WorkspaceRow from "./WorkspaceRow.svelte";
  import WorkspacePeek from "./WorkspacePeek.svelte";
  import WorkspaceProjectSwitcher from "./WorkspaceProjectSwitcher.svelte";
  import WorkspaceSearchField from "./WorkspaceSearchField.svelte";
  import type { StatusFilter, WorkspaceFilter, WorkspaceItem } from "./lib/workspace-items";
  import {
    DEFAULT_FILTER,
    applyFilter,
    bucketFor,
    buildWorkspaceItems,
    groupItems,
    isDefaultFilter,
  } from "./lib/workspace-items";

  const session = getWorkspaceContext();
  const planStore = getPlanStore();
  const windowCtx = getWindowContext();

  const PINNED_PREVIEW = 6;
  const RENDER_PAGE = 80;
  const DENSITY_KEY = "solus.workspace.density";
  const PINNED_COLLAPSED_KEY = "solus.workspace.pinned-collapsed";
  const PROJECT_SCOPE_KEY = "solus.workspace.project";

  const isEditorMode = $derived(windowCtx.viewMode === "editor" || windowCtx.isWeb);
  const open = $derived(session.router.at("folio"));

  // ── Data ──
  const descriptorsKey = planStore.descriptorCacheKey(undefined, true);
  const descriptors: PlanDescriptor[] = $derived(
    planStore.cachedDescriptorKey === descriptorsKey ? planStore.cachedDescriptors : [],
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
  const loadingLabel = $derived(
    plansLoading && worksLoading
      ? "loading plans and documents"
      : plansLoading
        ? "loading plans"
        : "loading documents",
  );

  // ── Project scope: which open project the ledger is showing (null = all).
  //    It sits above the filters — every facet count is counted inside it — and
  //    persists, so reopening the Workspace lands back in the same project. ──
  let projectScope = $state<string | null>(localStorage.getItem(PROJECT_SCOPE_KEY));
  // With a single project open, "all projects" *is* that project — name it,
  // rather than making the scope read wider than it is.
  const scopedProject = $derived(
    openProjects.find((project) => project.key === projectScope) ??
      (openProjects.length === 1 ? openProjects[0] : null),
  );
  const scopedProjectKey = $derived(scopedProject?.key ?? null);
  const items: WorkspaceItem[] = $derived(
    scopedProject ? allItems.filter((item) => item.projectKey === scopedProject.key) : allItems,
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

  function selectProject(key: string | null) {
    projectScope = key;
    if (key) localStorage.setItem(PROJECT_SCOPE_KEY, key);
    else localStorage.removeItem(PROJECT_SCOPE_KEY);
  }

  function load() {
    const ipcCtx = untrack(() => session.ctx);
    void planStore.getDescriptors(undefined, true, ipcCtx).catch(() => {});
    void session.worksStore.loadAll(session.galleryProjectPath);
  }

  // ── Filter + view state ──
  const filter = $state<WorkspaceFilter>({ ...DEFAULT_FILTER });
  let density = $state<"comfortable" | "compact">(
    localStorage.getItem(DENSITY_KEY) === "compact" ? "compact" : "comfortable",
  );
  let pinnedCollapsed = $state(localStorage.getItem(PINNED_COLLAPSED_KEY) === "true");
  let pinnedExpanded = $state(false);
  let selectedIndex = $state(0);
  let renderLimit = $state(RENDER_PAGE);
  let searchEl: HTMLInputElement | null = $state(null);
  let scrollEl: HTMLDivElement | null = $state(null);
  let mouseHasMoved = $state(false);

  const compact = $derived(density === "compact");
  const searching = $derived(!isDefaultFilter(filter));

  function setDensity(value: "comfortable" | "compact") {
    density = value;
    localStorage.setItem(DENSITY_KEY, value);
  }

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

  $effect(() => {
    if (open) {
      clearFilters();
      selectedIndex = 0;
      renderLimit = RENDER_PAGE;
      pinnedExpanded = false;
      mouseHasMoved = false;
      load();
      blurActiveTextInputOnMobile();
      if (!runtime.shouldSuppressFocus) {
        tick().then(() => searchEl?.focus());
      }
    }
  });

  // ── Derived ledger ──
  const filtered: WorkspaceItem[] = $derived(applyFilter(items, filter));
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
    const out: { key: string; label: string; total: number; items: WorkspaceItem[] }[] = [];
    for (const group of grouped.groups) {
      if (budget <= 0) break;
      const slice = group.items.slice(0, budget);
      budget -= slice.length;
      out.push({ key: group.key, label: group.label, total: group.items.length, items: slice });
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
  const selectedItem: WorkspaceItem | null = $derived(flat[selectedIndex] ?? null);

  // ── Rail counts: each axis counted with its own facet released, so the
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
    applyFilter(items, { ...filter, pinnedOnly: false }).filter((i) => i.pinned).length,
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

  // ── Selection bookkeeping ──
  $effect(() => {
    filter.type;
    filter.status;
    filter.pinnedOnly;
    filter.time;
    filter.text;
    // `openProjects` is rebuilt from the mounted tabs. Track the effective key,
    // not the reconstructed project object, or a background data refresh can
    // reset a hovered row to the first item even though the scope did not move.
    scopedProjectKey;
    selectedIndex = 0;
    renderLimit = RENDER_PAGE;
    pinnedExpanded = false;
  });

  $effect(() => {
    if (selectedIndex >= flat.length && flat.length > 0) selectedIndex = 0;
  });

  $effect(() => {
    if (!open) return;
    selectedIndex;
    flat.length;
    tick().then(() => {
      const el = scrollEl?.querySelector<HTMLElement>('[data-selected="true"]');
      el?.scrollIntoView({ block: "nearest" });
    });
  });

  function handleLedgerScroll() {
    const el = scrollEl;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 400) {
      const total = grouped.groups.reduce((n, g) => n + g.items.length, 0);
      if (renderLimit < total) renderLimit += RENDER_PAGE;
    }
  }

  // ── Keyboard ──
  useScope("workspace", { active: () => open });

  useKeybinding("workspace.close", () => close(), { enabled: () => open });
  useKeybinding("workspace.focus-search", () => searchEl?.focus(), {
    enabled: () => open && document.activeElement !== searchEl,
  });
  useKeybinding("workspace.open", () => { if (selectedItem) void openItem(selectedItem); }, { enabled: () => open && flat.length > 0 });
  useKeybinding("workspace.resume", () => { if (selectedItem) void resumeItem(selectedItem); }, { enabled: () => open && flat.length > 0 });
  useKeybinding("workspace.next", () => { selectedIndex = Math.min(selectedIndex + 1, flat.length - 1); }, { enabled: () => open && flat.length > 0 });
  useKeybinding("workspace.prev", () => { selectedIndex = Math.max(selectedIndex - 1, 0); }, { enabled: () => open && flat.length > 0 });
  useKeybinding("workspace.toggle-pin", () => { if (selectedItem) togglePin(selectedItem); }, { enabled: () => open && flat.length > 0 });

  // ── Actions ──
  function close() {
    session.router.close("folio");
  }

  async function openItem(item: WorkspaceItem) {
    if (item.source.kind === "plan") await session.openPlanFromDescriptor(item.source.descriptor);
    else await session.openWorkModal(item.id);
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

  function togglePin(item: WorkspaceItem) {
    if (item.source.kind === "work") {
      void session.worksStore.setPinned(item.id, !item.pinned);
      return;
    }
    const d = item.source.descriptor;
    const nowPinned = !d.bookmarked;
    d.bookmarked = nowPinned;
    d.bookmarkedAt = nowPinned ? Date.now() : undefined;
    const plan = planStore.get(planKey(d.sessionId, d.planToolUseId));
    if (plan) {
      plan.bookmarked = nowPinned;
      plan.bookmarkedAt = d.bookmarkedAt;
    }
    window.solus.toggleBookmarkPlan(d.sessionId, d.projectPath, d.cwd, d.planToolUseId, d.title);
  }

  /** Works only — a plan is a session artifact and has no delete. */
  function deleteItem(item: WorkspaceItem) {
    if (item.source.kind !== "work") return;
    session.requestWorkDelete(item.source.work);
    void tick().then(() => searchEl?.focus());
  }

  function createNew(type: "doc" | "diagram") {
    void session.createBlankWork(type);
  }

  let importInput: HTMLInputElement | null = $state(null);

  async function onImportFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    const text = await file.text();
    const title = file.name.replace(/\.(md|markdown|txt)$/i, "") || "Imported document";
    await session.createWorkFromContent(title, "doc", text);
  }
</script>

{#snippet ledgerRow(item: WorkspaceItem, index: number)}
  <WorkspaceRow
    {item}
    selected={index === selectedIndex}
    {compact}
    {showProject}
    onOpen={() => openItem(item)}
    onTogglePin={() => togglePin(item)}
    onDelete={item.source.kind === "work" ? () => deleteItem(item) : undefined}
    onHover={() => {
      if (mouseHasMoved) selectedIndex = index;
    }}
  />
{/snippet}

{#if open}
  <div
    class="workspace-root relative flex min-h-0 flex-1 flex-col"
    style={isEditorMode ? "" : "max-height:var(--pill-body-max)"}
    role="dialog"
    aria-label="Workspace"
    tabindex="-1"
  >
    <div class="flex min-h-0 flex-1">
      <div class="workspace-rail-host">
        <WorkspaceRail
          {filter}
          {projectOptions}
          projectScope={scopedProject?.key ?? null}
          onSelectProject={selectProject}
          {typeCounts}
          {timeCounts}
          {pinnedCount}
          {needsReviewCount}
          totalCount={items.length}
          allProjectsCount={allItems.length}
        />
      </div>

      <div class="flex min-w-0 flex-1 flex-col">
        <!-- ── Toolbar: search · density · status · New ── -->
        <div class="flex shrink-0 items-center gap-2.5 px-6 pb-3 pt-5 @max-[44rem]:px-4">
          <!-- The scope control lives in the rail; when the rail folds away it
               moves here so the ledger's scope is never invisible. -->
          <div class="workspace-scope-host">
            <WorkspaceProjectSwitcher
              options={projectOptions}
              value={scopedProject?.key ?? null}
              allCount={allItems.length}
              onSelect={selectProject}
              compact
            />
          </div>
          <WorkspaceSearchField
            {filter}
            totalCount={items.length}
            matches={searching ? filtered.length : null}
            bind:ref={searchEl}
          />
          <div class="workspace-density flex shrink-0 items-center gap-0.5 rounded-[0.625rem] bg-[color-mix(in_srgb,var(--muted)_62%,transparent)] p-[0.1875rem]">
            <button
              type="button"
              class="density-btn"
              class:active={!compact}
              onclick={() => setDensity("comfortable")}
              aria-label="Comfortable rows"
              aria-pressed={!compact}
              title="Comfortable rows"
            >
              <ListIcon size={13} />
            </button>
            <button
              type="button"
              class="density-btn"
              class:active={compact}
              onclick={() => setDensity("compact")}
              aria-label="Compact rows"
              aria-pressed={compact}
              title="Compact rows"
            >
              <RowsIcon size={13} />
            </button>
          </div>
          <SortMenu
            bind:value={filter.status}
            options={STATUS_OPTIONS}
            ariaLabel="Filter by status"
            class="h-9 shrink-0 gap-1.5 rounded-lg border border-[color-mix(in_srgb,var(--solus-container-border)_80%,transparent)] bg-transparent px-2.5 py-0 text-[12.5px] font-medium text-(--solus-text-secondary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)"
          />
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              {#snippet child({ props })}
                <button
                  {...props}
                  type="button"
                  class={PAGE_PRIMARY_BTN}
                  data-testid="workspace-new"
                >
                  <PlusIcon size={13} weight="bold" />
                  <span>New</span>
                  <CaretDownIcon size={9} />
                </button>
              {/snippet}
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="end" sideOffset={6} class="w-[160px]">
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
          <button type="button" class={PAGE_ICON_BTN} onclick={close} aria-label="Close">
            <XIcon size={15} />
          </button>
        </div>

        <!-- ── Ledger ── -->
        <div
          bind:this={scrollEl}
          class="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-6 pb-4 outline-none @max-[44rem]:px-4 [scrollbar-width:thin]"
          role="listbox"
          aria-label="Workspace items"
          tabindex="-1"
          onscroll={handleLedgerScroll}
          onmousemove={() => {
            mouseHasMoved = true;
          }}
        >
          {#if loading}
            <div class="flex flex-col gap-1 pt-2" aria-hidden="true">
              {#each Array(8) as _, i (i)}
                <div
                  class="h-[2.875rem] animate-pulse rounded-[0.5625rem] bg-[color-mix(in_srgb,var(--muted)_45%,transparent)]"
                  style="opacity:{1 - i * 0.1}"
                ></div>
              {/each}
            </div>
          {:else if items.length === 0}
            <PageEmpty icon={BooksIcon} title="Nothing here yet.">
              Plans, docs and diagrams your agents produce land here.
              {#snippet actions()}
                <button type="button" class={PAGE_PRIMARY_BTN} onclick={() => createNew("doc")}>
                  <PlusIcon size={13} weight="bold" />
                  <span>New document</span>
                </button>
                <button type="button" class={PAGE_SECONDARY_BTN} onclick={() => createNew("diagram")}>
                  New diagram
                </button>
              {/snippet}
            </PageEmpty>
          {:else if filtered.length === 0}
            <PageEmpty title="No matches in this filter.">
              {#if filter.text.trim() && outsideCount > 0}
                {outsideCount} {outsideCount === 1 ? "match" : "matches"} outside the active filters.
              {:else}
                Try a different search or filter.
              {/if}
              {#snippet actions()}
                <button type="button" class={PAGE_SECONDARY_BTN} onclick={clearFilters}>
                  Clear filters
                </button>
              {/snippet}
            </PageEmpty>
          {:else}
            {#if grouped.pinned.length > 0}
              <div class="group-header">
                <button
                  type="button"
                  class="group-chevron"
                  class:collapsed={pinnedCollapsed}
                  onclick={togglePinnedCollapsed}
                  aria-label={pinnedCollapsed ? "Expand pinned" : "Collapse pinned"}
                  aria-expanded={!pinnedCollapsed}
                >
                  <CaretDownIcon size={10} weight="bold" />
                </button>
                <span class="group-label">Pinned</span>
                <span class="group-count">{grouped.pinned.length}</span>
                <span class="group-rule"></span>
                {#if pinnedOverflow > 0 || pinnedExpanded}
                  <button
                    type="button"
                    class="group-action"
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
                  class="more-pinned-row"
                  onclick={() => (pinnedExpanded = true)}
                >
                  <span class="more-pinned-caret"><CaretDownIcon size={11} weight="bold" /></span>
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
              <div class="group-header group-header--sticky">
                <span class="group-chevron-spacer"></span>
                <span class="group-label">{group.label}</span>
                <span class="group-count">{group.total}</span>
                <span class="group-rule"></span>
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
                    class="animate-pulse rounded-[0.5625rem] bg-[color-mix(in_srgb,var(--muted)_45%,transparent)]"
                    style="height:{compact ? '2.125rem' : '2.875rem'};opacity:{0.55 - i * 0.25}"
                  ></div>
                {/each}
              </div>
            {/if}
          {/if}
        </div>

        <!-- ── Footer ── -->
        <div class="workspace-footer">
          <span>Showing {flat.length} of {items.length}</span>
          {#if anyLoading}
            <span class="opacity-40">·</span>
            <span class="workspace-loading" role="status">
              <span class="workspace-loading-dot"></span>
              {loadingLabel}<span class="workspace-loading-ellipsis">…</span>
            </span>
          {/if}
          {#if hasMoreRows}
            <span class="opacity-40">·</span>
            <span>scroll to load more</span>
          {/if}
          <span class="flex-1"></span>
          <span class="workspace-footer-keys">
            <Kbd variant="hint">↑↓</Kbd> move
            <Kbd variant="hint">⏎</Kbd> open
            <Kbd variant="hint">⌥P</Kbd> pin
            <Kbd variant="hint">⌥⌫</Kbd> delete
          </span>
        </div>
      </div>

      <div class="workspace-peek-host">
        <WorkspacePeek
          item={selectedItem}
          onOpen={() => selectedItem && openItem(selectedItem)}
          onTogglePin={() => selectedItem && togglePin(selectedItem)}
          onDelete={selectedItem?.source.kind === "work"
            ? () => selectedItem && deleteItem(selectedItem)
            : undefined}
          onResume={() => selectedItem && resumeItem(selectedItem)}
        />
      </div>
    </div>
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
    background: var(--solus-container-bg);
    overflow: hidden;
    /* Query container so the rail/peek respond to the pane's own width (a
       split pane, the pill, mobile web), not the viewport. */
    container: workspace-page / inline-size;
  }

  .workspace-rail-host,
  .workspace-peek-host {
    display: contents;
  }
  /* Below ~1180px the peek pane gives its width back to the ledger; below
     ~900px the rail follows. Search tokens keep every facet reachable. */
  @container workspace-page (max-width: 71rem) {
    .workspace-peek-host {
      display: none;
    }
  }
  .workspace-scope-host {
    display: none;
    flex: 0 1 9rem;
    min-width: 0;
  }
  @container workspace-page (max-width: 56rem) {
    .workspace-rail-host {
      display: none;
    }
    .workspace-scope-host {
      display: block;
    }
  }
  @container workspace-page (max-width: 44rem) {
    .workspace-footer-keys {
      display: none;
    }
    .workspace-density {
      display: none;
    }
  }

  .density-btn {
    width: 1.75rem;
    height: 1.75rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 0.4375rem;
    background: transparent;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    transition:
      background 0.12s ease,
      color 0.12s ease;
  }
  .density-btn:hover {
    color: var(--solus-text-primary);
  }
  .density-btn.active {
    background: var(--solus-container-bg);
    color: var(--solus-text-primary);
    box-shadow: 0 0.0625rem 0.125rem color-mix(in srgb, var(--solus-text-primary) 8%, transparent);
  }

  .group-header {
    display: flex;
    align-items: center;
    gap: 0.5625rem;
    padding: 0.8125rem 0 0.4375rem;
  }
  /* Each header pins to the top of the scroll area on an opaque background, so
     the current bucket is always named, even 300 rows down. */
  .group-header--sticky {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--solus-container-bg);
  }
  .group-chevron {
    width: 0.875rem;
    height: 0.875rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    padding: 0;
    color: color-mix(in srgb, var(--solus-text-tertiary) 90%, transparent);
    cursor: pointer;
    transition: transform 0.12s ease;
  }
  .group-chevron.collapsed {
    transform: rotate(-90deg);
  }
  .group-chevron-spacer {
    width: 0.875rem;
  }
  .group-label {
    font-size: 0.6563rem;
    font-weight: 500;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: var(--solus-text-tertiary);
  }
  .group-count {
    font-size: 0.7188rem;
    font-variant-numeric: tabular-nums;
    color: color-mix(in srgb, var(--solus-text-tertiary) 70%, transparent);
  }
  .group-rule {
    flex: 1 1 auto;
    height: 0.0625rem;
    background: color-mix(in srgb, var(--solus-container-border) 40%, transparent);
  }
  .group-action {
    border: none;
    background: transparent;
    padding: 0;
    font-size: 0.7188rem;
    color: var(--solus-text-tertiary);
    cursor: pointer;
  }
  .group-action:hover {
    color: var(--solus-text-primary);
  }

  .more-pinned-row {
    width: calc(100% + 1.25rem);
    height: 2.125rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0 0.625rem;
    margin: 0 -0.625rem;
    border: none;
    border-radius: 0.5625rem;
    background: transparent;
    font-size: 0.75rem;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    transition:
      background 0.12s ease,
      color 0.12s ease;
  }
  .more-pinned-row:hover {
    background: color-mix(in srgb, var(--muted) 55%, transparent);
    color: var(--solus-text-primary);
  }
  .more-pinned-caret {
    width: 1rem;
    display: inline-flex;
    justify-content: center;
  }

  .workspace-footer {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 0.5625rem;
    padding: 0.625rem 1.5rem 0.875rem;
    border-top: 0.0625rem solid color-mix(in srgb, var(--solus-container-border) 40%, transparent);
    font-size: 0.7188rem;
    color: var(--solus-text-tertiary);
  }
  .workspace-footer-keys {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
  }

  .workspace-loading {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
  }
  .workspace-loading-dot {
    width: 0.3125rem;
    height: 0.3125rem;
    border-radius: 9999px;
    background: var(--solus-accent);
    animation: pulse-dot 1.4s ease-in-out infinite;
  }
  /* Same scanning ellipsis the session picker uses while history streams in. */
  .workspace-loading-ellipsis {
    display: inline-block;
    width: 1em;
    overflow: hidden;
    vertical-align: bottom;
    letter-spacing: 0.05em;
    animation: scanning-ellipsis 1.4s steps(4, end) infinite;
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
