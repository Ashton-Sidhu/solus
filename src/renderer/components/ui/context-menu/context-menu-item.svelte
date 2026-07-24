<script lang="ts">
	import { ContextMenu as ContextMenuPrimitive } from "bits-ui";
	import { cn } from "@renderer/lib/utils.js";

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
		"group/context-menu-item relative flex cursor-default items-center gap-2 rounded-[9px] px-3 py-1.5 text-[0.6875rem] text-(--solus-text-secondary) outline-hidden select-none data-highlighted:bg-(--solus-surface-hover) data-highlighted:text-(--solus-text-primary) data-disabled:pointer-events-none data-disabled:opacity-50 data-[variant=destructive]:text-(--solus-status-error) data-[variant=destructive]:data-highlighted:bg-[color-mix(in_srgb,var(--solus-status-error)_10%,transparent)] data-[variant=destructive]:data-highlighted:text-(--solus-status-error) data-inset:pl-7 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
		className
	)}
	{...restProps}
/>
