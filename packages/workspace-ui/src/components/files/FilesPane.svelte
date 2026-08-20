<script lang="ts">
  import { onMount, type Snippet } from "svelte";
  import {
    FileTree,
    type ContextMenuItem,
    type FileTreeCompositionOptions,
    type FileTreeRenameEvent,
  } from "@pierre/trees";
  import {
    RotateCw as ArrowClockwiseIcon,
    ChevronLeft as CaretLeftIcon,
    FilePlus as FilePlusIcon,
    Save as FloppyDiskIcon,
    Folder as FolderIcon,
    FolderPlus as FolderPlusIcon,
    PanelLeft as SidebarSimpleIcon,
    CircleAlert as WarningCircleIcon,
  } from "@lucide/svelte";
  import Icon from "@iconify/svelte";
  import * as TooltipUI from "@solus/workspace-ui/components/ui/tooltip";
  import { Button } from "../ui/button";
  import type { IpcContext, ProjectFileMutation } from "@solus/contracts/types";
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
  import SegmentedControl from "../ui/SegmentedControl.svelte";
  import MarkdownFileSurface from "./MarkdownFileSurface.svelte";
  import {
    initialMarkdownFileViewMode,
    isMarkdownFile,
    MARKDOWN_FILE_VIEW_OPTIONS,
    persistMarkdownFileViewMode,
    type MarkdownFileViewMode,
  } from "./lib/markdown-file";
  import FilesPaneSkeleton from "./FilesPaneSkeleton.svelte";
  import FilesTreeContextMenu from "./FilesTreeContextMenu.svelte";
  import {
    addTreePath,
    canonicalTreePath,
    creationDirectoryFor,
    entryDisplayName,
    isFolderPath,
    parentDirectoryOf,
    placeholderEntryPath,
    removeTreePath,
    renameTreePath,
    type FileTreeEntryKind,
  } from "./lib/file-tree-mutations";
  import { toasts } from "../../lib/toasts";
  import { getWorkspaceContext, runtime } from "../../contexts";
  import * as Resizable from "../ui/resizable";
  import {
    paneBoundsPercent,
    percentToPixels,
    pixelsToPercent,
  } from "../../lib/resizablePane";

  interface Props {
    ctx: IpcContext;
    cwd: string;
    isDark: boolean;
    onClose: () => void;
  }

  let { ctx, cwd, isDark, onClose }: Props = $props();
  const workspace = getWorkspaceContext();

  // Register the small offline icon subset used by file-type badges.
  ensureIconCollections();

  // Match the PR-review guide's file header: an extension badge plus a
  // dir/name split. Uppercase extension, shown as a small badge.
  function ext(path: string): string {
    const name = entryDisplayName(path);
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(dot + 1).toUpperCase() : "·";
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
  let treePane: ReturnType<typeof Resizable.Pane> | undefined = $state();
  const treeMaxWidth = $derived(
    panelWidth > 0
      ? Math.max(
          TREE_MIN_WIDTH,
          Math.min(TREE_MAX_WIDTH, panelWidth - EDITOR_MIN_WIDTH),
        )
      : TREE_MAX_WIDTH,
  );
  const treeBounds = $derived(
    paneBoundsPercent(panelWidth, TREE_MIN_WIDTH, treeMaxWidth),
  );
  const treeDefaultSize = $derived(
    panelWidth > 0 ? pixelsToPercent(treeWidth, panelWidth) : 32,
  );

  let loading = $state(false);
  let error = $state<string | null>(null);
  let root = $state("");
  // Everything the tree draws: indexed files plus the folders no file reveals.
  // Folder entries carry a trailing slash, which is how the tree tells them apart.
  let treePaths = $state<string[]>([]);
  const filePaths = $derived(treePaths.filter((path) => !isFolderPath(path)));
  let selectedPath = $state<string | null>(null);
  let selectedContents = $state<string | null>(null);
  let selectedSize = $state<number | null>(null);
  let selectedReadOnly = $state(false);
  let selectedTruncated = $state(false);
  let fileLoading = $state(false);
  let fileError = $state<string | null>(null);
  let saveState = $state<FileSaveState>("idle");
  let markdownSurfaceRef: MarkdownFileSurface | null = $state(null);
  let markdownViewMode = $state<MarkdownFileViewMode>("rendered");
  let treeHost: HTMLDivElement | undefined = $state();
  let treeInstance: FileTree | null = $state(null);
  let renderedTreePaths: string[] | null = null;
  // The row the user picked, which is where the header's create buttons act.
  // `null` means nothing is picked and they act on the project root — the pane
  // opens a file on its own, so the open file is not evidence of a choice.
  let pickedPath = $state<string | null>(null);
  const newEntryDirectory = $derived(
    pickedPath ? creationDirectoryFor(pickedPath, isFolderPath(pickedPath)) : "",
  );
  let contextMenu = $state<{ x: number; y: number; path: string; isFolder: boolean } | null>(null);
  let closeTreeContextMenu: ((options?: { restoreFocus?: boolean }) => void) | null = null;
  const isSelectedMarkdown = $derived(
    selectedPath ? isMarkdownFile(selectedPath) : false,
  );

  const statusLabel = $derived.by(() => {
    if (selectedTruncated) return "Truncated — read only";
    if (selectedReadOnly) return "Read only";
    if (saveState === "dirty") return "Unsaved";
    if (saveState === "saving") return "Saving...";
    if (saveState === "saved") return "Saved";
    return selectedSize == null ? "" : `${Math.ceil(selectedSize / 1024)} KB`;
  });

  const statusClass = $derived(
    saveState === "saved"
      ? "text-(--solus-status-complete)"
      : "text-(--solus-text-tertiary)",
  );

  useScope("files-pane");
  useKeybinding("files-pane.close", () => closePane());
  useKeybinding("files-pane.focus-search", () => treeInstance?.openSearch());
  useKeybinding("files-pane.next-file", () => moveSelection(1));
  useKeybinding("files-pane.prev-file", () => moveSelection(-1));
  useKeybinding("files-pane.toggle-tree", () => toggleTree());
  useKeybinding("files-pane.toggle-markdown", () => toggleMarkdownView());

  function closePane() {
    onClose();
    requestInputFocus();
  }

  function toggleTree() {
    treeCollapsed = !treeCollapsed;
    if (treeCollapsed) treePane?.collapse();
    else treePane?.expand();
    requestInputFocus();
  }

  async function selectMarkdownView(mode: MarkdownFileViewMode) {
    await markdownSurfaceRef?.prepareModeChange(mode);
    markdownViewMode = mode;
    persistMarkdownFileViewMode(mode);
  }

  function toggleMarkdownView() {
    if (!isSelectedMarkdown) return;
    void selectMarkdownView(markdownViewMode === "rendered" ? "source" : "rendered");
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

  function handleTreeLayout(layout: number[]) {
    if (runtime.isMobileViewport || layout.length !== 2 || panelWidth <= 0) return;
    treeWidth = clampTreeWidth(percentToPixels(layout[0], panelWidth));
    if (!isResizing) persistTreeWidth();
  }

  function handleTreeDragging(dragging: boolean) {
    isResizing = dragging;
    if (!dragging) persistTreeWidth();
  }

  async function loadFiles() {
    loading = true;
    error = null;
    const result = await workspace
      .apiForSession(ctx.session.sessionId)
      .listProjectFiles(ctx, { cwd, includeEmptyDirectories: true });
    if (result.ok) {
      root = result.root;
      treePaths = [...result.files, ...(result.emptyDirectories ?? [])];
      if (!selectedPath || !result.files.includes(selectedPath)) {
        selectedPath = result.files[0] ?? null;
        if (selectedPath) void openFile(selectedPath);
      }
    } else {
      error = result.error;
      treePaths = [];
      selectedPath = null;
      selectedContents = null;
    }
    loading = false;
  }

  async function openFile(path: string) {
    selectedPath = path;
    markdownViewMode = initialMarkdownFileViewMode(path);
    syncTreeSelection(path);
    selectedContents = null;
    selectedSize = null;
    selectedReadOnly = false;
    selectedTruncated = false;
    fileError = null;
    fileLoading = true;
    saveState = "idle";
    const result = await workspace.apiForSession(ctx.session.sessionId).readProjectFile(ctx, { path, cwd: root || cwd });
    if (selectedPath !== path) return;
    if (result.ok) {
      selectedContents = result.contents;
      selectedSize = result.size;
      // A file too large to load whole is served as a prefix; editing it would
      // save the truncation back over the original.
      selectedReadOnly = result.isReadOnly;
      selectedTruncated = result.truncated === true;
      if (selectedTruncated) markdownViewMode = "source";
    } else {
      fileError = result.error;
    }
    fileLoading = false;
  }

  function moveSelection(delta: number) {
    if (filePaths.length === 0) return;
    const base = selectedPath ? filePaths.indexOf(selectedPath) : -1;
    const next = Math.min(filePaths.length - 1, Math.max(0, (base === -1 ? 0 : base) + delta));
    void openFile(filePaths[next]);
  }

  // The tree notifies selection listeners synchronously from inside `select()`
  // and `deselect()`, so this flag reliably marks the resulting callback as the
  // pane's own bookkeeping rather than a row the user picked.
  let isSyncingTreeSelection = false;

  function syncTreeSelection(path: string) {
    if (!treeInstance) return;
    isSyncingTreeSelection = true;
    try {
      const current = treeInstance.getSelectedPaths();
      if (current.length === 1 && current[0] === path) {
        treeInstance.scrollToPath(path, { offset: "nearest" });
        return;
      }
      for (const currentPath of current) treeInstance.getItem(currentPath)?.deselect();
      treeInstance.getItem(path)?.select();
      treeInstance.scrollToPath(path, { offset: "nearest" });
    } finally {
      isSyncingTreeSelection = false;
    }
  }

  async function mutate(mutation: ProjectFileMutation): Promise<boolean> {
    const result = await workspace
      .apiForSession(ctx.session.sessionId)
      .mutateProjectFile(ctx, { cwd: root || cwd, mutation });
    if (!result.ok) toasts.error(result.error);
    return result.ok;
  }

  /**
   * Create the entry under a placeholder name, then hand the user its rename
   * input. Deferring the write until they commit a name looks tidier but leaves
   * the row describing nothing: the tree treats an unchanged name as a no-op and
   * never reports it, so the row would survive with no file behind it.
   */
  async function startCreate(directory: string, kind: FileTreeEntryKind) {
    if (!treeInstance) return;
    const placeholder = placeholderEntryPath(directory, kind, new Set(treePaths));
    const created = await mutate(
      kind === "folder"
        ? { op: "createFolder", path: placeholder }
        : { op: "createFile", path: placeholder },
    );
    if (!created || !treeInstance) return;
    addTreePath(treePaths, placeholder);
    treeInstance.add(placeholder);
    if (kind === "file") void openFile(placeholder);
    // `startRenaming` expands the ancestors it needs, so the input is on screen.
    treeInstance.startRenaming(placeholder);
  }

  // The tree has already moved the row by the time this runs, so a failed disk
  // write has to put it back rather than merely report itself.
  function handleTreeRename(event: FileTreeRenameEvent) {
    void commitTreeRename(
      canonicalTreePath(event.sourcePath, event.isFolder),
      canonicalTreePath(event.destinationPath, event.isFolder),
    );
  }

  async function commitTreeRename(source: string, destination: string) {
    if (!(await mutate({ op: "rename", path: source, toPath: destination }))) {
      treeInstance?.move(destination, source);
      return;
    }

    const moved = renameTreePath(treePaths, source, destination);
    // The open file keeps its buffer and simply answers to the new path.
    const followed = selectedPath ? moved.find((entry) => entry.from === selectedPath) : undefined;
    if (followed) selectedPath = followed.to;
    if (pickedPath === source) pickedPath = destination;
  }

  async function deleteEntry(path: string) {
    const isFolder = isFolderPath(path);
    if (!(await mutate({ op: "delete", path }))) return;
    treeInstance?.remove(path, isFolder ? { recursive: true } : undefined);
    const removed = selectedPath !== null
      && (selectedPath === path || (isFolder && selectedPath.startsWith(path)));
    // A pick naming something deleted would send the next create into a folder
    // that is gone, so it falls back to the project root.
    if (pickedPath !== null && (pickedPath === path || pickedPath.startsWith(path))) {
      pickedPath = null;
    }
    removeTreePath(treePaths, path);
    toasts.success(`Deleted ${entryDisplayName(path)}`);
    if (!removed) return;
    selectedPath = null;
    selectedContents = null;
    const next = filePaths[0];
    if (next) void openFile(next);
  }

  function openContextMenu(
    item: ContextMenuItem,
    x: number,
    y: number,
    close: (options?: { restoreFocus?: boolean }) => void,
  ) {
    closeTreeContextMenu = close;
    contextMenu = {
      x,
      y,
      path: canonicalTreePath(item.path, item.kind === "directory"),
      isFolder: item.kind === "directory",
    };
  }

  function closeContextMenu() {
    contextMenu = null;
    // The tree keeps its row in a "menu open" state until it is told otherwise.
    const close = closeTreeContextMenu;
    closeTreeContextMenu = null;
    close?.({ restoreFocus: false });
  }

  /** Right-click plus a per-row button. Touch has no right-click and no hover,
   *  so on a phone the button is the only way in and has to stay on screen. */
  function treeComposition(): FileTreeCompositionOptions {
    return {
      contextMenu: {
        enabled: true,
        triggerMode: "both",
        buttonVisibility: runtime.isMobileViewport ? "always" : "when-needed",
        onOpen: (item, context) =>
          openContextMenu(item, context.anchorRect.left, context.anchorRect.bottom, context.close),
        onClose: () => {
          closeTreeContextMenu = null;
          contextMenu = null;
        },
      },
    };
  }

  function mountTree() {
    if (!treeHost || treeInstance) return;
    const tree = new FileTree({
      paths: treePaths,
      flattenEmptyDirectories: true,
      initialExpansion: "closed",
      search: true,
      searchBlurBehavior: "retain",
      renaming: { onRename: handleTreeRename, onError: (message) => toasts.error(message) },
      composition: treeComposition(),
      onSelectionChange: (selectedPaths) => {
        const next = selectedPaths[0] ?? null;
        const item = next ? tree.getItem(next) : null;
        const isDirectory = item?.isDirectory() === true;
        if (next && !isSyncingTreeSelection) pickedPath = canonicalTreePath(next, isDirectory);
        // A directory row click already toggles expansion natively; only clear
        // the directory's selection so the open file keeps its highlight.
        if (isDirectory) {
          item?.deselect();
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

  // Clicking the tree's empty space unpicks the current row, which is the only
  // way back to the project root once a row has been picked. The listener goes
  // on the host rather than the markup because rows live in the tree's shadow
  // DOM: the click is composed, so the row is found in the composed path.
  function unpickOnBackgroundClick(event: MouseEvent) {
    const onRow = event
      .composedPath()
      .some((node) => node instanceof HTMLElement && node.dataset.type === "item");
    if (!onRow) pickedPath = null;
  }

  onMount(() => {
    mountTree();
    return () => {
      treeInstance?.cleanUp();
      treeInstance = null;
    };
  });

  $effect(() => {
    const host = treeHost;
    if (!host) return;
    host.addEventListener("click", unpickOnBackgroundClick);
    return () => host.removeEventListener("click", unpickOnBackgroundClick);
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
    // Identity, not contents: a mutation the tree performed itself is written
    // back into `treePaths` in place, and re-seeding the tree from it would
    // throw away the row's expansion and rename state for nothing.
    if (renderedTreePaths !== treePaths) {
      renderedTreePaths = treePaths;
      treeInstance.resetPaths(treePaths);
    }
  });

  // The row's menu button has to become permanent when the pane crosses into a
  // touch layout, where nothing hovers it into view.
  $effect(() => {
    const composition = treeComposition();
    treeInstance?.setComposition(composition);
  });

  $effect(() => {
    if (selectedPath && filePaths.includes(selectedPath)) syncTreeSelection(selectedPath);
  });
</script>

<!-- The three plain header controls differ only in label, icon, and handler.
     The tree toggle stays written out: it alone carries a pressed state and a
     label that changes with it. -->
{#snippet newFileIcon()}<FilePlusIcon />{/snippet}
{#snippet newFolderIcon()}<FolderPlusIcon />{/snippet}
{#snippet refreshIcon()}<ArrowClockwiseIcon />{/snippet}

{#snippet chromeAction(label: string, onclick: () => void, icon: Snippet)}
  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props: tooltipProps })}
        <Button
          {...tooltipProps}
          variant="ghost"
          size="icon-xs"
          class="size-(--solus-tap-target) pointer-fine:size-6 text-(--solus-text-tertiary)"
          aria-label={label}
          {onclick}
        >
          {@render icon()}
        </Button>
      {/snippet}
    </TooltipUI.Trigger>
    <TooltipUI.Content value={label} />
  </TooltipUI.Root>
{/snippet}

<div
  class="flex h-full min-h-0 min-w-0 flex-col border-l border-(--solus-container-border) bg-(--solus-container-bg)"
  bind:clientWidth={panelWidth}
>
  <!-- In-content path line on the shared chrome centreline: the tree/refresh
       controls sit at its left and the pane's close lives in the floating
       PaneChrome cluster, which the right gutter reserves room for. -->
  <div
    class="workspace-titlebar flex h-(--solus-chrome-row-h) shrink-0 items-center gap-2 pr-[max(0.75rem,var(--solus-pane-chrome-inset,0px))] pl-[max(0.75rem,var(--solus-chrome-lead-inset,0px))]"
  >
    <!-- One cluster so the four controls read as a toolbar; the row's own
         `gap-2` then only separates them from the path line. The box shrinks to
         the icon on a fine pointer and keeps the full tap target on a coarse one. -->
    <div class="flex shrink-0 items-center gap-0.5">
      <TooltipUI.Root>
        <TooltipUI.Trigger>
          {#snippet child({ props: tooltipProps })}
            <Button
              {...tooltipProps}
              variant="ghost"
              size="icon-xs"
              class="size-(--solus-tap-target) pointer-fine:size-6 {treeCollapsed
                ? 'text-(--solus-text-tertiary)'
                : 'text-(--solus-text-primary)'}"
              aria-label={treeCollapsed ? "Show file tree" : "Hide file tree"}
              aria-pressed={!treeCollapsed}
              onclick={toggleTree}
            >
              <SidebarSimpleIcon weight="bold" />
            </Button>
          {/snippet}
        </TooltipUI.Trigger>
        <TooltipUI.Content value={treeCollapsed ? "Show file tree (⌥T)" : "Hide file tree (⌥T)"} />
      </TooltipUI.Root>
      {@render chromeAction("New file", () => void startCreate(newEntryDirectory, "file"), newFileIcon)}
      {@render chromeAction("New folder", () => void startCreate(newEntryDirectory, "folder"), newFolderIcon)}
      {@render chromeAction("Refresh files", () => void loadFiles(), refreshIcon)}
    </div>
    {#if selectedPath}
      {@const icon = fileTypeIcon(selectedPath)}
      {#if icon}
        <Icon {icon} width="14" height="14" class="shrink-0" />
      {:else}
        <span
          class="shrink-0 rounded bg-(--solus-accent-light) px-1.5 py-0.5 text-xs font-medium text-(--solus-text-tertiary)"
        >
          {ext(selectedPath)}
        </span>
      {/if}
      <div class="min-w-0 flex-1 truncate text-sm">
        <span class="text-(--solus-text-tertiary)">{parentDirectoryOf(selectedPath)}</span>
        <span class="text-(--solus-text-primary)">{entryDisplayName(selectedPath)}</span>
      </div>
    {:else}
      <FolderIcon size={13} weight="duotone" class="shrink-0 text-(--solus-text-tertiary)" />
      <div class="min-w-0 flex-1 truncate text-sm text-(--solus-text-primary)">
        Files
      </div>
    {/if}
    {#if isSelectedMarkdown}
      <SegmentedControl
        options={MARKDOWN_FILE_VIEW_OPTIONS}
        isActive={(mode) => markdownViewMode === mode}
        onSelect={selectMarkdownView}
        ariaLabel="Markdown file view"
        variant="bar"
        compact
      />
    {/if}
    {#if statusLabel}
      <div class="flex shrink-0 items-center gap-1 text-xs font-medium {statusClass}" role="status">
        <FloppyDiskIcon size={11} class="shrink-0" />
        <span class="tabular-nums">{statusLabel}</span>
      </div>
    {/if}
    {#if saveState === "conflict" && selectedPath}
      <button
        type="button"
        class="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-(--solus-text-primary) ring-1 ring-(--solus-container-border) transition-[background-color,scale] duration-150 hover:bg-(--solus-surface-hover) active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
        onclick={() => selectedPath && openFile(selectedPath)}
      >
        Reload
      </button>
    {/if}
  </div>

  <Resizable.PaneGroup
    direction={runtime.isMobileViewport ? "vertical" : "horizontal"}
    keyboardResizeBy={2}
    class="min-h-0 flex-1"
    onLayoutChange={handleTreeLayout}
  >
    <Resizable.Pane
      bind:this={treePane}
      order={1}
      defaultSize={runtime.isMobileViewport ? 35 : treeDefaultSize}
      minSize={runtime.isMobileViewport ? 20 : treeBounds.min}
      maxSize={runtime.isMobileViewport ? 55 : treeBounds.max}
      collapsedSize={0}
      collapsible
      onCollapse={() => (treeCollapsed = true)}
      onExpand={() => (treeCollapsed = false)}
      class="tree-pane"
    >
      <aside
        class="relative flex h-full min-h-48 w-full flex-col border-b border-(--solus-container-border) md:min-h-0 md:border-r md:border-b-0"
        aria-hidden={treeCollapsed}
      >
        <TooltipUI.Root>
          <TooltipUI.Trigger>
            {#snippet child({ props: tooltipProps })}
              <button {...tooltipProps}
          type="button"
          onclick={toggleTree}
          aria-label="Hide file tree"
          class="tree-collapse-btn absolute top-[0.875rem] left-3 z-10 w-5 h-5 flex items-center justify-center rounded cursor-pointer text-(--solus-text-tertiary)"
        >
          <span
            class="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
            aria-hidden="true"
          ></span>
          <CaretLeftIcon size={12} weight="bold" />
        </button>
            {/snippet}
          </TooltipUI.Trigger>
          <TooltipUI.Content value={"Hide file tree (⌥T)"} />
        </TooltipUI.Root>
        <div class="min-h-0 flex-1 overflow-hidden">
          {#if loading && treePaths.length === 0}
            <FilesPaneSkeleton variant="tree" />
          {:else if error}
            <div class="flex gap-2 p-3 text-xs text-(--solus-status-error)">
              <WarningCircleIcon size={14} weight="fill" class="mt-0.5 shrink-0" />
              <span class="min-w-0">{error}</span>
            </div>
          {:else if treePaths.length === 0}
            <div class="p-3 text-xs text-(--solus-text-tertiary)">No files found.</div>
          {:else}
            <div
              bind:this={treeHost}
              class="files-tree h-full min-h-0 overflow-auto"
              style="-webkit-overflow-scrolling:touch; overscroll-behavior-y:contain"
            ></div>
          {/if}
        </div>
      </aside>
    </Resizable.Pane>

    <Resizable.Handle
      aria-label="Resize file tree"
      disabled={treeCollapsed || runtime.isMobileViewport}
      class={treeCollapsed || runtime.isMobileViewport ? "hidden" : ""}
      onDraggingChange={handleTreeDragging}
    />

    <Resizable.Pane order={2} minSize={runtime.isMobileViewport ? 45 : 0}>
      <section class="flex h-full min-h-0 min-w-0 flex-col">
        {#if fileLoading || (loading && treePaths.length === 0)}
          <FilesPaneSkeleton variant="editor" />
        {:else if fileError}
          <div class="flex flex-1 items-center justify-center p-6 text-center text-xs text-(--solus-status-error)">
            {fileError}
          </div>
        {:else if selectedPath && selectedContents !== null}
          {#if isSelectedMarkdown}
            <MarkdownFileSurface
              bind:this={markdownSurfaceRef}
              api={workspace.apiForSession(ctx.session.sessionId)}
              {ctx}
              cwd={root || cwd}
              filePath={selectedPath}
              displayPath={selectedPath}
              contents={selectedContents}
              isReadOnly={selectedReadOnly}
              {isDark}
              mode={markdownViewMode}
              onSaveStateChange={(state) => {
                saveState = state;
              }}
            />
          {:else}
            <FilePreviewStream
              api={workspace.apiForSession(ctx.session.sessionId)}
              {ctx}
              cwd={root || cwd}
              filePath={selectedPath}
              displayPath={selectedPath}
              contents={selectedContents}
              isReadOnly={selectedReadOnly}
              {isDark}
              onSaveStateChange={(state) => {
                saveState = state;
              }}
            />
          {/if}
        {:else}
          <div class="flex flex-1 items-center justify-center text-xs text-(--solus-text-tertiary)">
            Select a file to edit.
          </div>
        {/if}
      </section>
    </Resizable.Pane>
  </Resizable.PaneGroup>
</div>

{#if contextMenu}
  {@const target = contextMenu}
  <FilesTreeContextMenu
    x={target.x}
    y={target.y}
    name={entryDisplayName(target.path)}
    onCreate={(kind) => void startCreate(creationDirectoryFor(target.path, target.isFolder), kind)}
    onRename={() => treeInstance?.startRenaming(target.path)}
    onDelete={() => void deleteEntry(target.path)}
    onClose={closeContextMenu}
  />
{/if}

<style>
  .tree-pane {
    transition: flex-grow 180ms cubic-bezier(0.2, 0, 0, 1);
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
