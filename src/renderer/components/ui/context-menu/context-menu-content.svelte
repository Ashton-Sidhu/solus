<script lang="ts">
	import { ContextMenu as ContextMenuPrimitive } from "bits-ui";
	import type { ComponentProps } from "svelte";
	import { cn, type WithoutChildrenOrChild } from "@renderer/lib/utils.js";
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
			"data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 text-popover-foreground z-[10002] min-w-32 overflow-hidden rounded-[14px] border border-(--solus-popover-border) bg-(--solus-popover-bg) p-1 shadow-(--solus-popover-shadow) ring-0 backdrop-blur-xl duration-100 outline-none",
			className
		)}
		{...restProps}
	/>
</ContextMenuPortal>
