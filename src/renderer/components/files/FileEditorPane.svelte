<script lang="ts">
  import {
    FileIcon,
    FloppyDiskIcon,
    WarningCircleIcon,
    XIcon,
  } from "phosphor-svelte";
  import type { IpcContext } from "../../../shared/types";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import {
    useKeybinding,
    useScope,
  } from "../../lib/keybindings/use-keybinding.svelte";
  import FilePreviewStream, {
    type FileSaveState,
  } from "../artifact/FilePreviewStream.svelte";

  interface Props {
    ctx: IpcContext;
    cwd: string;
    isDark: boolean;
    file: { path: string; line?: number };
    onClose: () => void;
  }

  let { ctx, cwd, isDark, file, onClose }: Props = $props();
  const workspace = getWorkspaceContext();

  let loading = $state(false);
  let fileError = $state<string | null>(null);
  let filePath = $state("");
  let displayPath = $state("");
  let contents = $state<string | null>(null);
  let size = $state<number | null>(null);
  let saveState = $state<FileSaveState>("idle");
  let saveMessage = $state<string | undefined>(undefined);
  let loadGeneration = 0;

  const statusLabel = $derived.by(() => {
    if (saveState === "dirty") return "Unsaved";
    if (saveState === "saving") return "Saving...";
    if (saveState === "saved") return "Saved";
    if (saveState === "conflict") return "Changed on disk";
    if (saveState === "error") return "Save failed";
    return size == null ? "" : `${Math.ceil(size / 1024)} KB`;
  });

  const statusClass = $derived(
    saveState === "saved"
      ? "text-(--solus-status-complete)"
      : saveState === "error" || saveState === "conflict"
        ? "text-(--solus-status-error)"
        : "text-(--solus-text-tertiary)",
  );

  useScope("file-editor");
  useKeybinding("file-editor.close", () => closeEditor());

  function closeEditor() {
    onClose();
    requestInputFocus();
  }

  async function loadFile(path: string) {
    const generation = ++loadGeneration;
    loading = true;
    fileError = null;
    contents = null;
    size = null;
    saveState = "idle";
    saveMessage = undefined;

    const result = await workspace.apiFor(ctx.session.tabId).readProjectFile(ctx, { path, cwd });
    if (generation !== loadGeneration) return;
    if (result.ok) {
      filePath = result.path;
      displayPath = result.displayPath;
      contents = result.contents;
      size = result.size;
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
    if (cwd && file.path) void loadFile(file.path);
  });
</script>

<div class="flex h-full min-h-0 min-w-0 flex-col border-l border-(--solus-container-border) bg-(--solus-container-bg)">
  <header
    class="flex h-(--solus-chrome-row-h,var(--solus-tap-target-lg)) shrink-0 items-center gap-2 border-b border-(--solus-chrome-row-border,var(--solus-container-border)) pr-3 pl-[max(0.75rem,var(--solus-chrome-lead-inset,0px))]"
  >
    <FileIcon size={13} weight="duotone" class="shrink-0 text-(--solus-text-tertiary)" />
    <div class="min-w-0 flex-1">
      <div class="truncate text-[0.75rem] font-semibold text-(--solus-text-primary)" title={displayPath}>
        {displayPath}
      </div>
    </div>
    {#if statusLabel}
      <div class="flex shrink-0 items-center gap-1 text-[0.625rem] font-medium {statusClass}" role="status" title={saveMessage}>
        <FloppyDiskIcon size={11} class="shrink-0" />
        <span class="tabular-nums">{statusLabel}</span>
      </div>
    {/if}
    {#if saveState === "conflict"}
      <button
        type="button"
        class="shrink-0 rounded-md px-2 py-1 text-[0.6875rem] font-medium text-(--solus-text-primary) ring-1 ring-(--solus-container-border) transition-[background-color,scale] duration-150 hover:bg-(--solus-surface-hover) active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
        onclick={() => void loadFile(file.path)}
      >
        Reload
      </button>
    {/if}
    <button
      type="button"
      class="flex size-(--solus-tap-target) shrink-0 cursor-pointer items-center justify-center rounded-md text-(--solus-text-tertiary) transition-[background-color,color,scale] duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
      aria-label="Close file editor"
      onclick={closeEditor}
    >
      <XIcon size={13} />
    </button>
  </header>

  {#if loading}
    <div class="flex flex-1 items-center justify-center text-[0.75rem] text-(--solus-text-tertiary)">
      Opening file...
    </div>
  {:else if fileError}
    <div class="flex flex-1 items-center justify-center gap-2 p-6 text-center text-[0.75rem] text-(--solus-status-error)">
      <WarningCircleIcon size={14} weight="fill" class="shrink-0" />
      <span>{fileError}</span>
    </div>
  {:else if contents !== null}
    <FilePreviewStream
      api={workspace.apiFor(ctx.session.tabId)}
      {ctx}
      {cwd}
      {filePath}
      {displayPath}
      {contents}
      line={file.line}
      {isDark}
      onSaveStateChange={(state, message) => {
        saveState = state;
        saveMessage = message;
      }}
    />
  {/if}
</div>
