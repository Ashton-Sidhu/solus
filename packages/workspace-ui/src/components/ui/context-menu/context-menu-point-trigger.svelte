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

<!-- `contents`: the trigger wrapper must generate no box of its own. Its only
     child is fixed, so in a flex or grid parent this component adds neither an
     item nor a gap, and summoning the menu cannot move the caller's layout. -->
<Trigger class="contents">
	<div
		bind:this={triggerEl}
		class="pointer-events-none fixed size-px"
		style:left="{x}px"
		style:top="{y}px"
		aria-hidden="true"
	></div>
</Trigger>
