<script lang="ts">
  import { fly } from "svelte/transition";
  import { XIcon } from "phosphor-svelte";
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
    <span class="text-[0.8125rem] font-semibold text-(--solus-text-primary)"
      >Changed files</span
    >
    <span class="text-[0.6875rem] text-(--solus-text-tertiary) tabular-nums"
      >{files.length}</span
    >
    <span class="flex-1"></span>
    <button
      type="button"
      onclick={onClose}
      aria-label="Close file list"
      class="mobile-tree-close"
    >
      <XIcon size={16} weight="bold" />
    </button>
  </div>
  <div class="mobile-tree-list">
    {#each files as file (diffFilePath(file))}
      {@const filePath = diffFilePath(file)}
      {@const status = diffFileStatus(file)}
      {@const stats = diffFileStats(file)}
      <button
        type="button"
        class="mobile-tree-row"
        onclick={() => onSelect(filePath)}
      >
        <span class="mobile-tree-status" data-status={status}>{status}</span>
        <span class="mobile-tree-path">{toTreeDisplayPath(filePath)}</span>
        <span class="mobile-tree-stats tabular-nums">
          {#if stats.additions > 0}<span
              style="color:var(--solus-status-complete)"
              >+{stats.additions}</span
            >{/if}
          {#if stats.deletions > 0}<span
              style="color:var(--solus-status-error)"
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
  .mobile-tree-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    min-height: 2.75rem;
    padding: 0.375rem 0.5rem;
    border-radius: 0.5rem;
    background: transparent;
    border: none;
    text-align: left;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .mobile-tree-row:active {
    background: var(--solus-surface-hover);
  }
  .mobile-tree-status {
    flex-shrink: 0;
    width: 1.125rem;
    text-align: center;
    font-size: 0.625rem;
    font-weight: 700;
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
  .mobile-tree-path {
    flex: 1;
    min-width: 0;
    font-size: 0.75rem;
    color: var(--solus-text-primary);
    font-family: var(--solus-code-font-family);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
  }
  .mobile-tree-stats {
    flex-shrink: 0;
    display: flex;
    gap: 0.375rem;
    font-size: 0.6875rem;
    font-weight: 600;
  }
</style>
