<script lang="ts">
	import { onMount, type Snippet } from "svelte";
	import { BREW_COMMAND, DOWNLOADS, SERVER_COMMAND, SERVER_TARGETS, detectPlatform, type DownloadPlatform } from "./download";

	// The download call to action for the visitor's OS: the desktop app for
	// macOS, Windows, or Linux. The page is prerendered, so it shows macOS until
	// the browser reports the platform.
	let {
		size = "md",
		compact = false,
		showOthers = false,
		showBrew = false,
		showServer = false,
		class: className = "",
		secondary,
	}: {
		size?: "sm" | "md" | "lg";
		/** The nav's short form: one button that says only "Download". */
		compact?: boolean;
		/** A line under the button with download links for the other platforms. */
		showOthers?: boolean;
		/** A pill that copies the server install command for this OS. */
		showServer?: boolean;
		/** On macOS, a second button that copies the Homebrew command. */
		showBrew?: boolean;
		/** Alignment of the button and the lines under it, such as "items-start". */
		class?: string;
		/** A second button in the same row, such as "Open Solus Cloud". */
		secondary?: Snippet;
	} = $props();

	let platform = $state<DownloadPlatform>("mac");
	let copied = $state<"server" | "brew" | null>(null);

	onMount(() => (platform = detectPlatform()));

	function copy(text: string, which: "server" | "brew") {
		navigator.clipboard.writeText(text);
		copied = which;
		setTimeout(() => (copied = null), 2000);
	}

	const sizeClass = $derived(size === "sm" ? "btn-sm" : size === "lg" ? "h-12 px-6 text-[16px]" : "");
	const others = $derived((Object.keys(DOWNLOADS) as DownloadPlatform[]).filter((other) => other !== platform));
</script>

{#snippet copyIcon()}
	<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
{/snippet}

{#snippet checkIcon()}
	<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
{/snippet}

<div class="flex flex-col gap-3 max-sm:w-full {className}">
	<div class="flex flex-wrap items-center gap-3 max-sm:w-full max-sm:flex-col">
		<a href={DOWNLOADS[platform].path} download={DOWNLOADS[platform].filename} class="btn btn-dark {sizeClass} max-sm:w-full">
			{compact ? "Download" : `Download for ${DOWNLOADS[platform].name}`}
			{#if !compact}
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v12M6 10l6 6 6-6M5 20h14" /></svg>
			{/if}
		</a>
		{#if showBrew && platform === "mac"}
			<button type="button" onclick={() => copy(BREW_COMMAND, "brew")} class="btn bg-raised text-ink hover:bg-brand-light {sizeClass} max-sm:w-full" aria-label="Copy the Homebrew install command">
				{#if copied === "brew"}{@render checkIcon()}Copied{:else}Copy Homebrew command{/if}
			</button>
		{/if}
		{#if secondary}{@render secondary()}{/if}
	</div>

	{#if showOthers}
		<span class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13.5px] text-ink-3">
			Also for
			{#each others as other (other)}
				<a href={DOWNLOADS[other].path} download={DOWNLOADS[other].filename} class="font-medium text-ink-2 underline decoration-line-strong underline-offset-4 hover:text-ink">
					{DOWNLOADS[other].name}
				</a>
			{/each}
			{#if showServer}
				<!-- The server install command for this OS: one click copies it. -->
				<button
					type="button"
					onclick={() => copy(SERVER_COMMAND, "server")}
					class="ml-1 inline-flex cursor-pointer items-center gap-2 rounded-full bg-surface py-1 pr-2.5 pl-3 font-mono text-[12.5px] text-ink-2 transition-colors hover:bg-[#e6e4dd] hover:text-ink"
					title="{SERVER_TARGETS[platform]}: {SERVER_COMMAND}"
					aria-label="Copy the server install command"
				>
					<span class="font-sans font-medium">Server</span>
					<span class="text-ink-3">$</span>curl -fsSL …/install.sh | sh
					{#if copied === "server"}{@render checkIcon()}{:else}{@render copyIcon()}{/if}
				</button>
			{/if}
		</span>

	{/if}
</div>
