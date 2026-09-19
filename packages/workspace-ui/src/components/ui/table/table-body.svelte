<script lang="ts">
  import { cn, type WithElementRef } from '@solus/workspace-ui/lib/utils'
  import type { HTMLAttributes } from 'svelte/elements'

  let {
    ref = $bindable(null),
    class: className,
    zebra = false,
    children,
    ...restProps
  }: WithElementRef<HTMLAttributes<HTMLTableSectionElement>> & {
    /**
     * Rows as the cloud site draws them: every other one washed in `--zebra`,
     * a hover composited over whatever fill the row has, and no rules between.
     * The wash sits on the cells because a <tr> cannot carry a box-shadow. Off
     * by default so a table that paints its own rows keeps them.
     */
    zebra?: boolean
  } = $props()
</script>

<tbody
  bind:this={ref}
  data-slot="table-body"
  data-zebra={zebra ? '' : undefined}
  class={cn(
    '[&_tr:last-child]:border-0',
    zebra &&
      '[&>tr]:border-0 [&>tr:nth-child(even)>td]:bg-(--zebra) [&>tr:hover>td]:shadow-(--hover-wash) [&>tr[data-state=selected]>td]:bg-muted',
    className,
  )}
  {...restProps}
>
  {@render children?.()}
</tbody>
