<script lang="ts">
  import { untrack } from "svelte";
  import type { IpcContext } from "@solus/contracts/types";
  import type { HostApi } from "@solus/client-core/host-api";
  import FilePreviewStream, {
    type FileSaveState,
  } from "../artifact/FilePreviewStream.svelte";
  import DocumentEditor from "../editor/DocumentEditor.svelte";
  import { toasts } from "../../lib/toasts";
  import type { MarkdownFileViewMode } from "./lib/markdown-file";

  interface Props {
    api: HostApi;
    ctx: IpcContext;
    cwd: string;
    filePath: string;
    displayPath: string;
    contents: string;
    isDark: boolean;
    mode: MarkdownFileViewMode;
    isReadOnly?: boolean;
    line?: number;
    revealEpoch?: number;
    onSaveStateChange?: (state: FileSaveState) => void;
  }

  let {
    api,
    ctx,
    cwd,
    filePath,
    displayPath,
    contents,
    isDark,
    mode,
    isReadOnly = false,
    line,
    revealEpoch = 0,
    onSaveStateChange,
  }: Props = $props();

  let renderedContents = $state(untrack(() => contents));
  let lastSavedContents = untrack(() => contents);
  let richEditorRef: DocumentEditor | null = $state(null);
  let sourceEditorRef: FilePreviewStream | null = $state(null);
  let saveQueue: Promise<void> = Promise.resolve();
  let hasMountedRendered = $state(untrack(() => mode === "rendered"));
  let hasMountedSource = $state(untrack(() => mode === "source"));

  $effect(() => {
    renderedContents = contents;
    lastSavedContents = contents;
  });

  $effect(() => {
    if (mode === "rendered") hasMountedRendered = true;
    else hasMountedSource = true;
  });

  function setSaveState(state: FileSaveState) {
    onSaveStateChange?.(state);
  }

  async function saveRenderedContents(nextContents: string): Promise<boolean> {
    if (isReadOnly) return true;
    let saved = false;
    saveQueue = saveQueue.then(async () => {
      if (nextContents === lastSavedContents) {
        saved = true;
        return;
      }
      setSaveState("saving");
      const result = await api.writeFile(ctx, {
        path: filePath,
        cwd,
        contents: nextContents,
        expectedContents: lastSavedContents,
      });
      if (result.ok) {
        lastSavedContents = nextContents;
        setSaveState("saved");
        saved = true;
        return;
      }
      if (result.conflict) {
        setSaveState("conflict");
        toasts.error("File changed on disk", {
          description: `${displayPath || filePath} — Reload before saving.`,
        });
        return;
      }
      setSaveState("error");
      toasts.error("Save failed", {
        description: `${displayPath || filePath} — ${result.error}`,
      });
    });
    await saveQueue;
    return saved;
  }

  async function handleRenderedChange(nextContents: string) {
    renderedContents = nextContents;
    const saved = await saveRenderedContents(nextContents);
    if (saved && mode === "rendered") {
      sourceEditorRef?.replaceContents(nextContents);
    }
  }

  export async function prepareModeChange(nextMode: MarkdownFileViewMode) {
    if (nextMode === mode) return;
    if (nextMode === "source") {
      richEditorRef?.cancelPendingEmit();
      const nextContents = richEditorRef?.getCurrentMarkdown() ?? renderedContents;
      renderedContents = nextContents;
      const saved = await saveRenderedContents(nextContents);
      sourceEditorRef?.replaceContents(nextContents, saved);
      return;
    }
    await sourceEditorRef?.flushSave();
    renderedContents = sourceEditorRef?.getCurrentContents() ?? renderedContents;
  }
</script>

<div class="relative flex h-full min-h-0 min-w-0 flex-1 flex-col">
  {#if hasMountedRendered}
    <div
      class="h-full min-h-0 min-w-0 flex-1"
      style:display={mode === "rendered" ? undefined : "none"}
      aria-hidden={mode !== "rendered"}
    >
      <DocumentEditor
        bind:this={richEditorRef}
        value={renderedContents}
        onInput={() => setSaveState("dirty")}
        onValueChange={(nextContents) => void handleRenderedChange(nextContents)}
        readOnly={isReadOnly}
        placeholder="Start writing…"
        class="markdown-file-document-editor h-full min-h-0 overflow-y-auto"
      />
    </div>
  {/if}

  {#if hasMountedSource}
    <div
      class="h-full min-h-0 min-w-0 flex-1"
      style:display={mode === "source" ? undefined : "none"}
      aria-hidden={mode !== "source"}
    >
      <FilePreviewStream
        bind:this={sourceEditorRef}
        {api}
        {ctx}
        {cwd}
        {filePath}
        {displayPath}
        {contents}
        {line}
        {revealEpoch}
        {isDark}
        {isReadOnly}
        {onSaveStateChange}
        onContentsChange={(nextContents) => {
          renderedContents = nextContents;
        }}
        onContentsSaved={(savedContents) => {
          lastSavedContents = savedContents;
        }}
      />
    </div>
  {/if}
</div>
