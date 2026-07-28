<script lang="ts">
	import { Select as SelectPrimitive } from "bits-ui";
	import { cn, type WithoutChild } from "@renderer/lib/utils.js";
	import { menuRowVariants } from "../menu/menu-row";
	import CheckIcon from '@lucide/svelte/icons/check';

	let {
		ref = $bindable(null),
		class: className,
		value,
		label,
		children: childrenProp,
		...restProps
	}: WithoutChild<SelectPrimitive.ItemProps> = $props();
</script>

<SelectPrimitive.Item
	bind:ref
	{value}
	data-slot="select-item"
	class={cn(
		menuRowVariants({ indicator: "trailing" }),
		"w-full [&_svg:not([class*='size-'])]:size-3.5 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
		className
	)}
	{...restProps}
>
	{#snippet children({ selected, highlighted })}
		<span class="absolute end-2 flex size-3 items-center justify-center">
			{#if selected}
				<CheckIcon class="cn-select-item-indicator-icon text-(--solus-accent)" />
			{/if}
		</span>
		<span class="flex flex-1 gap-2 shrink-0 whitespace-nowrap">
			{#if childrenProp}
				{@render childrenProp({ selected, highlighted })}
			{:else}
				{label || value}
			{/if}
		</span>
	{/snippet}
</SelectPrimitive.Item>
