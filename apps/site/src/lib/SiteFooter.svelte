<script lang="ts">
	import SolusMark from "./SolusMark.svelte";
	import { DOWNLOADS } from "./download";

	const columns = [
		{
			title: "Product",
			links: [
				...Object.values(DOWNLOADS).map((build) => ({ href: build.path, label: `Download for ${build.name}`, download: build.filename })),
				{ href: "https://github.com/Ashton-Sidhu/solus/releases/latest", label: "Server for Linux", external: true },
				{ href: "/#cloud", label: "Solus Cloud" },
				{ href: "/#data", label: "Integrations" },
				{ href: "/#workflow", label: "Workflow" },
				{ href: "/#observability", label: "Observability" },
				{ href: "/demo", label: "Live demo" },
			],
		},
		{
			title: "Resources",
			links: [
				{ href: "/docs", label: "Documentation" },
				{ href: "/#faq", label: "FAQ" },
				{ href: "https://github.com/Ashton-Sidhu/solus", label: "GitHub", external: true },
				{ href: "https://app.solus.sh/sign-in", label: "Sign in", external: true },
			],
		},
		{
			title: "Company",
			links: [
				{ href: "https://x.com/ashtonasidhu", label: "X / Twitter", external: true },
				{ href: "/privacy", label: "Privacy" },
				{ href: "/terms", label: "Terms" },
			],
		},
	];
</script>

<footer class="border-t border-line bg-surface">
	<div class="site-container grid gap-12 py-16 md:grid-cols-[1.4fr_repeat(3,1fr)] md:gap-8">
		<div class="flex flex-col gap-4">
			<a href="/" class="flex items-center gap-2 no-underline" aria-label="Solus home">
				<SolusMark />
				<span class="font-[family-name:var(--font-display)] text-[17px] font-bold tracking-[-0.03em] text-ink">Solus</span>
			</a>
			<p class="max-w-[30ch] text-[14px] leading-relaxed text-ink-2">
				One workspace for your agents, your data, and your team, on your machines or in the cloud.
			</p>
		</div>

		{#each columns as column (column.title)}
			<div class="flex flex-col gap-3">
				<div class="text-[13px] font-semibold text-ink">{column.title}</div>
				<ul class="flex list-none flex-col gap-2.5 p-0">
					{#each column.links as link (link.label)}
						<li>
							<a
								href={link.href}
								download={"download" in link ? link.download : undefined}
								target={"external" in link && link.external ? "_blank" : undefined}
								rel={"external" in link && link.external ? "noopener noreferrer" : undefined}
								class="text-[14px] text-ink-2 no-underline transition-colors hover:text-ink"
							>
								{link.label}
							</a>
						</li>
					{/each}
				</ul>
			</div>
		{/each}
	</div>
	<div class="border-t border-line">
		<div class="site-container flex flex-col gap-2 py-6 text-[13px] text-ink-3 sm:flex-row sm:items-center sm:justify-between">
			<span>© 2026 Solus. Free and source-available.</span>
			<span>Built for macOS, the browser, and your phone.</span>
		</div>
	</div>
</footer>
