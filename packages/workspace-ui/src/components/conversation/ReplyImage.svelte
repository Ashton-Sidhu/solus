<script lang="ts">
  import { replyImage } from "@solus/client-core/reply-images";
  import { isMarkdownVideo } from "./lib/markdown-image";
  import MarkdownImage from "./MarkdownImage.svelte";
  import MarkdownLink from "./MarkdownLink.svelte";

  let { href = "", title = undefined, text = "" }: { href?: string; title?: string; text?: string } = $props();
  const image = $derived(replyImage(href, text));
  const isVideo = $derived(isMarkdownVideo(href, null, null));
</script>

{#if isVideo}
  <MarkdownImage {href} {title} {text} expandable />
{:else}
  <MarkdownLink {href} title={title ?? href} text={image.label} fileChip>{image.label}</MarkdownLink>
{/if}
