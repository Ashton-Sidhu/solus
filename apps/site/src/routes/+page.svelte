<script lang="ts">
	import { onMount } from "svelte";
	import WorkflowShowcase from "$lib/WorkflowShowcase.svelte";
	import Shot from "$lib/Shot.svelte";
	import ToolMarks from "$lib/ToolMarks.svelte";
	import BrandMark from "$lib/BrandMark.svelte";
	import NetworkGraph from "$lib/NetworkGraph.svelte";
	import UsesFlow from "$lib/UsesFlow.svelte";
	import SolusMark from "$lib/SolusMark.svelte";
	import DownloadButton from "$lib/DownloadButton.svelte";


	const hostingModes = [
		{ mark: "Apple", title: "On your computer, even offline", body: "Mac, Windows, or Linux, with no account. On your network, devices connect straight to the host, with or without Solus Cloud." },
		{ mark: "Linux", title: "On your own VMs", body: "Install the server on any Linux or macOS machine, in any cloud or your own rack." },
		{ mark: "Solus", title: "Hosted by Solus", body: "Managed hosts for your team, with every member kept apart." },
	];

	const securityPoints = [
		{ title: "Nothing to open", body: "Your machines connect out. No ports to open, no VPN to run." },
		{ title: "Your code stays home", body: "Code and conversations live on your machines, never on ours." },
		{ title: "Keys stay locked", body: "Agents use your accounts without ever holding your keys." },
		{ title: "You decide who's in", body: "Remove a teammate, and their access ends within hours." },
	];

	const dataRows = [
		{
			marks: ["Jira", "GitHub"],
			title: "Tickets become tasks",
			body: "A Jira or GitHub issue opens as a Solus task with its spec and status. Start a session from it, and the task and the ticket stay in step.",
			shot: { slug: "tasks", width: 3024, height: 1964, alt: "Jira ticket ACME-214 open as a Solus task: the spec, the Jira upstream link, the agent session working it, and a thread where the agent and two people answer each other.", imgClass: "min-[701px]:h-full min-[701px]:object-cover min-[701px]:object-right-top min-[701px]:origin-top-right min-[701px]:scale-[1.2]" },
			caption: "Jira ACME-214 as a task, worked by an agent and two people.",
		},
		{
			marks: ["Confluence", "Google Drive"],
			title: "Docs in, docs out",
			body: "Agents read the real Confluence page or Google Doc. What they write publishes back, and edits made there pull back in.",
			shot: { slug: "doc", width: 2880, height: 1800, alt: "A rollout runbook the agent wrote, open in Solus: a numbered table of contents, a decision summary, an open comment thread, and a Publish action in the header.", imgClass: "min-[701px]:h-full min-[701px]:object-cover min-[701px]:object-left-top" },
			caption: "A runbook the agent wrote, ready to publish to Confluence.",
		},
	];

	const observabilityViews = [
		{
			slug: "insights",
			title: "Every turn, from every host.",
			body: "Spend, speed, and model for each turn, in one view. Ask a question in plain words or write SQL.",
			height: 1800,
			alt: "Insights in Solus: a chart of turns over the last 24 hours with spend, p50, and p95, and a table of every turn with its prompt, session, model, host, and duration.",
		},
		{
			slug: "trace",
			title: "One turn, step by step.",
			body: "Open a turn to see where the time and money went, and what Solus thinks you should fix.",
			height: 1800,
			alt: "Solus Insights page for one turn, showing a span waterfall of thinking, file reads, edits, a failed test run behind a 26-second permission wait, a passing re-run and the response, with findings for the repeated test command and the time spent waiting on the user.",
		},
	];

	const faqs = [
		{ q: "Do I need Solus Cloud?", a: "No. Solus runs on your own machine with no account. Signing in adds organizations, sharing, managed hosts, and sync." },
		{ q: "Do I need an API key?", a: "No. Solus drives the Claude Code and Codex tools you already have installed and signed in." },
		{ q: "Where do my credentials live?", a: "In one vault on the host, or in your Solus account. An agent never sees a token." },
		{ q: "Where does my code go?", a: "It stays on your machines and the hosts you add. Sharing a work or a task makes a cloud copy, only when you choose." },
		{ q: "What does it run on?", a: "Desktop apps for macOS 12 and later on Apple Silicon, Windows, and Linux; any browser; iPhone and Android; and a headless server for Linux or macOS." },
		{ q: "What does it cost?", a: "Free during the beta. The source is public under the Business Source License, which converts to Apache 2.0 in 2030." },
	];

	onMount(() => {
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						entry.target.classList.add("visible");
						observer.unobserve(entry.target);
					}
				}
			},
			{ threshold: 0.1 },
		);
		document.querySelectorAll(".reveal").forEach((el) => observer.observe(el));
		return () => observer.disconnect();
	});
