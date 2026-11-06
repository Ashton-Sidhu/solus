<script lang="ts">
  import { transcriptPaintProfiler } from "../../lib/mount-timing";
  import { observeStartupTranscriptPaint } from "../../contexts/workspace/startup-transcript";
  import { untrack, type Snippet } from "svelte";
  import type { Turn } from "./lib/turns";
  import { userBurstAt, type UserBurst } from "./lib/user-burst";
  import { TranscriptVirtualizer } from "./lib/transcript-virtualizer.svelte";

  let { tabId, turns, scrollElement, active, element = $bindable(null), virtualizer, children }: {
    tabId: string;
    turns: Turn[];
    scrollElement: HTMLElement | null;
    active: boolean;
    element?: HTMLDivElement | null;
    virtualizer: TranscriptVirtualizer;
    children: Snippet<[Turn, number, UserBurst]>;
  } = $props();

  const observeProfilePaint = transcriptPaintProfiler();
  const hasVisibleRows = $derived(active && slots.length > 0);
  $effect(() => {
    if (hasVisibleRows) return observeProfilePaint(tabId);
  });

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
  // The list never gets shorter than the whole transcript while its rows are
  // swapped. A layout read in the middle of a swap otherwise sees one spacer
  // already shrunk and the next not yet grown, and the browser clamps the
  // scroll to that short list. In Safari the scroll thread then puts the
  // reader's position back, and the next swap clamps it again.
  const totalHeight = $derived.by(() => {
    void virtualizer.revision;
    return virtualizer.geometry.total;
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

<div bind:this={element} class="relative messages-list cv-list" style="overflow-anchor:none" style:min-height="{totalHeight}px">
  {#each slots as slot (slot.key)}
    <div aria-hidden="true" style:height="{slot.space}px"></div>
    <!-- Read per row from the turn and its neighbours, so a second message
         that arrives live re-asks this row and the one above it. -->
    {@const burst = userBurstAt(turns, slot.index)}
    <!-- A burst's rows close the turn gap: the bubbles below sit 6px apart. -->
    <div use:virtualizer.row={slot.key} data-transcript-turn-id={slot.key} class="virtual-turn flow-root {burst.groupedWithNext ? '' : 'pb-4'}">
      <div class="space-y-2 @max-[30rem]/pane:space-y-3">
        {#if turns[slot.index]}
          {@render children(turns[slot.index], slot.index, burst)}
        {/if}
      </div>
    </div>
  {/each}
  <div aria-hidden="true" style:height="{trailingSpace}px"></div>
</div>
