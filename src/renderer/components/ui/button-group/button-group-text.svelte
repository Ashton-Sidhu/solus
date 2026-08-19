<script lang="ts">
	import { cn, type WithElementRef } from "@renderer/lib/utils.js";
	import type { HTMLAttributes } from "svelte/elements";
	import type { Snippet } from "svelte";

	type ButtonGroupTextProps = WithElementRef<HTMLAttributes<HTMLDivElement>>;

	let {
		ref = $bindable(null),
		class: className,
		child,
		...restProps
	}: ButtonGroupTextProps & {
		child?: Snippet<[{ props: ButtonGroupTextProps }]>;
	} = $props();

	const mergedProps = $derived({
		...restProps,
		class: cn("bg-muted gap-2 rounded-lg border px-2.5 text-[length:inherit] font-medium [&_svg:not([class*='size-'])]:size-4 flex items-center [&_svg]:pointer-events-none", className),
		"data-slot": "button-group-text",
	});
</script>

{#if child}
	{@render child({ props: mergedProps })}
{:else}
	<div bind:this={ref} {...mergedProps}>
		{@render mergedProps.children?.()}
	</div>
{/if}
