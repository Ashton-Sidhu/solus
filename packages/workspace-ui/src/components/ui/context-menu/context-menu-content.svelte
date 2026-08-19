<script lang="ts">
	import { ContextMenu as ContextMenuPrimitive } from "bits-ui";
	import type { ComponentProps } from "svelte";
	import { cn, type WithoutChildrenOrChild } from "@solus/workspace-ui/lib/utils.js";
	import ContextMenuPortal from "./context-menu-portal.svelte";

	let {
		ref = $bindable(null),
		sideOffset = 4,
		portalProps,
		class: className,
		...restProps
	}: ContextMenuPrimitive.ContentProps & {
		portalProps?: WithoutChildrenOrChild<ComponentProps<typeof ContextMenuPortal>>;
	} = $props();
</script>

<ContextMenuPortal {...portalProps}>
	<ContextMenuPrimitive.Content
		bind:ref
		data-slot="context-menu-content"
		{sideOffset}
		class={cn(
			"data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 text-popover-foreground menu-surface z-[10002] min-w-32 p-1.5 ring-0 duration-100 outline-none",
			className
		)}
		{...restProps}
	/>
</ContextMenuPortal>
