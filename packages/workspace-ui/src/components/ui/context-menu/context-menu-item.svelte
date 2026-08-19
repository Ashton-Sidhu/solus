<script lang="ts">
	import { ContextMenu as ContextMenuPrimitive } from "bits-ui";
	import { cn } from "@solus/workspace-ui/lib/utils.js";
	import { menuRowVariants } from "../menu/menu-row";

	let {
		ref = $bindable(null),
		class: className,
		inset,
		variant = "default",
		...restProps
	}: ContextMenuPrimitive.ItemProps & {
		inset?: boolean;
		variant?: "default" | "destructive";
	} = $props();
</script>

<ContextMenuPrimitive.Item
	bind:ref
	data-slot="context-menu-item"
	data-inset={inset}
	data-variant={variant}
	class={cn(
		menuRowVariants(),
		"group/context-menu-item data-inset:pl-7 [&_svg]:size-3.5 data-[variant=destructive]:text-(--solus-status-error) data-[variant=destructive]:data-highlighted:text-(--solus-status-error)",
		className
	)}
	{...restProps}
/>
