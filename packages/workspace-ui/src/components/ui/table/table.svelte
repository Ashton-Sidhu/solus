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

<!-- The table as Settings draws its cards (RowCard): a border and a soft
     shadow (a raised surface in dark mode), and hairlines inset to the cells' text. A full-pane data table
     passes `containerClass` to drop the card. -->
<div data-slot="table-container" class={cn('relative w-full overflow-x-auto rounded-xl border border-border bg-background shadow-[0_1px_2px_rgb(0_0_0/0.04),0_4px_12px_-6px_rgb(0_0_0/0.08)] dark:bg-card dark:shadow-none text-foreground', containerClass)}>
  <table
    bind:this={ref}
    data-slot="table"
    class={cn('w-full caption-bottom text-[length:inherit]', className)}
    {...restProps}
  >
    {@render children?.()}
  </table>
</div>
