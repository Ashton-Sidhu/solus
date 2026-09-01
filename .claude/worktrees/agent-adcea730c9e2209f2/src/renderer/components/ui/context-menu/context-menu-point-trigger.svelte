<script lang="ts">
	import Trigger from "./context-menu-trigger.svelte";

	interface Props {
		x: number;
		y: number;
	}

	let { x, y }: Props = $props();
	let triggerEl: HTMLDivElement | null = null;

	$effect(() => {
		const frame = requestAnimationFrame(() => {
			triggerEl?.dispatchEvent(
				new MouseEvent("contextmenu", {
					bubbles: true,
					cancelable: true,
					button: 2,
					clientX: x,
					clientY: y,
				})
			);
		});
		return () => cancelAnimationFrame(frame);
	});
</script>

<Trigger>
	<div
		bind:this={triggerEl}
		class="pointer-events-none fixed size-px"
		style:left="{x}px"
		style:top="{y}px"
		aria-hidden="true"
	></div>
</Trigger>
