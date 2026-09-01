<script lang="ts">
	import { onMount } from "svelte";

	let iframeElement = $state<HTMLIFrameElement>();
	let iframeSrc = $state("");
	let isReady = $state(false);
	let hasTrackedInteraction = false;
	let resetCounter = 0;

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

	const menuBarDate = new Date().toLocaleDateString("en-US", {
		weekday: "short",
		month: "short",
		day: "numeric",
	});

	function loadDemo() {
		if (!iframeSrc) iframeSrc = "/demo/";
	}

	function startDemo() {
		if (!isReady) return;

		iframeElement?.contentWindow?.postMessage(
			{ type: "demo:start" },
			location.origin,
		);
		window.plausible?.("demo-start");
	}

	function resetDemo() {
		iframeElement?.contentWindow?.postMessage(
			{ type: "demo:reset" },
			location.origin,
		);
		isReady = false;
		resetCounter += 1;
		iframeSrc = `${iframeSrc.split("?")[0]}?t=${resetCounter}`;
		window.plausible?.("demo-reset");
	}

	function downloadApp() {
		const link = document.createElement("a");
		link.href = "/api/download";
		link.download = "Solus-latest-arm64.dmg";
		document.body.appendChild(link);
		link.click();
		link.remove();
	}

	onMount(() => {
		const desktopQuery = window.matchMedia("(min-width: 1024px)");

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
				typeof event.data !== "object" ||
				event.data === null
			) return;

			switch (event.data.type) {
				case "demo:ready":
					isReady = true;
					window.plausible?.("demo-ready");
					startDemo();
					break;
				case "demo:cta-click":
					window.plausible?.("demo-cta-click");
					downloadApp();
					break;
				case "demo:interacted":
					if (!hasTrackedInteraction) {
						hasTrackedInteraction = true;
						window.plausible?.("demo-interacted");
					}
					break;
			}
		}

		syncViewport();
		desktopQuery.addEventListener("change", syncViewport);
		window.addEventListener("message", handleMessage);

		return () => {
			desktopQuery.removeEventListener("change", syncViewport);
			window.removeEventListener("message", handleMessage);
		};
	});
</script>

