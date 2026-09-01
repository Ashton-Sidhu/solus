<script lang="ts">
  import { ContextMenu as ContextMenuPrimitive } from "bits-ui";
  import { ChevronRight as CaretRightIcon } from "@lucide/svelte";
  import { cn } from "@solus/workspace-ui/lib/utils.js";
  import { menuRowVariants } from "../menu/menu-row";

  let {
    ref = $bindable(null),
    class: className,
    inset,
    children,
    ...restProps
  }: ContextMenuPrimitive.SubTriggerProps & { inset?: boolean } = $props();
</script>

<ContextMenuPrimitive.SubTrigger
  bind:ref
  data-slot="context-menu-sub-trigger"
  data-inset={inset}
  class={cn(
    menuRowVariants({ stagger: false }),
    "data-open:shadow-[inset_0_0_0_62rem_var(--solus-menu-hover-ink)] data-open:text-(--solus-text-primary) data-inset:pl-7 [&_svg:not([class*='size-'])]:size-3.5 pointer-fine:[.is-laptop-display_&]:h-8 pointer-fine:[.is-laptop-display_&]:gap-2.5 pointer-fine:[.is-laptop-display_&]:rounded-lg pointer-fine:[.is-laptop-display_&]:px-2.5",
    className,
  )}
  {...restProps}
>
  {@render children?.()}
  <CaretRightIcon size={9} class="ml-auto opacity-55" />
</ContextMenuPrimitive.SubTrigger>
