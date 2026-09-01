<script lang="ts">
	let { children } = $props();
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
</script>

<div class="grain" aria-hidden="true"></div>

<nav class="fixed top-5 inset-x-0 z-50 flex justify-center px-5 max-sm:px-4">
	<div
		class="flex items-center gap-8 max-sm:gap-3 px-5 max-sm:px-4 py-[11px] rounded-full w-full max-w-[640px]
		        bg-white/85 backdrop-blur-2xl
		        border border-black/[0.08]
		        shadow-[0_1px_0_rgba(0,0,0,0.05),0_4px_24px_rgba(0,0,0,0.08)]"
	>
		<a href="/" class="flex items-center gap-2 mr-auto no-underline">
			<svg width="20" height="20" viewBox="-60 -60 120 120" fill="none" aria-hidden="true">
				<circle cx="0" cy="0" r="31.2" fill="#D4AF6A" />
				<g stroke="#D4AF6A" stroke-width="10.4" stroke-linecap="round">
					<path d="M 0,-52 A 52,52 0 0 1 52,0" />
					<path d="M 43.68,35.36 A 52,52 0 0 1 -16.64,49.92" />
					<path d="M -43.68,35.36 A 52,52 0 0 1 -52,-16.64" />
				</g>
			</svg>
			<span class="font-[family-name:var(--font-display)] text-[15px] font-bold tracking-[-0.03em] text-[#1A1714]">Solus</span>
		</a>
		<a href="/#how-it-works" class="nav-link text-[13px] text-[#6B6158] hover:text-[#1A1714] transition-colors no-underline whitespace-nowrap max-sm:hidden">How it works</a>
		<a href="/#features" class="nav-link text-[13px] text-[#6B6158] hover:text-[#1A1714] transition-colors no-underline whitespace-nowrap max-sm:hidden">Features</a>
		<a href="/docs" class="nav-link text-[13px] text-[#1A1714] font-medium no-underline whitespace-nowrap max-sm:hidden">Docs</a>
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
			onclick={() => mobileMenuOpen = !mobileMenuOpen}
			aria-label="Toggle menu"
			aria-expanded={mobileMenuOpen}
		>
			<span class="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden" aria-hidden="true"></span>
			{#if mobileMenuOpen}
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
			{:else}
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>
			{/if}
		</button>
	</div>
</nav>

<!-- Mobile menu panel -->
{#if mobileMenuOpen}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-40 sm:hidden"
		onkeydown={(e) => { if (e.key === 'Escape') mobileMenuOpen = false; }}
	>
		<div
			class="absolute inset-0 bg-black/20 backdrop-blur-sm"
			onclick={() => mobileMenuOpen = false}
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
				href="/#how-it-works"
				class="px-4 py-3 text-[15px] text-[#1A1714] no-underline rounded-xl hover:bg-black/[0.04] transition-colors"
				onclick={() => mobileMenuOpen = false}
			>How it works</a>
			<a
				href="/#features"
				class="px-4 py-3 text-[15px] text-[#1A1714] no-underline rounded-xl hover:bg-black/[0.04] transition-colors"
				onclick={() => mobileMenuOpen = false}
			>Features</a>
			<a
				href="/docs"
				class="px-4 py-3 text-[15px] text-[#1A1714] font-medium no-underline rounded-xl hover:bg-black/[0.04] transition-colors"
				onclick={() => mobileMenuOpen = false}
			>Docs</a>
			<div class="h-px bg-black/[0.06] mx-2 my-1"></div>
			<button
				onclick={(e) => { mobileMenuOpen = false; downloadApp(e); }}
				class="mx-2 mb-1 px-4 py-3 text-[14px] font-semibold text-white text-center rounded-xl cursor-pointer border-none
				       transition-[transform,box-shadow] duration-150 active:scale-[0.98]"
				style="background: linear-gradient(145deg, #e08868 0%, #d97757 40%, #c96442 100%); box-shadow: 0 2px 8px rgba(217,119,87,0.3);"
			>Download</button>
		</div>
	</div>
{/if}

{@render children()}

<footer class="border-t border-black/[0.07] px-10 py-7 max-sm:px-5 max-sm:py-8">
	<div class="max-w-[1200px] mx-auto flex items-center gap-6 max-sm:flex-col max-sm:items-start max-sm:gap-5">
		<a href="/" class="flex items-center gap-1.5 no-underline">
			<svg width="16" height="16" viewBox="-60 -60 120 120" fill="none" aria-hidden="true">
				<circle cx="0" cy="0" r="31.2" fill="#D4AF6A" />
				<g stroke="#D4AF6A" stroke-width="10.4" stroke-linecap="round">
					<path d="M 0,-52 A 52,52 0 0 1 52,0" />
					<path d="M 43.68,35.36 A 52,52 0 0 1 -16.64,49.92" />
					<path d="M -43.68,35.36 A 52,52 0 0 1 -52,-16.64" />
				</g>
			</svg>
			<span class="font-[family-name:var(--font-display)] text-[14px] font-bold tracking-[-0.02em] text-[#1A1714]">Solus</span>
		</a>
		<div class="flex flex-wrap gap-5 max-sm:gap-3 sm:ml-auto sm:items-center">
			<a href="/docs" class="relative text-[14px] sm:text-[12px] text-[#A09488] no-underline hover:text-[#6B6158] transition-colors py-1"><span class="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden" aria-hidden="true"></span>Docs</a>
			<a href="/privacy" class="relative text-[14px] sm:text-[12px] text-[#A09488] no-underline hover:text-[#6B6158] transition-colors py-1"><span class="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden" aria-hidden="true"></span>Privacy</a>
			<a href="/terms" class="relative text-[14px] sm:text-[12px] text-[#A09488] no-underline hover:text-[#6B6158] transition-colors py-1"><span class="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden" aria-hidden="true"></span>Terms</a>
		</div>
		<p class="text-[13px] sm:text-[12px] text-[#A09488] max-sm:hidden sm:ml-auto">© 2026 Solus.</p>
		<p class="text-[13px] text-[#A09488] sm:hidden">© 2026 Solus.</p>
	</div>
</footer>
