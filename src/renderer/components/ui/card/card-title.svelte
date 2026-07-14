<script lang="ts">
  import { cn, type WithElementRef } from "@renderer/lib/utils.js";
  import type { HTMLAttributes } from "svelte/elements";

  let {
    ref = $bindable(null),
    class: className,
    children,
    ...restProps
  }: WithElementRef<HTMLAttributes<HTMLHeadingElement>> = $props();
</script>

<h3
  bind:this={ref}
  data-slot="card-title"
  class={cn("font-semibold leading-none", className)}
  {...restProps}
>
  {@render children?.()}
</h3>
