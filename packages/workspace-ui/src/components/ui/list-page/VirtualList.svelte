<script lang="ts" generics="T">
  import type { Snippet } from "svelte";
  import TinyVirtualList from "svelte-tiny-virtual-list";

  type VirtualItem = { index: number; style: string };
  type ScrollDetail = { event: Event; offset: number };

  interface Props {
    items: T[];
    height: number;
    itemSize: number | ((index: number) => number);
    keyOf: (item: T) => string | number;
    children: Snippet<[T, number, string]>;
    footer?: Snippet;
    overscan?: number;
    estimatedItemSize?: number;
    activeKey?: string | number | null;
    scrollOffset?: number;
    onAfterScroll?: (detail: ScrollDetail) => void;
  }

  let {
    items,
    height,
    itemSize,
    keyOf,
    children,
    footer: footerContent,
    overscan = 6,
    estimatedItemSize,
    activeKey = null,
    scrollOffset,
    onAfterScroll,
  }: Props = $props();

  /** The vendored list caches every item offset and only rebuilds that cache
   *  when `itemSize` or `itemCount` changes *by identity*. A grouped list
   *  changes composition without changing length — one row moves between
   *  groups, a header swaps places with a row — and a plain arrow prop never
   *  changes identity, so headers end up drawn at row offsets and rows collide.
   *  Re-wrapping the callback whenever `items` changes forces the rebuild. */
  const sizeForIndex = $derived.by(() => {
    void items;
    return itemSize instanceof Function
      ? (index: number) => itemSize(index)
      : itemSize;
  });

  const activeIndex = $derived(
    activeKey === null || activeKey === undefined
      ? undefined
      : items.findIndex((item) => keyOf(item) === activeKey),
  );
</script>

{#if height > 0 && items.length > 0}
  <div class="virtual-list-host h-full min-h-0">
    <TinyVirtualList
      width="100%"
      {height}
      itemCount={items.length}
      itemSize={sizeForIndex}
      {estimatedItemSize}
      getKey={(index: number) => keyOf(items[index])}
      scrollToIndex={activeIndex !== undefined && activeIndex >= 0 ? activeIndex : undefined}
      scrollToAlignment="auto"
      scrollToBehaviour="instant"
      overscanCount={overscan}
      {scrollOffset}
      on:afterScroll={(event) => onAfterScroll?.(event.detail)}
    >
      {#snippet item({ index, style }: VirtualItem)}
        {@render children(items[index], index, style)}
      {/snippet}
      {#snippet footer()}
        {#if footerContent}{@render footerContent()}{/if}
      {/snippet}
    </TinyVirtualList>
  </div>
{/if}

<style>
  :global(.virtual-list-host .virtual-list-wrapper) {
    overscroll-behavior-y: contain;
    scrollbar-width: none;
  }

  :global(.virtual-list-host .virtual-list-wrapper::-webkit-scrollbar) {
    width: 0;
  }
</style>
