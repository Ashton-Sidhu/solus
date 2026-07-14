<script lang="ts">
  import { fly } from "svelte/transition";
  import { tick, untrack } from "svelte";
  import { Input } from "../ui/input";
  import {
    MagnifyingGlassIcon,
    XIcon,
    FileTextIcon,
    GraphIcon,
    TrashIcon,
    PushPinIcon,
    PushPinSlashIcon,
    PlusIcon,
    UploadSimpleIcon,
    BooksIcon,
  } from "phosphor-svelte";
  import type { Work } from "../../../shared/types";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { getWindowContext } from "../../contexts/window.context.svelte";
  import { runtime } from "../../contexts/runtime.svelte";
  import {
    useKeybinding,
    useScope,
  } from "../../lib/keybindings/use-keybinding.svelte";
  import {
    formatTimeAgo,
    getDateGroup,
    matchesOpenProjects,
    type DateGroup,
  } from "../../lib/sessionUtils";
  import { PAGE_PRIMARY_BTN } from "../../lib/page-chrome";
  import PageShell from "../ui/PageShell.svelte";
  import PageHeader from "../ui/PageHeader.svelte";
  import SearchField from "../ui/search-field";
  import SegmentedControl from "../ui/SegmentedControl.svelte";
  import SectionLabel from "../ui/SectionLabel.svelte";
  import SortMenu from "../ui/SortMenu.svelte";
  import FolioCard from "./FolioCard.svelte";

  type SortMode = "updated" | "created" | "title";
  type TypeFilter = "all" | "doc" | "slides" | "diagram";

  const session = getWorkspaceContext();
  const windowCtx = getWindowContext();

  const isEditorMode = $derived(
    windowCtx.viewMode === "editor" || windowCtx.isWeb,
  );
  const open = $derived(session.folioGalleryOpen);

  let query = $state("");
  let selectedIndex = $state(0);
  let searchEl: HTMLInputElement | HTMLTextAreaElement | null = $state(null);
  let scrollEl: HTMLDivElement | null = $state(null);
  let sortMode = $state<SortMode>("updated");
  let typeFilter = $state<TypeFilter>("all");
  let newMenuOpen = $state(false);
  let mouseHasMoved = $state(false);

  const SORT_OPTIONS: { value: SortMode; label: string }[] = [
    { value: "updated", label: "Last updated" },
    { value: "created", label: "Date created" },
    { value: "title", label: "Title" },
  ];

  $effect(() => {
    if (open) {
      query = "";
      selectedIndex = 0;
      newMenuOpen = false;
      mouseHasMoved = false;
      void session.worksStore.loadAll(session.galleryProjectPath);
      if (!runtime.shouldSuppressFocus) {
        tick().then(() => searchEl?.focus());
      }
    }
  });

  function sortWorks(a: Work, b: Work): number {
    // Pinned always float to the top.
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    if (sortMode === "title") return a.title.localeCompare(b.title);
    const key = sortMode === "created" ? "createdAt" : "updatedAt";
    return new Date(b[key]).getTime() - new Date(a[key]).getTime();
  }

  // Scoped to the projects with open sessions in the sidebar.
  const scopeRoots = $derived(session.openProjectScopeRoots);
  const multiProject = $derived(session.openProjectKeys.length > 1);

  function projectShort(cwd: string): string {
    const dir = cwd?.replace(/\/$/, "");
    if (!dir || dir === "~") return "~";
    const parts = dir.split("/");
    return parts[parts.length - 1] || "~";
  }

  /** Works under an open project (minus a pending delete) — the visible universe. */
  const scopedWorks: Work[] = $derived(
    Object.values(session.worksStore.works).filter(
      (w) =>
        session.pendingWorkDelete?.id !== w.id &&
        matchesOpenProjects(w.cwd, scopeRoots),
    ),
  );

  // Counts stay over the unfiltered universe so the segment badges hold steady
  // while the user types a query.
  const typeCounts = $derived.by(() => {
    let doc = 0;
    let diagram = 0;
    for (const w of scopedWorks) {
      if (w.type === "diagram") diagram++;
      else if (w.type === "doc") doc++;
    }
    return { all: scopedWorks.length, doc, diagram };
  });

  const typeSegments = $derived([
    { value: "all" as TypeFilter, label: "All", count: typeCounts.all },
    { value: "doc" as TypeFilter, label: "Docs", count: typeCounts.doc },
    { value: "diagram" as TypeFilter, label: "Diagrams", count: typeCounts.diagram },
  ]);

  const filtered: Work[] = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return scopedWorks
      .filter((w) => {
        if (typeFilter !== "all" && w.type !== typeFilter) return false;
        if (!q) return true;
        return (
          w.title.toLowerCase().includes(q) ||
          w.preview.toLowerCase().includes(q)
        );
      })
      .sort(sortWorks);
  });

  // ── Card-grid variant: Pinned section + date groups (mirrors Plans) ──
  const dateGroupOrder: DateGroup[] = [
    "Today",
    "Yesterday",
    "This week",
    "This month",
    "Older",
  ];
  const folioPinned: Work[] = $derived(filtered.filter((w) => w.pinned));
  const folioDateGroups: { label: DateGroup; items: Work[] }[] = $derived.by(
    () => {
      const rest = filtered.filter((w) => !w.pinned);
      const groups = new Map<DateGroup, Work[]>();
      for (const w of rest) {
        const g = getDateGroup(new Date(w.updatedAt).getTime());
        let arr = groups.get(g);
        if (!arr) {
          arr = [];
          groups.set(g, arr);
        }
        arr.push(w);
      }
      return dateGroupOrder
        .filter((g) => groups.has(g))
        .map((g) => ({ label: g, items: groups.get(g)! }));
    },
  );

  $effect(() => {
    query;
    selectedIndex = 0;
  });

  $effect(() => {
    if (selectedIndex >= filtered.length && filtered.length > 0)
      selectedIndex = 0;
  });

  $effect(() => {
    if (!open) return;
    selectedIndex;
    filtered.length;
    tick().then(() => {
      const el = scrollEl?.querySelector<HTMLElement>('[data-selected="true"]');
      el?.scrollIntoView({ block: "nearest" });
    });
  });

  useScope("folio-gallery", { active: () => open });

  useKeybinding("folio-gallery.close", () => close(), { enabled: () => open });
  useKeybinding("folio-gallery.focus-search", () => searchEl?.focus(), {
    enabled: () => open && document.activeElement !== searchEl,
  });
  useKeybinding(
    "folio-gallery.open",
    () => {
      const w = filtered[selectedIndex];
      if (w) handleOpen(w);
    },
    { enabled: () => open && filtered.length > 0 },
  );
  useKeybinding(
    "folio-gallery.next",
    () => {
      selectedIndex = Math.min(selectedIndex + 1, filtered.length - 1);
    },
    { enabled: () => open && filtered.length > 0 },
  );
  useKeybinding(
    "folio-gallery.prev",
    () => {
      selectedIndex = Math.max(selectedIndex - 1, 0);
    },
    { enabled: () => open && filtered.length > 0 },
  );
  useKeybinding(
    "folio-gallery.delete",
    () => {
      const w = filtered[selectedIndex];
      if (w) handleDelete(w);
    },
    { enabled: () => open && filtered.length > 0 },
  );

  function close() {
    session.folioGalleryOpen = false;
  }

  function handleOpen(w: Work) {
    session.openWorkModal(w.id);
  }

  /** Delete a work (with global undo toast) and keep the selection in range. */
  function handleDelete(w: Work) {
    session.requestWorkDelete(w);
    const newLen = untrack(() => filtered.length);
    if (selectedIndex >= newLen && newLen > 0) selectedIndex = newLen - 1;
    void tick().then(() => searchEl?.focus());
  }

  function togglePin(w: Work, e: Event) {
    e.stopPropagation();
    void session.worksStore.setPinned(w.id, !w.pinned);
  }

  function duplicateWork(w: Work, e: Event) {
    e.stopPropagation();
    void session.worksStore.duplicate(w.id).then((duplicated) => {
      const index = filtered.findIndex((item) => item.id === duplicated.id);
      if (index !== -1) selectedIndex = index;
      searchEl?.focus();
    });
  }

  function createNew(type: "doc" | "diagram") {
    newMenuOpen = false;
    void session.createBlankWork(type);
  }

  let importInput: HTMLInputElement | null = $state(null);

  function triggerImport() {
    newMenuOpen = false;
    importInput?.click();
  }

  async function onImportFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ""; // allow re-importing the same file
    if (!file) return;
    const text = await file.text();
    const title =
      file.name.replace(/\.(md|markdown|txt)$/i, "") || "Imported document";
    await session.createWorkFromContent(title, "doc", text);
  }

