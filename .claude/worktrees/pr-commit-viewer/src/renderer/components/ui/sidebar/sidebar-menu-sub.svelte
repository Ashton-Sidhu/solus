<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import { cn, type WithElementRef } from "@renderer/lib/utils";

  let {
    ref = $bindable(null),
    class: className,
    children,
    ...restProps
  }: WithElementRef<HTMLAttributes<HTMLUListElement>, HTMLUListElement> & {
    children?: Snippet;
  } = $props();
</script>

<ul
  bind:this={ref}
  data-slot="sidebar-menu-sub"
  data-sidebar="menu-sub"
  class={cn(
    "mx-3.5 flex min-w-0 list-none flex-col gap-1 border-l border-sidebar-border px-2.5 py-0.5",
    className,
  )}
  {...restProps}
>
  {@render children?.()}
</ul>
