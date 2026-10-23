<script lang="ts">
	import BrandMark from "./BrandMark.svelte";
	import SolusMark from "./SolusMark.svelte";

	// The three steps of running work in Solus, each with a small drawing of the
	// part of the app that does it. A line joins the step numbers: across the
	// top on a wide screen, down the left on a narrow one.

	const steps = [
		{ title: "Pick where it runs", body: "Your Mac, a server you own, or a host Solus runs for your organization." },
		{ title: "Give it your context", body: "Tickets, specs, errors, and data from any MCP server go straight into the prompt, through your own sign-in." },
		{ title: "Follow it anywhere", body: "Start on your Mac, answer from your phone. It is one session, live on every device." },
	];

	const hosts = [
		{ mark: "Apple", name: "Maya's MacBook Pro", detail: "This Mac" },
		{ mark: "AWS", name: "build-01", detail: "AWS, us-east-1", selected: true },
		{ mark: "Solus", name: "agents-01", detail: "Run by Solus" },
	];

	// Where each step's panel crops the painting, so the three read as one scene.
	const stageCrops = ["object-[10%_40%]", "object-[50%_40%]", "object-[90%_40%]"];

	// Sources in the context drawing; the lit ones are the ones the prompt uses.
	const sources = ["GitHub", "Jira", "Confluence", "Google Drive", "Linear", "Notion", "Sentry", "Postgres"];
	const used = new Set(["Jira", "Confluence", "Sentry"]);
</script>

