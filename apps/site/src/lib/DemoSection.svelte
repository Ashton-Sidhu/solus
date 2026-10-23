<script lang="ts">
	import { onMount } from "svelte";
	import { detectPlatform, downloadApp } from "./download";

	let iframeElement = $state<HTMLIFrameElement>();
	let stageElement = $state<HTMLDivElement>();
	let iframeSrc = $state("");
	let isReady = $state(false);
	let hasVisitorInteracted = false;
	let resetCounter = 0;

	// A finished turn folds its activity into a single summary row, so the story
	// the replay just told collapses to a prompt and one line of chrome. Play it
	// again rather than leave an empty window in the hero. The hold lets the
	// finished state land before the reset; the visibility gate keeps a
	// backgrounded tab from booting the workspace on a timer forever.
	const REPLAY_HOLD_MS = 2000;
	let isStageVisible = false;
	let isReplayPending = false;
	let prefersReducedMotion = false;
	let replayTimer: ReturnType<typeof setTimeout> | null = null;

	// The demo is a real workspace, so its transcript is a live scroll container
	// — and scroll chaining does not cross an iframe boundary. Left interactive,
	// it swallows the wheel and the page cannot be scrolled past the hero at all;
	// on a large display the demo sits under the pointer for most of the
	// viewport. Keep it inert so wheels reach the page, and hand it the pointer
	// only when the visitor asks for it.
	let isDemoInteractive = $state(false);

	function activateDemo() {
		isDemoInteractive = true;
		// They took the wheel: never reset the demo under them from here on.
		hasVisitorInteracted = true;
	}

	function scheduleReplay() {
		// Once the visitor takes the wheel the demo is theirs; never reset under them.
		if (hasVisitorInteracted || prefersReducedMotion) return;
		if (!isStageVisible) {
			isReplayPending = true;
			return;
		}
		isReplayPending = false;
		if (replayTimer) clearTimeout(replayTimer);
		replayTimer = setTimeout(() => {
			replayTimer = null;
			reloadDemo();
		}, REPLAY_HOLD_MS);
	}

	// The demo lays itself out at a fixed "native" width and zooms down inside
	// the iframe (CSS zoom re-lays-out crisply; a parent transform would scale
	// rasterized bitmaps and blur text). The floor keeps text readable on
	// narrower desktop viewports.
	const DEMO_NATIVE_WIDTH = 1600;
	const DEMO_MIN_ZOOM = 0.72;
	let stageWidth = $state(0);
	let demoZoom = $derived(
		stageWidth
			? Math.min(1, Math.max(DEMO_MIN_ZOOM, stageWidth / DEMO_NATIVE_WIDTH))
			: 1,
	);

	$effect(() => {
		if (!isReady) return;
		iframeElement?.contentWindow?.postMessage(
			{ type: "demo:zoom", zoom: demoZoom },
			location.origin,
		);
	});

	function loadDemo() {
		// Name the file, not the directory: the demo is a static bundle, and the
		// dev server has no directory-index fallback, so "/demo/" 404s there while
		// it resolves in production. The bundle's asset base is absolute either way.
		if (!iframeSrc) iframeSrc = "/demo/index.html";
	}

	function startDemo() {
		if (!isReady) return;

		iframeElement?.contentWindow?.postMessage(
			{ type: "demo:start" },
			location.origin,
		);
		window.plausible?.("demo-start");
	}

	function reloadDemo() {
		if (!iframeSrc) return;
		iframeElement?.contentWindow?.postMessage(
			{ type: "demo:reset" },
			location.origin,
		);
		isReady = false;
		isDemoInteractive = false;
		resetCounter += 1;
		iframeSrc = `${iframeSrc.split("?")[0]}?t=${resetCounter}`;
	}

	function resetDemo() {
		reloadDemo();
		window.plausible?.("demo-reset");
	}

	onMount(() => {
		const desktopQuery = window.matchMedia("(min-width: 1024px)");
		const reducedMotionQuery = window.matchMedia(
			"(prefers-reduced-motion: reduce)",
		);
		prefersReducedMotion = reducedMotionQuery.matches;

		function syncReducedMotion() {
			prefersReducedMotion = reducedMotionQuery.matches;
		}

		// The replay only runs while the stage is on screen, so a demo that
		// finished off screen has to wait for the visitor to come back to it.
		const stageObserver = new IntersectionObserver(
			(entries) => {
				isStageVisible = entries.some((entry) => entry.isIntersecting);
				if (isStageVisible && isReplayPending) scheduleReplay();
			},
			{ threshold: 0.25 },
		);
		if (stageElement) stageObserver.observe(stageElement);

		function syncViewport() {
			if (desktopQuery.matches) {
				loadDemo();
				return;
			}

			iframeSrc = "";
			isReady = false;
		}

		function handleMessage(event: MessageEvent) {
			if (
				event.origin !== location.origin ||
				event.source !== iframeElement?.contentWindow ||
				Object.prototype.toString.call(event.data) !== "[object Object]"
			) return;

			switch (event.data.type) {
				case "demo:ready":
					isReady = true;
					window.plausible?.("demo-ready");
					startDemo();
					break;
				case "demo:complete":
					scheduleReplay();
					break;
				case "demo:cta-click":
					window.plausible?.("demo-cta-click");
					downloadApp(detectPlatform());
					break;
				case "demo:interacted":
					if (!hasVisitorInteracted) {
						hasVisitorInteracted = true;
						window.plausible?.("demo-interacted");
					}
					break;
			}
		}

		syncViewport();
		desktopQuery.addEventListener("change", syncViewport);
		reducedMotionQuery.addEventListener("change", syncReducedMotion);
		window.addEventListener("message", handleMessage);

		return () => {
			desktopQuery.removeEventListener("change", syncViewport);
			reducedMotionQuery.removeEventListener("change", syncReducedMotion);
			window.removeEventListener("message", handleMessage);
			stageObserver.disconnect();
			if (replayTimer) clearTimeout(replayTimer);
		};
	});
