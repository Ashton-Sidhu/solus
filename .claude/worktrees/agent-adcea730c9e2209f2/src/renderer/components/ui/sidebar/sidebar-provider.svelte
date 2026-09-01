<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import { cn, type WithElementRef } from "@renderer/lib/utils";
  import { setSidebar } from "./context.svelte";

  let {
    ref = $bindable(null),
    open = $bindable(true),
    onOpenChange = () => {},
    class: className,
    children,
    ...restProps
  }: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    children?: Snippet;
  } = $props();

  setSidebar({
    open: () => open,
    setOpen: (nextOpen) => {
      open = nextOpen;
      onOpenChange(nextOpen);
    },
  });
</script>

<div
  bind:this={ref}
  data-slot="sidebar-wrapper"
  class={cn("group/sidebar-wrapper h-full min-h-0 w-full", className)}
  {...restProps}
>
  {@render children?.()}
</div>
