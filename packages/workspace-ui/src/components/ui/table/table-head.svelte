<script lang="ts">
  import { cn, type WithElementRef } from '@solus/workspace-ui/lib/utils'
  import type { HTMLThAttributes } from 'svelte/elements'

  let { ref = $bindable(null), class: className, children, ...restProps }: WithElementRef<HTMLThAttributes> = $props()
</script>

<!-- The column head the cloud site draws, shared here: ten-pixel tracked caps
     in the muted ink, kept apart from the first row by space rather than a
     rule. A caller that needs another size passes its own text class. -->
<th
  bind:this={ref}
  data-slot="table-head"
  class={cn(
    'h-9 bg-clip-padding px-3 text-start align-middle text-[10px] font-medium tracking-[0.06em] whitespace-nowrap text-muted-foreground uppercase [&:has([role=checkbox])]:pe-0',
    className,
  )}
  {...restProps}
>
  {@render children?.()}
</th>
