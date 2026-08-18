<script lang="ts">
	import type { HTMLAttributes } from "svelte/elements";
	import { cn, type WithElementRef } from "@renderer/lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLSpanElement>> = $props();
</script>

<span
	bind:this={ref}
	data-slot="context-menu-shortcut"
	class={cn("text-(--solus-text-tertiary) ml-auto text-xs st", className)}
	{...restProps}
>
	{@render children?.()}
</span>