</script>

<div class="w-full">
	<div class="hidden lg:block">
		<div
			class="relative overflow-hidden rounded-2xl bg-raised shadow-[0_0_0_1px_rgba(26,23,20,0.10),0_40px_80px_-40px_rgba(26,23,20,0.35),0_16px_32px_-20px_rgba(26,23,20,0.20)]"
		>
			<div
				bind:this={stageElement}
				class="relative aspect-[16/10] overflow-hidden bg-bg"
				bind:clientWidth={stageWidth}
			>
				{#if iframeSrc}
					<iframe
						bind:this={iframeElement}
						src={iframeSrc}
						title="Interactive Solus demo"
						class="size-full border-0 bg-bg {isDemoInteractive ? '' : 'pointer-events-none'}"
					></iframe>
				{/if}

				{#if isReady && !isDemoInteractive}
					<!-- Claim the pointer only on request, so the wheel keeps reaching the page -->
					<button
						type="button"
						onclick={activateDemo}
						class="group absolute inset-0 z-10 cursor-pointer border-0 bg-transparent p-0"
					>
						<span class="sr-only">Take control of the demo</span>
						<span
							class="pointer-events-none absolute bottom-5 left-1/2 -translate-x-1/2 rounded-lg bg-ink px-3.5 py-2 text-[13px] font-medium text-white opacity-0 shadow-lg transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100"
						>
							Click to try it yourself
						</span>
					</button>
				{/if}

				<!-- Seamless poster: the demo's real end state, crossfading into the live demo -->
				<div
					aria-hidden={isReady}
					class="pointer-events-none absolute inset-0 bg-bg bg-cover bg-center transition-[opacity,visibility] duration-500 {isReady ? 'invisible opacity-0' : 'visible opacity-100'}"
					style="background-image: url('/demo-poster.webp');"
				></div>
			</div>

		</div>
		<div class="mt-3 flex items-center justify-end gap-3 px-1 text-[13px] text-ink-3">
			<span>Live demo of the workspace. Click it to take control.</span>
			<button
				type="button"
				onclick={resetDemo}
				disabled={!iframeSrc}
				class="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-raised px-2.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
			>
				<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
					<path d="M3 3v5h5" />
				</svg>
				Replay
			</button>
		</div>
	</div>

	<div class="lg:hidden">
		<div class="shot-frame">
			<picture>
				<!-- A phone column turns the whole-window poster into texture, so it
				     gets a crop of the permission card at a readable size. -->
				<source media="(max-width: 700px)" srcset="/workflow/delegate-mobile.avif" type="image/avif" />
				<source media="(max-width: 700px)" srcset="/workflow/delegate-mobile.jpg" type="image/jpeg" />
				<img
					src="/demo-poster.webp"
					alt="The Solus workspace: a session transcript beside the task, git, and environment panels."
					width="3200"
					height="2000"
					class="shot max-[700px]:aspect-auto"
					fetchpriority="high"
				/>
			</picture>
		</div>
	</div>
</div>
