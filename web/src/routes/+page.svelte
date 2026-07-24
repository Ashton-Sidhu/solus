<script lang="ts">
	import { onMount } from "svelte";
	import DemoSection from "$lib/DemoSection.svelte";
	import WorkflowShowcase from "$lib/WorkflowShowcase.svelte";
	import CraftStrip from "$lib/CraftStrip.svelte";

	let mobileMenuOpen = $state(false);

	function downloadApp(e: MouseEvent) {
		e.preventDefault();
		const a = document.createElement("a");
		a.href = "/api/download";
		a.download = "Solus-latest-arm64.dmg";
		document.body.appendChild(a);
		a.click();
		a.remove();
	}

	function trackSpotlight(e: MouseEvent) {
		const card = e.currentTarget as HTMLElement;
		const rect = card.getBoundingClientRect();
		card.style.setProperty(
			"--mx",
			`${((e.clientX - rect.left) / rect.width) * 100}%`,
		);
		card.style.setProperty(
			"--my",
			`${((e.clientY - rect.top) / rect.height) * 100}%`,
		);
	}

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

		return () => {
			observer.disconnect();
		};
	});
</script>

<div class="grain" aria-hidden="true"></div>

<!-- Nav -->
<nav
	class="fixed top-5 max-[1400px]:top-8 inset-x-0 z-50 flex justify-center px-5 max-sm:px-4"
