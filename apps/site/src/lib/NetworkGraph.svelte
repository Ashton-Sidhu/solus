<script lang="ts">
	import { onMount } from "svelte";
	import BrandMark from "./BrandMark.svelte";
	import SolusMark from "./SolusMark.svelte";
	import { chipWidth, cloudPath, floorLines, localPath, narrowStage, stageNodes, wideStage, type Node, type Stage } from "./network-graph";

	// The laptop in your network: it reaches your fleet directly, and every
	// other host through Solus Cloud.
	const traced = "Maya's MacBook Pro";
	const reachDelay = 1.1;

	let root: HTMLDivElement;

	// When the drawing comes into view, packets leave the laptop for each machine
	// in your network and for Solus Cloud, then Solus Cloud sends one to every
	// host. Each runs once.
	onMount(() => {
		if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (!entries.some((entry) => entry.isIntersecting)) return;
				observer.disconnect();
				for (const motion of root.querySelectorAll<SVGAnimationElement>("animateMotion, set")) {
					motion.beginElementAt(Number(motion.dataset.delay ?? 0));
				}
			},
			{ threshold: 0.35 },
		);
		for (const stage of root.querySelectorAll("svg[data-stage]")) observer.observe(stage);
		return () => observer.disconnect();
	});
</script>

{#snippet mark(node: Node, size: number, x: number, y: number)}
	{#if node.mark === "Solus"}
		<g transform="translate({x} {y})"><SolusMark {size} /></g>
	{:else}
		<BrandMark label={node.mark} {size} {x} {y} />
	{/if}
{/snippet}

<!-- A host or device on the wide stage: its mark, its name, and where it runs. -->
{#snippet chip(node: Node, key: string)}
	{@const width = chipWidth(node)}
	<g transform="translate({node.x} {node.y}) scale({node.scale})" opacity={0.6 + 0.4 * node.nearness}>
		<rect x={-width / 2} y="-23" {width} height="46" rx="13" fill="#fff" stroke={node.label === traced ? "#d97757" : "#e6e4de"} filter="url(#lift-{key})" />
		{@render mark(node, 22, -width / 2 + 13, -11)}
		<text x={-width / 2 + 45} y="-3" font-size="13" font-weight="600" fill="#2a2618">{node.label}</text>
		<text x={-width / 2 + 45} y="13" font-size="11" fill="#7d7a6e">{node.detail}</text>
	</g>
{/snippet}

<!-- A host or device on the narrow stage: a mark in a disc, its name below. -->
{#snippet bubble(node: Node)}
	<g transform="translate({node.x} {node.y}) scale({node.scale})" opacity={0.65 + 0.35 * node.nearness}>
		<circle r="21" fill="#fff" stroke={node.label === traced ? "#d97757" : "#e6e4de"} />
		{@render mark(node, 20, -10, -10)}
		<text y="37" text-anchor="middle" font-size="11" font-weight="600" fill="#2a2618">{node.label}</text>
	</g>
{/snippet}

<!-- A packet that runs once along a link. -->
{#snippet packet(path: string, delay: number)}
	<circle r="3.5" fill="#d97757" opacity="0">
		<animateMotion {path} dur="0.9s" begin="indefinite" fill="freeze" data-delay={delay} />
		<set attributeName="opacity" to="1" begin="indefinite" dur="0.9s" data-delay={delay} />
	</circle>
{/snippet}

{#snippet stage(stage: Stage, key: string, wide: boolean)}
	{@const nodes = stageNodes(stage)}
	{@const { cloud } = stage}
	{@const hosts = nodes.filter((node) => node.kind === "host")}
	{@const devices = nodes.filter((node) => node.kind === "device")}
	<svg data-stage viewBox="0 0 {stage.width} {stage.height}" fill="none" class="block h-auto w-full overflow-visible font-[family-name:var(--font-sans)]" aria-hidden="true">
		<defs>
			<filter id="lift-{key}" x="-20%" y="-40%" width="140%" height="200%">
				<feDropShadow dx="0" dy="8" stdDeviation="9" flood-color="#2a2618" flood-opacity="0.12" />
			</filter>
			<radialGradient id="glow-{key}">
				<stop offset="0%" stop-color="#d97757" stop-opacity="0.3" />
				<stop offset="55%" stop-color="#d97757" stop-opacity="0.08" />
				<stop offset="100%" stop-color="#d97757" stop-opacity="0" />
			</radialGradient>
			<radialGradient id="floor-fade-{key}" cx="50%" cy="55%" r="60%">
				<stop offset="0%" stop-color="#fff" />
				<stop offset="100%" stop-color="#fff" stop-opacity="0" />
			</radialGradient>
			<mask id="floor-{key}">
				<rect width={stage.width} height={stage.height} fill="url(#floor-fade-{key})" />
			</mask>
		</defs>

		<!-- The floor, in perspective, fading out at its edges. -->
		<g mask="url(#floor-{key})" stroke="#d97757" stroke-opacity="0.13">
			{#each floorLines(stage) as line (line)}
				<path d={line} />
			{/each}
		</g>

		<!-- Your network: a dashed region of the floor around your own fleet. -->
		<rect x={stage.zone.x} y={stage.zone.y} width={stage.zone.width} height={stage.zone.height} rx="22" fill="#fff" fill-opacity="0.55" stroke="#d97757" stroke-opacity="0.45" stroke-dasharray="5 7" />
		<text x={stage.zone.x + 22} y={stage.zone.y + 30} font-size={wide ? 12.5 : 11} font-weight="600" letter-spacing="1" fill="#c15f2c">YOUR NETWORK · WORKS OFFLINE</text>
		<text x={stage.zone.x + 22} y={stage.zone.y + (wide ? 50 : 46)} font-size={wide ? 13 : 11.5} fill="#7d7a6e">Your own fleet, reached directly. No account.</text>
		{#if wide}
			<text x={stage.zone.x + stage.zone.width + 48} y="34" font-size="12.5" font-weight="600" letter-spacing="1" fill="#7d7a6e">ANYWHERE ELSE · THROUGH SOLUS CLOUD</text>
		{:else}
			<text x={stage.width / 2} y="12" text-anchor="middle" font-size="11" font-weight="600" letter-spacing="1" fill="#7d7a6e">ANYWHERE · THROUGH SOLUS CLOUD</text>
		{/if}

		<!-- Solus Cloud out to every cloud host, and every remote device up to Solus Cloud. -->
		{#each hosts.filter((node) => node.via === "cloud") as node, index (node.label)}
			{@const path = cloudPath(stage, node, wide)}
			<path d={path} stroke="#d97757" stroke-opacity={0.3 + 0.3 * node.nearness} stroke-width="1.2" />
			{@render packet(path, reachDelay + index * 0.08)}
		{/each}
		{#each devices.filter((node) => node.via === "cloud" || (wide && node.label === traced)) as node (node.label)}
			{@const path = cloudPath(stage, node, wide)}
			<path d={path} stroke={node.label === traced ? "#d97757" : "#c9c5ba"} stroke-width={node.label === traced ? 1.8 : 1.1} />
			{#if node.label === traced}{@render packet(path, 0.2)}{/if}
		{/each}

		<!-- The laptop straight to each machine in your network. -->
		{#each devices.filter((node) => node.via === "local") as device (device.label)}
			{#each hosts.filter((node) => node.via === "local") as host, index (host.label)}
				{@const path = localPath(device, host, wide)}
				<path d={path} stroke="#d97757" stroke-opacity={0.45 + 0.3 * host.nearness} stroke-width="1.3" stroke-dasharray="4 5" />
				{@render packet(path, 0.2 + index * 0.08)}
			{/each}
		{/each}

		{#each hosts as node (node.label)}
			{#if wide}{@render chip(node, key)}{:else}{@render bubble(node)}{/if}
		{/each}

		<!-- Solus Cloud: the mark in rings, on a warm glow. -->
		<circle cx={cloud.x} cy={cloud.y} r={cloud.r * 3.4} fill="url(#glow-{key})" />
		{#each [[1.55, 0.55], [2.15, 0.28], [2.8, 0.13]] as [ring, opacity], index (ring)}
			<circle cx={cloud.x} cy={cloud.y} r={cloud.r * ring} stroke="#d97757" stroke-opacity={opacity} stroke-dasharray={index === 1 ? "2 6" : "none"} />
		{/each}
		<circle cx={cloud.x} cy={cloud.y} r={cloud.r} fill="#fff" stroke="#f9e9e1" stroke-width="1.5" filter="url(#lift-{key})" />
		<g transform="translate({cloud.x - cloud.r * 0.62} {cloud.y - cloud.r * 0.62})"><SolusMark size={cloud.r * 1.24} /></g>
		{#if wide}
			<text x={cloud.x + cloud.r * 3} y={cloud.y - 4} font-family="var(--font-display)" font-size="20" font-weight="600" letter-spacing="-0.4" fill="#2a2618">Solus Cloud</text>
			<text x={cloud.x + cloud.r * 3} y={cloud.y + 18} font-size="13.5" fill="#7d7a6e">Connects them. Never sees your code.</text>
		{:else}
			<text x={cloud.x + cloud.r * 2.3} y={cloud.y + 4} font-family="var(--font-display)" font-size="15" font-weight="600" fill="#2a2618">Solus Cloud</text>
		{/if}

		{#each devices as node (node.label)}
			{#if wide}{@render chip(node, key)}{:else}{@render bubble(node)}{/if}
		{/each}
	</svg>
{/snippet}

<div
	bind:this={root}
	class="flex flex-col gap-3"
	role="img"
	aria-label="Two zones. Your network, which works offline with no account: a MacBook Pro reaches your own fleet directly, Linux racks, a Mac Studio, a GPU box, a Mac mini, and a Raspberry Pi. Anywhere else: an iPhone, an iPad, an Android phone, and a browser link up to Solus Cloud, which links out to hosts on AWS, Google Cloud, Azure, DigitalOcean, and hosts run by Solus. The MacBook Pro links to Solus Cloud too, so it reaches both."
>
	<div class="max-lg:hidden">{@render stage(wideStage, "wide", true)}</div>
	<div class="mx-auto w-full max-w-[420px] lg:hidden">{@render stage(narrowStage, "narrow", false)}</div>
</div>
