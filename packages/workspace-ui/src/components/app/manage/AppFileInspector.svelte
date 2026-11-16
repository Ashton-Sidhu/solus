<script lang="ts">
  import { Check as CheckIcon, Copy as CopyIcon, FileText as FileGlyph } from "@lucide/svelte";
  import type { AppFileView } from "@solus/contracts/apps";
  import { formatFileSize } from "../../files/lib/non-text-file";
  import { Button } from "../../ui/button";
  import { fileAddedLongText, fileOriginText, shortFileId } from "./lib/app-file-list";
  import type { FilePreview } from "./lib/app-file-preview.svelte";

  /**
   * The selected app file, plain beside the table: a preview, its facts, its
   * id to copy for the backend's `files.get(id)`, Download, and Delete, which
   * asks first in place.
   */
  interface Props {
    file: AppFileView;
    preview: FilePreview;
    nowMs: number;
    isBusy: boolean;
    isCopied: boolean;
    onCopyId: () => void;
    onDownload: () => void;
    onDelete: () => void;
  }
  let { file, preview, nowMs, isBusy, isCopied, onCopyId, onDownload, onDelete }: Props = $props();

  /** The parent keys this inspector by the file, so a new selection never keeps the question of the last one. */
  let isConfirming = $state(false);
</script>

<aside class="flex w-58 shrink-0 flex-col gap-5 pt-1.5 @max-[52rem]/pane:w-full" aria-label="The selected file" data-testid="app-file-inspector">
  <div class="flex h-42 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--wash-2)]">
    {#if preview.url}
      <img src={preview.url} alt="Preview of {file.name}" class="max-h-full max-w-full object-contain" />
    {:else if preview.isLoading}
      <span class="text-xs text-(--solus-text-tertiary)" role="status" aria-busy="true">Loading the preview…</span>
    {:else}
      <FileGlyph size={36} strokeWidth={1.25} class="text-(--solus-text-tertiary)" aria-hidden="true" />
    {/if}
  </div>

  <div class="flex min-w-0 flex-col gap-1">
    <h3 class="m-0 text-[15px] leading-4.5 font-semibold [overflow-wrap:anywhere] text-foreground">{file.name}</h3>
    <p class="m-0 text-[13px] leading-4 text-(--solus-text-tertiary)">{fileOriginText(file)}</p>
  </div>

  <dl class="m-0 flex flex-col text-[13px] leading-4">
    <div class="flex justify-between gap-4 border-t border-border/60 py-2.5">
      <dt class="text-(--solus-text-tertiary)">Size</dt>
      <dd class="m-0 text-foreground tabular-nums">{formatFileSize(file.size)}</dd>
    </div>
    <div class="flex justify-between gap-4 border-t border-border/60 py-2.5">
      <dt class="text-(--solus-text-tertiary)">Added</dt>
      <dd class="m-0 text-right text-foreground" title={new Date(file.createdAt).toLocaleString()}>{fileAddedLongText(file.createdAt, nowMs)}</dd>
    </div>
    <div class="flex items-center justify-between gap-4 border-y border-border/60 py-1.5">
      <dt class="text-(--solus-text-tertiary)">File id</dt>
      <dd class="m-0 flex min-w-0 items-center gap-1">
        <span class="truncate font-mono text-xs text-foreground" title={file.id}>{shortFileId(file.id)}</span>
        <Button size="icon-xs" variant="ghost" aria-label="Copy the file id" title={isCopied ? "Copied" : "Copy the id for files.get(id)"} onclick={onCopyId} data-testid="app-file-copy-id">
          {#if isCopied}<CheckIcon class="text-(--solus-status-complete)" />{:else}<CopyIcon />{/if}
        </Button>
      </dd>
    </div>
  </dl>

  {#if isConfirming}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="flex flex-col gap-2.5 rounded-[10px] bg-destructive/8 p-3"
      role="alertdialog"
      aria-label="Delete {file.name}"
      tabindex="-1"
      onkeydown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        isConfirming = false;
      }}
    >
      <p class="m-0 text-[13px] leading-[1.45] text-destructive">Delete this file? The app can no longer read it.</p>
      <div class="flex gap-2">
        <!-- svelte-ignore a11y_autofocus -->
        <Button size="sm" variant="ghost" class="rounded-full" autofocus disabled={isBusy} onclick={() => (isConfirming = false)}>Cancel</Button>
        <Button size="sm" variant="destructive" disabled={isBusy} onclick={onDelete} data-testid="app-file-delete-confirm">{isBusy ? "Deleting…" : "Delete"}</Button>
      </div>
    </div>
  {:else}
    <div class="flex items-center gap-2">
      <Button size="sm" variant="outline" class="rounded-full" disabled={isBusy} aria-busy={isBusy || undefined} onclick={onDownload}>Download</Button>
      <Button size="sm" variant="ghost" class="rounded-full text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={isBusy} onclick={() => (isConfirming = true)} data-testid="app-file-delete">
        Delete
      </Button>
    </div>
  {/if}
</aside>
