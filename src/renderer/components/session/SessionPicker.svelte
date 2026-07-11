<script lang="ts">
  import { tick, onDestroy, onMount } from "svelte";
  import { fly } from "svelte/transition";
  import Input from "../ui/Input.svelte";
  import {
    MagnifyingGlassIcon,
    PlusIcon,
    SparkleIcon,
    XIcon,
  } from "phosphor-svelte";
  import VirtualList from "svelte-tiny-virtual-list";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { getStatusBarContext } from "../../contexts/status-bar.context.svelte";
  import { runtime } from "../../contexts/runtime.svelte";
  import { blurActiveTextInputOnMobile } from "../../lib/inputFocus";
  import { getPopoverLayer, useClickOutside } from "../popoverLayer.svelte";
  import { portal } from "../portal";
  import {
    entryTitle,
    entryByline,
    formatTimeAgoFromTimestamp,
    type PickerEntry,
  } from "../../lib/sessionUtils";
  import {
    dedupeHistoryEntries,
    filterEntries,
    buildRows,
    FrozenEntryOrder,
    type PickerRow,
  } from "../../lib/pickerEntries";
  import { createSessionPreviewStore } from "../../lib/preview.svelte";
  import { sessionHistorySourcesFromRoots } from "../../lib/sessionPickerHistory";
  import { createSessionHistoryStore } from "../../contexts/session-history.store.svelte";
  import SessionPickerItem from "./SessionPickerItem.svelte";
  import SessionPickerSkeleton from "./SessionPickerSkeleton.svelte";
  import SessionPreview from "./SessionPreview.svelte";
  import Kbd from "../ui/Kbd.svelte";
  import { worktreeProjectRoot, type SessionMeta } from "../../../shared/types";

  interface Props {
    open: boolean;
    onClose: () => void;
    inline?: boolean;
    portalTarget?: HTMLElement | null;
  }
  let {
    open = $bindable(),
    onClose,
    inline = false,
    portalTarget = null,
  }: Props = $props();

  const session = getWorkspaceContext();
  const statusBar = getStatusBarContext();
  const layer = getPopoverLayer();

  let query = $state("");
  let selectedIndex = $state(0);
  let searchEl: HTMLInputElement | HTMLTextAreaElement | null = $state(null);
  let popoverEl: HTMLDivElement | null = $state(null);
  let showHistorySkeleton = $state(false);
  let skeletonTimer: ReturnType<typeof setTimeout> | null = null;
  const history = createSessionHistoryStore();
  const historySessions = $derived(history.sessions);
  const historyLoading = $derived(history.loading);

  const preview = createSessionPreviewStore();
  let listHeight = $state(0);
  let virtualList: VirtualList | null = $state(null);
  let wasOpen = false;
  let lastHistoryScopeKey: string | null = null;
  let historyLoadSeq = 0;

  let countBump = $state(false);
  let prevEntryCount = 0;

  const scopeRoots = $derived(session.openProjectScopeRoots);
  const historyScopeRoots = $derived.by(() => {
    if (scopeRoots.length > 0) return scopeRoots;
    return effectiveProjectPath ? [effectiveProjectPath] : [];
  });
  const historyScopeKey = $derived(historyScopeRoots.join("\n"));
  const historySources = $derived(
    sessionHistorySourcesFromRoots(historyScopeRoots),
  );
  const historyScopeLabel = $derived.by(() => {
    if (historyScopeRoots.length > 1)
      return `${historyScopeRoots.length} projects`;
    const root = historyScopeRoots[0] ?? effectiveProjectPath;
    if (!root || root === "~") return "~";
    return root.replace(/\/$/, "").split("/").at(-1) || root;
  });

  $effect(() => {
    const count = allEntries.length;
    if (historyLoading && count > prevEntryCount && prevEntryCount > 0) {
      countBump = true;
      const t = setTimeout(() => {
        countBump = false;
      }, 250);
      prevEntryCount = count;
      return () => clearTimeout(t);
    }
    prevEntryCount = count;
  });

  const HEADER_HEIGHT = 26;
  const ENTRY_HEIGHT = 46;

  const entryOrder = new FrozenEntryOrder();

  const effectiveProjectPath = $derived(statusBar.ctx.workingDirectory);

  const openTabEntries: PickerEntry[] = $derived(
    session.tabOrder
      .filter((id) => session.tabs[id] && session.sessionFor(id))
      .map((id) => ({
        kind: "open" as const,
        tabId: id,
        tab: session.tabs[id],
        session: session.sessionFor(id)!,
      })),
  );

  const dedupedHistory: PickerEntry[] = $derived(
    dedupeHistoryEntries(historySessions, {
      tabs: session.tabs,
      sessions: session.sessions,
      tabOrder: session.tabOrder,
    }),
  );

  function isSelectedHistoryMeta(meta: SessionMeta) {
    const selected = filteredItems[selectedIndex];
    return (
      selected?.kind === "history" &&
      selected.meta.sessionId === meta.sessionId &&
      selected.meta.projectPath === meta.projectPath &&
      selected.meta.provider === meta.provider
    );
  }

  const allEntries: PickerEntry[] = $derived(
    entryOrder.sort(
      [...openTabEntries, ...dedupedHistory],
      open && !historyLoading,
    ),
  );

  const filteredItems: PickerEntry[] = $derived(
    filterEntries(allEntries, query),
  );

  const rows: PickerRow[] = $derived(
    buildRows(filteredItems, (e) => entryOrder.timestamp(e)),
  );

  const selectedEntry = $derived(
    open && filteredItems.length > 0
      ? filteredItems[Math.min(selectedIndex, filteredItems.length - 1)]
      : undefined,
  );
  const previewTitle = $derived(selectedEntry ? entryTitle(selectedEntry) : "");
  const previewByline = $derived(
    selectedEntry ? entryByline(selectedEntry) : "",
  );
  const previewTimeAgo = $derived(
    selectedEntry
      ? formatTimeAgoFromTimestamp(entryOrder.timestamp(selectedEntry))
      : null,
  );

  const rowIndexOfSelected = $derived(
    rows.findIndex((r) => r.kind === "entry" && r.entryIndex === selectedIndex),
  );

  const getRowSize = (index: number) =>
    rows[index]?.kind === "header" ? HEADER_HEIGHT : ENTRY_HEIGHT;

  $effect(() => {
    // Reset selection when filter changes
    query;
    selectedIndex = 0;
  });

  $effect(() => {
    // Recompute row heights whenever the row shape changes (length-stable edits
    // don't auto-trigger VirtualList's recompute, so cached sizes can go stale).
    rows;
    virtualList?.recomputeSizes?.(0);
  });

  // InputBar reclaims focus on close via its sessionPickerOpen effect.
  $effect(() => {
    const isOpen = open;
    const scopeKey = historyScopeKey;
    if (!isOpen) {
      wasOpen = false;
      historyLoadSeq++;
      history.cancel();
      preview.reset();
      return;
    }

    const isOpening = !wasOpen;
    if (isOpening) {
      query = "";
      selectedIndex = 0;
      resetPickerCaches();
      blurActiveTextInputOnMobile();
      tick().then(() => {
        if (!runtime.shouldSuppressFocus) {
          searchEl?.focus();
        } else {
          // Focus the container (tabindex="-1") so keyboard events are captured
          // without triggering the virtual keyboard on touch devices
          popoverEl?.focus();
        }
      });
      wasOpen = true;
    }

    if (isOpening || lastHistoryScopeKey !== scopeKey) {
      const scopeChanged = lastHistoryScopeKey !== scopeKey;
      lastHistoryScopeKey = scopeKey;
      // Keep the last successful scan visible when reopening the same scope.
      // A refresh should not collapse the picker to only its open tabs.
      if (scopeChanged) history.clear();
      selectedIndex = 0;
      resetPickerCaches();
      void loadHistory(historySources, scopeKey);
    }
  });

  function resetPickerCaches() {
    preview.reset();
    preview.clearCache();
    entryOrder.reset();
  }

  $effect(() => {
    if (!selectedEntry) {
      preview.reset();
      return;
    }
    preview.show(
      selectedEntry,
      session.ctx,
      () =>
        selectedEntry.kind === "history" &&
        lastHistoryScopeKey === historyScopeKey &&
        isSelectedHistoryMeta(selectedEntry.meta),
    );
  });

  async function loadHistory(
    sources = historySources,
    scopeKey = historyScopeKey,
  ) {
    const seq = ++historyLoadSeq;
    showHistorySkeleton = false;
    if (skeletonTimer) clearTimeout(skeletonTimer);
    const timer = setTimeout(() => {
      if (
        seq === historyLoadSeq &&
        historyLoading &&
        historySessions.length === 0
      )
        showHistorySkeleton = true;
    }, 140);
    skeletonTimer = timer;

    try {
      await history.load({
        sources,
        ctx: session.ctx,
        scopeKey,
        onBatch: (sessions) => {
          if (showHistorySkeleton && sessions.length > 0)
            showHistorySkeleton = false;
        },
      });
      if (seq !== historyLoadSeq || lastHistoryScopeKey !== scopeKey) return;
      if (showHistorySkeleton && historySessions.length > 0)
        showHistorySkeleton = false;
    } finally {
      if (seq === historyLoadSeq && lastHistoryScopeKey === scopeKey) {
        showHistorySkeleton = false;
      }
      if (skeletonTimer === timer) {
        clearTimeout(timer);
        skeletonTimer = null;
      }
    }
  }

  function handleSelect(entry: PickerEntry, opts?: { keepOpen?: boolean }) {
    const keepOpen = opts?.keepOpen ?? false;
    if (!keepOpen) session.plansGalleryOpen = false;
    if (entry.kind === "open") {
      if (!keepOpen) session.selectTab(entry.tabId);
    } else {
      void session.resumeSession(entry.meta, { background: keepOpen });
    }
    if (!keepOpen) close();
  }

  function close() {
    open = false;
    history.cancel();
    preview.reset();
    if (skeletonTimer) {
      clearTimeout(skeletonTimer);
      skeletonTimer = null;
    }
    onClose();
    requestAnimationFrame(() => blurActiveTextInputOnMobile());
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      if (filteredItems.length > 0) {
        selectedIndex = Math.min(selectedIndex + 1, filteredItems.length - 1);
      }
      return;
    }
    if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
      e.preventDefault();
      if (filteredItems.length > 0) {
        selectedIndex = Math.max(selectedIndex - 1, 0);
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const entry = filteredItems[selectedIndex];
      if (entry) handleSelect(entry, { keepOpen: e.altKey });
      return;
    }
  }

  function handleNewSession() {
    session.createTab();
    close();
  }

  useClickOutside(
    () => open && !inline,
    () => [popoverEl],
    close,
  );

  onDestroy(() => {
    historyLoadSeq++;
    history.cancel();
  });

  onMount(() =>
    window.solus.onSessionIndexUpdated((event) => {
      if (!open || event.provider !== "codex") return;
      const affectsScope = historyScopeRoots.some((root) =>
        event.projectPaths.some(
          (path) =>
            path === root ||
            worktreeProjectRoot(path) === root ||
            worktreeProjectRoot(root) === path,
        ),
      );
      if (affectsScope) void loadHistory(historySources, historyScopeKey);
    }),
  );
