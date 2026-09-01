<script lang="ts">
	import { Command as CommandPrimitive } from "bits-ui";
	import { cn } from "@solus/workspace-ui/lib/utils.js";
	import { menuRowVariants } from "../menu/menu-row";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: CommandPrimitive.ItemProps = $props();
</script>

<CommandPrimitive.Item
	bind:ref
	data-slot="command-item"
	class={cn(
		menuRowVariants({ stagger: false }),
		"group/command-item",
		className,
	)}
	{...restProps}
/>
