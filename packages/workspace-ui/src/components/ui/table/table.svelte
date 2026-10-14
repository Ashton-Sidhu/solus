<script lang="ts">
  import { cn, type WithElementRef } from '@solus/workspace-ui/lib/utils'
  import type { HTMLTableAttributes } from 'svelte/elements'

  let {
    ref = $bindable(null),
    class: className,
    containerClass,
    children,
    ...restProps
  }: WithElementRef<HTMLTableAttributes> & { containerClass?: string } = $props()
</script>

<!-- The table as Settings draws its cards (RowCard): a soft border, the page
     background, and hairlines inset to the cells' text. A full-pane data table
     passes `containerClass` to drop the card. -->
<div data-slot="table-container" class={cn('relative w-full overflow-x-auto rounded-xl border border-border/50 bg-background text-foreground', containerClass)}>
  <table
    bind:this={ref}
    data-slot="table"
    class={cn('w-full caption-bottom text-[length:inherit]', className)}
    {...restProps}
  >
    {@render children?.()}
  </table>
</div>
