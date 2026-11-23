<script lang="ts">
  import { CircleAlert, Play } from "@lucide/svelte";
  import type { ToolStrip } from "@solus/client-core/tool-outputs";

  let { strip, onOpen }: { strip: ToolStrip; onOpen: (toolId: string, chip: HTMLElement) => void } = $props();
</script>

<div class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 pt-0.5" data-slot="tool-output-strip">
  {#each strip.chips as chip (chip.key)}
    <button
      type="button"
      class="inline-flex h-6 max-w-[min(14rem,100%)] min-w-0 cursor-pointer items-center gap-1.5 overflow-hidden rounded-full border-0 bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] pr-2.5 pl-2 text-xs leading-[1.35] font-medium text-muted-foreground transition-colors hover:bg-[color-mix(in_oklch,var(--foreground)_10%,transparent)] hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--solus-accent-border-medium) pointer-coarse:h-8"
      aria-label={chip.kind === "audio" ? `Open the ${chip.server} audio` : `Open what was left out of the result`}
      onclick={(event) => onOpen(chip.toolId, event.currentTarget)}
    >
      {#if chip.kind === "audio"}
        <Play size={11} class="shrink-0 fill-current" aria-hidden="true" />
        <span class="min-w-0 truncate text-(--solus-text-primary)">{chip.server}</span>
        <span class="shrink-0 font-normal">{chip.format}</span>
      {:else}
        <CircleAlert size={13} strokeWidth={1.75} class="shrink-0" aria-hidden="true" />
        <span class="min-w-0 truncate">{chip.count} left out</span>
      {/if}
    </button>
  {/each}
</div>
