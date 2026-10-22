<script lang="ts">
	// A real capture of the workspace. Desktop captures are 1440px wide; a phone
	// column gets a crop of the one thing the caption is about, at a readable size.
	let {
		slug,
		alt,
		width,
		height,
		priority = false,
		imgClass = "",
	}: { slug: string; alt: string; width: number; height: number; priority?: boolean; imgClass?: string } = $props();
</script>

<picture>
	<source media="(max-width: 700px)" srcset="/workflow/{slug}-mobile.avif" type="image/avif" />
	<source media="(max-width: 700px)" srcset="/workflow/{slug}-mobile.jpg" type="image/jpeg" />
	<source srcset="/workflow/{slug}.avif" type="image/avif" />
	<img
		src="/workflow/{slug}.jpg"
		{alt}
		{width}
		{height}
		loading={priority ? "eager" : "lazy"}
		decoding="async"
		class="shot max-[700px]:aspect-auto {imgClass}"
	/>
</picture>
