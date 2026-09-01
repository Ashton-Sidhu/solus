<script lang="ts">
	import { Command as CommandPrimitive } from "bits-ui";
	import { cn } from "@renderer/lib/utils.js";

	let {
		ref = $bindable(null),
		value = $bindable(""),
		class: className,
		...restProps
	}: CommandPrimitive.InputProps = $props();
</script>

<CommandPrimitive.Input
	bind:ref
	bind:value
	data-slot="command-input"
	class={cn(
		"h-10 w-full bg-transparent text-sm outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
		className,
	)}
	{...restProps}
/>