{#snippet check()}
	<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
{/snippet}

{#snippet mark(name: string, size: number)}
	{#if name === "Solus"}<SolusMark {size} />{:else}<BrandMark label={name} {size} />{/if}
{/snippet}

{#snippet hostPicker()}
	<div class="flex flex-col gap-1">
		<span class="px-2 pb-1 text-[12px] font-medium text-ink-3">Run on</span>
		{#each hosts as host (host.name)}
			<div class="flex items-center gap-3 rounded-lg px-2 py-2 {host.selected ? 'bg-brand-light ring-1 ring-brand-soft' : ''}">
				<span class="flex size-8 items-center justify-center rounded-lg bg-surface">{@render mark(host.mark, 17)}</span>
				<div class="flex min-w-0 flex-1 flex-col">
					<span class="truncate text-[13.5px] font-medium text-ink">{host.name}</span>
					<span class="text-[12px] text-ink-3">{host.detail}</span>
				</div>
				<span class="size-1.5 rounded-full bg-[#3f9a62]" title="Online"></span>
				{#if host.selected}<span class="text-brand-deep">{@render check()}</span>{/if}
			</div>
		{/each}
	</div>
{/snippet}

<!-- Sources on top; the ones in use run down into the prompt as mentions. -->
{#snippet contextFlow()}
	<div class="flex flex-col p-1">
		<div class="grid grid-cols-4 gap-2">
			{#each sources as source (source)}
				<span class="flex aspect-square items-center justify-center rounded-xl {used.has(source) ? 'bg-brand-light ring-1 ring-brand-soft' : 'bg-surface opacity-70'}" title={source}>
					{@render mark(source, 22)}
				</span>
			{/each}
		</div>
		<svg class="h-10 w-full" viewBox="0 0 100 40" preserveAspectRatio="none" fill="none" aria-hidden="true">
			{#each [37.5, 62.5, 62.5] as x, index (index)}
				<path d="M{x} 0 C {x} 22, 50 18, 50 40" stroke="#d97757" stroke-width="1.4" vector-effect="non-scaling-stroke" />
			{/each}
			{#each [12.5, 87.5] as x (x)}
				<path d="M{x} 0 C {x} 22, 50 18, 50 40" stroke="#d4d1c8" stroke-dasharray="3 4" vector-effect="non-scaling-stroke" />
			{/each}
		</svg>
		<div class="rounded-xl border border-line-strong bg-raised p-3 text-[13.5px] leading-[2] text-ink">
			Fix
			{@render mention("Jira", "ACME-214")}
			to match
			{@render mention("Confluence", "Rate limits spec")}
			then check
			{@render mention("Sentry", "429 spike")}
		</div>
	</div>
{/snippet}

{#snippet mention(source: string, label: string)}
	<span class="inline-flex items-center gap-1.5 rounded-md bg-brand-light px-1.5 py-0.5 align-middle text-[12.5px] leading-tight font-medium text-brand-deep">
		{@render mark(source, 13)}{label}
	</span>
{/snippet}

<!-- One session on a MacBook and an iPhone at once: real captures in device frames. -->
{#snippet followAnywhere()}
	<div class="relative px-1 pt-10 pb-1">
		<span class="absolute top-0 left-1 flex items-center gap-1.5 rounded-full bg-raised/90 px-2.5 py-1 text-[11.5px] font-medium text-ink shadow-[0_6px_16px_-8px_rgba(42,38,24,0.5)]">
			<span class="size-1.5 rounded-full bg-[#3f9a62]"></span>Live on both
		</span>
		<div class="w-[80%]">
			<div class="rounded-t-[10px] bg-ink p-[3px] pb-[5px]">
				<picture>
					<source srcset="/workflow/orchestrate.avif" type="image/avif" />
					<img src="/workflow/orchestrate.jpg" alt="" width="2880" height="1800" loading="lazy" decoding="async" class="block aspect-[16/10] w-full rounded-[7px] object-cover" />
				</picture>
			</div>
			<div class="relative h-2.5 w-[112%] -translate-x-[5.4%] rounded-b-[10px] bg-gradient-to-b from-[#dedad1] to-[#b9b4a8]">
				<span class="absolute top-0 left-1/2 h-1 w-[14%] -translate-x-1/2 rounded-b-md bg-[#a9a497]"></span>
			</div>
		</div>
		<div class="absolute right-1 bottom-0 w-[26%] rounded-[22px] bg-ink p-[4px] shadow-[0_24px_40px_-18px_rgba(42,38,24,0.6)]">
			<span class="absolute top-[9px] left-1/2 z-10 h-[9px] w-[30%] -translate-x-1/2 rounded-full bg-ink"></span>
			<picture>
				<source srcset="/workflow/follow-phone.avif" type="image/avif" />
				<img src="/workflow/follow-phone.jpg" alt="" width="1170" height="2532" loading="lazy" decoding="async" class="block aspect-[1170/2532] w-full rounded-[20px] bg-bg object-cover object-top" />
			</picture>
		</div>
	</div>
{/snippet}

<ol class="relative m-0 grid list-none gap-12 p-0 lg:grid-cols-3 lg:gap-8">
	<!-- The line that joins the step numbers. -->
	<span class="absolute top-4 bottom-4 left-4 w-px bg-gradient-to-b from-brand via-brand-soft to-line lg:top-4 lg:right-[16%] lg:bottom-auto lg:left-4 lg:h-px lg:w-auto lg:bg-gradient-to-r" aria-hidden="true"></span>

	{#each steps as step, index (step.title)}
		<li class="reveal reveal-d{index} relative flex flex-col gap-5 pl-14 lg:pl-0">
			<span class="absolute top-0 left-0 flex size-8 items-center justify-center rounded-full bg-ink font-[family-name:var(--font-display)] text-[14px] font-semibold text-white ring-4 ring-bg lg:relative">{index + 1}</span>
			<div class="flex flex-col gap-2">
				<h2 class="font-[family-name:var(--font-display)] text-[22px] font-semibold tracking-[-0.025em] text-ink">{step.title}</h2>
				<p class="max-w-[36ch] text-[15.5px] leading-[1.6] text-ink-2 text-pretty lg:min-h-[4.8em]">{step.body}</p>
			</div>
			<!-- Each drawing floats on a crop of the hero's painting, as the app window does. -->
			<div class="relative flex flex-col justify-center overflow-hidden rounded-2xl px-[7%] py-[8%] lg:flex-1">
				<picture>
					<source srcset="/stage/seine-morning.avif" type="image/avif" />
					<img src="/stage/seine-morning.jpg" alt="" width="2400" height="1350" loading="lazy" decoding="async" aria-hidden="true" class="pointer-events-none absolute inset-0 size-full object-cover {stageCrops[index]}" />
				</picture>
				{#if index === 2}
					<div class="relative">{@render followAnywhere()}</div>
				{:else}
					<div class="relative rounded-xl bg-raised p-3 shadow-[0_0_0_1px_rgba(42,38,24,0.10),0_30px_60px_-24px_rgba(42,38,24,0.55)]">
						{#if index === 0}{@render hostPicker()}{:else}{@render contextFlow()}{/if}
					</div>
				{/if}
			</div>
		</li>
	{/each}
</ol>
