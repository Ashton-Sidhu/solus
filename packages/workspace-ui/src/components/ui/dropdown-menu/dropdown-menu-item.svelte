<script lang="ts">
	import { cn } from "@solus/workspace-ui/lib/utils.js";
	import { menuRowVariants } from "../menu/menu-row";
	import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";

	let {
		ref = $bindable(null),
		class: className,
		inset,
		variant = "default",
		...restProps
	}: DropdownMenuPrimitive.ItemProps & {
		inset?: boolean;
		variant?: "default" | "destructive";
	} = $props();
</script>

<DropdownMenuPrimitive.Item
	bind:ref
	data-slot="dropdown-menu-item"
	data-inset={inset}
	data-variant={variant}
	class={cn(
		menuRowVariants(),
		"group/dropdown-menu-item data-inset:pl-7 data-[inset]:pl-8 [&_svg:not([class*='size-'])]:size-3.5 data-[variant=destructive]:text-destructive data-[variant=destructive]:data-highlighted:text-destructive data-[variant=destructive]:*:[svg]:text-destructive",
		className
	)}
	{...restProps}
/>
