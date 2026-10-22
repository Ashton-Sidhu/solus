<script lang="ts">
	import { onMount } from "svelte";
	import WorkflowShowcase from "$lib/WorkflowShowcase.svelte";
	import Shot from "$lib/Shot.svelte";
	import { BREW_COMMAND, downloadApp } from "$lib/download";

	let brewCopied = $state(false);

	function copyBrew() {
		navigator.clipboard.writeText(BREW_COMMAND);
		brewCopied = true;
		setTimeout(() => (brewCopied = false), 2000);
	}

	const integrations = ["Claude Code", "Codex", "GitHub", "Jira", "Confluence", "Google Drive", "Any MCP server"];

	// Each row is one thing Solus does for a team, with one concrete fact and a
	// link to the docs that describe it.
	const uses = [
		{
			title: "Run agents anywhere",
			body: "On your Mac, on a server you own, or on hosts Solus manages for your organization. Every host runs the same Claude Code and Codex, and your phone or any browser drives it.",
			fact: "An agent on one host can start sessions on any other host you can reach.",
			href: "/docs#connections",
			link: "Hosts and connections",
		},
		{
			title: "Connect your data",
			body: "Add any MCP server from the catalog or by URL, sign in once to GitHub, Atlassian, and Google, and agents read the spec, the ticket, and the doc where they live.",
			fact: "Each tool is marked read, write, or destructive, and you decide which ones agents get.",
			href: "/docs#connections",
			link: "Integrations",
		},
		{
			title: "Keep everything in sync",
			body: "Settings, keybindings, and your agent profile follow your account to every device and host. Tasks sync with Jira and GitHub both ways, and write-ups publish back to Confluence or Google Docs.",
			fact: "Your Insights show your turns from every host in one place.",
			href: "/docs#settings",
			link: "Sync and settings",
		},
	];

	const cloudSteps = [
		{
			title: "Hosts where you need them.",
			body: "A personal host is your own machine. A self-hosted one is a server you run. A managed host is a cloud machine Solus provisions for your organization, with one isolated user per member.",
		},
		{
			title: "Share without moving code.",
			body: "A session stays on its host. Share a link and a teammate follows it live, or a guest prompts it in supervised mode. Works and tasks get a cloud copy you can share on their own.",
		},
		{
			title: "One account, every device.",
			body: "Sign in on the Mac app, the web client, and the phone app. The same organizations, hosts, settings, and agent profile appear on each, and the console shows your organization's activity.",
		},
	];

	const dataPoints = [
		{
			title: "MCP integrations",
			body: "Browse a catalog of servers or paste an address. Sign in with OAuth, see every tool, and switch off the ones agents should not have.",
			icon: "M4 7h16M4 12h16M4 17h10M18 15l2 2 4-4",
		},
		{
			title: "Specs and documents",
			body: "Hand an agent a Confluence page or a Google Doc and it reads the real thing, or searches both when you only half-remember the title.",
			icon: "M6 3h9l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM14 3v6h6M9 13h6M9 17h6",
		},
		{
			title: "Tickets and pull requests",
			body: "Jira issues and GitHub issues become tasks. Status, labels, and comments move both ways, and the agent answers reviewers in the thread.",
			icon: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
		},
		{
			title: "Credentials in one vault",
			body: "Every tool call runs with your own account. Credentials live in one vault on the host or in your Solus account, and an agent never sees a token.",
			icon: "M12 3a5 5 0 0 1 5 5v3h1a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2h1V8a5 5 0 0 1 5-5zM9 11V8a3 3 0 0 1 6 0v3",
		},
	];

	const syncPoints = [
		{
			title: "Settings and keybindings",
			body: "Change a setting once and every connected device has it.",
			icon: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
		},
		{
			title: "Your agent profile",
			body: "Your files, skills, and MCP connections are applied on every host you work on.",
			icon: "M20 21a8 8 0 1 0-16 0M12 13a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
		},
		{
			title: "Insights from every host",
			body: "Turns from all your machines land in one view, with cost, duration, and model.",
			icon: "M3 3v18h18M7 15l4-4 4 4 5-6",
		},
		{
			title: "Tasks, both ways",
			body: "Jira and GitHub issues stay current as agents and people work them.",
			icon: "M17 2l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3",
		},
		{
			title: "Works that publish back",
			body: "Publish a doc to Confluence or Google Docs. The next publish updates the same page, and you can pull its edits back.",
			icon: "M12 3v12M8 11l4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2",
		},
		{
			title: "Pull requests, watched",
			body: "Checks, reviews, and merges reach the session that opened the pull request.",
			icon: "M6 3v12M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9v3a3 3 0 0 1-3 3H9",
		},
	];

	type DataCard = {
		title: string;
		body: string;
		shot: { slug: string; width: number; height: number; alt: string };
		fit: string;
	};

	const dataCards: DataCard[] = [
		{
			title: "A ticket, synced with Jira, worked by an agent and two people",
			body: "The spec is the task body. The session that worked it is attached. Status, labels, and comments move in both directions, and the agent answers the reviewer in the same thread.",
			shot: {
				slug: "tasks",
				width: 3024,
				height: 1964,
				alt: "A task open in Solus, synced with Jira ticket ACME-214: the spec in the body, the agent session working it, and a thread where the agent and two people answer each other.",
			},
			fit: "object-cover object-left-bottom",
		},
		{
			title: "A runbook the agent wrote, with Publish in the header",
			body: "Docs, decks, and diagrams are real artifacts. Publish one to Confluence or Google Docs and it stays linked to that page.",
			shot: {
				slug: "doc",
				width: 2880,
				height: 1800,
				alt: "A rollout runbook open in Solus: a numbered table of contents, a decision summary, and an open comment thread, with a Publish action in the header.",
			},
			fit: "object-cover object-left-top",
		},
	];

	const orchestrationSteps = [
		{
			title: "One session leads.",
			body: "Give a task to a lead session. It starts worker sessions, each in its own worktree or on another host you can reach, and sends each one what it needs.",
		},
		{
			title: "Workers report back.",
			body: "When a worker finishes, its report lands in the lead's conversation: the files it changed, the branch, the pull request, and the works it wrote.",
		},
		{
			title: "A person decides.",
			body: "A worker's question, plan, or permission appears on the lead's card and in the worker's own tab. Answer it in either place. Agents never approve for each other.",
		},
	];

	const faqs = [
		{
			q: "Do I need Solus Cloud?",
			a: "No. Solus runs on your own machine with no account. Signing in adds organizations, sharing, managed hosts, settings and profile sync, and Insights across your hosts.",
		},
		{
			q: "Do I need an API key?",
			a: "No. Solus drives the Claude Code and Codex command-line tools you already have installed and signed in. It ships no model of its own and never asks for a key.",
		},
		{
			q: "Where do my credentials live?",
			a: "In one vault on the host, or in your Solus account when you sign in. A tool call runs with your own account, an executor receives a short-lived credential for one use, and an agent never sees a token.",
		},
		{
			q: "Where does my code go?",
			a: "Agents run on your machines or on the hosts you add. A shared session stays on its host. Sharing a work or a task makes a cloud copy, and only when you choose to.",
		},
		{
			q: "What does it run on?",
			a: "A native app for macOS 12 and later on Apple Silicon, a web client in any browser, a native app for iPhone and Android, and a headless server for Linux or macOS.",
		},
		{
			q: "What does it cost?",
			a: "Solus is free during the beta. The source is public under the Business Source License, which converts to Apache 2.0 in 2030.",
		},
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

{#snippet appleMark()}
	<svg width="15" height="15" viewBox="0 0 814 1000" fill="currentColor" aria-hidden="true">
		<path d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.3-165-39.3c-76.5 0-103.7 40.8-165 40.8s-105-42.7-147.8-103.6c-49-68.9-90.6-176.5-90.6-279C0 469.8 166.4 265 348.6 265 407.5 265 458 304.5 490 304.5c29.8 0 88.8-44.5 163.7-44.5 26.6 0 108.2 2.6 168.6 74.9zm-237.6-74.9c31.8-37.7 54.6-90.1 54.6-142.5 0-7.1-.6-14.3-1.9-20.1-51.9 2-112.3 34.8-149.1 75.5-29.2 32.6-55.1 84.4-55.1 139.8 0 7.7 1.3 15.5 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 46.5 0 102.3-31.2 136-72.1z" />
	</svg>
{/snippet}

{#snippet lineIcon(path: string)}
	<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<path d={path} />
	</svg>
{/snippet}

{#snippet arrow()}
	<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		<path d="M5 12h14M13 6l6 6-6 6" />
	</svg>
{/snippet}

<!-- Line illustrations. Nodes are hosts or sessions; the filled one is yours. -->
{#snippet illustrationHosts()}
	<svg viewBox="0 0 280 120" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="h-[120px] w-full max-w-[280px]">
		<rect x="24" y="44" width="56" height="36" rx="6" /><path d="M36 86h32" />
		<rect x="112" y="36" width="56" height="12" rx="3" /><rect x="112" y="54" width="56" height="12" rx="3" /><rect x="112" y="72" width="56" height="12" rx="3" />
		<path d="M212 78a14 14 0 0 1 2-28 18 18 0 0 1 34-4 12 12 0 0 1 8 32z" />
		<path d="M80 62h32M168 60h40" stroke-dasharray="3 4" />
		<circle cx="52" cy="62" r="4" fill="var(--color-brand)" stroke="none" />
	</svg>
{/snippet}

{#snippet illustrationShare()}
	<svg viewBox="0 0 280 120" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="h-[120px] w-full max-w-[280px]">
		<rect x="24" y="30" width="112" height="60" rx="8" />
		<path d="M40 48h60M40 62h80M40 76h48" />
		<path d="M136 60h44" stroke="var(--color-brand)" /><path d="M174 54l6 6-6 6" stroke="var(--color-brand)" />
		<circle cx="212" cy="46" r="8" /><path d="M198 72c0-10 28-10 28 0" />
		<circle cx="248" cy="62" r="7" /><path d="M236 86c0-9 24-9 24 0" />
	</svg>
{/snippet}

{#snippet illustrationDevices()}
	<svg viewBox="0 0 280 120" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="h-[120px] w-full max-w-[280px]">
		<rect x="20" y="30" width="96" height="60" rx="6" /><path d="M48 98h40" />
		<rect x="144" y="26" width="80" height="64" rx="6" /><path d="M144 40h80" />
		<rect x="240" y="36" width="24" height="52" rx="5" /><path d="M248 80h8" />
		<circle cx="140" cy="12" r="6" fill="var(--color-brand)" stroke="none" />
		<path d="M140 18v6M140 24c-40 0-72 0-72 12M140 24c20 0 44 0 44 2M140 24c60 0 112 0 112 12" stroke-dasharray="3 4" />
	</svg>
{/snippet}

{#snippet illustrationLead()}
	<svg viewBox="0 0 280 120" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true" class="h-[120px] w-full max-w-[280px]">
		<circle cx="40" cy="60" r="9" fill="var(--color-brand)" stroke="none" />
		<path d="M52 60h60M112 60c40 0 40-36 80-36M112 60h80M112 60c40 0 40 36 80 36" />
		<circle cx="204" cy="24" r="7" /><circle cx="204" cy="60" r="7" /><circle cx="204" cy="96" r="7" />
		<path d="M218 24h30M218 60h30M218 96h30" stroke-dasharray="3 4" />
	</svg>
{/snippet}

{#snippet illustrationReport()}
	<svg viewBox="0 0 280 120" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true" class="h-[120px] w-full max-w-[280px]">
		<circle cx="52" cy="24" r="7" /><circle cx="52" cy="60" r="7" /><circle cx="52" cy="96" r="7" />
		<path d="M66 24c40 0 40 36 80 36M66 60h80M66 96c40 0 40-36 80-36" />
		<rect x="152" y="40" width="96" height="40" rx="8" />
		<path d="M166 54h40M166 66h56" stroke="var(--color-brand)" />
	</svg>
{/snippet}

{#snippet illustrationDecide()}
	<svg viewBox="0 0 280 120" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="h-[120px] w-full max-w-[280px]">
		<path d="M24 60h84" />
		<rect x="108" y="36" width="64" height="48" rx="10" />
		<path d="M128 60l8 8 16-16" stroke="var(--color-brand)" stroke-width="2" />
		<path d="M172 60h84" />
		<circle cx="140" cy="18" r="6" /><path d="M130 36c0-8 20-8 20 0" />
	</svg>
{/snippet}

<!-- Hero -->
<section class="relative overflow-hidden">
	<div class="grid-backdrop pointer-events-none absolute inset-x-0 top-0 -z-10 h-[720px]" aria-hidden="true"></div>

	<div class="site-container pt-20 pb-14 sm:pt-28 lg:pt-32">
		<h1 class="display max-w-[15ch] text-[clamp(40px,6.2vw,80px)]">
			Your agents, your data, your team. One workspace.
		</h1>
		<p class="mt-7 max-w-[60ch] text-[17px] leading-[1.6] text-ink-2 text-pretty sm:text-[20px]">
			Solus runs Claude Code and Codex on your machines or in the cloud, connects them to the systems your work already lives in, and keeps every device, host, and teammate in sync.
		</p>
		<div class="mt-9 flex flex-wrap items-center gap-3 max-sm:w-full max-sm:flex-col">
			<button type="button" onclick={downloadApp} class="btn btn-primary h-12 px-6 text-[16px] max-sm:w-full">
				{@render appleMark()}
				Download for macOS
			</button>
			<a href="https://app.solus.sh/sign-in" class="btn btn-secondary h-12 px-6 text-[16px] max-sm:w-full">Open Solus Cloud</a>
		</div>
		<p class="mt-5 text-[14px] text-ink-3">
			Free and source-available. Runs on the Claude or ChatGPT subscription you already have.
		</p>
	</div>

	<div class="mx-auto w-full max-w-[1360px] px-4 sm:px-6 lg:px-10">
		<div class="shot-frame">
			<Shot
				slug="orchestrate"
				alt="A lead session in Solus after the user approves a plan: a card for seven worker agents, three working, one waiting on a shell permission a person must answer, and three done with their reports."
				width={2880}
				height={1800}
				priority
			/>
		</div>
	</div>

	<div class="site-container flex flex-col items-center gap-5 pt-16 sm:pt-20">
		<span class="text-[13px] font-medium text-ink-3">Works with the tools your team already uses</span>
		<ul class="flex list-none flex-wrap items-center justify-center gap-x-10 gap-y-3 p-0">
			{#each integrations as name (name)}
				<li class="font-[family-name:var(--font-display)] text-[18px] font-semibold tracking-[-0.02em] text-ink-3">{name}</li>
			{/each}
		</ul>
	</div>
</section>

<!-- What teams use Solus for -->
<section id="uses" class="pt-20 pb-24 lg:pt-24 lg:pb-32">
	<div class="site-container flex flex-col gap-12">
		<h2 class="reveal display text-[clamp(32px,4.2vw,52px)]">What teams use Solus for.</h2>
		<div class="flex flex-col">
			{#each uses as use (use.title)}
				<div class="reveal grid gap-5 border-t border-line py-10 last:border-b lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16 lg:py-14">
					<h3 class="font-[family-name:var(--font-display)] text-[clamp(24px,2.6vw,34px)] font-semibold tracking-[-0.025em] text-ink">{use.title}</h3>
					<div class="flex flex-col gap-4">
						<p class="max-w-[56ch] text-[16px] leading-[1.65] text-ink-2 text-pretty">{use.body}</p>
						<p class="max-w-[56ch] text-[16px] leading-[1.65] font-medium text-ink text-pretty">{use.fact}</p>
						<a href={use.href} class="inline-flex items-center gap-1.5 text-[15px] font-medium text-brand no-underline hover:text-brand-deep">
							{use.link}
							{@render arrow()}
						</a>
					</div>
				</div>
			{/each}
		</div>
	</div>
</section>

<!-- Cloud -->
<section id="cloud" class="border-t border-line bg-sky-soft py-24 lg:py-32">
	<div class="site-container flex flex-col gap-14">
		<div class="reveal flex max-w-[720px] flex-col gap-5">
			<span class="text-[14px] font-medium text-sky-ink">Solus Cloud</span>
			<h2 class="display text-[clamp(32px,4.2vw,52px)]">Local by default. Cloud when you want it.</h2>
			<p class="max-w-[56ch] text-[17px] leading-[1.65] text-ink-2 text-pretty">
				Everything works on one machine with no account. Sign in and Solus adds organizations, hosts you can share or have provisioned, and sharing that never moves your code.
			</p>
		</div>

		<div class="reveal grid gap-10 md:grid-cols-3 md:gap-0 md:divide-x md:divide-line-strong">
			{#each cloudSteps as step, index (step.title)}
				<div class="flex flex-col gap-6 md:px-8 md:first:pl-0 md:last:pr-0">
					<div class="text-sky-ink">
						{#if index === 0}{@render illustrationHosts()}{:else if index === 1}{@render illustrationShare()}{:else}{@render illustrationDevices()}{/if}
					</div>
					<div class="flex flex-col gap-2.5">
						<span class="text-[13px] font-medium text-ink-3">0{index + 1}</span>
						<h3 class="font-[family-name:var(--font-display)] text-[20px] font-semibold tracking-[-0.02em] text-ink">{step.title}</h3>
						<p class="text-[15px] leading-[1.65] text-ink-2 text-pretty">{step.body}</p>
					</div>
				</div>
			{/each}
		</div>

		<div class="reveal grid gap-5 md:grid-cols-2">
			<div class="flex flex-col gap-3 rounded-2xl border border-line bg-raised p-7 sm:p-8">
				<span class="text-[13px] font-medium text-ink-3">Start small</span>
				<h3 class="font-[family-name:var(--font-display)] text-[24px] font-semibold tracking-[-0.025em] text-ink">Run it on your Mac.</h3>
				<p class="text-[15px] leading-[1.65] text-ink-2 text-pretty">Install the app, open a project, and start a session. Pair your phone or a browser when you want to check in from somewhere else.</p>
				<button type="button" onclick={downloadApp} class="btn btn-primary mt-3 self-start">Download for macOS</button>
			</div>
			<div class="flex flex-col gap-3 rounded-2xl border border-line bg-raised p-7 sm:p-8">
				<span class="text-[13px] font-medium text-ink-3">Go big</span>
				<h3 class="font-[family-name:var(--font-display)] text-[24px] font-semibold tracking-[-0.025em] text-ink">Bring your organization.</h3>
				<p class="text-[15px] leading-[1.65] text-ink-2 text-pretty">Add members, share hosts or have Solus manage them, and see every team's sessions, tasks, and Insights from the console.</p>
				<a href="https://app.solus.sh/sign-in" class="btn btn-secondary mt-3 self-start">Open Solus Cloud</a>
			</div>
		</div>
	</div>
</section>

<!-- Data -->
<section id="data" class="border-t border-line py-24 lg:py-32">
	<div class="site-container flex flex-col gap-14">
		<div class="reveal grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
			<div class="flex flex-col gap-5">
				<span class="text-[14px] font-medium text-sky-ink">Connect your data</span>
				<h2 class="display text-[clamp(32px,4.2vw,52px)]">Agents that work from your real sources.</h2>
			</div>
			<p class="max-w-[52ch] text-[17px] leading-[1.65] text-ink-2 text-pretty lg:pt-12">
				The spec is in Confluence. The ticket is in Jira. The numbers are behind an MCP server. Solus is the MCP client, so agents reach all of it with your own accounts and write back when they are done.
			</p>
		</div>

		<div class="reveal grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
			{#each dataPoints as point (point.title)}
				<div class="flex flex-col gap-4 rounded-2xl border border-line bg-raised p-6">
					<span class="flex size-10 items-center justify-center rounded-xl bg-sky-soft text-sky-ink">
						{@render lineIcon(point.icon)}
					</span>
					<div class="flex flex-col gap-1.5">
						<h3 class="font-[family-name:var(--font-display)] text-[17px] font-semibold tracking-[-0.02em] text-ink">{point.title}</h3>
						<p class="text-[14.5px] leading-[1.6] text-ink-2 text-pretty">{point.body}</p>
					</div>
				</div>
			{/each}
		</div>

		<div class="grid gap-5 lg:grid-cols-[1.3fr_1fr]">
			{#each dataCards as card (card.title)}
				<article class="reveal flex flex-col overflow-hidden rounded-2xl border border-line bg-raised">
					<div class="flex flex-col gap-2 p-6 sm:p-8">
						<h3 class="font-[family-name:var(--font-display)] text-[20px] font-semibold tracking-[-0.02em] text-ink">{card.title}</h3>
						<p class="text-[15px] leading-[1.6] text-ink-2 text-pretty">{card.body}</p>
					</div>
					<div class="mt-auto pl-6 sm:pl-8">
						<div class="shot-frame aspect-[2/1] rounded-tr-none rounded-br-none rounded-bl-none">
							<Shot slug={card.shot.slug} alt={card.shot.alt} width={card.shot.width} height={card.shot.height} imgClass="h-full {card.fit}" />
						</div>
					</div>
				</article>
			{/each}
		</div>
	</div>
</section>

<!-- Sync -->
<section id="sync" class="border-t border-line bg-sky-soft py-24 lg:py-32">
	<div class="site-container flex flex-col gap-14">
		<div class="reveal flex max-w-[720px] flex-col gap-5">
			<span class="text-[14px] font-medium text-sky-ink">Keep everything in sync</span>
			<h2 class="display text-[clamp(32px,4.2vw,52px)]">Everything stays in step.</h2>
			<p class="max-w-[56ch] text-[17px] leading-[1.65] text-ink-2 text-pretty">
				Your account carries your setup to every device and host. The systems around Solus carry the work back out, so nothing you see is a stale copy.
			</p>
		</div>
		<div class="reveal grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
			{#each syncPoints as point (point.title)}
				<div class="flex gap-4 rounded-2xl border border-line bg-raised p-6">
					<span class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-sky-soft text-sky-ink">
						{@render lineIcon(point.icon)}
					</span>
					<div class="flex flex-col gap-1.5">
						<h3 class="font-[family-name:var(--font-display)] text-[17px] font-semibold tracking-[-0.02em] text-ink">{point.title}</h3>
						<p class="text-[14.5px] leading-[1.6] text-ink-2 text-pretty">{point.body}</p>
					</div>
				</div>
			{/each}
		</div>
	</div>
</section>

<!-- Orchestration -->
<section id="orchestration" class="border-t border-line py-24 lg:py-32">
	<div class="site-container flex flex-col gap-14">
		<div class="reveal flex max-w-[720px] flex-col gap-5">
			<span class="text-[14px] font-medium text-sky-ink">Orchestration</span>
			<h2 class="display text-[clamp(32px,4.2vw,52px)]">Staff a task across your hosts.</h2>
			<p class="max-w-[56ch] text-[17px] leading-[1.65] text-ink-2 text-pretty">
				A session can start other sessions, on this host or on any host you can reach, send them messages, stop them, and hear back. The lead sees everything that happened. People approve; agents do the work.
			</p>
		</div>

		<div class="reveal grid gap-10 md:grid-cols-3 md:gap-0 md:divide-x md:divide-line-strong">
			{#each orchestrationSteps as step, index (step.title)}
				<div class="flex flex-col gap-6 md:px-8 md:first:pl-0 md:last:pr-0">
					<div class="text-sky-ink">
						{#if index === 0}{@render illustrationLead()}{:else if index === 1}{@render illustrationReport()}{:else}{@render illustrationDecide()}{/if}
					</div>
					<div class="flex flex-col gap-2.5">
						<span class="text-[13px] font-medium text-ink-3">0{index + 1}</span>
						<h3 class="font-[family-name:var(--font-display)] text-[20px] font-semibold tracking-[-0.02em] text-ink">{step.title}</h3>
						<p class="text-[15px] leading-[1.65] text-ink-2 text-pretty">{step.body}</p>
					</div>
				</div>
			{/each}
		</div>
	</div>
</section>

<!-- Workflow -->
<section id="workflow" class="border-t border-line py-24 lg:py-32">
	<div class="site-container flex flex-col gap-16 lg:gap-20">
		<div class="reveal flex max-w-[720px] flex-col gap-5">
			<span class="text-[14px] font-medium text-sky-ink">The engineering loop</span>
			<h2 class="display text-[clamp(32px,4.2vw,52px)]">From ticket to pull request, with a review in between.</h2>
			<p class="max-w-[56ch] text-[17px] leading-[1.65] text-ink-2 text-pretty">
				Hand the work off, gate it twice, and land it clean. The same loop whether the agent ran on your Mac or on a host in the cloud.
			</p>
		</div>
		<div class="mx-auto w-full max-w-[1320px]">
			<WorkflowShowcase />
		</div>
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
	<div
		class="reveal relative overflow-hidden rounded-[28px] border border-line bg-sky-soft px-6 py-16 text-center sm:px-12 sm:py-24"
	>
		<div class="grid-backdrop pointer-events-none absolute inset-0" aria-hidden="true"></div>
		<div class="relative flex flex-col items-center gap-6">
			<h2 class="display max-w-[18ch] text-[clamp(32px,4.6vw,56px)]">Bring your agents. Bring your team.</h2>
			<p class="max-w-[46ch] text-[17px] leading-[1.6] text-ink-2 text-pretty">
				Free and source-available. Install in a minute and start your first session with the subscription you already pay for.
			</p>
			<div class="mt-2 flex flex-wrap items-center justify-center gap-3 max-sm:w-full max-sm:flex-col">
				<button type="button" onclick={downloadApp} class="btn btn-primary h-12 px-6 text-[16px] max-sm:w-full">
					{@render appleMark()}
					Download for macOS
				</button>
				<button
					type="button"
					onclick={copyBrew}
					class="btn btn-secondary h-12 px-6 text-[16px] max-sm:w-full"
					aria-label="Copy the Homebrew install command"
				>
					{#if brewCopied}
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
						Copied
					{:else}
						Copy Homebrew command
					{/if}
				</button>
			</div>
		</div>
	</div>
</section>
