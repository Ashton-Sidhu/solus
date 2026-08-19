<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { page } from '$app/state';

	let { children } = $props();

	const canonicalUrl = $derived.by(() => {
		const path = page.url.pathname === '/' ? '' : page.url.pathname.replace(/\/$/, '');
		return `https://solus.sh${path}`;
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<link rel="canonical" href={canonicalUrl} />
	<meta property="og:url" content={canonicalUrl} />
	<meta name="twitter:url" content={canonicalUrl} />
</svelte:head>

{@render children()}
