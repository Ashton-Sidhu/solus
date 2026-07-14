<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import { cn, type WithElementRef } from "@renderer/lib/utils";

  let {
    ref = $bindable(null),
    class: className,
    children,
    ...restProps
  }: WithElementRef<HTMLAttributes<HTMLLIElement>, HTMLLIElement> & { children?: Snippet } = $props();
</script>

<li
  bind:this={ref}
  data-slot="sidebar-menu-sub-item"
  data-sidebar="menu-sub-item"
  class={cn("group/menu-sub-item relative", className)}
  {...restProps}
>
  {@render children?.()}
</li>
