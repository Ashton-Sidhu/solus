<script lang="ts">
  import type { Snippet } from 'svelte'
  import VirtualList from 'svelte-tiny-virtual-list'

  type VirtualItem = {
    index: number
    style: string
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
>
  {#snippet item(args)}
    {@render item(args)}
  {/snippet}
</VirtualList>
