<script lang="ts">
	import { onMount } from "svelte";
	import { afterNavigate } from "$app/navigation";
	import SolusMark from "./SolusMark.svelte";
	import DownloadButton from "./DownloadButton.svelte";

	const links = [
		{ href: "/#cloud", label: "Cloud" },
		{ href: "/#data", label: "Data" },
		{ href: "/#workflow", label: "Workflow" },
		{ href: "/#observability", label: "Observability" },
		{ href: "/demo", label: "Demo" },
		{ href: "/docs", label: "Docs" },
	];

	let menuOpen = $state(false);
	let scrolled = $state(false);

	afterNavigate(() => (menuOpen = false));

	onMount(() => {
		const update = () => (scrolled = window.scrollY > 8);
		update();
		window.addEventListener("scroll", update, { passive: true });
		return () => window.removeEventListener("scroll", update);
	});
</script>

<header
	class="sticky top-0 z-50 border-b transition-[background-color,border-color] duration-200
	       {scrolled || menuOpen
		? 'border-line bg-bg/85 backdrop-blur-xl'
		: 'border-transparent bg-bg/0'}"
>
	<div class="site-container flex h-16 items-center gap-8">
		<a href="/" class="flex items-center gap-2 no-underline" aria-label="Solus home">
			<SolusMark />
			<span class="font-[family-name:var(--font-display)] text-[17px] font-bold tracking-[-0.03em] text-ink">Solus</span>
		</a>

		<nav class="hidden items-center gap-7 md:flex" aria-label="Primary">
			{#each links as link (link.href)}
				<a
					href={link.href}
					class="text-[14px] font-medium text-ink-2 no-underline transition-colors hover:text-ink"
				>
					{link.label}
				</a>
			{/each}
		</nav>

		<div class="ml-auto hidden items-center gap-2 md:flex">
			<a href="https://app.solus.sh/sign-in" class="btn btn-sm btn-ghost">Sign in</a>
			<DownloadButton size="sm" compact />
		</div>

		<button
			type="button"
			class="ml-auto flex size-10 items-center justify-center rounded-lg text-ink-2 transition-colors hover:bg-ink/5 hover:text-ink md:hidden"
			onclick={() => (menuOpen = !menuOpen)}
			aria-label={menuOpen ? "Close menu" : "Open menu"}
			aria-expanded={menuOpen}
		>
			{#if menuOpen}
				<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
					<path d="M18 6 6 18M6 6l12 12" />
				</svg>
			{:else}
				<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
					<path d="M4 7h16M4 12h16M4 17h16" />
				</svg>
			{/if}
		</button>
	</div>

	{#if menuOpen}
		<div
			class="border-t border-line bg-bg md:hidden"
			style="animation: popup-in 180ms cubic-bezier(0.16, 1, 0.3, 1)"
		>
			<nav class="site-container flex flex-col py-3" aria-label="Primary">
				{#each links as link (link.href)}
					<a
						href={link.href}
						class="rounded-lg px-3 py-3 text-[16px] font-medium text-ink no-underline hover:bg-ink/5"
						onclick={() => (menuOpen = false)}
					>
						{link.label}
					</a>
				{/each}
				<a
					href="https://app.solus.sh/sign-in"
					class="rounded-lg px-3 py-3 text-[16px] font-medium text-ink no-underline hover:bg-ink/5"
					onclick={() => (menuOpen = false)}
				>
					Sign in
				</a>
				<div class="mt-2 mb-1"><DownloadButton /></div>
			</nav>
		</div>
	{/if}
</header>