>
	<div
		class="flex items-center gap-8 max-sm:gap-3 px-5 max-sm:px-4 py-[11px] rounded-full w-full max-w-[640px]
	            bg-white/85 backdrop-blur-2xl
	            border border-black/[0.08]
	            shadow-[0_1px_0_rgba(0,0,0,0.05),0_4px_24px_rgba(0,0,0,0.08)]"
	>
		<a href="/" class="flex items-center gap-2 mr-auto no-underline">
			<svg
				width="20"
				height="20"
				viewBox="-60 -60 120 120"
				fill="none"
				aria-hidden="true"
			>
				<circle cx="0" cy="0" r="31.2" fill="#D4AF6A" />
				<g stroke="#D4AF6A" stroke-width="10.4" stroke-linecap="round">
					<path d="M 0,-52 A 52,52 0 0 1 52,0" />
					<path d="M 43.68,35.36 A 52,52 0 0 1 -16.64,49.92" />
					<path d="M -43.68,35.36 A 52,52 0 0 1 -52,-16.64" />
				</g>
			</svg>
			<span
				class="font-[family-name:var(--font-display)] text-[15px] font-bold tracking-[-0.03em] text-[#1A1714]"
				>Solus</span
			>
		</a>

		<a
			href="#workflow"
			class="nav-link text-[13px] text-[#6B6158] hover:text-[#1A1714] transition-colors no-underline whitespace-nowrap max-sm:hidden"
		>
			Workflow
		</a>
		<a
			href="#how-it-works"
			class="nav-link text-[13px] text-[#6B6158] hover:text-[#1A1714] transition-colors no-underline whitespace-nowrap max-sm:hidden"
		>
			How it works
		</a>
		<a
			href="/docs"
			class="nav-link text-[13px] text-[#6B6158] hover:text-[#1A1714] transition-colors no-underline whitespace-nowrap max-sm:hidden"
		>
			Docs
		</a>

		<button
			onclick={downloadApp}
			class="ml-auto text-[12px] font-semibold text-white whitespace-nowrap cursor-pointer
		          px-3.5 py-1.5 rounded-full max-sm:hidden border-none
		          transition-[transform,box-shadow] duration-150
		          hover:-translate-y-px active:scale-[0.98]"
			style="background: linear-gradient(145deg, #e08868 0%, #d97757 40%, #c96442 100%); box-shadow: 0 2px 8px rgba(217,119,87,0.3);"
		>
			Download
		</button>

		<!-- Mobile hamburger -->
		<button
			class="sm:hidden relative flex items-center justify-center size-9 rounded-full
			       text-[#6B6158] hover:text-[#1A1714] transition-colors ml-auto"
			onclick={() => (mobileMenuOpen = !mobileMenuOpen)}
			aria-label="Toggle menu"
			aria-expanded={mobileMenuOpen}
		>
			<span
				class="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
				aria-hidden="true"
			></span>
			{#if mobileMenuOpen}
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					><line x1="18" y1="6" x2="6" y2="18" /><line
						x1="6"
						y1="6"
						x2="18"
						y2="18"
					/></svg
				>
			{:else}
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					><line x1="4" y1="7" x2="20" y2="7" /><line
						x1="4"
						y1="12"
						x2="20"
						y2="12"
					/><line x1="4" y1="17" x2="20" y2="17" /></svg
				>
			{/if}
		</button>
	</div>
</nav>

<!-- Mobile menu panel -->
{#if mobileMenuOpen}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-40 sm:hidden"
		onkeydown={(e) => {
			if (e.key === "Escape") mobileMenuOpen = false;
		}}
	>
		<div
			class="absolute inset-0 bg-black/20 backdrop-blur-sm"
			onclick={() => (mobileMenuOpen = false)}
			role="presentation"
		></div>
		<div
			class="absolute top-20 inset-x-4 flex flex-col gap-1 p-3
			       bg-white/95 backdrop-blur-2xl rounded-2xl
			       border border-black/[0.08]
			       shadow-[0_8px_32px_rgba(0,0,0,0.12)]"
			style="animation: popup-in 0.2s cubic-bezier(0.16, 1, 0.3, 1)"
		>
			<a
				href="#workflow"
				class="px-4 py-3 text-[15px] text-[#1A1714] no-underline rounded-xl hover:bg-black/[0.04] transition-colors"
				onclick={() => (mobileMenuOpen = false)}>Workflow</a
			>
			<a
				href="#how-it-works"
				class="px-4 py-3 text-[15px] text-[#1A1714] no-underline rounded-xl hover:bg-black/[0.04] transition-colors"
				onclick={() => (mobileMenuOpen = false)}>How it works</a
			>
			<a
				href="/docs"
				class="px-4 py-3 text-[15px] text-[#1A1714] no-underline rounded-xl hover:bg-black/[0.04] transition-colors"
				onclick={() => (mobileMenuOpen = false)}>Docs</a
			>
			<div class="h-px bg-black/[0.06] mx-2 my-1"></div>
			<button
				onclick={(e) => {
					mobileMenuOpen = false;
					downloadApp(e);
				}}
				class="mx-2 mb-1 px-4 py-3 text-[14px] font-semibold text-white text-center rounded-xl cursor-pointer border-none
				       transition-[transform,box-shadow] duration-150 active:scale-[0.98]"
				style="background: linear-gradient(145deg, #e08868 0%, #d97757 40%, #c96442 100%); box-shadow: 0 2px 8px rgba(217,119,87,0.3);"
				>Download</button
			>
		</div>
	</div>
{/if}

<!-- Hero -->
<section class="hero v2">
	<!-- Quiet title block -->
	<div class="v2-text">
		<h1 class="v2-title">
			The best way<span class="v2-title-accent"
				>to ship with coding agents.</span
			>
		</h1>
		<p class="v2-sub">
			Plan, review, and ship agent work with Claude Code or Codex — without
			changing editors.
		</p>
		<div class="v2-cta-row">
			<button onclick={downloadApp} class="v2-cta-primary">
				<svg
					width="14"
					height="14"
					viewBox="0 0 814 1000"
					fill="currentColor"
					aria-hidden="true"
				>
					<path
						d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.3-165-39.3c-76.5 0-103.7 40.8-165 40.8s-105-42.7-147.8-103.6c-49-68.9-90.6-176.5-90.6-279C0 469.8 166.4 265 348.6 265 407.5 265 458 304.5 490 304.5c29.8 0 88.8-44.5 163.7-44.5 26.6 0 108.2 2.6 168.6 74.9zm-237.6-74.9c31.8-37.7 54.6-90.1 54.6-142.5 0-7.1-.6-14.3-1.9-20.1-51.9 2-112.3 34.8-149.1 75.5-29.2 32.6-55.1 84.4-55.1 139.8 0 7.7 1.3 15.5 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 46.5 0 102.3-31.2 136-72.1z"
					/>
				</svg>
				Download for macOS
			</button>
		</div>
		<ul class="v2-trust" aria-label="What Solus is">
			<li>Keyboard-first</li>
			<li>Model-agnostic — Claude Code &amp; Codex</li>
			<li>
				<a
					href="https://github.com/Ashton-Sidhu/solus"
					target="_blank"
					rel="noreferrer"
					class="relative inline-flex items-center gap-1.5 font-medium text-[#6B6158] no-underline transition-colors after:absolute after:-inset-x-2 after:-inset-y-3 hover:text-[#1A1714]"
				>
					<svg
						width="13"
						height="13"
						viewBox="0 0 24 24"
						fill="currentColor"
						aria-hidden="true"
					>
						<path
							d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.52-1.34-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.57-.29-5.27-1.28-5.27-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.16 1.18a10.98 10.98 0 0 1 5.75 0c2.2-1.49 3.16-1.18 3.16-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.71 5.39-5.29 5.68.42.36.79 1.06.79 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z"
						/>
					</svg>
					GitHub
				</a>
			</li>
		</ul>
	</div>

	<DemoSection />
</section>

<!-- The workflow — three acts -->
<section
	id="workflow"
	class="px-10 py-[160px] max-[1800px]:py-[110px] max-lg:px-6 max-lg:py-20"
>
	<div class="max-w-[1200px] mx-auto flex flex-col gap-20 max-lg:gap-14">
		<div class="flex flex-col gap-5">
			<div
				class="reveal font-[family-name:var(--font-mono)] text-[11px] font-semibold uppercase tracking-[0.12em] text-[#B08D3E]"
			>
				The workflow
			</div>
			<h2
				class="reveal reveal-d1 font-[family-name:var(--font-display)] text-[clamp(30px,3.8vw,52px)] max-[1440px]:text-[clamp(27px,3.4vw,52px)] font-semibold tracking-[-0.038em] leading-[1.1] max-w-[22ch] text-balance"
			>
				Delegate. Review. Ship.
				<em class="not-italic text-[#D4AF6A]">The loop you already run.</em>
			</h2>
			<p
				class="reveal reveal-d2 text-base/7 sm:text-[16px] max-[1440px]:sm:text-[15px] leading-[1.75] text-[#6B6158] max-w-[52ch] text-pretty"
			>
				Solus maps agent work onto the way software actually gets built — hand
				work off like you would to a teammate, gate it twice, land it clean.
			</p>
		</div>

		<WorkflowShowcase />
	</div>
</section>

<!-- How it works -->
<section
	id="how-it-works"
	class="px-10 py-[160px] max-[1800px]:py-[110px] border-t border-black/[0.07] max-lg:px-6 max-lg:py-20"
>
	<div class="max-w-[1200px] mx-auto flex flex-col gap-14">
		<div class="flex flex-col gap-5 max-w-[640px]">
			<div
				class="reveal font-[family-name:var(--font-mono)] text-[11px] font-semibold uppercase tracking-[0.12em] text-[#B08D3E]"
			>
				How it works
			</div>
			<h2
				class="reveal reveal-d1 font-[family-name:var(--font-display)] text-[clamp(30px,3.8vw,52px)] max-[1440px]:text-[clamp(27px,3.4vw,52px)] font-semibold tracking-[-0.038em] leading-[1.1] max-w-[22ch] text-balance"
			>
				Four chords.<br />
				<em class="not-italic text-[#D4AF6A]">No mouse required.</em>
			</h2>
			<p
				class="reveal reveal-d2 text-base/7 sm:text-[16px] max-[1440px]:sm:text-[15px] leading-[1.75] text-[#6B6158] max-w-[52ch] text-pretty"
			>
				Solus is keyboard-first. The whole flow — invoke, ask, review, dismiss —
				fits in four chords you'll never have to look up again.
			</p>
		</div>

		<div class="po-cheat reveal reveal-d2">
			<div class="po-cheat-card">
				<div class="po-cheat-chord">
					<kbd class="po-cheat-kbd">⌥</kbd>
					<span class="po-cheat-plus">+</span>
					<kbd class="po-cheat-kbd po-cheat-kbd-wide">Space</kbd>
				</div>
				<div class="po-cheat-body">
					<div class="po-cheat-num">01</div>
					<h3 class="po-cheat-title">Toggle</h3>
					<p class="po-cheat-desc">
						Bring Solus to front. From anywhere, in any app.
					</p>
				</div>
			</div>

			<div class="po-cheat-card">
				<div class="po-cheat-chord">
					<kbd class="po-cheat-kbd">⌥</kbd>
					<span class="po-cheat-plus">+</span>
					<kbd class="po-cheat-kbd">⇧</kbd>
					<span class="po-cheat-plus">+</span>
					<kbd class="po-cheat-kbd">T</kbd>
				</div>
				<div class="po-cheat-body">
					<div class="po-cheat-num">02</div>
					<h3 class="po-cheat-title">New tab</h3>
					<p class="po-cheat-desc">
						Spawn a fresh agent session. Work many threads at once.
					</p>
				</div>
			</div>

			<div class="po-cheat-card">
				<div class="po-cheat-chord">
					<kbd class="po-cheat-kbd">⌥</kbd>
					<span class="po-cheat-plus">+</span>
					<kbd class="po-cheat-kbd">⇧</kbd>
					<span class="po-cheat-plus">+</span>
					<kbd class="po-cheat-kbd">E</kbd>
				</div>
				<div class="po-cheat-body">
					<div class="po-cheat-num">03</div>
					<h3 class="po-cheat-title">Editor mode</h3>
					<p class="po-cheat-desc">
						Expand to plan view, diff review, or the full session.
					</p>
				</div>
			</div>

			<div class="po-cheat-card">
				<div class="po-cheat-chord">
					<kbd class="po-cheat-kbd po-cheat-kbd-wide">Esc</kbd>
				</div>
				<div class="po-cheat-body">
					<div class="po-cheat-num">04</div>
					<h3 class="po-cheat-title">Dismiss</h3>
					<p class="po-cheat-desc">
						Send Solus back. Editor takes over — exactly where you left off.
					</p>
				</div>
			</div>
		</div>

		<div class="po-cheat-meta reveal reveal-d3">
			<div class="po-cheat-meta-stat">
				<span class="po-cheat-meta-n">0.2s</span>
				<span class="po-cheat-meta-l">overlay → typing</span>
			</div>
			<div class="po-cheat-meta-sep" aria-hidden="true"></div>
			<div class="po-cheat-meta-stat">
				<span class="po-cheat-meta-n">3</span>
				<span class="po-cheat-meta-l">keystrokes per request</span>
			</div>
			<div class="po-cheat-meta-sep" aria-hidden="true"></div>
			<div class="po-cheat-meta-stat">
				<span class="po-cheat-meta-n">∞</span>
				<span class="po-cheat-meta-l">tabs in flight</span>
			</div>
		</div>
	</div>
</section>

<!-- Craft details -->
<CraftStrip />

<!-- CTA -->
<section
	class="relative overflow-hidden px-10 py-[180px] max-[1800px]:py-[130px] border-t border-black/[0.07] max-lg:px-6 max-lg:py-24"
>
	<div class="absolute inset-0 pointer-events-none" aria-hidden="true">
		<div
			class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[400px]"
			style="background: radial-gradient(ellipse, rgba(212,175,106,0.09) 0%, transparent 65%); filter: blur(60px);"
		></div>
		<svg
			class="absolute inset-0 w-full h-full"
			xmlns="http://www.w3.org/2000/svg"
		>
			<circle cx="12%" cy="20%" r="3" fill="#D4AF6A" opacity="0.12" />
			<circle cx="88%" cy="15%" r="5" fill="#D4AF6A" opacity="0.08" />
			<circle cx="5%" cy="70%" r="2" fill="#D4AF6A" opacity="0.10" />
			<circle cx="93%" cy="65%" r="4" fill="#D4AF6A" opacity="0.09" />
			<circle cx="22%" cy="85%" r="2.5" fill="#D4AF6A" opacity="0.08" />
			<circle cx="78%" cy="80%" r="3" fill="#D4AF6A" opacity="0.07" />
			<circle cx="50%" cy="8%" r="2" fill="#D4AF6A" opacity="0.10" />
			<circle cx="35%" cy="92%" r="1.5" fill="#D4AF6A" opacity="0.08" />
			<circle cx="65%" cy="90%" r="2.5" fill="#D4AF6A" opacity="0.06" />
		</svg>
	</div>
	<div class="max-w-[720px] mx-auto flex flex-col gap-7 relative">
		<div
			class="reveal flex items-center gap-2.5 font-[family-name:var(--font-mono)] text-[11px] font-semibold text-[#6B6158] uppercase tracking-[0.12em]"
		>
			<span
				class="w-[6px] h-[6px] rounded-full bg-[#D4AF6A] shrink-0"
				style="animation: breathe 2.4s ease-in-out infinite"
			></span>
			Available now
		</div>

		<h2
			class="reveal reveal-d1 font-[family-name:var(--font-display)] text-[clamp(36px,5vw,64px)] font-semibold tracking-[-0.045em] leading-[1] text-[#1A1714] max-w-[20ch] text-balance"
		>
			Run your agents the way you run your team.
		</h2>

		<p
			class="reveal reveal-d2 text-base/7 sm:text-[16px] max-[1440px]:sm:text-[15px] leading-[1.65] text-[#6B6158]"
		>
			Delegate, review, ship — built by engineers, for engineers..
		</p>

		<div class="reveal reveal-d3 flex flex-col gap-3 mt-1">
			<button onclick={downloadApp} class="v2-cta-primary self-start">
				<svg
					width="14"
					height="14"
					viewBox="0 0 814 1000"
					fill="currentColor"
					aria-hidden="true"
				>
					<path
						d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.3-165-39.3c-76.5 0-103.7 40.8-165 40.8s-105-42.7-147.8-103.6c-49-68.9-90.6-176.5-90.6-279C0 469.8 166.4 265 348.6 265 407.5 265 458 304.5 490 304.5c29.8 0 88.8-44.5 163.7-44.5 26.6 0 108.2 2.6 168.6 74.9zm-237.6-74.9c31.8-37.7 54.6-90.1 54.6-142.5 0-7.1-.6-14.3-1.9-20.1-51.9 2-112.3 34.8-149.1 75.5-29.2 32.6-55.1 84.4-55.1 139.8 0 7.7 1.3 15.5 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 46.5 0 102.3-31.2 136-72.1z"
					/>
				</svg>
				Download for macOS
			</button>
			<p class="text-[12px] text-[#6B6158]">
				Free during beta. macOS 13 Ventura or later.
			</p>
		</div>
	</div>
</section>

<!-- Footer -->
<footer class="border-t border-black/[0.07] px-10 py-7 max-sm:px-5 max-sm:py-8">
	<div
		class="max-w-[1200px] mx-auto flex items-center gap-6 max-sm:flex-col max-sm:items-start max-sm:gap-5"
	>
		<a href="/" class="flex items-center gap-1.5 no-underline">
			<svg
				width="16"
				height="16"
				viewBox="-60 -60 120 120"
				fill="none"
				aria-hidden="true"
			>
				<circle cx="0" cy="0" r="31.2" fill="#D4AF6A" />
				<g stroke="#D4AF6A" stroke-width="10.4" stroke-linecap="round">
					<path d="M 0,-52 A 52,52 0 0 1 52,0" />
					<path d="M 43.68,35.36 A 52,52 0 0 1 -16.64,49.92" />
					<path d="M -43.68,35.36 A 52,52 0 0 1 -52,-16.64" />
				</g>
			</svg>
			<span
				class="font-[family-name:var(--font-display)] text-[14px] font-bold tracking-[-0.02em] text-[#1A1714]"
				>Solus</span
			>
		</a>
		<div class="flex flex-wrap gap-5 max-sm:gap-3 sm:ml-auto sm:items-center">
			<a
				href="/docs"
				class="relative text-[14px] sm:text-[12px] text-[#A09488] no-underline hover:text-[#6B6158] transition-colors py-1"
				><span
					class="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
					aria-hidden="true"
				></span>Docs</a
			>
			<a
				href="/privacy"
				class="relative text-[14px] sm:text-[12px] text-[#A09488] no-underline hover:text-[#6B6158] transition-colors py-1"
				><span
					class="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
					aria-hidden="true"
				></span>Privacy</a
			>
			<a
				href="/terms"
				class="relative text-[14px] sm:text-[12px] text-[#A09488] no-underline hover:text-[#6B6158] transition-colors py-1"
				><span
					class="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
					aria-hidden="true"
				></span>Terms</a
			>
			<a
				href="https://x.com/ashtonasidhu"
				target="_blank"
				rel="noopener noreferrer"
				class="relative text-[14px] sm:text-[12px] text-[#A09488] no-underline hover:text-[#6B6158] transition-colors py-1"
				><span
					class="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
					aria-hidden="true"
				></span>X / Twitter</a
			>
		</div>
		<p
			class="text-[13px] sm:text-[12px] text-[#A09488] max-sm:order-first max-sm:hidden sm:ml-auto"
		>
			© 2026 Solus.
		</p>
		<p class="text-[13px] text-[#A09488] sm:hidden">© 2026 Solus.</p>
	</div>
</footer>
