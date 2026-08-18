<script lang="ts">
  import { untrack } from "svelte";
  import { FloppyDiskIcon, LockSimpleIcon, WarningCircleIcon } from "phosphor-svelte";
  import Icon from "@iconify/svelte";
  import type { IpcContext } from "../../../shared/types";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { getWorkspaceContext } from "../../contexts";
  import { fileTypeIcon } from "../../lib/fileTypeIcon";
  import { ensureIconCollections } from "../diagram/iconify";
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

  interface Props {
    ctx: IpcContext;
    cwd: string;
    isDark: boolean;
    file: { path: string; line?: number };
    /** Identifies the reveal *request*, so re-opening the same file and line
     *  scrolls to it again instead of looking like nothing happened. */
    revealEpoch?: number;
    onClose: () => void;
  }

  let { ctx, cwd, isDark, file, revealEpoch = 0, onClose }: Props = $props();
  const workspace = getWorkspaceContext();

  ensureIconCollections();

  function ext(path: string): string {
    const name = fileName(path);
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(dot + 1).toUpperCase() : "·";
  }

  function fileName(path: string): string {
    return path.split("/").pop() ?? path;
  }

  function dirName(path: string): string {
    const index = path.lastIndexOf("/");
    return index > 0 ? path.slice(0, index + 1) : "";
  }

  let loading = $state(false);
  let fileError = $state<string | null>(null);
  let filePath = $state("");
  let displayPath = $state("");
  let contents = $state<string | null>(null);
  let size = $state<number | null>(null);
  let isReadOnly = $state(false);
  let isTruncated = $state(false);
  let saveState = $state<FileSaveState>("idle");
  let markdownSurfaceRef: MarkdownFileSurface | null = $state(null);
  let markdownViewMode = $state<MarkdownFileViewMode>(
    untrack(() => initialMarkdownFileViewMode(file.path, file.line)),
  );
  let loadGeneration = 0;
  const headerPath = $derived(displayPath || file.path);
  const headerIcon = $derived(fileTypeIcon(headerPath));
  const isMarkdown = $derived(isMarkdownFile(headerPath));

  const statusLabel = $derived.by(() => {
    if (isTruncated) return "Truncated — read only";
    if (isReadOnly) return "Read only";
    if (saveState === "dirty") return "Unsaved";
    if (saveState === "saving") return "Saving...";
    if (saveState === "saved") return "Saved";
    return size == null ? "" : `${Math.ceil(size / 1024)} KB`;
  });

  const statusClass = $derived(
    saveState === "saved"
      ? "text-(--solus-status-complete)"
      : "text-(--solus-text-tertiary)",
  );

  useScope("file-editor");
  useKeybinding("file-editor.close", () => closeEditor());
  useKeybinding("file-editor.toggle-markdown", () => toggleMarkdownView());

  function closeEditor() {
    onClose();
    requestInputFocus();
  }

  async function selectMarkdownView(mode: MarkdownFileViewMode) {
    await markdownSurfaceRef?.prepareModeChange(mode);
    markdownViewMode = mode;
    persistMarkdownFileViewMode(mode);
  }

  function toggleMarkdownView() {
    if (!isMarkdown) return;
    void selectMarkdownView(markdownViewMode === "rendered" ? "source" : "rendered");
  }

  async function loadFile(path: string) {
    const generation = ++loadGeneration;
    loading = true;
    fileError = null;
    contents = null;
    size = null;
    isReadOnly = false;
    isTruncated = false;
    saveState = "idle";

    const result = await workspace.apiForSession(ctx.session.sessionId).readProjectFile(ctx, { path, cwd });
    if (generation !== loadGeneration) return;
    if (result.ok) {
      filePath = result.path;
      displayPath = result.displayPath;
      contents = result.contents;
      size = result.size;
      isReadOnly = result.isReadOnly;
      isTruncated = result.truncated === true;
      if (isTruncated) markdownViewMode = "source";
    } else {
      filePath = path;
      displayPath = path;
      fileError = result.error;
    }
    loading = false;
  }

  $effect(() => {
    void cwd;
    void file.path;
    void file.line;
    markdownViewMode = initialMarkdownFileViewMode(file.path, file.line);
    if (cwd && file.path) void loadFile(file.path);
  });
</script>

<div
  class="text-xs flex h-full min-h-0 min-w-0 flex-col border-l border-(--solus-container-border) bg-(--solus-container-bg)"
  data-file-editor-pane
>
  <!-- In-content path line on the shared chrome centreline. The pane's close
       lives in the floating PaneChrome cluster, which the right gutter reserves
       room for. -->
  <div
    class="workspace-titlebar flex h-(--solus-chrome-row-h) shrink-0 items-center gap-2 pr-[max(0.75rem,var(--solus-pane-chrome-inset,0px))] pl-[max(0.75rem,var(--solus-chrome-lead-inset,0px))]"
  >
    {#if headerIcon}
      <Icon icon={headerIcon} width="14" height="14" class="shrink-0" />
    {:else}
      <span
        class="shrink-0 rounded bg-(--solus-accent-light) px-1.5 py-0.5  font-medium text-(--solus-text-tertiary)"
      >
        {ext(headerPath)}
      </span>
    {/if}
    <div
      class="min-w-0 flex-1 truncate text-sm"
      title={headerPath}
    >
      <span class="text-(--solus-text-tertiary)">{dirName(headerPath)}</span>
      <span class="text-(--solus-text-primary)">{fileName(headerPath)}</span>
    </div>
    {#if isMarkdown}
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
      <div class="flex shrink-0 items-center gap-1  font-medium {statusClass}" role="status">
        {#if isReadOnly}
          <LockSimpleIcon size={11} class="shrink-0" />
        {:else}
          <FloppyDiskIcon size={11} class="shrink-0" />
        {/if}
        <span class="tabular-nums">{statusLabel}</span>
      </div>
    {/if}
    {#if saveState === "conflict"}
      <button
        type="button"
        class="shrink-0 rounded-md px-2 py-1  font-medium text-(--solus-text-primary) ring-1 ring-(--solus-container-border) transition-[background-color,scale] duration-150 hover:bg-(--solus-surface-hover) active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
        onclick={() => void loadFile(file.path)}
      >
        Reload
      </button>
    {/if}
  </div>

  {#if loading}
    <div class="flex min-h-0 flex-1 flex-col" role="status">
      <FilesPaneSkeleton variant="editor" />
      <span class="sr-only">Opening file...</span>
    </div>
  {:else if fileError}
    <div class="flex flex-1 items-center justify-center gap-2 p-6 text-center  text-(--solus-status-error)">
      <WarningCircleIcon size={14} weight="fill" class="shrink-0" />
      <span>{fileError}</span>
    </div>
  {:else if contents !== null}
    {#if isMarkdown}
      <MarkdownFileSurface
        bind:this={markdownSurfaceRef}
        api={workspace.apiForSession(ctx.session.sessionId)}
        {ctx}
        {cwd}
        {filePath}
        {displayPath}
        {contents}
        line={file.line}
        {revealEpoch}
        {isDark}
        {isReadOnly}
        mode={markdownViewMode}
        onSaveStateChange={(state) => {
          saveState = state;
        }}
      />
    {:else}
      <FilePreviewStream
        api={workspace.apiForSession(ctx.session.sessionId)}
        {ctx}
        {cwd}
        {filePath}
        {displayPath}
        {contents}
        line={file.line}
        {revealEpoch}
        {isDark}
        {isReadOnly}
        onSaveStateChange={(state) => {
          saveState = state;
        }}
      />
    {/if}
  {/if}
</div>
