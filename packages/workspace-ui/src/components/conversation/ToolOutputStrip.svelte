<script lang="ts">
  import { CircleAlert, Play } from "@lucide/svelte";
  import type { ToolStripChip } from "@solus/client-core/tool-outputs";

  /**
   * What a folded row holds besides images: one chip for each audio clip and
   * for each call's left-out notes (docs/transcript-cards.md, "Tool outputs").
   * A chip opens the folds down to its tool line.
   */
  let { chips, onOpen }: { chips: ToolStripChip[]; onOpen: (toolId: string, chip: HTMLElement) => void } = $props();
</script>

<div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1" data-slot="tool-output-strip">
  {#each chips as chip (chip.key)}
    <button
      type="button"
      class="inline-flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden rounded-sm text-transcript-meta text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      aria-label={chip.kind === "audio" ? `Open the ${chip.server} audio` : `Open what was left out of the result`}
      onclick={(event) => onOpen(chip.toolId, event.currentTarget)}
    >
      {#if chip.kind === "audio"}
        <Play size={11} class="shrink-0 fill-current" />
        <span class="truncate text-(--solus-text-primary)">{chip.server}</span>
        <span class="shrink-0 font-mono opacity-70">{chip.format}</span>
      {:else}
        <CircleAlert size={12} class="shrink-0" />
        <span class="truncate">{chip.count} left out</span>
      {/if}
    </button>
  {/each}
</div>
