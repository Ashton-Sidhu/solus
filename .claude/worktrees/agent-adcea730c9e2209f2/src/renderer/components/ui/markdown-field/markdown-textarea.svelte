<script lang="ts">
	import type { ComponentProps } from "svelte";
	import { Textarea } from "../textarea";
	import { cn } from "@renderer/lib/utils.js";

	type Props = ComponentProps<typeof Textarea> & { bare?: boolean };

	let {
		ref = $bindable(null),
		value = $bindable(),
		bare = false,
		mic = false,
		vadMinSpeechMs = 300,
		submitOn = "mod-enter",
		rows = 1,
		class: className,
		...restProps
	}: Props = $props();
</script>

<Textarea
	bind:ref
	bind:value
	{mic}
	{vadMinSpeechMs}
	{submitOn}
	{rows}
	class={cn(
		"min-h-8 max-h-40 overflow-y-auto",
		bare && "h-auto! min-h-0! rounded-none border-0 bg-transparent! px-0 py-0! shadow-none focus-visible:ring-0 dark:bg-transparent!",
		className
	)}
	{...restProps}
/>
