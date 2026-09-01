<script lang="ts">
	import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
	import { cn } from "@renderer/lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: DropdownMenuPrimitive.SubContentProps = $props();
</script>

<DropdownMenuPrimitive.SubContent
	bind:ref
	data-slot="dropdown-menu-sub-content"
	class={cn("data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 text-popover-foreground menu-surface min-w-[96px] p-1.5 ring-0 duration-100 z-[10002] w-auto", className)}
	{...restProps}
/>
