<script lang="ts">
	import Shot from "./Shot.svelte";

	const steps = [
		{
			slug: "delegate",
			label: "Delegate",
			title: "Staff a task across agents.",
			body: "A lead session splits the plan between Claude and Codex workers. Their questions and reports come back to the lead, and you can open any worker beside it.",
			width: 2880,
			height: 1800,
			alt: "The billing lead's question is answered with 'Free tier' and the worker reports are in; the Dashboard usage graph worker's transcript, open beside it, lists the six files it wrote in web-dashboard and its pull request #148.",
		},
		{
			slug: "review",
			label: "Review",
			title: "A second agent writes the review guide.",
			body: "The guide walks the change in order, each part beside its code, and flags the tradeoffs to decide. Your line comments wait and go out as one review.",
			width: 2880,
			height: 1800,
			alt: "The Solus review guide for a rate-limiting pull request: the token-bucket section with a flagged tradeoff, its code beside it, and a pending line comment on the refill line.",
		},
		{
			slug: "ship",
			label: "Ship",
			title: "Merge with checks and reviewers in view.",
			body: "Or hand a conflicted branch back to an agent in its own worktree.",
			width: 2880,
			height: 1800,
			alt: "A pull request in Solus with its merge status, reviewers, passing checks, and every changed file with its line counts.",
		},
		{
			slug: "automations",
			label: "Monitor",
			title: "Keep watch after it ships.",
			body: "Automations triage new errors, check for drift, and keep dependencies current on a schedule. Each run is a session you can open and reply to, and a failure asks for your attention.",
			width: 2216,
			height: 1136,
			alt: "Solus Automations page listing eight automations across api-gateway, billing-service, web-dashboard, ios-app, infra and marketing-site, with recent run history, one needing attention and one paused.",
		},
	];
</script>

<div class="flex flex-col gap-20 lg:gap-28">
	{#each steps as step, index (step.slug)}
		<article class="reveal flex flex-col gap-8">
			<div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
				<div class="flex flex-col gap-3">
					<div class="flex items-center gap-3 text-[14px] font-medium text-brand-deep">
						<span class="flex size-7 items-center justify-center rounded-full bg-brand-soft text-[13px] font-semibold">{index + 1}</span>
						{step.label}
					</div>
					<h3 class="display text-[clamp(26px,3vw,38px)]">{step.title}</h3>
				</div>
				<p class="max-w-[52ch] text-[16px] leading-[1.65] text-ink-2 text-pretty lg:pt-10">{step.body}</p>
			</div>

			<figure class="m-0 rounded-[22px] bg-surface p-2 sm:p-4 lg:p-6">
				<div class="shot-frame">
					<Shot slug={step.slug} alt={step.alt} width={step.width} height={step.height} />
				</div>
			</figure>
		</article>
	{/each}
</div>
