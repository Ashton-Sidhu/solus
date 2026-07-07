<script lang="ts">
  import { onMount } from "svelte";
  import { FileTree } from "@pierre/trees";
  import {
    ArrowClockwiseIcon,
    CaretLeftIcon,
    FloppyDiskIcon,
    FolderIcon,
    SidebarSimpleIcon,
    WarningCircleIcon,
    XIcon,
  } from "phosphor-svelte";
  import Icon from "@iconify/svelte";
  import { tooltip } from "../../lib/tooltip";
  import type { IpcContext } from "../../../shared/types";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { fileTypeIcon } from "../../lib/fileTypeIcon";
  import { ensureIconCollections } from "../diagram/iconify";
  import { FILE_TREE_CHEVRON_CSS } from "../../lib/fileTreeTheme";
  import {
    useKeybinding,
    useScope,
  } from "../../lib/keybindings/use-keybinding.svelte";
  import FilePreviewStream, {
    type FileSaveState,
  } from "../artifact/FilePreviewStream.svelte";
  import { runtime } from "../../contexts/runtime.svelte";

  interface Props {
    ctx: IpcContext;
    cwd: string;
    isDark: boolean;
    onClose: () => void;
  }

  let { ctx, cwd, isDark, onClose }: Props = $props();

  // Register the (lazy, ~12MB) `logos` icon set so the header's file-type badge
  // can resolve its vibrant brand icon. Idempotent and shared across the app.
  ensureIconCollections();

  // Match the PR-review guide's file header: an extension badge plus a
  // dir/name split. Uppercase extension, shown as a small badge.
  function ext(path: string): string {
    const name = path.split("/").pop() ?? path;
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(dot + 1).toUpperCase() : "·";
  }
  function fileName(path: string): string {
    return path.split("/").pop() ?? path;
  }
  function dirName(path: string): string {
    const i = path.lastIndexOf("/");
    return i > 0 ? path.slice(0, i + 1) : "";
  }

  let treeCollapsed = $state(false);

  const TREE_MIN_WIDTH = 192;
  const TREE_MAX_WIDTH = 480;
  // Keep at least this much room for the editor when clamping the tree width.
  const EDITOR_MIN_WIDTH = 280;
  const TREE_WIDTH_KEY = "solus-files-tree-width";
  let panelWidth = $state(0);
  let treeWidth = $state(
    clampTreeWidth(Number(localStorage.getItem(TREE_WIDTH_KEY)) || 256),
  );
  let isResizing = $state(false);
  let resizeStartX = 0;
  let resizeStartWidth = 0;
  let pendingWidth = 0;
  let resizeRaf = 0;

  let loading = $state(false);
  let error = $state<string | null>(null);
  let root = $state("");
  let files = $state<string[]>([]);
  let selectedPath = $state<string | null>(null);
  let selectedContents = $state<string | null>(null);
  let selectedSize = $state<number | null>(null);
  let fileLoading = $state(false);
  let fileError = $state<string | null>(null);
  let saveState = $state<FileSaveState>("idle");
  let saveMessage = $state<string | undefined>(undefined);
  let treeHost: HTMLDivElement | undefined = $state();
  let treeInstance: FileTree | null = $state(null);
  let treeFiles: string[] | null = null;

  const statusLabel = $derived.by(() => {
    if (saveState === "dirty") return "Unsaved";
    if (saveState === "saving") return "Saving...";
    if (saveState === "saved") return "Saved";
    if (saveState === "conflict") return "Changed on disk";
    if (saveState === "error") return "Save failed";
    return selectedSize == null ? "" : `${Math.ceil(selectedSize / 1024)} KB`;
  });

  const statusClass = $derived(
    saveState === "saved"
      ? "text-(--solus-status-complete)"
      : saveState === "error" || saveState === "conflict"
        ? "text-(--solus-status-error)"
        : "text-(--solus-text-tertiary)",
  );

  useScope("files-pane");
  useKeybinding("files-pane.close", () => closePane());
  useKeybinding("files-pane.focus-search", () => treeInstance?.openSearch());
  useKeybinding("files-pane.next-file", () => moveSelection(1));
  useKeybinding("files-pane.prev-file", () => moveSelection(-1));
  useKeybinding("files-pane.toggle-tree", () => toggleTree());

  function closePane() {
    onClose();
    requestInputFocus();
  }

  function toggleTree() {
    treeCollapsed = !treeCollapsed;
    requestInputFocus();
  }

  // Clamp the tree width to its bounds, but never so wide that the editor falls
  // below EDITOR_MIN_WIDTH once the pane's own width is known.
  function clampTreeWidth(width: number) {
    const ceiling =
      panelWidth > 0
        ? Math.max(
            TREE_MIN_WIDTH,
            Math.min(TREE_MAX_WIDTH, panelWidth - EDITOR_MIN_WIDTH),
          )
        : TREE_MAX_WIDTH;
    return Math.min(ceiling, Math.max(TREE_MIN_WIDTH, width));
  }

  function persistTreeWidth() {
    localStorage.setItem(TREE_WIDTH_KEY, String(treeWidth));
  }

  function startResize(e: MouseEvent) {
    isResizing = true;
    resizeStartX = e.clientX;
    resizeStartWidth = treeWidth;
    pendingWidth = treeWidth;
    e.preventDefault();
    window.addEventListener("mousemove", onResizeMove);
    window.addEventListener("mouseup", onResizeEnd);
  }

  function onResizeMove(e: MouseEvent) {
    pendingWidth = clampTreeWidth(resizeStartWidth + (e.clientX - resizeStartX));
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      treeWidth = pendingWidth;
    });
  }

  function onResizeEnd() {
    if (resizeRaf) {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = 0;
    }
    treeWidth = pendingWidth;
    isResizing = false;
    persistTreeWidth();
    window.removeEventListener("mousemove", onResizeMove);
    window.removeEventListener("mouseup", onResizeEnd);
  }

  function handleResizeKey(e: KeyboardEvent) {
    const step = e.shiftKey ? 40 : 16;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      treeWidth = clampTreeWidth(treeWidth - step);
      persistTreeWidth();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      treeWidth = clampTreeWidth(treeWidth + step);
      persistTreeWidth();
    }
  }

  async function loadFiles() {
    loading = true;
    error = null;
    const result = await window.solus.listProjectFiles(ctx, { cwd });
    if (result.ok) {
      root = result.root;
      files = result.files;
      if (!selectedPath || !result.files.includes(selectedPath)) {
        selectedPath = result.files[0] ?? null;
        if (selectedPath) void openFile(selectedPath);
      }
    } else {
      error = result.error;
      files = [];
      selectedPath = null;
      selectedContents = null;
    }
    loading = false;
  }

  async function openFile(path: string) {
    selectedPath = path;
    syncTreeSelection(path);
    selectedContents = null;
    selectedSize = null;
    fileError = null;
    fileLoading = true;
    saveState = "idle";
    saveMessage = undefined;
    const result = await window.solus.readProjectFile(ctx, { path, cwd: root || cwd });
    if (selectedPath !== path) return;
    if (result.ok) {
      selectedContents = result.contents;
      selectedSize = result.size;
    } else {
      fileError = result.error;
    }
    fileLoading = false;
  }

  function moveSelection(delta: number) {
    if (files.length === 0) return;
    const base = selectedPath ? files.indexOf(selectedPath) : -1;
    const next = Math.min(files.length - 1, Math.max(0, (base === -1 ? 0 : base) + delta));
    void openFile(files[next]);
  }

  function syncTreeSelection(path: string) {
    if (!treeInstance) return;
    const current = treeInstance.getSelectedPaths();
    if (current.length === 1 && current[0] === path) {
      treeInstance.scrollToPath(path, { offset: "nearest" });
      return;
    }
    for (const currentPath of current) treeInstance.getItem(currentPath)?.deselect();
    treeInstance.getItem(path)?.select();
    treeInstance.scrollToPath(path, { offset: "nearest" });
  }

  function mountTree() {
    if (!treeHost || treeInstance) return;
    const tree = new FileTree({
      paths: files,
      flattenEmptyDirectories: true,
      initialExpansion: "closed",
      search: true,
      searchBlurBehavior: "retain",
      onSelectionChange: (selectedPaths) => {
        const next = selectedPaths[0] ?? null;
        const item = next ? tree.getItem(next) : null;
        // A directory row click already toggles expansion natively; only clear
        // the directory's selection so the open file keeps its highlight.
        if (item?.isDirectory()) {
          item.deselect();
          if (selectedPath) syncTreeSelection(selectedPath);
          return;
        }
        if (next && next !== selectedPath) void openFile(next);
      },
      unsafeCSS: `
        [data-type='item'][data-item-selected='true']::after {
          content: '';
          position: absolute;
          top: 0.1875rem; bottom: 0.1875rem; left: 0;
          width: 0.1563rem;
          border-radius: 0 0.1875rem 0.1875rem 0;
          background: var(--solus-accent);
        }
        [data-type='item'][data-item-selected='true']::before {
          outline-color: transparent !important;
        }
        ${FILE_TREE_CHEVRON_CSS}
        [data-file-tree-search-container] {
          padding-top: 0.375rem;
          padding-left: calc(var(--trees-padding-inline) + 2.125rem);
          margin-bottom: 0.625rem;
        }
        [data-file-tree-search-input] {
          min-width: 0;
        }
      `,
    });
    tree.render({ containerWrapper: treeHost });
    treeInstance = tree;
  }

  onMount(() => {
    mountTree();
    return () => {
      window.removeEventListener("mousemove", onResizeMove);
      window.removeEventListener("mouseup", onResizeEnd);
      treeInstance?.cleanUp();
      treeInstance = null;
    };
  });

  // Re-clamp when the pane itself resizes so a stored width can't squeeze the
  // editor below its floor on a narrower pane.
  $effect(() => {
    if (panelWidth <= 0) return;
    const clamped = clampTreeWidth(treeWidth);
    if (clamped !== treeWidth) treeWidth = clamped;
  });

  $effect(() => {
    if (!cwd) return;
    void loadFiles();
  });

  $effect(() => {
    if (!treeInstance) {
      mountTree();
      return;
    }
    if (treeFiles !== files) {
      treeFiles = files;
      treeInstance.resetPaths(files);
    }
  });

  $effect(() => {
    if (selectedPath && files.includes(selectedPath)) syncTreeSelection(selectedPath);
  });