<div class="w-full max-w-[1600px]">
	<div class="hidden lg:block">
		<!-- Desktop scene: wallpaper + menu bar, with the Solus window floating on top -->
		<div
			class="relative overflow-hidden rounded-[20px] shadow-[0_0_0_1px_rgba(0,0,0,0.14),0_8px_16px_-4px_rgba(70,55,35,0.12),0_24px_56px_-12px_rgba(70,55,35,0.20),0_48px_100px_-24px_rgba(70,55,35,0.24)]"
			style="background-image: radial-gradient(85% 65% at 82% -5%, rgba(224,136,104,0.42), transparent 58%), radial-gradient(95% 75% at 8% 105%, rgba(212,175,106,0.30), transparent 60%), linear-gradient(152deg, #3B2F26 0%, #262019 55%, #17130F 100%);"
		>
			<!-- macOS menu bar -->
			<div class="relative flex h-8 items-center gap-5 bg-black/25 px-5 text-[12px] font-medium text-white/80">
				<svg width="12" height="14" viewBox="0 0 814 1000" fill="currentColor" class="text-white/90" aria-hidden="true">
					<path d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.3-165-39.3c-76.5 0-103.7 40.8-165 40.8s-105-42.7-147.8-103.6c-49-68.9-90.6-176.5-90.6-279C0 469.8 166.4 265 348.6 265 407.5 265 458 304.5 490 304.5c29.8 0 88.8-44.5 163.7-44.5 26.6 0 108.2 2.6 168.6 74.9zm-237.6-74.9c31.8-37.7 54.6-90.1 54.6-142.5 0-7.1-.6-14.3-1.9-20.1-51.9 2-112.3 34.8-149.1 75.5-29.2 32.6-55.1 84.4-55.1 139.8 0 7.7 1.3 15.5 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 46.5 0 102.3-31.2 136-72.1z" />
				</svg>
				<span class="font-semibold text-white/95">Solus</span>
				<span class="flex gap-5 max-xl:hidden" aria-hidden="true">
					<span>File</span><span>Edit</span><span>View</span><span>Window</span><span>Help</span>
				</span>
				<div class="ml-auto flex items-center gap-4">
					<button
						type="button"
						onclick={resetDemo}
						disabled={!iframeSrc}
						class="flex h-6 cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-2 text-[11.5px] font-medium text-white/65 transition-colors duration-150 hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
					>
						<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
							<path d="M3 3v5h5" />
						</svg>
						Reset demo
					</button>
					<span class="tabular-nums">{menuBarDate}&ensp;9:41 AM</span>
				</div>
			</div>

			<!-- Desktop surface -->
			<div class="relative px-10 pt-7 pb-11">
				<div class="overflow-hidden rounded-xl bg-[#E8E4DA] shadow-[0_0_0_0.5px_rgba(0,0,0,0.4),0_1px_0_rgba(255,255,255,0.25)_inset,0_12px_28px_-8px_rgba(0,0,0,0.5),0_40px_90px_-18px_rgba(0,0,0,0.55)]">
					<div class="relative flex h-9 items-center border-b border-black/[0.06] bg-[#F0EDE5] px-4">
						<div class="flex items-center gap-2" aria-hidden="true">
							<span class="size-2.5 rounded-full bg-[#E46B5D] shadow-[0_0_0_0.5px_rgba(0,0,0,0.12)_inset]"></span>
							<span class="size-2.5 rounded-full bg-[#E2B34E] shadow-[0_0_0_0.5px_rgba(0,0,0,0.12)_inset]"></span>
							<span class="size-2.5 rounded-full bg-[#68B36B] shadow-[0_0_0_0.5px_rgba(0,0,0,0.12)_inset]"></span>
						</div>
						<div class="pointer-events-none absolute left-1/2 -translate-x-1/2 text-[12px] font-medium text-[#6B6158]">
							Solus — acme
						</div>
					</div>

					<div class="relative aspect-[16/10] overflow-hidden bg-[#1A1714]" bind:clientWidth={stageWidth}>
						{#if iframeSrc}
							<iframe
								bind:this={iframeElement}
								src={iframeSrc}
								title="Interactive Solus demo"
								class="size-full border-0 bg-[#1A1714]"
							></iframe>
						{/if}

						<!-- Seamless poster: the demo's real end state, crossfading into the live demo -->
						<div
							aria-hidden={isReady}
							class="pointer-events-none absolute inset-0 bg-[#F9F8F5] bg-cover bg-center transition-[opacity,visibility] duration-500 {isReady ? 'invisible opacity-0' : 'visible opacity-100'}"
							style="background-image: url('/demo-poster.webp'), linear-gradient(145deg, #39332d 0%, #26221e 52%, #161412 100%);"
						></div>
					</div>
				</div>
			</div>
		</div>
	</div>

	<div class="lg:hidden">
		<div
			class="relative aspect-[16/10] overflow-hidden rounded-2xl bg-[#25221E] bg-cover bg-center shadow-[0_0_0_1px_rgba(0,0,0,0.09),0_2px_5px_rgba(26,23,20,0.08),0_18px_50px_rgba(26,23,20,0.12)]"
			style="background-image: linear-gradient(rgba(26,23,20,0.35), rgba(26,23,20,0.6)), url('/demo-poster.webp'), linear-gradient(145deg, #39332d 0%, #26221e 52%, #161412 100%);"
		>
			<div class="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-[radial-gradient(circle_at_50%_40%,rgba(212,175,106,0.16),transparent_45%)] px-6 text-center">
				<div class="font-[family-name:var(--font-display)] text-[20px] font-semibold tracking-[-0.03em] text-white/90">
					Solus
				</div>
				<a
					href="/api/download"
					download="Solus-latest-arm64.dmg"
					class="flex min-h-11 items-center rounded-full bg-white/95 px-5 text-[13px] font-semibold text-[#1A1714] no-underline shadow-[0_0_0_1px_rgba(255,255,255,0.15),0_8px_28px_rgba(0,0,0,0.24)] transition-[scale,box-shadow,background-color] duration-150 hover:bg-white hover:shadow-[0_0_0_1px_rgba(255,255,255,0.15),0_10px_34px_rgba(0,0,0,0.3)] active:scale-[0.96]"
				>
					Download for macOS
				</a>
			</div>
		</div>
	</div>
</div>
