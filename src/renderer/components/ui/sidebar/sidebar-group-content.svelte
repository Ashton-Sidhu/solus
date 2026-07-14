<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import { cn, type WithElementRef } from "@renderer/lib/utils";

  let {
    ref = $bindable(null),
    class: className,
    children,
    ...restProps
  }: WithElementRef<HTMLAttributes<HTMLDivElement>> & { children?: Snippet } = $props();
</script>

<div
  bind:this={ref}
  data-slot="sidebar-group-content"
  data-sidebar="group-content"
  class={cn("w-full text-sm", className)}
  {...restProps}
>
  {@render children?.()}
</div>
