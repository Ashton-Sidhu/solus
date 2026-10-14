<script lang="ts">
  import { cn, type WithElementRef } from '@solus/workspace-ui/lib/utils'
  import type { HTMLAttributes } from 'svelte/elements'

  let { ref = $bindable(null), class: className, children, ...restProps }: WithElementRef<
    HTMLAttributes<HTMLTableRowElement>
  > = $props()
</script>

<tr
  bind:this={ref}
  data-slot="table-row"
  class={cn(
    'transition-colors data-[state=selected]:bg-muted',
    // A hairline above every row after the first, inset sixteen pixels at both
    // ends, as RowCard draws it. It is a 1px background line on the cells: a
    // pseudo-element on a <tr> becomes a cell of its own and shifts the row.
    '[&+&>td]:bg-[linear-gradient(color-mix(in_oklch,var(--border)_40%,transparent),color-mix(in_oklch,var(--border)_40%,transparent))] [&+&>td]:bg-[length:100%_1px] [&+&>td]:bg-no-repeat',
    '[&+&>td:first-child:not(:last-child)]:bg-[length:calc(100%-1rem)_1px] [&+&>td:first-child:not(:last-child)]:bg-[position:1rem_0]',
    '[&+&>td:last-child:not(:first-child)]:bg-[length:calc(100%-1rem)_1px]',
    '[&+&>td:only-child]:bg-[length:calc(100%-2rem)_1px] [&+&>td:only-child]:bg-[position:1rem_0]',
    className,
  )}
  {...restProps}
>
  {@render children?.()}
</tr>
