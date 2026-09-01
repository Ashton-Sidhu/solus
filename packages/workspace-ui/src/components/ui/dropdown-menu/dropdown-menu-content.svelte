<script lang="ts">
	import { cn, type WithoutChildrenOrChild } from "@solus/workspace-ui/lib/utils.js";
	import DropdownMenuPortal from "./dropdown-menu-portal.svelte";
	import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
	import type { ComponentProps } from "svelte";

	let {
		ref = $bindable(null),
		sideOffset = 4,
		align = "start",
		// A menu anchored inside a pane still drops out into the window, so it can
		// be wider than the pane it came from and land under a window edge. One
		// default here beats every call site remembering; `bits-ui` flips or
		// shifts the content to keep this much clearance.
		collisionPadding = 16,
		portalProps,
		class: className,
		...restProps
	}: DropdownMenuPrimitive.ContentProps & {
		portalProps?: WithoutChildrenOrChild<ComponentProps<typeof DropdownMenuPortal>>;
	} = $props();
</script>

<DropdownMenuPortal {...portalProps}>
	<DropdownMenuPrimitive.Content
		bind:ref
		data-slot="dropdown-menu-content"
		{sideOffset}
		{align}
		{collisionPadding}
		class={cn(
			"data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 text-popover-foreground menu-surface min-w-32 p-1.5 ring-0 duration-100 z-[10002] w-(--bits-dropdown-menu-anchor-width) overflow-y-auto outline-none data-closed:overflow-hidden",
			className
		)}
		{...restProps}
	/>
</DropdownMenuPortal>
