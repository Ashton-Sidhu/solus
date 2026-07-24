<script lang="ts">
	import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
	import CheckIcon from '@lucide/svelte/icons/check';
	import { cn, type WithoutChild } from "@renderer/lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		children: childrenProp,
		...restProps
	}: WithoutChild<DropdownMenuPrimitive.RadioItemProps> = $props();
</script>

<DropdownMenuPrimitive.RadioItem
	bind:ref
	data-slot="dropdown-menu-radio-item"
	class={cn(
		"data-highlighted:bg-(--solus-surface-hover) data-highlighted:text-(--solus-text-primary) gap-2 rounded-[9px] py-1.5 pr-8 pl-3 text-[0.6875rem] lg:text-xs text-(--solus-text-secondary) data-[state=checked]:bg-(--solus-accent-light) data-[state=checked]:data-highlighted:bg-[color-mix(in_srgb,var(--solus-accent)_13%,transparent)] data-[state=checked]:text-(--solus-text-primary) data-[state=checked]:font-medium data-inset:pl-7 [&_svg:not([class*='size-'])]:size-4 relative flex cursor-default items-center outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
		className
	)}
	{...restProps}
>
	{#snippet children({ checked })}
		<span
			class="absolute right-2 flex items-center justify-center pointer-events-none"
			data-slot="dropdown-menu-radio-item-indicator"
		>
			{#if checked}
				<CheckIcon class="size-3.5 text-(--solus-accent)" />
			{/if}
		</span>
		{@render childrenProp?.({ checked })}
	{/snippet}
</DropdownMenuPrimitive.RadioItem>