</script>

{#snippet pickerHeader()}
  <div
    class="relative flex flex-shrink-0 items-center gap-2.5 px-[1.125rem] after:absolute after:bottom-0 after:left-[1.125rem] after:right-[1.125rem] after:h-px after:content-['']
      {inline ? 'h-11' : 'h-12 max-md:h-[3.25rem]'}
      {historyLoading
      ? 'after:animate-[search-glow-pulse_1.6s_ease-in-out_infinite] after:bg-[var(--solus-accent)] after:opacity-100'
      : 'after:bg-[var(--solus-popover-border)] after:opacity-35'}"
  >
    <MagnifyingGlassIcon
      size={14}
      class="flex-shrink-0 text-(--solus-text-tertiary)"
    />
    <Input
      bind:el={searchEl}
      bind:value={query}
      type="text"
      variant="bare"
      size="lg"
      placeholder={historyLoading
        ? "Loading sessions…"
        : `Search ${allEntries.length} sessions in ${historyScopeLabel}…`}
      class="flex-1 tracking-[-0.005em]"
      onkeydown={(e) => {
        if (e.key === "Enter" && runtime.isMobileViewport) {
          e.stopPropagation();
          e.preventDefault();
          (e.target as HTMLInputElement)?.blur();
        }
      }}
    />
    <button
      class="relative inline-flex cursor-pointer items-center gap-1 rounded-[0.4375rem] border border-transparent bg-transparent px-[0.5625rem] py-[0.1875rem] text-xs text-[var(--solus-text-tertiary)] transition-[background-color,color,border-color] duration-150 hover:border-[var(--solus-accent-border)] hover:bg-[var(--solus-accent-light)] hover:text-[var(--solus-accent)] focus-visible:border-[var(--solus-accent-border)] focus-visible:bg-[var(--solus-accent-light)] focus-visible:text-[var(--solus-accent)] focus-visible:outline-none pointer-coarse:before:absolute pointer-coarse:before:left-1/2 pointer-coarse:before:top-1/2 pointer-coarse:before:h-[max(100%,3rem)] pointer-coarse:before:w-[max(100%,3rem)] pointer-coarse:before:-translate-x-1/2 pointer-coarse:before:-translate-y-1/2 pointer-coarse:before:content-[''] max-md:hidden"
      onclick={handleNewSession}
    >
      <PlusIcon size={11} />
      <span>New</span>
    </button>
    <button
      type="button"
      class="relative flex h-6 w-6 cursor-pointer items-center justify-center rounded-md border-none bg-transparent text-[var(--solus-text-tertiary)] transition-[background-color,color] duration-100 hover:bg-[var(--solus-surface-hover)] hover:text-[var(--solus-text-primary)] pointer-coarse:before:absolute pointer-coarse:before:left-1/2 pointer-coarse:before:top-1/2 pointer-coarse:before:h-[max(100%,3rem)] pointer-coarse:before:w-[max(100%,3rem)] pointer-coarse:before:-translate-x-1/2 pointer-coarse:before:-translate-y-1/2 pointer-coarse:before:content-[''] max-md:h-9 max-md:w-9 max-md:rounded-[0.625rem]"
      onclick={close}
      aria-label="Close session picker"
    >
      <XIcon size={14} />
    </button>
  </div>
{/snippet}

{#snippet pickerBody()}
  <div class="flex min-h-0 flex-1 overflow-hidden max-md:overflow-visible">
    <div
      class="w-[clamp(20rem,42%,27.5rem)] flex-shrink-0 overflow-y-auto overscroll-y-contain pb-1 pt-2 max-md:w-full"
      bind:clientHeight={listHeight}
      role="listbox"
      tabindex="-1"
    >
      {#if historyLoading && showHistorySkeleton && historySessions.length === 0 && !query.trim()}
        <SessionPickerSkeleton />
      {:else if historyLoading && historySessions.length === 0 && !query.trim()}
        <div
          class="flex h-full flex-col items-center justify-center gap-3 px-5 text-center"
        ></div>
      {:else if filteredItems.length === 0}
        <div
          class="flex h-full flex-col items-center justify-center gap-3 px-5 text-center"
        >
          {#if query.trim()}
            <span
              class="text-xs tracking-[0.005em] text-[var(--solus-text-tertiary)]"
              >No sessions match "{query}"</span
            >
            <button
              class="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--solus-accent-border)] bg-[var(--solus-accent-light)] px-[0.6875rem] py-[0.3125rem] text-[0.7188rem] text-[var(--solus-accent)] transition-[background-color,border-color] duration-150 hover:border-[var(--solus-accent-border-medium)] hover:bg-[var(--solus-accent-soft)]"
              onclick={handleNewSession}
            >
              <SparkleIcon size={12} />
              <span>Start new session</span>
              <Kbd variant="accent" class="ml-0.5">↵</Kbd>
            </button>
          {:else}
            <span
              class="text-xs tracking-[0.005em] text-[var(--solus-text-tertiary)]"
              >No sessions yet</span
            >
            <button
              class="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--solus-accent-border)] bg-[var(--solus-accent-light)] px-[0.6875rem] py-[0.3125rem] text-[0.7188rem] text-[var(--solus-accent)] transition-[background-color,border-color] duration-150 hover:border-[var(--solus-accent-border-medium)] hover:bg-[var(--solus-accent-soft)]"
              onclick={handleNewSession}
            >
              <PlusIcon size={12} />
              <span>New session</span>
            </button>
          {/if}
        </div>
      {:else}
        <VirtualList
          bind:this={virtualList}
          width="100%"
          height={listHeight ? listHeight - 12 : 400}
          itemCount={rows.length}
          itemSize={getRowSize}
          scrollToIndex={rowIndexOfSelected >= 0 ? rowIndexOfSelected : 0}
          scrollToAlignment="auto"
          scrollToBehaviour="instant"
          overscanCount={5}
        >
          {#snippet item({ style, index })}
            <div {style}>
              {#if rows[index].kind === "header"}
                <div
                  class="pointer-events-none flex h-full select-none items-end px-5 pb-1 pt-2.5 text-[0.6875rem] font-medium uppercase tracking-[0.1em] text-[var(--solus-text-tertiary)] opacity-70"
                >
                  {(rows[index] as { label: string }).label}
                </div>
              {:else}
                {@const r = rows[index] as {
                  entry: PickerEntry;
                  entryIndex: number;
                }}
                <SessionPickerItem
                  item={r.entry}
                  isSelected={r.entryIndex === selectedIndex}
                  onSelect={() => handleSelect(r.entry)}
                  onHover={() => {
                    selectedIndex = r.entryIndex;
                  }}
                />
              {/if}
            </div>
          {/snippet}
        </VirtualList>
      {/if}
    </div>

    <div
      class="relative min-w-0 flex-1 overflow-hidden bg-[color-mix(in_srgb,var(--solus-surface-primary)_5%,transparent)] shadow-[inset_0.0625rem_0_0_0_color-mix(in_srgb,var(--solus-popover-border)_45%,transparent)] max-md:hidden"
    >
      <SessionPreview
        messages={preview.messages}
        loading={preview.loading}
        title={previewTitle}
        byline={previewByline}
        timeAgo={previewTimeAgo}
        hiddenCountOverride={preview.hiddenCount}
        onContinue={() => {
          const entry = filteredItems[selectedIndex];
          if (entry) handleSelect(entry);
        }}
      />
    </div>
  </div>
{/snippet}

{#snippet pickerFooter()}
  <div
    class="relative flex h-8 flex-shrink-0 items-center justify-between bg-[linear-gradient(to_bottom,transparent_0%,color-mix(in_srgb,var(--solus-popover-bg)_60%,transparent)_100%)] px-[1.125rem] text-[var(--solus-text-tertiary)] max-md:h-9 max-md:pb-[max(0px,env(safe-area-inset-bottom,0px))]"
  >
    <span
      class="text-xs tracking-[0.01em] opacity-75 [font-variant-numeric:tabular-nums] {historyLoading &&
      countBump
        ? 'animate-[count-scale-bump_250ms_ease-out]'
        : ''}"
    >
      {#if filteredItems.length === allEntries.length}
        {allEntries.length}
        {allEntries.length === 1 ? "session" : "sessions"}
      {:else}
        {filteredItems.length} of {allEntries.length}
      {/if}
      {#if historyLoading}
        <span
          class="inline-block w-[1em] overflow-hidden align-bottom tracking-[0.05em] animate-[scanning-ellipsis_1.4s_steps(4,end)_infinite]"
          >…</span
        >
      {/if}
    </span>
    <div class="flex items-center gap-3.5 max-md:hidden">
      <span class="inline-flex items-center gap-[0.3125rem] text-xs">
        <Kbd variant="hint">↑</Kbd><Kbd variant="hint">↓</Kbd>
        <span class="tracking-[0.01em] opacity-75">navigate</span>
      </span>
      <span class="inline-flex items-center gap-[0.3125rem] text-xs">
        <Kbd variant="hint">↵</Kbd>
        <span class="tracking-[0.01em] opacity-75">open</span>
      </span>
      <span class="inline-flex items-center gap-[0.3125rem] text-xs">
        <Kbd variant="hint">⌥</Kbd><Kbd variant="hint">↵</Kbd>
        <span class="tracking-[0.01em] opacity-75">open &amp; stay</span>
      </span>
      <span class="inline-flex items-center gap-[0.3125rem] text-xs">
        <Kbd variant="hint">esc</Kbd>
        <span class="tracking-[0.01em] opacity-75">close</span>
      </span>
    </div>
  </div>
{/snippet}

{#if open && inline}
  <div
    bind:this={popoverEl}
    class="flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-transparent outline-none"
    role="dialog"
    aria-label="Session picker"
    tabindex="-1"
    onkeydown={handleKeyDown}
    transition:fly={{ y: 8, duration: 160 }}
  >
    {@render pickerHeader()}
    {@render pickerBody()}
    {@render pickerFooter()}
  </div>
{:else if open && (portalTarget || layer.el)}
  <div
    use:portal={portalTarget ?? layer.el}
    class="z-[200] flex items-center justify-center overflow-hidden overscroll-contain {portalTarget
      ? 'absolute inset-0'
      : 'pointer-events-auto fixed inset-0 max-md:bg-black/50'}"
  >
    <div
      bind:this={popoverEl}
      class="flex flex-col overflow-hidden overscroll-contain border border-[var(--solus-popover-border)] bg-[color-mix(in_srgb,var(--solus-popover-bg)_82%,transparent)] outline-none backdrop-blur-[3rem] backdrop-saturate-[1.15] origin-top animate-[picker-enter_180ms_cubic-bezier(0.22,1,0.36,1)_both] rounded-[1.125rem] shadow-[var(--solus-popover-shadow),inset_0_0.0625rem_0_rgba(255,255,255,0.14)] dark:shadow-[var(--solus-popover-shadow),inset_0_0.0625rem_0_rgba(255,255,255,0.06)] max-md:h-[100dvh] max-md:w-full max-md:rounded-none max-md:border-none max-md:bg-[var(--solus-container-bg)] max-md:shadow-none max-md:backdrop-filter-none {portalTarget
        ? 'h-3/4 max-h-[75%] w-3/4'
        : 'h-[75vh] w-[clamp(32rem,58vw,56rem)] md:max-[1100px]:h-[min(78vh,42rem)] md:max-[1100px]:w-[min(80vw,48rem)]'}"
      role="dialog"
      aria-label="Session picker"
      tabindex="-1"
      onkeydown={handleKeyDown}
    >
      {@render pickerHeader()}
      {@render pickerBody()}
      {@render pickerFooter()}
    </div>
  </div>
{/if}