</script>

<!-- Mirrors PlanCard: a tone-tinted accent rail, a meta header with actions,
     a one-line title, and a two-line preview. Docs show their body preview;
     diagrams (which have no body text) show a quiet type label. -->
{#snippet gridCard(w: Work, i: number)}
  <FolioCard
    work={w}
    selected={i === selectedIndex}
    showProject={multiProject}
    onOpen={() => handleOpen(w)}
    onTogglePin={(event) => togglePin(w, event)}
    onDuplicate={(event) => duplicateWork(w, event)}
    onDelete={() => handleDelete(w)}
    onHover={() => { if (mouseHasMoved) selectedIndex = i; }}
  />
{/snippet}

{#if open && isEditorMode}
  <div
    class="folio-inline relative flex flex-col flex-1 min-h-0"
    role="dialog"
    aria-label="Folio gallery"
    tabindex="-1"
  >
    <PageShell onClose={close}>
      <PageHeader
        title="Folio"
        subtitle="Documents and diagrams from your sessions."
      >
        {#snippet icon()}
          <BooksIcon size={18} weight="fill" />
        {/snippet}
        {#snippet actions()}
          <div class="new-menu-wrap">
            <button
              type="button"
              class={PAGE_PRIMARY_BTN}
              onclick={() => (newMenuOpen = !newMenuOpen)}
              aria-haspopup="menu"
              aria-expanded={newMenuOpen}
              data-testid="folio-new"
            >
              <PlusIcon size={13} weight="bold" />
              <span>New</span>
            </button>
            {#if newMenuOpen}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div class="new-menu" role="menu">
                <button type="button" role="menuitem" class="new-menu__item" onclick={() => createNew("doc")}>
                  <FileTextIcon size={14} /> Document
                </button>
                <button type="button" role="menuitem" class="new-menu__item" onclick={() => createNew("diagram")}>
                  <GraphIcon size={14} /> Diagram
                </button>
                <button type="button" role="menuitem" class="new-menu__item" onclick={triggerImport}>
                  <UploadSimpleIcon size={14} /> Import .md…
                </button>
              </div>
            {/if}
          </div>
        {/snippet}
      </PageHeader>

      <!-- ── Command bar: search + type segments + sort ── -->
      <div class="flex flex-wrap items-center gap-2 pb-4">
        <SearchField
          bind:ref={searchEl}
          bind:value={query}
          placeholder="Search documents…"
        />
        <SegmentedControl
          options={typeSegments}
          isActive={(v) => typeFilter === v}
          onSelect={(v) => (typeFilter = v)}
          ariaLabel="Filter by type"
        />
        <div class="ml-auto flex shrink-0 items-center gap-1">
          <SortMenu
            bind:value={sortMode}
            options={SORT_OPTIONS}
            ariaLabel="Sort works"
          />
        </div>
      </div>

      <div
        bind:this={scrollEl}
        class="outline-none"
        role="listbox"
        tabindex="-1"
        onmousemove={() => { mouseHasMoved = true; }}
      >
        {#if filtered.length === 0}
          <div class="empty">
            <p class="empty-title">{query ? "No matches." : "No documents yet."}</p>
            {#if !query}
              <p class="empty-sub">Press <span class="empty-kbd">New</span> to start one, or ask the agent to write a document.</p>
            {/if}
          </div>
        {:else}
          {#if folioPinned.length > 0}
            <SectionLabel label="Pinned" count={folioPinned.length}>
              {#snippet icon()}
                <PushPinIcon size={12} weight="fill" class="text-(--solus-accent)" />
              {/snippet}
            </SectionLabel>
            <div class="card-grid">
              {#each folioPinned as w, i (w.id)}
                {@render gridCard(w, i)}
              {/each}
            </div>
          {/if}
          {#each folioDateGroups as group}
            {@const groupOffset =
              folioPinned.length +
              folioDateGroups
                .slice(0, folioDateGroups.indexOf(group))
                .reduce((n, g) => n + g.items.length, 0)}
            <SectionLabel label={group.label} count={group.items.length} />
            <div class="card-grid">
              {#each group.items as w, j (w.id)}
                {@render gridCard(w, groupOffset + j)}
              {/each}
            </div>
          {/each}
        {/if}
      </div>
    </PageShell>
  </div>
{/if}

{#if open && !isEditorMode}
  <div
    class="folio-inline-pill flex flex-col flex-1 min-h-0"
    style="max-height:var(--pill-body-max)"
    transition:fly={{ y: 8, duration: 160 }}
    role="dialog"
    aria-label="Folio gallery"
    tabindex="-1"
  >
    <div class="gallery-top">
      <div class="flex items-center justify-between px-4 pt-3 pb-2">
        <span class="gallery-title">Folio</span>
        <div class="flex items-center gap-1">
          <div class="new-menu-wrap">
            <button
              type="button"
              class="new-btn"
              onclick={() => (newMenuOpen = !newMenuOpen)}
              aria-haspopup="menu"
              aria-expanded={newMenuOpen}
            >
              <PlusIcon size={12} weight="bold" />
              <span>New</span>
            </button>
            {#if newMenuOpen}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div class="new-menu" role="menu">
                <button type="button" role="menuitem" class="new-menu__item" onclick={() => createNew("doc")}>
                  <FileTextIcon size={14} /> Document
                </button>
                <button type="button" role="menuitem" class="new-menu__item" onclick={() => createNew("diagram")}>
                  <GraphIcon size={14} /> Diagram
                </button>
                <button type="button" role="menuitem" class="new-menu__item" onclick={triggerImport}>
                  <UploadSimpleIcon size={14} /> Import .md…
                </button>
              </div>
            {/if}
          </div>
          <button
            type="button"
            class="close-btn"
            onclick={close}
            aria-label="Close"
          >
            <XIcon size={14} />
          </button>
        </div>
      </div>
      <div class="gallery-search">
        <MagnifyingGlassIcon
          size={14}
          class="text-(--solus-text-tertiary) flex-shrink-0"
        />
        <Input
          bind:ref={searchEl}
          bind:value={query}
          type="text"
          class="h-auto rounded-none border-0 bg-transparent p-0 text-[0.7813rem] shadow-none focus-visible:ring-0 dark:bg-transparent"
          placeholder="Search documents…"
          onkeydown={(e) => {
            if (e.key === "Enter" && runtime.isMobileViewport) {
              e.stopPropagation();
              e.preventDefault();
              (e.target as HTMLInputElement)?.blur();
            }
          }}
        />
      </div>
    </div>

    <div
      bind:this={scrollEl}
      class="gallery-scroll pill-scroll"
      role="listbox"
      tabindex="-1"
    >
      {#if filtered.length === 0}
        <div class="empty">
          <p class="empty-title">
            {query ? "No matches." : "No documents yet."}
          </p>
          {#if !query}
            <p class="empty-sub">
              Press New to start one, or ask the agent to write a document.
            </p>
          {/if}
        </div>
      {:else}
        {#each filtered as w, i (w.id)}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="pill-work-row"
            data-selected={i === selectedIndex ? "true" : null}
            onclick={() => handleOpen(w)}
            role="option"
            aria-selected={i === selectedIndex}
            tabindex="-1"
          >
            {#if w.type === "diagram"}
              <GraphIcon
                size={13}
                class="flex-shrink-0 text-(--solus-text-tertiary)"
              />
            {:else}
              <FileTextIcon
                size={13}
                class="flex-shrink-0 text-(--solus-text-tertiary)"
              />
            {/if}
            <div class="pill-work-body">
              <span class="pill-work-title">{w.title}</span>
              <span class="pill-work-end">
                {#if multiProject}
                  <span class="pill-work-project" title={w.cwd}>{projectShort(w.cwd)}</span>
                {/if}
                <span class="pill-work-time">{formatTimeAgo(w.updatedAt)}</span>
              </span>
            </div>
            <button
              type="button"
              class="pin-btn"
              class:pinned={w.pinned}
              onclick={(e) => togglePin(w, e)}
              aria-label={w.pinned ? "Unpin" : "Pin"}
              title={w.pinned ? "Unpin" : "Pin"}
            >
              {#if w.pinned}
                <PushPinSlashIcon size={11} />
              {:else}
                <PushPinIcon size={11} />
              {/if}
            </button>
            <button
              type="button"
              class="delete-btn"
              onclick={(e) => { e.stopPropagation(); handleDelete(w); }}
              aria-label="Delete"
              title="Delete (⌥⌫)"
            >
              <TrashIcon size={11} />
            </button>
          </div>
        {/each}
      {/if}
    </div>
  </div>
{/if}

<input
  bind:this={importInput}
  type="file"
  accept=".md,.markdown,.txt,text/markdown,text/plain"
  class="sr-only-input"
  onchange={onImportFile}
  tabindex="-1"
  aria-hidden="true"
/>

<style>
  .folio-inline {
    background: var(--solus-container-bg);
    overflow: hidden;
    /* Query container so the command bar responds to the pane's own width
       (e.g. a split pane on desktop), not just the viewport. */
    container: folio-gallery / inline-size;
  }
  .folio-inline-pill {
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
  .close-btn {
    position: relative;
    width: 1.5rem;
    height: 1.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 0.375rem;
    border: none;
    background: transparent;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    transition:
      background 0.1s ease,
      color 0.1s ease;
  }

  @media (pointer: coarse) {
    .close-btn::before,
    .delete-btn::before {
      content: "";
      position: absolute;
      top: 50%;
      left: 50%;
      width: max(100%, 3rem);
      height: max(100%, 3rem);
      transform: translate(-50%, -50%);
    }
    /* Touch devices zoom the viewport when focusing an input under 16px — pin
       the search to 16px so focusing it never triggers that jump. */
    :global(.gallery-search .inp) {
      font-size: 16px;
    }
  }
  .close-btn:hover {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }

  /* Search row (pill mode): its own gutter. */
  .gallery-search {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.25rem 1rem 0.625rem 1rem;
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
    padding: 0.375rem;
  }

  .delete-btn {
    position: relative;
    width: 1.25rem;
    height: 1.25rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 0.3125rem;
    border: none;
    background: transparent;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    opacity: 0;
    transition:
      opacity 0.15s ease,
      background 0.15s ease,
      color 0.15s ease;
  }
  .pill-work-row:hover .delete-btn {
    opacity: 1;
  }
  .delete-btn:hover {
    background: color-mix(
      in srgb,
      var(--solus-status-error, #e53e3e) 12%,
      transparent
    );
    color: var(--solus-status-error, #e53e3e);
  }

  /* Pin button mirrors the delete affordance (reveal on hover). */
  .pin-btn {
    position: relative;
    width: 1.25rem;
    height: 1.25rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 0.3125rem;
    border: none;
    background: transparent;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    opacity: 0;
    transition:
      opacity 0.15s ease,
      background 0.15s ease,
      color 0.15s ease;
  }
  .pill-work-row:hover .pin-btn {
    opacity: 1;
  }
  .pin-btn:hover {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }
  /* A pinned work shows its pin even when not hovered. */
  .pin-btn.pinned {
    opacity: 1;
    color: var(--solus-accent);
  }

  /* ── Pill work rows ── */
  .pill-work-row {
    display: flex;
    align-items: center;
    gap: 0.5625rem;
    padding: 0.5rem 0.625rem;
    border-radius: 0.5rem;
    cursor: pointer;
    transition: background 0.1s ease;
    user-select: none;
  }
  .pill-work-row:hover {
    background: var(--solus-surface-hover);
  }
  .pill-work-body {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .pill-work-title {
    font-size: 0.7813rem;
    font-weight: 500;
    color: var(--solus-text-primary);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .pill-work-end {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
    min-width: 0;
  }

  .pill-work-project {
    font-size: 0.625rem;
    color: var(--solus-text-tertiary);
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    max-width: 5rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pill-work-time {
    font-size: 0.6563rem;
    color: var(--solus-text-tertiary);
    white-space: nowrap;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    flex-shrink: 0;
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 3rem 1rem;
    gap: 0.25rem;
    text-align: center;
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

  /* ── Card-grid (Plans-style) ── */
  .card-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.5rem;
    margin-bottom: 0.25rem;
  }
  /* Column count tracks the pane's own width (container), mirroring Plans. */
  @container folio-gallery (max-width: 56.25rem) {
    .card-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  @container folio-gallery (max-width: 40rem) {
    .card-grid {
      grid-template-columns: 1fr;
    }
  }

  /* ── New button + menu ── */
  .new-menu-wrap {
    position: relative;
  }
  .new-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    padding: 0.25rem 0.5rem;
    border-radius: 0.4375rem;
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--solus-accent);
    background: var(--solus-accent-light);
    border: none;
    cursor: pointer;
    transition: background var(--duration-quick, 0.12s) ease;
  }
  .new-btn:hover {
    background: color-mix(in srgb, var(--solus-accent-light) 100%, var(--solus-accent) 12%);
  }
  .new-menu {
    position: absolute;
    top: calc(100% + 0.25rem);
    right: 0;
    z-index: 40;
    min-width: 9rem;
    padding: 0.25rem;
    border-radius: 0.625rem;
    background: var(--solus-popover-bg);
    border: 0.0625rem solid var(--solus-popover-border);
    box-shadow: var(--solus-popover-shadow);
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }
  .new-menu__item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.5rem;
    border-radius: 0.4375rem;
    font-size: 0.75rem;
    color: var(--solus-text-primary);
    background: transparent;
    border: none;
    cursor: pointer;
    text-align: left;
    transition: background var(--duration-quick, 0.12s) ease;
  }
  .new-menu__item:hover {
    background: var(--solus-surface-hover);
  }

  .empty-kbd {
    font-weight: 600;
    color: var(--solus-accent);
  }

  .sr-only-input {
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
