<script lang="ts">
  import { fly } from "svelte/transition";
  import { X as XIcon } from "@lucide/svelte";
  import type { FileDiffMetadata } from "@pierre/diffs";
  import {
    diffFilePath,
    diffFileStats,
    diffFileStatus,
  } from "../../lib/diffTreeAdapter";
  import { toTreeDisplayPath } from "../../lib/diffTreeAdapter";

  interface Props {
    files: FileDiffMetadata[];
    onClose: () => void;
    onSelect: (path: string) => void;
  }

  let { files, onClose, onSelect }: Props = $props();

  // The desktop Changed files card, kept whole: uppercase label, split
  // add/delete bar, per-file counts in tabular mono. Mobile changes only what
  // it must — the row grows so the filename can lead on its own line and never
  // truncate to make room for its folder.
  const totals = $derived(
    files.reduce(
      (sum, file) => {
        const stats = diffFileStats(file);
        return {
          additions: sum.additions + stats.additions,
          deletions: sum.deletions + stats.deletions,
        };
      },
      { additions: 0, deletions: 0 },
    ),
  );
  const totalChanged = $derived(totals.additions + totals.deletions);
  const addedShare = $derived(
    totalChanged === 0 ? 0 : Math.round((totals.additions / totalChanged) * 100),
  );

  /** `panels/MenuRow.svelte` → `MenuRow.svelte` over `…/panels`. The folder
   *  elides from the head because its tail is the part that locates the file. */
  function splitPath(path: string) {
    const display = toTreeDisplayPath(path);
    const cut = display.lastIndexOf("/");
    if (cut < 0) return { name: display, folder: "" };
    return { name: display.slice(cut + 1), folder: display.slice(0, cut) };
  }
</script>

<button
  type="button"
  class="mobile-tree-backdrop"
  aria-label="Close changed files"
  onclick={onClose}
></button>
<div
  class="mobile-tree-sheet"
  transition:fly={{ y: 320, duration: 220, opacity: 1 }}
  role="dialog"
  aria-label="Changed files"
  data-testid="mobile-tree-sheet"
