<script lang="ts">
	import { Command as CommandPrimitive } from "bits-ui";
	import { cn } from "@renderer/lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: CommandPrimitive.ViewportProps = $props();
</script>

<CommandPrimitive.Viewport
	bind:ref
	data-slot="command-viewport"
	class={cn("overflow-x-hidden overflow-y-auto", className)}
	{...restProps}
/>
