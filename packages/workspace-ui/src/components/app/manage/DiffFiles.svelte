<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";
  import FileIcon from "../../ui/file-icon/FileIcon.svelte";
  import type { VersionDiffFile } from "../lib/app-version-diff";
  import { dirName, fileName } from "../../diff/lib/diff-file-path";

  /**
   * The files of a source change, flat on the page: for each file the head of
   * the diff panel (a 32px row with no card, fill, or border: caret, file
   * icon, folder and name, counts), then its diff. The first file is open;
   * the others open with their head.
   */
  interface Props {
    files: VersionDiffFile[];
    /** The whole patch, for a change the file list cannot split. */
    patch: string;
    truncated: boolean;
  }
  let { files, patch, truncated }: Props = $props();

  const toggled = new SvelteSet<string>();
</script>

<div class="flex min-w-0 flex-col" data-testid="app-source-changes">
  {#if files.length === 0}
    {#if patch}
      <pre class="m-0 max-h-96 overflow-auto py-3 font-mono text-xs whitespace-pre">{patch}</pre>
    {:else}
      <p class="m-0 py-3 text-xs text-(--solus-text-tertiary)">The source did not change.</p>
    {/if}
  {/if}
  {#each files as file, index (file.path)}
    {@const isOpen = (index === 0) !== toggled.has(file.path)}
    {@const folder = dirName(file.path)}
    <!-- The head of the diff panel's file, flat on the page: caret, file icon, folder and name, counts. -->
    <button
      type="button"
      class="flex h-8 w-full min-w-0 shrink-0 cursor-pointer items-center gap-2 overflow-hidden rounded-md border-0 bg-transparent px-0 text-left transition-colors duration-150 hover:bg-(--solus-surface-hover) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]"
      aria-expanded={isOpen}
      onclick={() => (toggled.has(file.path) ? toggled.delete(file.path) : toggled.add(file.path))}
    >
      <span class="inline-flex size-5 shrink-0 items-center justify-center text-(--solus-text-tertiary) transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none {isOpen ? 'rotate-90' : ''}" aria-hidden="true">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3.5 2L6.5 5L3.5 8" stroke="currentColor" stroke-width="0.625" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </span>
      <FileIcon path={file.path} />
      <span class="flex min-w-0 flex-1 items-baseline font-mono text-workspace-chrome" title={file.path}>
        {#if folder}<span class="min-w-0 truncate text-(--solus-text-tertiary)">{folder}</span>{/if}
        <span class="shrink-0 whitespace-nowrap text-foreground">{fileName(file.path)}</span>
      </span>
      <span class="flex shrink-0 gap-1.25 font-mono text-xs font-medium tabular-nums">
        <span class="text-(--solus-diff-added-text-vivid)">+{file.additions}</span>
        <span class="text-(--solus-diff-removed-text-vivid)">−{file.deletions}</span>
      </span>
    </button>
    {#if isOpen}
      <div class="min-w-0 overflow-x-auto pb-2">
        {#if file.patch}
          {#await import("../../diff/Diff.svelte")}
            <p class="m-0 py-3 text-xs text-(--solus-text-tertiary)">Loading the diff…</p>
          {:then diffModule}
            {@const Diff = diffModule.default}
            <Diff patch={file.patch} />
          {/await}
        {:else}
          <p class="m-0 py-3 text-xs text-(--solus-text-tertiary)">No text diff for this file (binary, or a rename with no change).</p>
        {/if}
      </div>
    {/if}
  {/each}
  {#if truncated}
    <p class="m-0 py-2.5 text-xs text-(--solus-text-tertiary)">The patch is cut at the size limit.</p>
  {/if}
</div>
