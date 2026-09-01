<script lang="ts">
	// Real captures of the workspace, not drawings of it. The caption sits above
	// the shot rather than beside it: a 1440px-wide app screenshot needs close to
	// its own width on screen before its labels can be read, and a side-by-side
	// column can never give it that. The old collage squeezed three of these into
	// a third of the page each and rendered their text at 7px.
	const acts = [
		{
			slug: "delegate",
			step: "01 / Delegate",
			title: "Hand off work like a teammate.",
			body: "Create a session, assign the task, and let the agent plan, code, and validate end to end. It asks before it runs anything you have not already allowed.",
			detail: "⌘T new session, new task",
			height: 1800,
			alt: "The Solus workspace running a task: the agent explains its plan while a permission card asks to run the test command, with branch, git state, and task panels alongside.",
		},
		{
			slug: "review",
			step: "02 / Review",
			title: "Review intent, then output.",
			body: "A second agent reads the branch and writes a guided report — what to check, in what order, and why it matters — with each concern sitting next to the exact code it refers to.",
			detail: "4 concerns · +31 −0 · per-file",
			height: 1800,
			alt: "The Solus review guide for a rate-limiting change, listing numbered concerns beside the token bucket and middleware code they refer to.",
		},
		{
			slug: "ship",
			step: "03 / Ship",
			title: "Land approved work cleanly.",
			body: "Reviewers, checks, and every changed file in one place. Merge when it is ready, or hand a conflicted branch back to an agent in its own worktree.",
			detail: "✓ ready to merge",
			height: 1330,
			alt: "A pull request in Solus, ready to merge, showing reviewers, approval state, and every changed file with its line counts.",
		},
	];
</script>

<div class="workflow-showcase">
	{#each acts as act (act.slug)}
		<section class="workflow-act reveal reveal-d1">
			<div class="workflow-head">
				<div class="workflow-lede">
					<span class="workflow-step">{act.step}</span>
					<h3>{act.title}</h3>
				</div>
				<div class="workflow-aside">
					<p>{act.body}</p>
					<span class="workflow-detail">{act.detail}</span>
				</div>
			</div>

			<figure class="workflow-shot">
				<picture>
					<!-- A phone column is ~345px. The whole-window capture becomes
					     texture at that width, so narrow screens get a crop of the
					     one thing the caption is about, at a size it can be read. -->
					<source
						media="(max-width: 700px)"
						srcset="/workflow/{act.slug}-mobile.avif"
						type="image/avif"
					/>
					<source
						media="(max-width: 700px)"
						srcset="/workflow/{act.slug}-mobile.jpg"
						type="image/jpeg"
					/>
					<source srcset="/workflow/{act.slug}.avif" type="image/avif" />
					<img
						src="/workflow/{act.slug}.jpg"
						alt={act.alt}
						width="2880"
						height={act.height}
						loading="lazy"
						decoding="async"
					/>
				</picture>
			</figure>
		</section>
	{/each}
</div>

<style>
	.workflow-showcase {
		display: flex;
		flex-direction: column;
		gap: 110px;
	}

	.workflow-act {
		display: flex;
		flex-direction: column;
		gap: 32px;
	}

	.workflow-head {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1.05fr);
		align-items: end;
		gap: 56px;
	}
	.workflow-lede {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 12px;
	}
	.workflow-aside {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 12px;
	}

	.workflow-step {
		color: #b08d3e;
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}
	.workflow-head h3 {
		margin: 0;
		color: #1a1714;
		font-family: var(--font-display);
		font-size: clamp(24px, 2.4vw, 34px);
		font-weight: 600;
		letter-spacing: -0.03em;
		line-height: 1.14;
		text-wrap: balance;
	}
	.workflow-aside p {
		max-width: 56ch;
		margin: 0;
		color: #6b6158;
		font-size: 15px;
		line-height: 1.65;
		text-wrap: pretty;
	}
	.workflow-detail {
		color: #6b6158;
		font-family: var(--font-mono);
		font-size: 11px;
		letter-spacing: 0.015em;
	}

	.workflow-shot {
		margin: 0;
		overflow: hidden;
		border-radius: 14px;
		background: #faf9f6;
		box-shadow:
			0 0 0 1px rgba(0, 0, 0, 0.08),
			0 1px 0 rgba(255, 255, 255, 0.8) inset,
			0 24px 52px -22px rgba(70, 55, 35, 0.28),
			0 8px 18px -10px rgba(70, 55, 35, 0.16);
	}
	.workflow-shot img {
		display: block;
		width: 100%;
		height: auto;
	}

	@media (max-width: 900px) {
		.workflow-showcase {
			gap: 72px;
		}
		.workflow-act {
			gap: 22px;
		}
		.workflow-head {
			grid-template-columns: 1fr;
			gap: 14px;
		}
		.workflow-aside p {
			max-width: none;
			font-size: 16px;
		}
	}

	@media (max-width: 700px) {
		/* The mobile crop has its own shape; the width/height attributes describe
		   the desktop capture, so stop them dictating the box. */
		.workflow-shot img {
			aspect-ratio: auto;
		}
	}
</style>
