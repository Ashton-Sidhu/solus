<script lang="ts">
	import Shot from "./Shot.svelte";

	const steps = [
		{
			slug: "delegate",
			label: "Delegate",
			title: "Hand work to an agent the way you would to a teammate.",
			body: "Open a session from a task, describe the change, and let the agent plan, code, and validate end to end. It asks before it runs anything you have not already allowed, and every step is visible in the transcript.",
			points: ["Plan mode drafts before it edits", "Permission cards for anything new", "Steer mid-turn or queue the next prompt"],
			height: 1800,
			alt: "The Solus workspace running a task: the agent explains its plan while a permission card asks to run the test command, with branch, git state, and task panels alongside.",
		},
		{
			slug: "review",
			label: "Review",
			title: "Review the intent, then the output.",
			body: "A second agent reads the branch and writes a guided report: what to check, in what order, and why it matters. Each concern sits next to the exact code it refers to, so a review takes minutes instead of a context switch.",
			points: ["Guided review with numbered concerns", "Line comments sent back as one message", "Map, Guide, and Diff views of the same branch"],
			height: 1800,
			alt: "The Solus review guide for a rate-limiting change, listing numbered concerns beside the token bucket and middleware code they refer to.",
		},
		{
			slug: "ship",
			label: "Ship",
			title: "Land approved work without leaving the workspace.",
			body: "Reviewers, checks, and every changed file in one place. Merge, squash, or rebase when it is ready, or hand a conflicted branch back to an agent in its own worktree.",
			points: ["Commit, push, and open the PR in one action", "Checks and reviewers in view", "Conflicts resolved in an isolated worktree"],
			height: 1330,
			alt: "A pull request in Solus, ready to merge, showing reviewers, approval state, and every changed file with its line counts.",
		},
	];
</script>

<div class="flex flex-col gap-24 lg:gap-32">
	{#each steps as step, index (step.slug)}
		<article class="reveal flex flex-col gap-10">
			<div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
				<div class="flex flex-col gap-4">
					<div class="flex items-center gap-3 text-[14px] font-medium text-sky-ink">
						<span class="flex size-7 items-center justify-center rounded-full bg-sky-soft text-[13px] font-semibold">{index + 1}</span>
						{step.label}
					</div>
					<h3 class="display text-[clamp(26px,3vw,38px)]">{step.title}</h3>
				</div>
				<div class="flex flex-col gap-5 lg:pt-10">
					<p class="max-w-[56ch] text-[16px] leading-[1.65] text-ink-2 text-pretty">{step.body}</p>
					<ul class="flex list-none flex-col gap-2 p-0">
						{#each step.points as point (point)}
							<li class="flex items-start gap-2.5 text-[15px] text-ink">
								<svg class="mt-[5px] shrink-0 text-brand" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
									<path d="M20 6 9 17l-5-5" />
								</svg>
								{point}
							</li>
						{/each}
					</ul>
				</div>
			</div>

			<figure class="m-0 rounded-[22px] bg-sky-soft p-2 sm:p-4 lg:p-6">
				<div class="shot-frame">
					<Shot slug={step.slug} alt={step.alt} width={2880} height={step.height} />
				</div>
			</figure>
		</article>
	{/each}
</div>
