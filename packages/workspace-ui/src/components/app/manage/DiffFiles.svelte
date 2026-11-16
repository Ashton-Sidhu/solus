<script lang="ts">
  import { ChevronRight as DisclosureIcon } from "@lucide/svelte";
  import { SvelteSet } from "svelte/reactivity";
  import type { VersionDiffFile } from "../lib/app-version-diff";

  /**
   * The files of a source change, flat: a head for each file with its path
   * and its lines added and removed, then its diff. The first file is open;
   * the others open with their head. It draws no card of its own, so it sits
   * inside the change card or plain on the page.
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
      <pre class="m-0 max-h-96 overflow-auto px-5 py-3 font-mono text-xs whitespace-pre">{patch}</pre>
    {:else}
      <p class="m-0 px-5 py-3 text-xs text-(--solus-text-tertiary)">The source did not change.</p>
    {/if}
  {/if}
  {#each files as file, index (file.path)}
    {@const isOpen = (index === 0) !== toggled.has(file.path)}
    <button
      type="button"
      class="flex h-9.5 w-full min-w-0 shrink-0 cursor-pointer items-center gap-2 overflow-hidden border-0 border-b border-[var(--hairline)] bg-[var(--wash-1)] px-5 text-left transition-colors duration-150 hover:bg-[var(--wash-2)] focus-visible:bg-[var(--wash-2)] focus-visible:outline-none {index > 0 ? 'border-t' : ''}"
      aria-expanded={isOpen}
      onclick={() => (toggled.has(file.path) ? toggled.delete(file.path) : toggled.add(file.path))}
    >
      <DisclosureIcon size={12} class="shrink-0 text-(--solus-text-tertiary) transition-transform duration-150 motion-reduce:transition-none {isOpen ? 'rotate-90' : ''}" aria-hidden="true" />
      <span class="min-w-0 flex-1 truncate font-mono text-xs text-foreground" title={file.path}>{file.path}</span>
      <span class="shrink-0 text-xs tabular-nums">
        <span class="text-(--solus-diff-added-text-vivid)">+{file.additions}</span>
        <span class="text-(--solus-diff-removed-text-vivid)">−{file.deletions}</span>
      </span>
    </button>
    {#if isOpen}
      <div class="min-w-0 overflow-x-auto bg-(--solus-diff-surface)">
        {#if file.patch}
          {#await import("../../diff/Diff.svelte")}
            <p class="m-0 px-5 py-3 text-xs text-(--solus-text-tertiary)">Loading the diff…</p>
          {:then diffModule}
            {@const Diff = diffModule.default}
            <Diff patch={file.patch} />
          {/await}
        {:else}
          <p class="m-0 px-5 py-3 text-xs text-(--solus-text-tertiary)">No text diff for this file (binary, or a rename with no change).</p>
        {/if}
      </div>
    {/if}
  {/each}
  {#if truncated}
    <p class="m-0 px-5 py-2.5 text-xs text-(--solus-text-tertiary)">The patch is cut at the size limit.</p>
  {/if}
</div>
