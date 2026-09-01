<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLButtonAttributes } from "svelte/elements";
  import { cn, type WithElementRef } from "@renderer/lib/utils";

  let {
    ref = $bindable(null),
    class: className,
    children,
    isActive = false,
    type = "button",
    ...restProps
  }: WithElementRef<HTMLButtonAttributes, HTMLButtonElement> & {
    children?: Snippet;
    isActive?: boolean;
  } = $props();
</script>

<button
  bind:this={ref}
  data-slot="sidebar-menu-sub-button"
  data-sidebar="menu-sub-button"
  data-active={isActive ? "true" : undefined}
  class={cn(
    "flex h-8 w-full min-w-0 items-center gap-2 overflow-hidden rounded-lg px-2 text-left text-[0.8125rem] text-sidebar-foreground/75 outline-none transition-[color,background-color,transform] duration-150 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:scale-[0.96] focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground [&>span:last-child]:truncate",
    className,
  )}
  {type}
  {...restProps}
>
  {@render children?.()}
</button>
