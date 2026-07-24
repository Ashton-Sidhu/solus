<script lang="ts">
	import ActDelegate from "$lib/ActDelegate.svelte";
	import ActReview from "$lib/ActReview.svelte";
	import ActShip from "$lib/ActShip.svelte";
</script>

<div class="workflow-showcase reveal reveal-d2">
	<div class="workflow-theater">
		<div class="workflow-glow" aria-hidden="true"></div>
		<div class="workflow-window delegate"><ActDelegate /></div>
		<div class="workflow-window review"><ActReview /></div>
		<div class="workflow-window ship"><ActShip /></div>
	</div>

	<dl class="workflow-summaries">
		<div>
			<dt>
				<span>01 / Delegate</span>
				<strong>Hand off work like a teammate.</strong>
			</dt>
			<dd>
				<p>Create a session, assign the task, and let Solus plan, code, and validate end to end.</p>
				<span><b>⌥⇧T</b> new session, new task</span>
			</dd>
		</div>
		<div>
			<dt>
				<span>02 / Review</span>
				<strong>Review intent, then output.</strong>
			</dt>
			<dd>
				<p>Guide concerns, inspect diffs, and send precise feedback straight back to the agent.</p>
				<span><b class="positive">+12</b> / <b class="negative">−4</b>　live, per-file</span>
			</dd>
		</div>
		<div>
			<dt>
				<span>03 / Ship</span>
				<strong>Land approved work cleanly.</strong>
			</dt>
			<dd>
				<p>Review checks, resolve conflicts with an agent, and merge the pull request when it’s ready.</p>
				<span class="positive"><b>green</b> → merged</span>
			</dd>
		</div>
	</dl>
</div>

<style>
	.workflow-showcase { display: flex; flex-direction: column; gap: 54px; }
	.workflow-theater { position: relative; min-height: 540px; isolation: isolate; }
	.workflow-glow {
		position: absolute;
		top: 5%;
		left: 27%;
		z-index: -1;
		width: 44%;
		aspect-ratio: 1.2;
		border-radius: 999px;
		background: radial-gradient(circle, rgba(212,175,106,.19), rgba(212,175,106,.06) 42%, transparent 72%);
		filter: blur(22px);
	}
	.workflow-window {
		position: absolute;
		overflow: hidden;
		border-radius: min(1vw, 12px);
		background: #faf9f6;
		box-shadow:
			0 0 0 1px rgba(0,0,0,.08),
			0 1px 0 rgba(255,255,255,.8) inset,
			0 24px 52px -22px rgba(70,55,35,.28),
			0 8px 18px -10px rgba(70,55,35,.16);
	}
	.workflow-window.delegate { top: 56px; left: 0; width: 40%; height: 430px; }
	.workflow-window.review { top: 0; left: 27%; z-index: 2; width: 44%; height: 500px; }
	.workflow-window.ship { top: 64px; right: 0; width: 29%; height: 412px; }
	.workflow-summaries { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin: 0; }
	.workflow-summaries > div { min-width: 0; padding: 0 38px; }
	.workflow-summaries > div:first-child { padding-left: 0; }
	.workflow-summaries > div:last-child { padding-right: 0; }
	.workflow-summaries > div + div { border-left: 1px solid rgba(0,0,0,.09); }
	.workflow-summaries dt { display: flex; flex-direction: column; gap: 12px; }
	.workflow-summaries dt span { color: #b08d3e; font-family: var(--font-mono); font-size: 10px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; }
	.workflow-summaries dt strong { color: #1a1714; font-family: var(--font-display); font-size: clamp(20px, 2vw, 27px); font-weight: 600; letter-spacing: -.027em; line-height: 1.18; text-wrap: balance; }
	.workflow-summaries dd { display: flex; flex-direction: column; gap: 16px; margin: 13px 0 0; }
	.workflow-summaries p { max-width: 38ch; margin: 0; color: #6b6158; font-size: 14px; line-height: 1.65; text-wrap: pretty; }
	.workflow-summaries dd > span { color: #6b6158; font-family: var(--font-mono); font-size: 10px; letter-spacing: .015em; }
	.workflow-summaries dd b { color: #1a1714; font-weight: 600; }
	.workflow-summaries .positive { color: #4a7c5c; }
	.workflow-summaries .negative { color: #b06a5a; }

	@media (max-width: 1050px) {
		.workflow-theater { min-height: 480px; }
		.workflow-window.delegate { top: 50px; height: 380px; }
		.workflow-window.review { height: 440px; }
		.workflow-window.ship { top: 58px; height: 360px; }
		.workflow-summaries > div { padding: 0 26px; }
	}
	@media (max-width: 900px) {
		.workflow-showcase { gap: 44px; }
		.workflow-theater { display: flex; min-height: 0; flex-direction: column; align-items: center; gap: 18px; }
		.workflow-glow { top: 26%; left: 5%; width: 90%; }
		.workflow-window { position: relative; top: auto !important; right: auto !important; left: auto !important; width: min(100%, 640px) !important; }
		.workflow-window.delegate { height: 470px; order: 1; }
		.workflow-window.review { height: 510px; order: 2; }
		.workflow-window.ship { height: 440px; order: 3; }
		.workflow-summaries { grid-template-columns: 1fr; }
		.workflow-summaries > div { padding: 28px 0 !important; }
		.workflow-summaries > div:first-child { padding-top: 0 !important; }
		.workflow-summaries > div + div { border-top: 1px solid rgba(0,0,0,.09); border-left: 0; }
	}
	@media (max-width: 520px) {
		.workflow-showcase { gap: 36px; }
		.workflow-theater { gap: 14px; }
		.workflow-window.delegate { height: 430px; }
		.workflow-window.review { height: 460px; }
		.workflow-window.ship { height: 400px; }
		.workflow-summaries dt strong { font-size: 24px; }
		.workflow-summaries p { font-size: 16px; }
		.workflow-summaries dd > span { font-size: 12px; }
	}
</style>