>
  <div class="mobile-tree-grabber" aria-hidden="true"></div>
  <div class="mobile-tree-header">
    <span class="mobile-tree-label">Changed files</span>
    <span class="flex-1"></span>
    <span class="mobile-tree-count tabular-nums"
      >{files.length} file{files.length === 1 ? "" : "s"}</span
    >
    <button
      type="button"
      onclick={onClose}
      aria-label="Close file list"
      class="mobile-tree-close"
    >
      <XIcon size={16} weight="bold" />
    </button>
  </div>

  {#if totalChanged > 0}
    <div class="mobile-tree-summary">
      <span class="mobile-tree-bar" aria-hidden="true">
        <span class="mobile-tree-bar-add" style="width:{addedShare}%"></span>
        <span class="mobile-tree-bar-del" style="width:{100 - addedShare}%"></span>
      </span>
      <span class="mobile-tree-stats tabular-nums">
        <span style="color:color-mix(in oklch, var(--success) 62%, var(--foreground))"
          >+{totals.additions}</span
        >
        <span style="color:color-mix(in oklch, var(--failure) 70%, var(--foreground))"
          >−{totals.deletions}</span
        >
      </span>
    </div>
  {/if}

  <div class="mobile-tree-list">
    {#each files as file (diffFilePath(file))}
      {@const filePath = diffFilePath(file)}
      {@const status = diffFileStatus(file)}
      {@const stats = diffFileStats(file)}
      {@const parts = splitPath(filePath)}
      <button
        type="button"
        class="mobile-tree-row"
        onclick={() => onSelect(filePath)}
      >
        <span class="mobile-tree-status" data-status={status}>{status}</span>
        <span class="mobile-tree-names">
          <span class="mobile-tree-name">{parts.name}</span>
          {#if parts.folder}
            <span class="mobile-tree-folder">{parts.folder}</span>
          {/if}
        </span>
        <span class="mobile-tree-stats tabular-nums">
          {#if stats.additions > 0}<span
              style="color:color-mix(in oklch, var(--success) 62%, var(--foreground))"
              >+{stats.additions}</span
            >{/if}
          {#if stats.deletions > 0}<span
              style="color:color-mix(in oklch, var(--failure) 70%, var(--foreground))"
              >−{stats.deletions}</span
            >{/if}
        </span>
      </button>
    {/each}
  </div>
</div>

<style>
  .tabular-nums {
    font-variant-numeric: tabular-nums;
  }
  .mobile-tree-backdrop {
    position: absolute;
    inset: 0;
    z-index: 40;
    padding: 0;
    border: 0;
    background: rgba(0, 0, 0, 0.4);
    backdrop-filter: blur(0.125rem);
    -webkit-backdrop-filter: blur(0.125rem);
  }
  .mobile-tree-sheet {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 41;
    display: flex;
    flex-direction: column;
    max-height: 70%;
    padding-bottom: max(0.5rem, env(safe-area-inset-bottom, 0));
    border-top-left-radius: 1rem;
    border-top-right-radius: 1rem;
    background: var(--solus-container-bg);
    border-top: 0.0625rem solid var(--solus-container-border);
    box-shadow: 0 -0.5rem 1.5rem rgba(0, 0, 0, 0.18);
  }
  .mobile-tree-grabber {
    width: 2.25rem;
    height: 0.25rem;
    margin: 0.5rem auto 0.25rem;
    border-radius: 0.125rem;
    background: var(--solus-container-border);
    flex-shrink: 0;
  }
  .mobile-tree-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.75rem 0.5rem;
    border-bottom: 0.0625rem solid var(--solus-container-border);
    flex-shrink: 0;
  }
  .mobile-tree-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    border-radius: 0.5rem;
    color: var(--solus-text-tertiary);
    background: transparent;
    border: none;
    cursor: pointer;
  }
  .mobile-tree-close:active {
    background: var(--solus-surface-hover);
  }
  .mobile-tree-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    padding: 0.25rem 0.5rem 0.5rem;
  }
  .mobile-tree-label {
    font-size: var(--text-xs);
    font-weight: 500;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted-foreground);
  }

  .mobile-tree-count {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--muted-foreground);
    opacity: 0.75;
  }

  .mobile-tree-summary {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.625rem 0.875rem;
    border-bottom: 0.0625rem solid var(--hairline);
    flex-shrink: 0;
  }

  /* One bar, split: the share added against the share removed, so the size and
     the direction of a turn read at a glance without the numbers. */
  .mobile-tree-bar {
    display: flex;
    flex: 1;
    height: 0.375rem;
    border-radius: 624.9375rem;
    overflow: hidden;
    background: var(--wash-3);
  }

  .mobile-tree-bar-add {
    background: color-mix(in oklch, var(--success) 70%, transparent);
  }

  .mobile-tree-bar-del {
    background: color-mix(in oklch, var(--failure) 65%, transparent);
  }

  .mobile-tree-row {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    width: 100%;
    min-height: 3.625rem;
    padding: 0.5rem 0.625rem;
    border-radius: 0.75rem;
    background: transparent;
    border: none;
    text-align: left;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  .mobile-tree-names {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    flex: 1;
    min-width: 0;
  }

  .mobile-tree-name {
    font-family: var(--solus-code-font-family);
    font-size: var(--text-sm);
    color: var(--solus-text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The folder elides from the head: its tail is the part that locates a file,
     so `…/renderer/panels` beats `panels/Menu…`. */
  .mobile-tree-folder {
    font-family: var(--solus-code-font-family);
    font-size: var(--text-xs);
    color: var(--muted-foreground);
    opacity: 0.7;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
  }
  .mobile-tree-row:active {
    background: var(--solus-surface-hover);
  }
  .mobile-tree-status {
    flex-shrink: 0;
    width: 1.125rem;
    text-align: center;
    font-size: var(--text-xs);
    font-weight: 500;
    font-family: var(--solus-code-font-family);
    color: var(--solus-text-tertiary);
  }
  .mobile-tree-status[data-status="A"] {
    color: var(--solus-status-complete);
  }
  .mobile-tree-status[data-status="D"] {
    color: var(--solus-status-error);
  }
  .mobile-tree-status[data-status="M"],
  .mobile-tree-status[data-status="R"] {
    color: var(--solus-accent);
  }
  .mobile-tree-stats {
    flex-shrink: 0;
    display: flex;
    gap: 0.375rem;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }
</style>
