<script lang="ts">
	import BrandMark from "./BrandMark.svelte";

	// Eight marks, so the grid is one row of eight or two rows of four.
	const labels = ["Claude Code", "Codex", "GitHub", "Jira", "Linear", "Confluence", "Google Drive", "Any MCP server"];
</script>

<ul class="m-0 grid w-full max-w-[960px] list-none grid-cols-4 gap-y-8 p-0 lg:grid-cols-8">
	{#each labels as label (label)}
		<li class="flex flex-col items-center gap-3 text-center text-ink-2">
			<BrandMark {label} size={28} />
			<span class="text-[12.5px] leading-tight font-medium">{label}</span>
		</li>
	{/each}
</ul>
