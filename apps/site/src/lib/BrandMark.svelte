<script lang="ts">
	import { markBody, toolMark } from "./tool-marks";

	let { label, size = 20, x, y }: { label: string; size?: number; x?: number; y?: number } = $props();
	const uid = $props.id();
	const mark = $derived(toolMark(label));
</script>

<svg {x} {y} width={size} height={size} viewBox={mark.viewBox} fill="currentColor" class="shrink-0 text-ink" aria-hidden="true">{@html markBody(mark, uid)}</svg>