</script>

<!-- The Solus mark at page scale: the core and the first ring are the logo,
     the rings beyond it repeat its three gaps, each fainter than the last. -->
{#snippet orbit()}
	<svg viewBox="-60 -60 120 120" fill="none" stroke="#d97757" stroke-linecap="round" aria-hidden="true" class="size-full">
		<circle cx="0" cy="0" r="6.4" fill="#d97757" fill-opacity="0.85" stroke="none" />
		<g stroke-width="2.1" stroke-opacity="0.55">
			<path d="M 0,-10.6 A 10.6,10.6 0 0 1 10.6,0" />
			<path d="M 8.9,7.2 A 10.6,10.6 0 0 1 -3.4,10.2" />
			<path d="M -8.9,7.2 A 10.6,10.6 0 0 1 -10.6,-3.4" />
		</g>
		{#each [[19, 0.9, 0.4], [28, 0.75, 0.3], [37, 0.6, 0.22], [46, 0.5, 0.15], [55, 0.45, 0.1]] as [r, w, o], i}
			<g stroke-width={w} stroke-opacity={o} transform="rotate({(i + 1) * 9})">
				<path d="M 0,{-r} A {r},{r} 0 0 1 {r},0" />
				<path d="M {r * 0.84},{r * 0.68} A {r},{r} 0 0 1 {-r * 0.32},{r * 0.96}" />
				<path d="M {-r * 0.84},{r * 0.68} A {r},{r} 0 0 1 {-r},{-r * 0.32}" />
			</g>
		{/each}
	</svg>
{/snippet}

{#snippet arrow()}
	<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<path d="M5 12h14M13 6l6 6-6 6" />
	</svg>
{/snippet}

{#snippet heading(label: string, title: string, lede: string)}
	<div class="reveal flex max-w-[720px] flex-col gap-4">
		<span class="text-[14px] font-medium text-brand-deep">{label}</span>
		<h2 class="display text-[clamp(32px,4.2vw,52px)]">{title}</h2>
		{#if lede}
			<p class="max-w-[52ch] text-[17px] leading-[1.6] text-ink-2 text-pretty">{lede}</p>
		{/if}
	</div>
{/snippet}

<!-- Hero -->
<section>
	<div class="site-container pt-16 pb-10 sm:pt-24">
		<h1 class="max-w-[30ch] font-[family-name:var(--font-display)] text-[clamp(26px,2.8vw,38px)] font-medium leading-[1.2] tracking-[-0.02em] text-ink text-balance">
			Solus is the workspace for running agents on your machines, in your cloud, and across your data.
		</h1>
		<div class="mt-7 flex flex-wrap items-start gap-3 max-sm:w-full max-sm:flex-col">
			<DownloadButton showOthers class="items-start">
				{#snippet secondary()}
					<a href="https://app.solus.sh/sign-in" class="btn btn-secondary max-sm:w-full">
						Open Solus Cloud
						{@render arrow()}
					</a>
				{/snippet}
			</DownloadButton>
		</div>
	</div>

	<!-- The stage: the app window floats inside a wide panel over a painting.
	     Charles-François Daubigny, The Seine: Morning, 1874. The Metropolitan
	     Museum of Art, Open Access (CC0). -->
	<div class="site-container">
		<div class="relative overflow-hidden rounded-xl bg-surface px-[6%] pt-[5%] pb-[6%]">
			<picture>
				<source srcset="/stage/seine-morning.avif" type="image/avif" />
				<img
					src="/stage/seine-morning.jpg"
					alt=""
					width="2400"
					height="1350"
					fetchpriority="high"
					decoding="async"
					aria-hidden="true"
					class="pointer-events-none absolute inset-0 size-full object-cover object-[center_38%]"
				/>
			</picture>
			<div class="relative overflow-hidden rounded-[10px] bg-bg shadow-[0_0_0_1px_rgba(42,38,24,0.10),0_30px_70px_-20px_rgba(42,38,24,0.45),0_8px_20px_-10px_rgba(42,38,24,0.25)]">
				<Shot
					slug="orchestrate"
					alt="A billing-service lead session in Solus coordinates seven agents (four done, two working, one waiting on a question about which customers move to metered prices first) while the dashboard worker's diff is open in a pane beside it."
					width={2880}
					height={1800}
					priority
				/>
			</div>
		</div>
	</div>

	<div class="site-container flex flex-col items-center gap-6 pt-20 sm:pt-24">
		<span class="text-[14px] text-ink-2">Works with the tools your team already uses</span>
		<ToolMarks />
	</div>
</section>

<!-- What teams use Solus for -->
<section id="uses" class="pt-20 pb-24 lg:pt-24 lg:pb-32">
	<div class="site-container">
		<UsesFlow />
	</div>
</section>

<!-- Cloud -->
<section id="cloud" class="border-t border-line py-24 lg:py-32">
	<div class="site-container flex flex-col gap-14">
		{@render heading("Solus Cloud", "Every device, every host, one secure network.", "Run Solus on your own computer with no account, on your own VMs and servers, or on hosts Solus runs for you. Sign in, and every device reaches every host.")}

		<ul class="reveal m-0 grid list-none overflow-hidden rounded-2xl border border-line bg-raised p-0 md:grid-cols-3 md:divide-x md:divide-line max-md:divide-y max-md:divide-line">
			{#each hostingModes as mode (mode.title)}
				<li class="flex gap-4 p-6">
					<span class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface">
						{#if mode.mark === "Solus"}<SolusMark size={22} />{:else}<BrandMark label={mode.mark} size={22} />{/if}
					</span>
					<div class="flex flex-col gap-1">
						<h3 class="font-[family-name:var(--font-display)] text-[17px] font-semibold tracking-[-0.02em] text-ink">{mode.title}</h3>
						<p class="text-[14.5px] leading-[1.55] text-ink-2 text-pretty">{mode.body}</p>
					</div>
				</li>
			{/each}
		</ul>

		<div class="reveal">
			<NetworkGraph />
		</div>

		<div class="reveal grid gap-8 border-t border-line-strong pt-10 sm:grid-cols-2 lg:grid-cols-4">
			{#each securityPoints as point (point.title)}
				<div class="flex flex-col gap-2">
					<h3 class="font-[family-name:var(--font-display)] text-[17px] font-semibold tracking-[-0.02em] text-ink">{point.title}</h3>
					<p class="text-[14.5px] leading-[1.6] text-ink-2 text-pretty">{point.body}</p>
				</div>
			{/each}
		</div>
	</div>
</section>

<!-- Data -->
<section id="data" class="border-t border-line py-24 lg:py-32">
	<div class="site-container flex flex-col gap-14">
		{@render heading("Connect your data", "Every source your agents need, one sign-in each.", "Solus is a full MCP client. Pick a server from the catalog or paste any address, sign in once, and every agent on every host can use it.")}

		<figure class="reveal m-0 flex flex-col gap-4">
			<div class="shot-frame">
				<Shot slug="mcp" alt="Solus MCP settings listing GitHub, Linear, Atlassian Rovo, Notion, Sentry, Slack and Context7 as installed and connected, above a catalog of more servers such as Figma, Vercel, Supabase and Neon, each with a Connect button." width={2880} height={1800} />
			</div>
			<figcaption class="text-[14.5px] text-ink-2">Connect your tracker, docs, errors, and chat once, and every agent on the host can use them.</figcaption>
		</figure>

		{#each dataRows as row, index (row.title)}
			<div class="reveal grid items-center gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:gap-14">
				<figure class="m-0 flex flex-col gap-4 {index % 2 ? 'lg:order-2' : ''}">
					<div class="shot-frame min-[701px]:aspect-[16/10]">
						<Shot slug={row.shot.slug} alt={row.shot.alt} width={row.shot.width} height={row.shot.height} imgClass={row.shot.imgClass} />
					</div>
					<figcaption class="text-[14.5px] text-ink-2">{row.caption}</figcaption>
				</figure>
				<div class="flex flex-col gap-4">
					<div class="flex items-center gap-2">
						{#each row.marks as mark (mark)}
							<span class="flex items-center gap-2 rounded-full border border-line bg-raised py-1.5 pr-3 pl-2 text-[13px] font-medium text-ink">
								<BrandMark label={mark} size={16} />
								{mark}
							</span>
						{/each}
					</div>
					<h3 class="font-[family-name:var(--font-display)] text-[26px] font-semibold tracking-[-0.025em] text-ink">{row.title}</h3>
					<p class="max-w-[44ch] text-[16px] leading-[1.6] text-ink-2 text-pretty">{row.body}</p>
				</div>
			</div>
		{/each}

	</div>
</section>

<!-- Workflow -->
<section id="workflow" class="border-t border-line py-24 lg:py-32">
	<div class="site-container flex flex-col gap-16 lg:gap-20">
		{@render heading("The engineering loop", "From ticket to pull request, and watched after it ships.", "")}
		<div class="mx-auto w-full max-w-[1320px]">
			<WorkflowShowcase />
		</div>
	</div>
</section>

<!-- Observability -->
<section id="observability" class="border-t border-line py-24 lg:py-32">
	<div class="site-container flex flex-col gap-14">
		{@render heading("Observability", "See every turn, and what it cost.", "Solus traces every turn on every host you use. See where the time went, what you spent, and what to fix, without wiring up a thing.")}

		{#each observabilityViews as view (view.slug)}
			<article class="reveal flex flex-col gap-8">
				<div class="grid gap-3 lg:grid-cols-2 lg:gap-16">
					<h3 class="display text-[clamp(24px,2.6vw,32px)]">{view.title}</h3>
					<p class="max-w-[52ch] text-[16px] leading-[1.65] text-ink-2 text-pretty">{view.body}</p>
				</div>
				<figure class="m-0 rounded-[22px] bg-surface p-2 sm:p-4 lg:p-6">
					<div class="shot-frame">
						<Shot slug={view.slug} alt={view.alt} width={2880} height={view.height} />
					</div>
				</figure>
			</article>
		{/each}
	</div>
</section>

<!-- FAQ -->
<section id="faq" class="border-t border-line py-24 lg:py-32">
	<div class="site-container flex flex-col gap-12">
		<h2 class="reveal display text-[clamp(32px,4.2vw,48px)]">Frequently asked questions</h2>
		<div class="reveal grid gap-4 md:grid-cols-2">
			{#each faqs as faq (faq.q)}
				<details class="group rounded-2xl border border-line bg-raised open:border-line-strong">
					<summary class="flex cursor-pointer list-none items-center justify-between gap-4 px-6 py-5 text-[16px] font-medium text-ink [&::-webkit-details-marker]:hidden">
						{faq.q}
						<svg class="shrink-0 text-ink-3 transition-transform duration-200 group-open:rotate-45" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
							<path d="M12 5v14M5 12h14" />
						</svg>
					</summary>
					<p class="px-6 pb-6 text-[15px] leading-[1.65] text-ink-2 text-pretty">{faq.a}</p>
				</details>
			{/each}
		</div>
	</div>
</section>

<!-- Closing call -->
<section class="site-container pb-24 lg:pb-32">
	<div class="reveal relative overflow-hidden rounded-[28px] bg-surface px-6 py-16 text-center sm:px-12 sm:py-24">
		<div class="pointer-events-none absolute -bottom-[300px] -left-[260px] size-[700px]" aria-hidden="true">
			{@render orbit()}
		</div>
		<div class="relative flex flex-col items-center gap-6">
			<h2 class="display max-w-[18ch] text-[clamp(32px,4.6vw,56px)]">Bring your agents. Bring your team.</h2>
			<p class="max-w-[46ch] text-[17px] leading-[1.6] text-ink-2 text-pretty">
				Free and source-available. Install in a minute and use the subscription you already pay for.
			</p>
			<DownloadButton size="lg" showBrew showOthers class="mt-2 items-center" />
		</div>
	</div>
</section>
