<script lang="ts">
	import type { ComponentProps } from "svelte";
	import { Input } from "../input";
	import { cn } from "@renderer/lib/utils.js";

	type Props = Omit<ComponentProps<typeof Input>, "type"> & { bare?: boolean };

	let {
		ref = $bindable(null),
		value = $bindable(),
		bare = false,
		mic = false,
		vadMinSpeechMs = 300,
		submitOn = "enter",
		class: className,
		...restProps
	}: Props = $props();
</script>

<Input
	type="text"
	bind:ref
	bind:value
	{mic}
	{vadMinSpeechMs}
	{submitOn}
	class={cn(
		"text-[0.7813rem] md:text-[0.7813rem]",
		bare &&
			(mic
				? "h-auto rounded-none border-0 bg-transparent py-0 pl-0 pr-7! shadow-none focus-visible:ring-0 dark:bg-transparent"
				: "h-auto rounded-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-0 dark:bg-transparent"),
		className
	)}
	{...restProps}
/>