</script>

<div
  class="flex h-full min-h-0 min-w-0 flex-col border-l border-(--solus-container-border) bg-(--solus-container-bg)"
  class:cursor-col-resize={isResizing}
  class:select-none={isResizing}
  bind:clientWidth={panelWidth}
>
  <header
    class="flex h-(--solus-chrome-row-h,var(--solus-tap-target-lg)) shrink-0 items-center gap-2 border-b border-(--solus-chrome-row-border,var(--solus-container-border)) pr-3 pl-[max(0.75rem,var(--solus-chrome-lead-inset,0px))]"
  >
    <button
      type="button"
      class="flex size-(--solus-tap-target) shrink-0 cursor-pointer items-center justify-center rounded-md transition-[background-color,color,scale] duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent) {treeCollapsed ? 'text-(--solus-text-tertiary)' : 'text-(--solus-text-primary)'}"
      aria-label={treeCollapsed ? "Show file tree" : "Hide file tree"}
      aria-pressed={!treeCollapsed}
      onclick={toggleTree}
      use:tooltip={treeCollapsed ? "Show file tree (⌥T)" : "Hide file tree (⌥T)"}
    >
      <SidebarSimpleIcon size={13} weight="bold" />
    </button>
    {#if selectedPath}
      {@const icon = fileTypeIcon(selectedPath)}
      {#if icon}
        <Icon {icon} width="14" height="14" class="shrink-0" />
      {:else}
        <span
          class="shrink-0 rounded bg-(--solus-accent-light) px-1.5 py-0.5 font-mono text-[0.625rem] font-semibold text-(--solus-text-tertiary)"
        >
          {ext(selectedPath)}
        </span>
      {/if}
      <div class="min-w-0 flex-1 truncate font-mono text-[0.8125rem]">
        <span class="text-(--solus-text-tertiary)">{dirName(selectedPath)}</span>
        <span class="text-(--solus-text-primary)">{fileName(selectedPath)}</span>
      </div>
    {:else}
      <FolderIcon size={13} weight="duotone" class="shrink-0 text-(--solus-text-tertiary)" />
      <div class="min-w-0 flex-1 truncate font-mono text-[0.8125rem] text-(--solus-text-primary)">
        Files
      </div>
    {/if}
    {#if statusLabel}
      <div class="flex shrink-0 items-center gap-1 text-[0.625rem] font-medium {statusClass}" role="status" title={saveMessage}>
        <FloppyDiskIcon size={11} class="shrink-0" />
        <span class="tabular-nums">{statusLabel}</span>
      </div>
    {/if}
    {#if saveState === "conflict" && selectedPath}
      <button
        type="button"
        class="shrink-0 rounded-md px-2 py-1 text-[0.6875rem] font-medium text-(--solus-text-primary) ring-1 ring-(--solus-container-border) transition-[background-color,scale] duration-150 hover:bg-(--solus-surface-hover) active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
        onclick={() => selectedPath && openFile(selectedPath)}
      >
        Reload
      </button>
    {/if}
    <button
      type="button"
      class="flex size-(--solus-tap-target) shrink-0 cursor-pointer items-center justify-center rounded-md text-(--solus-text-tertiary) transition-[background-color,color,scale] duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
      aria-label="Refresh files"
      onclick={() => void loadFiles()}
    >
      <ArrowClockwiseIcon size={13} />
    </button>
    <button
      type="button"
      class="flex size-(--solus-tap-target) shrink-0 cursor-pointer items-center justify-center rounded-md text-(--solus-text-tertiary) transition-[background-color,color,scale] duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
      aria-label="Close files"
      onclick={closePane}
    >
      <XIcon size={13} />
    </button>
  </header>

  <div class="flex min-h-0 flex-1 flex-col md:flex-row">
    <aside
      class="relative flex min-h-48 shrink-0 flex-col border-b border-(--solus-container-border) md:min-h-0 md:border-r md:border-b-0"
      class:tree-hidden={treeCollapsed}
      style={runtime.isMobileViewport ? "" : `width:${treeWidth}px`}
    >
      <button
        type="button"
        onclick={toggleTree}
        aria-label="Hide file tree"
        class="tree-collapse-btn absolute top-[0.875rem] left-3 z-10 w-5 h-5 flex items-center justify-center rounded cursor-pointer text-(--solus-text-tertiary)"
        use:tooltip={"Hide file tree (⌥T)"}
      >
        <span
          class="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
          aria-hidden="true"
        ></span>
        <CaretLeftIcon size={12} weight="bold" />
      </button>
      <div class="min-h-0 flex-1 overflow-hidden">
        {#if loading && files.length === 0}
          <div class="p-3 text-[0.75rem] text-(--solus-text-tertiary)">Loading files...</div>
        {:else if error}
          <div class="flex gap-2 p-3 text-[0.75rem] text-(--solus-status-error)">
            <WarningCircleIcon size={14} weight="fill" class="mt-0.5 shrink-0" />
            <span class="min-w-0">{error}</span>
          </div>
        {:else if files.length === 0}
          <div class="p-3 text-[0.75rem] text-(--solus-text-tertiary)">No files found.</div>
        {:else}
          <div
            bind:this={treeHost}
            class="files-tree h-full min-h-0 overflow-auto"
            style="-webkit-overflow-scrolling:touch; overscroll-behavior-y:contain"
          ></div>
        {/if}
      </div>
    </aside>

    {#if !treeCollapsed && !runtime.isMobileViewport}
      <div
        class="files-tree-resize-handle"
        class:is-resizing={isResizing}
        onmousedown={startResize}
        onkeydown={handleResizeKey}
        role="slider"
        tabindex="0"
        aria-orientation="vertical"
        aria-label="Resize file tree"
        aria-valuenow={treeWidth}
        aria-valuemin={TREE_MIN_WIDTH}
        aria-valuemax={TREE_MAX_WIDTH}
      >
        <span class="files-tree-resize-grip" aria-hidden="true"></span>
      </div>
    {/if}

    <section class="flex min-h-0 min-w-0 flex-1 flex-col">
      {#if fileLoading}
        <div class="flex flex-1 items-center justify-center text-[0.75rem] text-(--solus-text-tertiary)">
          Opening file...
        </div>
      {:else if fileError}
        <div class="flex flex-1 items-center justify-center p-6 text-center text-[0.75rem] text-(--solus-status-error)">
          {fileError}
        </div>
      {:else if selectedPath && selectedContents !== null}
        <FilePreviewStream
          {ctx}
          cwd={root || cwd}
          filePath={selectedPath}
          displayPath={selectedPath}
          contents={selectedContents}
          {isDark}
          onSaveStateChange={(state, message) => {
            saveState = state;
            saveMessage = message;
          }}
        />
      {:else}
        <div class="flex flex-1 items-center justify-center text-[0.75rem] text-(--solus-text-tertiary)">
          Select a file to edit.
        </div>
      {/if}
    </section>
  </div>
</div>

<style>
  .tree-hidden {
    display: none !important;
  }
  .files-tree-resize-handle {
    width: 0;
    flex-shrink: 0;
    cursor: col-resize;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    overflow: visible;
    z-index: 11;
  }
  .files-tree-resize-handle::before {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: -3px;
    width: 6px;
  }
  .files-tree-resize-handle:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.125rem;
  }
  .files-tree-resize-grip {
    position: relative;
    width: 2px;
    height: 28px;
    border-radius: 2px;
    background: var(--solus-text-tertiary);
    opacity: 0;
    transform: scaleY(0.6);
    transition:
      opacity 0.15s ease,
      transform 0.15s ease,
      background-color 0.15s ease;
    pointer-events: none;
  }
  .files-tree-resize-handle:hover .files-tree-resize-grip,
  .files-tree-resize-handle.is-resizing .files-tree-resize-grip {
    opacity: 1;
    transform: scaleY(1);
    background: var(--solus-accent);
  }
  .tree-collapse-btn {
    transition:
      color 120ms ease,
      background-color 120ms ease;
  }
  .tree-collapse-btn:hover {
    color: var(--solus-text-primary);
    background: var(--solus-surface-hover);
  }
  .tree-collapse-btn:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.125rem;
  }
  .files-tree {
    --trees-bg-override: transparent;
    --trees-fg-override: var(--solus-text-secondary);
    --trees-fg-muted-override: var(--solus-text-tertiary);
    --trees-bg-muted-override: var(--solus-surface-hover);
    --trees-accent-override: var(--solus-accent);
    --trees-border-color-override: var(--solus-container-border);
    --trees-selected-fg-override: var(--solus-text-primary);
    --trees-selected-bg-override: var(--solus-accent-light);
    --trees-selected-focused-border-color-override: transparent;
    --trees-focus-ring-color-override: var(--solus-accent);
    --trees-scrollbar-thumb-override: var(--solus-scroll-thumb);
    --trees-font-family-override:
      -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui,
      sans-serif;
    --trees-font-size-override: 0.75rem;
    --trees-padding-inline-override: 0.625rem;
    --trees-density-override: 0.75;
    --trees-scrollbar-gutter-override: 0.1875rem;
    --trees-search-bg-override: var(--solus-input-bg-soft);
    --trees-search-fg-override: var(--solus-text-primary);
    --trees-status-added-override: var(--solus-status-complete);
    --trees-status-modified-override: var(--solus-accent);
    --trees-status-deleted-override: var(--solus-status-error);
  }
</style>
