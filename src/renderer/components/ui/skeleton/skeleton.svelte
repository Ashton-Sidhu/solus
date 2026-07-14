<script lang="ts">
	import { cn, type WithElementRef, type WithoutChildren } from "@renderer/lib/utils.js";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: WithoutChildren<WithElementRef<HTMLAttributes<HTMLDivElement>>> = $props();
</script>

<div
	bind:this={ref}
	data-slot="skeleton"
	class={cn(
		"relative overflow-hidden rounded-md bg-(--solus-surface-secondary)",
		"after:absolute after:inset-0 after:-translate-x-full after:content-['']",
		"after:animate-[skeleton-shimmer_1.4s_ease-in-out_infinite] after:[animation-delay:inherit]",
		"after:bg-[linear-gradient(90deg,transparent_0%,var(--solus-surface-hover)_50%,transparent_100%)]",
		"motion-reduce:after:animate-none",
		className
	)}
	{...restProps}
></div>
