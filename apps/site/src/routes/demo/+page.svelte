<script lang="ts">
	import DemoSection from "$lib/DemoSection.svelte";
	import { downloadApp } from "$lib/download";
</script>

<svelte:head>
	<title>Live demo · Solus</title>
	<meta
		name="description"
		content="A live, interactive replay of the Solus workspace: an agent takes a task from plan to permission to review, and you can take the controls at any point."
	/>
</svelte:head>

<section class="site-container flex flex-col gap-4 pt-16 pb-10 sm:pt-20">
	<span class="text-[14px] font-medium text-brand">Live demo</span>
	<h1 class="display max-w-[20ch] text-[clamp(32px,4.4vw,52px)]">The workspace, running in your browser.</h1>
	<p class="max-w-[56ch] text-[17px] leading-[1.65] text-ink-2 text-pretty">
		This is the real Solus client with a recorded session. Watch an agent take a task from plan to permission to review, then click in to take the controls yourself.
	</p>
	<p class="text-[14px] text-ink-3 lg:hidden">The interactive replay needs a desktop-sized window. On a phone it shows the finished workspace.</p>
</section>

<div class="mx-auto w-full max-w-[1360px] px-4 pb-24 sm:px-6 lg:px-10 lg:pb-32">
	<DemoSection />
	<div class="mt-12 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
		<button type="button" onclick={downloadApp} class="btn btn-primary">Download for macOS</button>
		<a href="/" class="btn btn-ghost">Back to the overview</a>
	</div>
</div>
