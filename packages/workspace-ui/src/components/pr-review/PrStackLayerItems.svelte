<script lang="ts">
  import { Check as CheckIcon, CornerDownRight as BaseIcon } from "@lucide/svelte";
  import type { PrStack } from "@solus/contracts/providers";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { prStatusGlyph } from "../prs/lib/prs-list-view";
  import { stackLayerStatus } from "./lib/pr-stack";

  /**
   * Every layer of a stack as menu rows, top first as GitHub draws it, ending
   * on the branch the stack lands on. The pull request header's stack menu
   * and the list row's stack menu both draw it.
   */
  let {
    stack,
    current,
    onOpen,
  }: {
    stack: PrStack;
    /** The layer being looked at; it is marked and does not open. */
    current: number;
    onOpen: (number: number) => void;
  } = $props();
</script>

<DropdownMenu.Label>Stack on {stack.base}</DropdownMenu.Label>
<div class="max-h-80 overflow-y-auto">
  {#each stack.layers.toReversed() as layer (layer.number)}
    {@const glyph = prStatusGlyph(stackLayerStatus(layer))}
    <DropdownMenu.Item
      aria-current={layer.number === current ? "true" : undefined}
      onSelect={() => {
        if (layer.number !== current) onOpen(layer.number);
      }}
    >
      <glyph.icon size={14} class="shrink-0 {glyph.toneClass}" aria-label={glyph.label} />
      <span class="min-w-0 flex-1 truncate {layer.number === current ? 'font-medium' : ''}">
        {layer.title || layer.headRef}
      </span>
      <span class="shrink-0 text-muted-foreground tabular-nums">#{layer.number}</span>
      {#if layer.number === current}
        <CheckIcon size={12} class="shrink-0 text-primary" aria-hidden="true" />
      {/if}
    </DropdownMenu.Item>
  {/each}
</div>
<div class="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground">
  <BaseIcon size={12} class="shrink-0" aria-hidden="true" />
  <span class="truncate font-mono">{stack.base}</span>
</div>
