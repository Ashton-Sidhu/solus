<script lang="ts">
  import * as ResizablePrimitive from "paneforge";
  import { cn, type WithoutChildrenOrChild } from "@renderer/lib/utils.js";

  let {
    ref = $bindable(null),
    class: className,
    withHandle = true,
    ...restProps
  }: WithoutChildrenOrChild<ResizablePrimitive.PaneResizerProps> & {
    withHandle?: boolean;
  } = $props();
</script>

<ResizablePrimitive.PaneResizer
  bind:ref
  data-slot="resizable-handle"
  class={cn(
    "group/resizer relative z-10 flex w-0 shrink-0 items-center justify-center outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2 focus-visible:after:bg-[color-mix(in_srgb,var(--solus-accent)_18%,transparent)] data-[direction=vertical]:h-0 data-[direction=vertical]:w-full data-[direction=vertical]:after:inset-x-0 data-[direction=vertical]:after:top-1/2 data-[direction=vertical]:after:h-2 data-[direction=vertical]:after:w-full data-[direction=vertical]:after:translate-x-0 data-[direction=vertical]:after:-translate-y-1/2",
    className,
  )}
  {...restProps}
>
  {#if withHandle}
    <span
      class="pointer-events-none relative z-10 h-7 w-0.5 scale-y-60 rounded-full bg-(--solus-text-tertiary) opacity-0 transition-[opacity,scale,background-color] duration-150 ease-out group-hover/resizer:scale-y-100 group-hover/resizer:bg-(--solus-accent) group-hover/resizer:opacity-100 group-focus-visible/resizer:scale-y-100 group-focus-visible/resizer:bg-(--solus-accent) group-focus-visible/resizer:opacity-100 group-data-[active]/resizer:scale-y-100 group-data-[active]/resizer:bg-(--solus-accent) group-data-[active]/resizer:opacity-100 group-data-[direction=vertical]/resizer:h-0.5 group-data-[direction=vertical]/resizer:w-7 group-data-[direction=vertical]/resizer:scale-x-60 group-data-[direction=vertical]/resizer:scale-y-100 group-data-[direction=vertical]/resizer:group-hover/resizer:scale-x-100 group-data-[direction=vertical]/resizer:group-focus-visible/resizer:scale-x-100 group-data-[direction=vertical]/resizer:group-data-[active]/resizer:scale-x-100"
      aria-hidden="true"
    ></span>
  {/if}
</ResizablePrimitive.PaneResizer>
