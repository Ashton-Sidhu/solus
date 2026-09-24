<script lang="ts">
  import { observeStartupTranscriptPaint } from "../../contexts/workspace/startup-transcript";
  import { untrack, type Snippet } from "svelte";
  import type { Turn } from "./lib/turns";
  import { TranscriptVirtualizer } from "./lib/transcript-virtualizer.svelte";

  let { tabId, turns, scrollElement, active, element = $bindable(null), virtualizer, children }: {
    tabId: string;
    turns: Turn[];
    scrollElement: HTMLElement | null;
    active: boolean;
    element?: HTMLDivElement | null;
    virtualizer: TranscriptVirtualizer;
    children: Snippet<[Turn, number]>;
  } = $props();

  $effect.pre(() => {
    const keys = turns.map((turn) => turn.id);
    untrack(() => virtualizer.setKeys(keys));
  });
  $effect(() => {
    const scroll = scrollElement;
    const content = element;
    if (scroll && content && active) return untrack(() => virtualizer.connect(scroll, content));
  });
  const slots = $derived.by(() => {
    void virtualizer.revision;
    return virtualizer.geometry.slots(virtualizer.range, virtualizer.pinnedKeys);
  });
  const trailingSpace = $derived.by(() => {
    void virtualizer.revision;
    const last = slots.at(-1);
    return virtualizer.geometry.total - (last ? virtualizer.geometry.offsets[last.index + 1] : 0);
  });
  $effect(() => {
    if (active && slots.length) return observeStartupTranscriptPaint(tabId);
  });
  // Runs after the slots reach the DOM, before paint: a row that mounted or
  // unmounted above the reader is corrected in the same frame.
  $effect(() => {
    void slots;
    void trailingSpace;
    untrack(() => virtualizer.rendered());
  });
</script>

<div bind:this={element} class="relative messages-list cv-list" style="overflow-anchor:none">
  {#each slots as slot (slot.key)}
    <div aria-hidden="true" style:height="{slot.space}px"></div>
    <div use:virtualizer.row={slot.key} data-transcript-turn-id={slot.key} class="virtual-turn flow-root pb-2 @max-[30rem]/pane:pb-3">
      <div class="space-y-2 @max-[30rem]/pane:space-y-3">
        {#if turns[slot.index]}
          {@render children(turns[slot.index], slot.index)}
        {/if}
      </div>
    </div>
  {/each}
  <div aria-hidden="true" style:height="{trailingSpace}px"></div>
</div>
