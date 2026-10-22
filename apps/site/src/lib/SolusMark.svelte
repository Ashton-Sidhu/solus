<script lang="ts">
	let { size = 22 }: { size?: number } = $props();
</script>

<svg width={size} height={size} viewBox="-60 -60 120 120" fill="none" aria-hidden="true">
	<circle cx="0" cy="0" r="31.2" fill="#B45A3C" />
	<g stroke="#D97757" stroke-width="10.4" stroke-linecap="round">
		<path d="M 0,-52 A 52,52 0 0 1 52,0" />
		<path d="M 43.68,35.36 A 52,52 0 0 1 -16.64,49.92" />
		<path d="M -43.68,35.36 A 52,52 0 0 1 -52,-16.64" />
	</g>
</svg>
