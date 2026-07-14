<script lang="ts">
  import type { Snippet } from 'svelte'
  import VirtualList from 'svelte-tiny-virtual-list'

  type VirtualItem = {
    index: number
    style: string
  }

  type ScrollDetail = {
    event: Event
    offset: number
  }

  interface Props {
    height: number | string
    itemCount: number
    itemSize: number | ((index: number) => number)
    item: Snippet<[VirtualItem]>
    width?: number | string
    overscanCount?: number
    scrollToIndex?: number
    scrollToAlignment?: string
    scrollToBehaviour?: string
    onAfterScroll?: (detail: ScrollDetail) => void
  }

  let {
    width = '100%',
    height,
    itemCount,
    itemSize,
    item,
    overscanCount = 5,
    scrollToIndex,
    scrollToAlignment,
    scrollToBehaviour,
    onAfterScroll,
  }: Props = $props()
</script>

<VirtualList
  {width}
  {height}
  {itemCount}
  {itemSize}
  {overscanCount}
  {scrollToIndex}
  {scrollToAlignment}
  {scrollToBehaviour}
  on:afterScroll={(event) => onAfterScroll?.(event.detail)}
>
  {#snippet item(args)}
    {@render item(args)}
  {/snippet}
</VirtualList>
