<script lang="ts">
  import { untrack } from "svelte";
  import {
    CaseSensitive as TextAaIcon,
    ChevronLeft as CaretLeftIcon,
    FileType2 as MarkdownLogoIcon,
    Save as FloppyDiskIcon,
    LockKeyhole as LockSimpleIcon,
    CircleAlert as WarningCircleIcon,
  } from "@lucide/svelte";
  import Icon from "@iconify/svelte";
  import type { IpcContext } from "@solus/contracts/types";
  import type { PaneId } from "../../contexts/workspace/routing/location";
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
  import {
    HTML_FILE_VIEW_OPTIONS,
    initialHtmlFileViewMode,
    isHtmlFile,
    persistHtmlFileViewMode,
    type HtmlFileViewMode,
  } from "./lib/html-file";
  import HtmlFilePreview from "./HtmlFilePreview.svelte";
  import FilesPaneSkeleton from "./FilesPaneSkeleton.svelte";
  import CodeIntelPopover from "../code-intel/CodeIntelPopover.svelte";
  import { codeIntelStore } from "../code-intel/code-intel.store.svelte";
  import { symbolAvailability } from "../code-intel/lib/symbol-card";
  import type { CodeSymbolHit } from "../code-intel/lib/hit-test";
  import type { CodeSymbolAvailability, CodeSymbolLookup } from "../code-intel/lib/symbol-card";
  import { serverConnections } from "@solus/client-core/server-connections";

  interface Props {
    ctx: IpcContext;
    cwd: string;
    isDark: boolean;
    file: { path: string; line?: number };
    /** The tab or draft this editor was opened for; symbol navigation opens
     *  its targets in the same pane lineage. */
    sourceId?: string;
    /** The pane that owns this editor. Symbol targets open across from it. */
    paneId?: PaneId;
    /** Identifies the reveal *request*, so re-opening the same file and line
     *  scrolls to it again instead of looking like nothing happened. */
    revealEpoch?: number;
    bordered?: boolean;
    onClose: () => void;
  }

  let { ctx, cwd, isDark, file, sourceId, paneId, revealEpoch = 0, bordered = true, onClose }: Props = $props();
  const workspace = getWorkspaceContext();

  // The identifier the user asked about, until the card closes.
  let symbolLookup = $state<CodeSymbolLookup | null>(null);

  function symbolLookupForHit(hit: CodeSymbolHit): CodeSymbolLookup | null {
    // `readProjectFile` uses the absolute path as its display path for files
    // outside the project. Such files are not part of this project's index.
    if (!displayPath || displayPath === filePath) return null;
    const api = workspace.apiForSession(ctx.session.sessionId);
    return {
      serverId: serverConnections.serverIdForApi(api),
      api,
      ctx,
      root: cwd,
      path: displayPath.replaceAll("\\", "/"),
      line: hit.line - 1,
      character: hit.character,
      token: hit.token,
      anchor: hit.anchor,
    };
  }

  function handleSymbolHit(hit: CodeSymbolHit) {
    symbolLookup = symbolLookupForHit(hit);
  }

  async function availabilityOfSymbol(hit: CodeSymbolHit): Promise<CodeSymbolAvailability> {
    const lookup = symbolLookupForHit(hit);
    if (!lookup) return "none";
    try {
      const result = await codeIntelStore.symbolAt(lookup.serverId, lookup.api, lookup.ctx, {
        cwd: lookup.root,
        path: lookup.path,
        line: lookup.line,
        character: lookup.character,
      });
      return symbolAvailability(result);
    } catch {
      return "none";
    }
  }

  function openSymbolLocation(path: string, line: number) {
    symbolLookup = null;
    if (!sourceId) return;
    workspace.openFilePreview({ path: `${cwd}/${path}`, line }, sourceId, paneId);
  }

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
  const isHtml = $derived(isHtmlFile(headerPath));
  let htmlContents = $state("");
  let htmlSourceMounted = $state(false);
  let filePreviewRef: FilePreviewStream | null = $state(null);
  let htmlViewMode = $state<HtmlFileViewMode>(
    untrack(() => initialHtmlFileViewMode(file.path, file.line)),
  );

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

  async function selectHtmlView(mode: HtmlFileViewMode) {
    if (mode === "preview") {
      const editor = filePreviewRef;
      await editor?.flushSave();
      if (editor !== filePreviewRef) return;
      htmlContents = editor?.getCurrentContents() ?? htmlContents;
    }
    if (mode === "source") htmlSourceMounted = true;
    htmlViewMode = mode;
    persistHtmlFileViewMode(mode);
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
      htmlContents = result.contents;
      htmlSourceMounted = htmlViewMode === "source";
      size = result.size;
      isReadOnly = result.isReadOnly;
      isTruncated = result.truncated === true;
      // Half a document previews as a broken page. Both surfaces fall back to
      // the bytes that actually arrived.
      if (isTruncated) {
        markdownViewMode = "source";
        htmlViewMode = "source";
      }
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
  class={`text-xs flex h-full min-h-0 min-w-0 flex-col bg-(--solus-container-bg) ${bordered ? "border-l border-(--solus-container-border)" : ""}`}
  data-file-editor-pane
>
  <!-- In-content path line on the shared chrome centreline. The pane's close
       lives in the floating PaneChrome cluster, which the right gutter reserves
       room for.

       The band measures its own width, as the review panel's does: a phone
       renders this editor full screen over the conversation with no pane
       chrome at all, and a desktop pane is legally ~356px beside a companion.

       ── The record rung (`@max-[30rem]/band`) ──
       The row leads with the platform's back chevron, because on a phone the
       navbar stands down under this surface and the ✕ was never here. The
       directory gives way to the file name, and the markdown view switch
       becomes the one quiet icon button the document toolbar uses at the
       same rung. -->
  <div class="@container/band shrink-0">
  <div
    class="workspace-titlebar flex h-(--solus-chrome-row-h) items-center gap-2 pr-[max(0.75rem,var(--solus-pane-chrome-inset,0px))] pl-[max(0.75rem,var(--solus-chrome-lead-inset,0px))] @max-[30rem]/band:h-14 @max-[30rem]/band:gap-1 @max-[30rem]/band:pl-2"
  >
    <button
      type="button"
      class="no-drag hidden size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-muted-foreground active:bg-[var(--wash-2)] active:text-foreground @max-[30rem]/band:flex [-webkit-tap-highlight-color:transparent]"
      aria-label="Back to conversation"
      onclick={closeEditor}
    >
      <CaretLeftIcon size={19} />
    </button>
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
      <span class="text-(--solus-text-tertiary) @max-[30rem]/band:hidden">{dirName(headerPath)}</span>
      <span class="text-(--solus-text-primary)">{fileName(headerPath)}</span>
    </div>
    {#if isMarkdown}
      <span class="contents @max-[30rem]/band:hidden">
        <SegmentedControl
          options={MARKDOWN_FILE_VIEW_OPTIONS}
          isActive={(mode) => markdownViewMode === mode}
          onSelect={selectMarkdownView}
          ariaLabel="Markdown file view"
          variant="bar"
          compact
        />
      </span>
      <button
        type="button"
        class="no-drag hidden size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-muted-foreground active:bg-[var(--wash-2)] active:text-foreground @max-[30rem]/band:flex [-webkit-tap-highlight-color:transparent]"
        aria-label={markdownViewMode === "rendered" ? "View raw markdown" : "View rendered editor"}
        onclick={toggleMarkdownView}
      >
        {#if markdownViewMode === "rendered"}<MarkdownLogoIcon size={16} />{:else}<TextAaIcon size={16} />{/if}
      </button>
    {:else if isHtml && !isTruncated}
      <SegmentedControl
        options={HTML_FILE_VIEW_OPTIONS}
        isActive={(mode) => htmlViewMode === mode}
        onSelect={selectHtmlView}
        ariaLabel="HTML file view"
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
      {#if isHtml && htmlViewMode === "preview" && !isTruncated}
        <HtmlFilePreview contents={htmlContents} title={headerPath} />
      {/if}
      {#if !isHtml || htmlViewMode === "source" || htmlSourceMounted}
        <div class="flex min-h-0 flex-1 flex-col" style:display={isHtml && htmlViewMode === "preview" && !isTruncated ? "none" : undefined}>
          <FilePreviewStream
            bind:this={filePreviewRef}
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
            onSymbolHit={sourceId ? handleSymbolHit : undefined}
            symbolAvailability={sourceId ? availabilityOfSymbol : undefined}
            onContentsChange={(nextContents) => { htmlContents = nextContents; }}
          />
        </div>
      {/if}
    {/if}
  {/if}
</div>

<CodeIntelPopover
  lookup={symbolLookup}
  onNavigate={openSymbolLocation}
  onClose={() => (symbolLookup = null)}
/>
