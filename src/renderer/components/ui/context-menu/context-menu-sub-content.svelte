<script lang="ts">
  import { ContextMenu as ContextMenuPrimitive } from "bits-ui";
  import { cn } from "@renderer/lib/utils.js";

  let {
    ref = $bindable(null),
    class: className,
    ...restProps
  }: ContextMenuPrimitive.SubContentProps = $props();
</script>

<ContextMenuPrimitive.SubContent
  bind:ref
  data-slot="context-menu-sub-content"
  class={cn(
    "data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 text-popover-foreground menu-surface z-[10002] min-w-[150px] p-1.5 ring-0 duration-100",
    className,
  )}
  {...restProps}
/>
