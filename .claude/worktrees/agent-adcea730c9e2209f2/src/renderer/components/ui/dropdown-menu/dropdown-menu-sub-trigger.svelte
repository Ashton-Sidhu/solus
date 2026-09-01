<script lang="ts">
	import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
	import { CaretRightIcon } from "phosphor-svelte";
	import { cn } from "@renderer/lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		inset,
		children,
		...restProps
	}: DropdownMenuPrimitive.SubTriggerProps & {
		inset?: boolean;
	} = $props();
</script>

<DropdownMenuPrimitive.SubTrigger
	bind:ref
	data-slot="dropdown-menu-sub-trigger"
	data-inset={inset}
	class={cn(
		"data-highlighted:bg-(--solus-accent-light) data-highlighted:text-(--solus-text-primary) data-open:bg-(--solus-accent-light) data-open:text-(--solus-text-primary) gap-2 rounded-md px-3 py-1.5 text-[0.6875rem] lg:text-xs text-(--solus-text-secondary) data-inset:pl-7 [&_svg:not([class*='size-'])]:size-4 flex cursor-default items-center outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0",
		className
	)}
	{...restProps}
>
	{@render children?.()}
	<CaretRightIcon size={11} class="ml-auto opacity-60" />
</DropdownMenuPrimitive.SubTrigger>
