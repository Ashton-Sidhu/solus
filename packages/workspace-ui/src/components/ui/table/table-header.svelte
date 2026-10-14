<script lang="ts">
  import { cn, type WithElementRef } from '@solus/workspace-ui/lib/utils'
  import type { HTMLAttributes } from 'svelte/elements'

  let { ref = $bindable(null), class: className, children, ...restProps }: WithElementRef<
    HTMLAttributes<HTMLTableSectionElement>
  > = $props()
</script>

<thead bind:this={ref} data-slot="table-header" class={cn('[&_tr]:border-b [&_tr]:border-border/40', className)} {...restProps}>
  {@render children?.()}
</thead>
