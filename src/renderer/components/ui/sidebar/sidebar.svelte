<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import { cn, type WithElementRef } from "@renderer/lib/utils";
  import { useSidebar } from "./context.svelte";

  let {
    ref = $bindable(null),
    side = "left",
    variant = "sidebar",
    collapsible = "offcanvas",
    class: className,
    children,
    ...restProps
  }: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
    side?: "left" | "right";
    variant?: "sidebar" | "floating" | "inset";
    collapsible?: "offcanvas" | "icon" | "none";
    children?: Snippet;
  } = $props();

  const sidebar = useSidebar();
</script>

<div
  bind:this={ref}
  data-slot="sidebar"
  data-sidebar="sidebar"
  data-state={sidebar.state}
  data-side={side}
  data-variant={variant}
  data-collapsible={sidebar.state === "collapsed" ? collapsible : ""}
  class={cn(
    "group/sidebar peer flex h-full min-h-0 w-full flex-col bg-sidebar text-sidebar-foreground",
    className,
  )}
  {...restProps}
>
  {@render children?.()}
</div>
