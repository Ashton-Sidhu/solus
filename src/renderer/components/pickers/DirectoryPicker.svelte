<script lang="ts">
  import { fly } from "svelte/transition";
  import { Input } from "../ui/input";
  import {
    MagnifyingGlassIcon,
    FolderIcon,
    CaretRightIcon,
    HouseIcon,
    ClockCounterClockwiseIcon,
    EyeIcon,
    EyeSlashIcon,
    XIcon,
  } from "phosphor-svelte";
  import VirtualList from "svelte-tiny-virtual-list";
  import { projectsStore, getWorkspaceContext, getStatusBarContext, runtime } from "../../contexts";
  import { getPopoverLayer } from "../popoverLayer.svelte";
  import { portal } from "../portal";
  import { abbreviateHome } from "../../lib/paths";
  import { blurActiveTextInputOnMobile } from "../../lib/inputFocus";
  import Kbd from "../ui/Kbd.svelte";
  import type { DirectoryEntry } from "../../../shared/types";
  import { resolveDirectorySelection } from "./lib/directory-selection";

  interface Props {
    open: boolean;
    onClose: () => void;
    onSelect: (path: string) => void;
    initialPath?: string;
    title?: string;
    actionLabel?: string;
  }

  let {
    open = $bindable(),
    onClose,
    onSelect,
    initialPath,
    title = "Choose folder",
    actionLabel = "Select",
  }: Props = $props();

  const session = getWorkspaceContext();
  const statusBar = getStatusBarContext();
  const layer = getPopoverLayer();
  const projectMetadata = projectsStore;

  let currentPath = $state("");
  let parentPath = $state<string | null>(null);
  let entries = $state<DirectoryEntry[]>([]);
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let reloadVersion = $state(0);
  let selectedIndex = $state(-1);
  let filterQuery = $state("");
  let showHidden = $state(false);
  let popoverEl: HTMLDivElement | null = $state(null);
  let searchEl: HTMLInputElement | HTMLTextAreaElement | null = $state(null);
  let virtualList: VirtualList | null = $state(null);
  let listHeight = $state(0);

  const filteredEntries = $derived(
    filterQuery.trim()
      ? entries.filter((e) =>
          e.name.toLowerCase().includes(filterQuery.toLowerCase()),
        )
      : entries,
  );

  const dirEntries = $derived(filteredEntries.filter((e) => e.isDir));
  const shouldAutofocus = $derived(
    !runtime.shouldSuppressFocus,
  );
  const dirItemHeight = $derived(runtime.isMobileViewport ? 48 : 40);

  const breadcrumbs = $derived(
    currentPath
      .split("/")
      .filter(Boolean)
      .map((seg, i, arr) => ({
        label: seg,
        path: "/" + arr.slice(0, i + 1).join("/"),
      })),
  );

  const homePath = $derived(session.staticInfo?.homePath || "~");

  const currentFolderName = $derived(
    currentPath.split("/").filter(Boolean).pop() || "/",
  );

  const selection = $derived(
    resolveDirectorySelection(
      currentPath,
      currentFolderName,
      dirEntries,
      selectedIndex,
    ),
  );
  const selectedEntry = $derived(selection.entry);
  const selectionPath = $derived(selection.path);
  const primaryTargetName = $derived(selection.name);
  const activeDescendant = $derived(
    selectedEntry ? `directory-option-${selectedIndex}` : undefined,
  );

  const sidebarLocations = $derived([
    { label: "Home", path: homePath },
    { label: "Desktop", path: homePath + "/Desktop" },
    { label: "Documents", path: homePath + "/Documents" },
    { label: "Downloads", path: homePath + "/Downloads" },
  ]);

  function handleBackdropMousedown(e: MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  $effect(() => {
    if (!open) return;

    const startPath =
      initialPath ||
      statusBar.ctx.workingDirectory ||
      session.staticInfo?.homePath ||
      "~";
    currentPath = startPath;

    blurActiveTextInputOnMobile();

    void projectMetadata.loadRecentProjects();

    if (shouldAutofocus) requestAnimationFrame(() => searchEl?.focus());
  });

  $effect(() => {
    if (!open || !currentPath) return;
    void reloadVersion;
    let cancelled = false;
    loading = true;
    loadError = null;
    window.solus
      .listDirectory(currentPath, showHidden)
      .then((result) => {
        if (cancelled) return;
        entries = result.entries;
        currentPath = result.currentPath;
        parentPath = result.parentPath;
        loadError = result.error;
        loading = false;
        selectedIndex = -1;
        filterQuery = "";
        if (shouldAutofocus) requestAnimationFrame(() => searchEl?.focus());
      })
      .catch(() => {
        if (cancelled) return;
        loading = false;
        entries = [];
        loadError = "Couldn’t load this folder. Check the connection and try again.";
      });
    return () => {
      cancelled = true;
    };
  });

  function navigateTo(path: string) {
    selectedIndex = -1;
    filterQuery = "";
    if (path === currentPath) return;
    currentPath = path;
  }

  function navigateUp() {
    if (parentPath) navigateTo(parentPath);
  }

  function primarySelect() {
    if (!loading && !loadError) onSelect(selectionPath);
  }

  // Keep Tab focus cycling inside the dialog so keyboard users can't fall
  // through to the page behind the backdrop.
  function trapFocus(e: KeyboardEvent) {
    if (!popoverEl) return;
    const focusable = Array.from(
      popoverEl.querySelectorAll<HTMLElement>(
        'button, [href], input, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter(
      (el) =>
        !el.hasAttribute("disabled") &&
        el.getAttribute("tabindex") !== "-1" &&
        el.offsetParent !== null,
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Tab") {
      trapFocus(e);
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }

    // When a focusable control (sidebar location, recent, breadcrumb, toggle,
    // Select button) has focus, let it handle Enter/Space/arrows natively
    // instead of hijacking them for list navigation.
    const target = e.target as HTMLElement | null;
    if (
      target &&
      target.closest(
        ".fn-sidebar-item, .fn-crumb, .toggle-hidden-btn, .error-action-btn, .picker-mobile-close, .cancel-btn, .select-btn",
      )
    ) {
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (dirEntries.length > 0) {
        selectedIndex = Math.min(selectedIndex + 1, dirEntries.length - 1);
      }
      return;
    }

    if (e.key === "ArrowUp" && e.metaKey) {
      e.preventDefault();
      navigateUp();
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (dirEntries.length > 0) selectedIndex = Math.max(selectedIndex - 1, 0);
      return;
    }

    // ← / → only navigate the folder tree when the filter is empty; otherwise
    // they move the text cursor in the filter box (consistent on both sides).
    if (e.key === "ArrowLeft" && filterQuery === "") {
      e.preventDefault();
      navigateUp();
      return;
    }

    if (e.key === "ArrowRight" && filterQuery === "") {
      e.preventDefault();
      if (selectedEntry) navigateTo(selectedEntry.path);
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      primarySelect();
      return;
    }

    if (e.key === "Backspace" && filterQuery === "") {
      e.preventDefault();
      navigateUp();
      return;
    }
  }

  const scrollThumb = `color-mix(in srgb, var(--solus-text-tertiary) 40%, transparent)`;
</script>

{#if open && layer.el}
  <div use:portal={layer.el} class="picker-backdrop" role="presentation" onmousedown={handleBackdropMousedown}>
    <div
      bind:this={popoverEl}
      class="picker-container"
      role="dialog"
      aria-modal="true"
      aria-labelledby="directory-picker-title"
      tabindex="-1"
      onkeydown={handleKeyDown}
      transition:fly={{ y: 8, duration: 180 }}
    >
      <div class="picker-mobile-header">
        <span id="directory-picker-title" class="picker-mobile-title">{title}</span>
        <button
          type="button"
          class="picker-mobile-close"
          onclick={onClose}
          aria-label="Cancel"
        >
          <XIcon size={18} />
        </button>
      </div>

      <div class="fn-main">
        <div class="fn-sidebar" style="--scroll-thumb:{scrollThumb}">
          {#each sidebarLocations as loc}
            <button
              class="fn-sidebar-item"
              class:fn-sidebar-item-active={currentPath === loc.path}
              onclick={() => navigateTo(loc.path)}
              title={loc.path}
            >
              {#if loc.label === "Home"}
                <HouseIcon size={14} weight="fill" class="flex-shrink-0" />
              {:else}
                <FolderIcon size={14} weight="fill" class="flex-shrink-0" />
              {/if}
              <span class="truncate">{loc.label}</span>
            </button>
          {/each}

          <div class="fn-sidebar-sep"></div>

          {#if projectMetadata.recentProjects.length > 0}
            {#each projectMetadata.recentProjects.slice(0, 6) as project (project.path)}
              <button
                class="fn-sidebar-item"
                class:fn-sidebar-item-active={currentPath === project.path}
                onclick={() => navigateTo(project.path)}
                title={project.path}
              >
                <ClockCounterClockwiseIcon size={14} class="flex-shrink-0" />
                <span class="truncate">{project.folderName}</span>
              </button>
            {/each}
          {/if}
        </div>

        <div class="fn-content">
          <div class="fn-content-header">
            <div class="fn-breadcrumbs">
              <button class="fn-crumb" onclick={() => navigateTo("/")}>/</button>
              {#each breadcrumbs as crumb, i (crumb.path)}
                <CaretRightIcon size={8} class="flex-shrink-0 text-(--solus-text-muted)" />
                <button
                  class="fn-crumb"
                  class:fn-crumb-active={i === breadcrumbs.length - 1}
                  onclick={() => navigateTo(crumb.path)}
                >{crumb.label}</button>
              {/each}
            </div>
            <div class="fn-search-row">
              <MagnifyingGlassIcon size={13} class="flex-shrink-0 text-(--solus-text-tertiary)" />
              <Input
                bind:ref={searchEl}
                bind:value={filterQuery}
                type="text"
                class="h-auto rounded-none border-0 bg-transparent p-0 text-[0.8438rem] shadow-none focus-visible:ring-0 dark:bg-transparent"
                placeholder="Filter..."
                role="combobox"
                aria-label="Filter folders"
                aria-autocomplete="list"
                aria-controls="directory-picker-list"
                aria-expanded={!loading && !loadError}
                aria-activedescendant={activeDescendant}
                oninput={() => { selectedIndex = -1 }}
                onkeydown={(e) => {
                  if (e.key === 'Enter' && runtime.isMobileViewport) {
                    e.stopPropagation();
                    e.preventDefault();
                    (e.target as HTMLInputElement)?.blur();
                  }
                }}
              />
              <button
                class="toggle-hidden-btn"
                onclick={() => (showHidden = !showHidden)}
                title={showHidden ? "Hide hidden folders" : "Show hidden folders"}
                aria-label={showHidden ? "Hide hidden folders" : "Show hidden folders"}
                aria-pressed={showHidden}
              >
                {#if showHidden}<EyeSlashIcon size={12} />{:else}<EyeIcon size={12} />{/if}
              </button>
            </div>
          </div>

          <div
            class="fn-content-list"
            bind:clientHeight={listHeight}
            id="directory-picker-list"
            role="listbox"
            aria-label="Folders"
          >
            {#if loading}
              <div class="picker-empty" role="status" aria-live="polite"><span class="empty-text">Loading folders…</span></div>
            {:else if loadError}
              <div class="picker-empty picker-error" role="alert">
                <FolderIcon size={18} class="text-(--solus-status-error)" />
                <span class="empty-text">{loadError}</span>
                <div class="error-actions">
                  {#if parentPath}
                    <button class="error-action-btn" onclick={navigateUp}>Go up</button>
                  {/if}
                  <button class="error-action-btn" onclick={() => reloadVersion++}>Retry</button>
                </div>
              </div>
            {:else if dirEntries.length === 0}
              <div class="picker-empty">
                <FolderIcon size={18} class="text-(--solus-text-muted)" />
                <span class="empty-text">{filterQuery ? "No matching folders" : "Empty"}</span>
              </div>
            {:else if runtime.isMobileViewport}
              <div class="fn-mobile-dir-list">
                {#each dirEntries as entry (entry.path)}
                  {@const sel = false}
                  <button
                    class="fn-dir-item"
                    role="option"
                    aria-selected={sel}
                    tabindex={-1}
                    onclick={() => navigateTo(entry.path)}
                  >
                    <FolderIcon size={15} weight="fill" class="flex-shrink-0 {sel ? 'text-(--solus-accent)' : 'text-(--solus-text-tertiary)'}" />
                    <span class="flex-1 truncate text-[0.8125rem] {sel ? 'text-(--solus-accent)' : 'text-(--solus-text-primary)'}">{entry.name}</span>
                    <CaretRightIcon size={10} class="flex-shrink-0 opacity-25 {sel ? 'text-(--solus-accent)' : 'text-(--solus-text-muted)'}" />
                  </button>
                {/each}
              </div>
            {:else if listHeight > 0}
              <VirtualList
                bind:this={virtualList}
                width="100%"
                height={listHeight}
                itemCount={dirEntries.length}
                itemSize={dirItemHeight}
                scrollToIndex={Math.max(selectedIndex, 0)}
                scrollToAlignment="auto"
                scrollToBehaviour="instant"
                overscanCount={5}
              >
                {#snippet item({ index, style }: { index: number; style: string })}
                  {@const entry = dirEntries[index]}
                  {@const sel = index === selectedIndex}
                  <div {style}>
                    <button
                      class="fn-dir-item"
                      id={`directory-option-${index}`}
                      class:fn-dir-item-sel={sel}
                      role="option"
                      aria-selected={sel}
                      tabindex={-1}
                      onclick={() => (selectedIndex = index)}
                      ondblclick={() => navigateTo(entry.path)}
                    >
                      <FolderIcon size={15} weight="fill" class="flex-shrink-0 {sel ? 'text-(--solus-accent)' : 'text-(--solus-text-tertiary)'}" />
                      <span class="flex-1 truncate text-[0.8125rem] {sel ? 'text-(--solus-accent)' : 'text-(--solus-text-primary)'}">{entry.name}</span>
                      <CaretRightIcon size={10} class="flex-shrink-0 opacity-25 {sel ? 'text-(--solus-accent)' : 'text-(--solus-text-muted)'}" />
                    </button>
                  </div>
                {/snippet}
              </VirtualList>
            {/if}
          </div>
        </div>
      </div>

      <div class="picker-footer">
        <span class="footer-path" title={selectionPath}>{abbreviateHome(selectionPath)}</span>
        <div class="picker-footer-actions flex items-center gap-3">
          <div class="footer-hints">
            <span class="hint"><Kbd variant="hint">↑↓</Kbd> navigate</span>
            <span class="hint"><Kbd variant="hint">→</Kbd> open</span>
          </div>
          {#if !runtime.isMobileViewport}
            <span class="text-[0.6563rem] text-(--solus-text-muted) tabular-nums flex-shrink-0">{dirEntries.length} folders</span>
            <button class="cancel-btn" onclick={onClose}>Cancel</button>
          {/if}
          <button class="select-btn" onclick={primarySelect} disabled={loading || !!loadError}>{actionLabel} <span class="select-btn-name">“{primaryTargetName}”</span>{#if !runtime.isMobileViewport} <Kbd variant="inline" class="opacity-70 ml-1">↵</Kbd>{/if}</button>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .picker-backdrop {
    position: fixed;
    inset: 0;
    z-index: 200;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: auto;
    overflow: hidden;
    overscroll-behavior: contain;
    background: color-mix(in srgb, black 12%, transparent);
  }

  .picker-container {
    width: clamp(32.5rem, 60vw, 60rem);
    height: clamp(21.25rem, 50vh, 36.25rem);
    background: #fcfbf8;
    border: 0.0625rem solid var(--solus-popover-border);
    border-radius: 1.125rem;
    box-shadow:
      var(--solus-popover-shadow),
      inset 0 0.0625rem 0 rgba(255, 255, 255, 0.14);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    overscroll-behavior: contain;
    transform-origin: center top;
  }
  :global(.dark) .picker-container {
    background: #1e1d1a;
    box-shadow:
      var(--solus-popover-shadow),
      inset 0 0.0625rem 0 rgba(255, 255, 255, 0.06);
  }


  .toggle-hidden-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.5rem;
    height: 2.5rem;
    border-radius: 0.375rem;
    border: none;
    background: transparent;
    color: var(--solus-text-tertiary);
    cursor: pointer;
  }
  .toggle-hidden-btn:hover { background: var(--solus-surface-hover); color: var(--solus-text-primary); }

  .picker-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 0.5rem;
  }
  .empty-text { font-size: 0.75rem; color: var(--solus-text-tertiary); }
  .picker-error { padding: 1.5rem; text-align: center; }
  .error-actions { display: flex; align-items: center; gap: 0.5rem; }
  .error-action-btn,
  .cancel-btn {
    min-height: 2.5rem;
    padding: 0 0.75rem;
    border: none;
    border-radius: 0.5rem;
    background: transparent;
    color: var(--solus-text-secondary);
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
  }
  .error-action-btn:hover,
  .cancel-btn:hover { background: var(--solus-surface-hover); color: var(--solus-text-primary); }
  .error-action-btn:active,
  .cancel-btn:active { scale: 0.96; }

  .picker-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.625rem 1.125rem;
    flex-shrink: 0;
    border-top: 0.0625rem solid color-mix(in srgb, var(--solus-popover-border) 40%, transparent);
  }
  .footer-path {
    flex: 1;
    min-width: 0;
    font-family: var(--font-mono, "Geist Mono", monospace);
    font-size: 0.6875rem;
    color: var(--solus-text-tertiary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .footer-hints { display: flex; gap: 0.5rem; flex-shrink: 0; }
  .hint { font-size: 0.625rem; color: var(--solus-text-muted); white-space: nowrap; }

  .select-btn {
    min-height: 2.5rem;
    padding: 0.3125rem 1rem;
    border-radius: 0.5rem;
    border: none;
    background: var(--solus-accent);
    color: white;
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
    flex-shrink: 0;
    transition-property: scale, opacity;
    transition-duration: 100ms;
  }
  .select-btn:hover { opacity: 0.9; }
  .select-btn:active { scale: 0.96; }
  .select-btn:disabled { cursor: not-allowed; opacity: 0.5; scale: 1; }
  .select-btn-name {
    display: inline-block;
    max-width: 12rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: bottom;
  }

  /* Visible focus rings for keyboard users tabbing through the dialog. */
  .fn-sidebar-item:focus-visible,
  .fn-crumb:focus-visible,
  .toggle-hidden-btn:focus-visible,
  .error-action-btn:focus-visible,
  .picker-mobile-close:focus-visible,
  .cancel-btn:focus-visible,
  .select-btn:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: -0.125rem;
    border-radius: 0.5rem;
  }

  .picker-mobile-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 3rem;
    padding: 0.375rem 0.75rem 0.375rem 1rem;
    flex-shrink: 0;
    border-bottom: 0.0625rem solid color-mix(in srgb, var(--solus-popover-border) 25%, transparent);
  }

  .picker-mobile-title {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--solus-text-primary);
  }

  .picker-mobile-close {
    width: 2.5rem;
    height: 2.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 0.625rem;
    border: none;
    background: transparent;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .picker-mobile-close:hover {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }

  /* ─── Finder layout ─── */
  .fn-main { flex: 1; display: flex; min-height: 0; }

  .fn-sidebar {
    width: 10.625rem;
    flex-shrink: 0;
    border-right: 0.0625rem solid color-mix(in srgb, var(--solus-popover-border) 30%, transparent);
    padding: 0.625rem 0;
    overflow-y: auto;
    background: var(--solus-surface-hover);
  }
  .fn-sidebar::-webkit-scrollbar { width: 0.125rem; }
  .fn-sidebar::-webkit-scrollbar-track { background: transparent; }
  .fn-sidebar::-webkit-scrollbar-thumb { background: var(--scroll-thumb); border-radius: 0.25rem; }

  .fn-sidebar-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: calc(100% - 1rem);
    margin: 0.0625rem 0.5rem;
    padding: 0.375rem 0.625rem;
    border: none;
    border-radius: 0.5rem;
    background: transparent;
    color: var(--solus-text-secondary);
    font-size: 0.7813rem;
    cursor: pointer;
    text-align: left;
    min-height: 2.5rem;
  }
  .fn-sidebar-item:hover { background: var(--solus-surface-hover); color: var(--solus-text-primary); }
  .fn-sidebar-item-active { background: var(--solus-accent-light); color: var(--solus-accent); }

  .fn-sidebar-sep {
    height: 0.0625rem;
    margin: 0.5rem 1rem;
    background: color-mix(in srgb, var(--solus-popover-border) 40%, transparent);
  }

  .fn-content { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }

  .fn-content-header {
    flex-shrink: 0;
    border-bottom: 0.0625rem solid color-mix(in srgb, var(--solus-popover-border) 25%, transparent);
  }

  .fn-breadcrumbs {
    display: flex;
    align-items: center;
    gap: 0.1875rem;
    padding: 0.625rem 1rem 0;
    overflow-x: auto;
    touch-action: pan-x;
    scrollbar-width: none;
  }
  .fn-breadcrumbs::-webkit-scrollbar { display: none; }

  .fn-crumb {
    font-family: var(--font-mono, "Geist Mono", monospace);
    font-size: 0.6875rem;
    color: var(--solus-text-tertiary);
    background: none;
    border: none;
    padding: 0.125rem 0.375rem;
    border-radius: 0.3125rem;
    cursor: pointer;
    white-space: nowrap;
    min-height: 2.5rem;
  }
  .fn-crumb:hover { background: var(--solus-surface-hover); color: var(--solus-text-primary); }
  .fn-crumb-active { color: var(--solus-text-primary); font-weight: 500; }

  .fn-search-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0 1rem;
    height: 2.75rem;
  }

  .fn-content-list { flex: 1; min-height: 0; overflow: hidden; overscroll-behavior-y: contain; }
  :global(.fn-content-list .virtual-list-wrapper) {
    overscroll-behavior-y: contain;
    scrollbar-width: thin;
    touch-action: pan-y;
  }
  .fn-mobile-dir-list {
    height: 100%;
    overflow-y: auto;
    overscroll-behavior-y: contain;
    scrollbar-width: thin;
    touch-action: pan-y;
    -webkit-overflow-scrolling: touch;
  }

  .fn-dir-item {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    width: 100%;
    height: 2.5rem;
    padding: 0 1rem;
    border: none;
    background: transparent;
    cursor: pointer;
    text-align: left;
  }
  .fn-dir-item-sel {
    background: var(--solus-accent-light);
    border-radius: 0.5rem;
    margin: 0 0.375rem;
    padding: 0 0.625rem;
    width: calc(100% - 0.75rem);
  }

  /* ── Mobile ── */
  @media (max-width: 767px) {
    .picker-container {
      width: 100%;
      height: 90dvh;
      border-radius: 1rem 1rem 0 0;
      box-shadow: 0 -0.25rem 1.5rem rgba(0, 0, 0, 0.15);
      border: none;
      margin-top: auto;
    }

    /* On a fixed `inset:0` backdrop the bottom edge resolves to the large
       viewport (behind the browser's bottom chrome). Pin the backdrop to the
       dynamic viewport height instead so the bottom-anchored sheet — and its
       footer — land just above the address bar rather than behind it. */
    .picker-backdrop {
      align-items: flex-end;
      bottom: auto;
      height: 100dvh;
    }

    .picker-mobile-header {
      padding: 0.75rem 1rem 0.5rem;
    }

    .fn-main {
      flex-direction: column;
      flex: 1 1 auto;
      min-height: 0;
    }

    .fn-content {
      flex: 1 1 auto;
      min-height: 0;
    }

    .fn-content-list {
      flex: 1 1 auto;
      min-height: 0;
    }

    .fn-sidebar {
      width: 100%;
      flex-shrink: 0;
      border-right: none;
      border-bottom: 0.0625rem solid color-mix(in srgb, var(--solus-popover-border) 30%, transparent);
      display: flex;
      flex-direction: row;
      overflow-x: auto;
      overflow-y: hidden;
      padding: 0.5rem 0.75rem;
      gap: 0.375rem;
      scrollbar-width: none;
      background: transparent;
      -webkit-overflow-scrolling: touch;
      touch-action: pan-x;
    }

    .fn-sidebar::-webkit-scrollbar {
      display: none;
    }

    .fn-sidebar-item {
      white-space: nowrap;
      flex-shrink: 0;
      width: auto;
      margin: 0;
      padding: 0.5rem 0.875rem;
      border-radius: 1.25rem;
      font-size: 0.75rem;
      min-height: 2.5rem;
    }

    .fn-sidebar-sep {
      width: 0.0625rem;
      height: 1.25rem;
      margin: 0 0.125rem;
      align-self: center;
    }

    .fn-dir-item {
      min-height: 3rem;
      height: 3rem;
    }

    .fn-dir-item-sel {
      min-height: 3rem;
      height: 3rem;
    }

    .fn-search-row {
      height: 2.75rem;
    }


    .fn-breadcrumbs {
      padding: 0.625rem 1rem 0.125rem;
      gap: 0.25rem;
    }

    .fn-crumb {
      font-size: 0.8125rem;
      padding: 0.25rem 0.5rem;
    }

    .picker-footer {
      flex-wrap: wrap;
      gap: 0.5rem;
      padding: 0.625rem 1rem;
      padding-bottom: max(0.625rem, env(safe-area-inset-bottom, 0));
    }

    .footer-hints {
      display: none;
    }

    /* The current path already shows in the breadcrumbs; the footer is just the
       primary action on mobile, so the Select button spans the full width. */
    .footer-path {
      display: none;
    }

    .picker-footer-actions {
      flex: 1;
      gap: 0;
    }

    .select-btn {
      flex: 1;
      padding: 0.625rem 1rem;
      font-size: 0.875rem;
      min-height: 2.75rem;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.25rem;
    }
  }

  @media (max-width: 1100px) and (min-width: 768px) {
    .footer-hints { display: none; }
  }
</style>
