<script lang="ts" generics="T">
  import { untrack, type Snippet } from "svelte";
  import { createVirtualizer } from "@tanstack/svelte-virtual";
  import { startOffset } from "./virtual-list";

  interface Props {
    items: T[];
    height: number;
    /** Each row's exact height. Rows are never measured after they render. */
    itemSize: (index: number) => number;
    keyOf: (item: T) => string | number;
    children: Snippet<[T, number, string]>;
    footer?: Snippet;
    overscan?: number;
    /** List pages scroll without a bar; a picker keeps its bar as a cue. */
    showScrollbar?: boolean;
    activeKey?: string | number | null;
    scrollOffset?: number;
    onScroll?: (offset: number) => void;
  }

  let {
    items,
    height,
    itemSize,
    keyOf,
    children,
    footer,
    overscan = 6,
    showScrollbar = false,
    activeKey = null,
    scrollOffset,
    onScroll,
  }: Props = $props();

  let scroller = $state<HTMLDivElement | null>(null);

  /** Every row height is known before paint, so each size is exact rather than
   *  measured. The key reader and the sizes close over this pass's rows: a new
   *  key reader is how TanStack learns the rows changed, so a regrouped list of
   *  the same length is laid out again. */
  function rowOptions() {
    const rows = items;
    return {
      count: rows.length,
      estimateSize: itemSize,
      getItemKey: (index: number) => keyOf(rows[index]),
      overscan,
    };
  }

  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    ...untrack(rowOptions),
    getScrollElement: () => scroller,
    initialRect: { width: 0, height: untrack(() => height) },
    // TanStack moves the scroller here itself when it attaches, so the rows
    // drawn and the scroll position start as one fact.
    initialOffset: () =>
      untrack(() => startOffset(scrollOffset ?? 0, items.length, itemSize, height)),
  });

  // Before the rows render, so the count and keys never lag the rows drawn.
  $effect.pre(() => {
    const options = rowOptions();
    untrack(() => $virtualizer.setOptions(options));
  });

  // Attach to the scroller when it mounts, and let go when it leaves.
  $effect(() => {
    void scroller;
    untrack(() => $virtualizer.setOptions({}));
  });

  // An offset set from outside — a reset to the top — moves the list. The
  // offset this list reported itself is already where it is.
  $effect(() => {
    const offset = scrollOffset;
    if (offset === undefined || !scroller) return;
    untrack(() => {
      if (Math.abs(($virtualizer.scrollOffset ?? 0) - offset) > 1) {
        $virtualizer.scrollToOffset(offset);
      }
    });
  });

  const activeIndex = $derived(
    activeKey === null || activeKey === undefined
      ? -1
      : items.findIndex((item) => keyOf(item) === activeKey),
  );

  // Keep the active row in view, and bring it back when the rows change under
  // it. `auto` moves only when the row is out of view.
  $effect(() => {
    const index = activeIndex;
    void items;
    if (index < 0 || !scroller) return;
    untrack(() => $virtualizer.scrollToIndex(index, { align: "auto", behavior: "instant" }));
  });
</script>

{#if height > 0 && items.length > 0}
  <div
    bind:this={scroller}
    data-virtual-list
    class="w-full overflow-x-hidden overflow-y-auto overscroll-y-contain {showScrollbar
      ? ''
      : '[scrollbar-width:none] [&::-webkit-scrollbar]:w-0'}"
    style:height="{height}px"
    onscroll={() => {
      if (scroller) onScroll?.(scroller.scrollTop);
    }}
  >
    <div class="relative w-full" style:height="{$virtualizer.getTotalSize()}px">
      {#each $virtualizer.getVirtualItems() as row (row.key)}
        {@const item = items[row.index]}
        {#if item !== undefined}
          {@render children(
            item,
            row.index,
            `position:absolute;top:${row.start}px;left:0;width:100%;height:${row.size}px;`,
          )}
        {/if}
      {/each}
    </div>
    {#if footer}{@render footer()}{/if}
  </div>
{/if}
