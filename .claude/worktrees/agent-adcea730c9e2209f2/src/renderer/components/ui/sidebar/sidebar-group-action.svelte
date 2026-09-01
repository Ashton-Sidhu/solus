<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLButtonAttributes } from "svelte/elements";
  import { cn, type WithElementRef } from "@renderer/lib/utils";
  import { tooltip } from "@renderer/lib/tooltip";

  let {
    ref = $bindable(null),
    class: className,
    children,
    tooltipContent,
    type = "button",
    ...restProps
  }: WithElementRef<HTMLButtonAttributes, HTMLButtonElement> & {
    children?: Snippet;
    tooltipContent?: string;
  } = $props();
</script>

<button
  bind:this={ref}
  data-slot="sidebar-group-action"
  data-sidebar="group-action"
  class={cn(
    "absolute right-3 top-3 flex size-7 items-center justify-center rounded-md text-sidebar-foreground/70 outline-none transition-[color,background-color,transform] duration-150 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:scale-[0.96] focus-visible:ring-2 focus-visible:ring-sidebar-ring",
    className,
  )}
  use:tooltip={tooltipContent}
  {type}
  {...restProps}
>
  {@render children?.()}
</button>
