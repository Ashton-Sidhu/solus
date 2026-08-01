<script lang="ts">
	import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
	import { CaretRightIcon } from "phosphor-svelte";
	import { cn } from "@renderer/lib/utils.js";
	import { menuRowVariants } from "../menu/menu-row";

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
		menuRowVariants({ stagger: false }),
		"data-open:shadow-[inset_0_0_0_62rem_var(--solus-menu-hover-ink)] data-open:text-(--solus-text-primary) data-inset:pl-7 data-[inset]:pl-8 [&_svg:not([class*='size-'])]:size-3.5",
		className
	)}
	{...restProps}
>
	{@render children?.()}
	<CaretRightIcon size={9} class="ml-auto opacity-55" />
</DropdownMenuPrimitive.SubTrigger>
