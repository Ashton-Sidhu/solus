<script lang="ts">
  import {
    getMarkdownImageContext,
    markdownImageUrl,
  } from "./lib/markdown-image";

  interface Props {
    href?: string;
    title?: string;
    text?: string;
  }

  let { href = "", title = undefined, text = "" }: Props = $props();
  const context = getMarkdownImageContext();
  const src = $derived(markdownImageUrl(href, context?.cwd()));
</script>

<img {src} {title} alt={text} loading="lazy" class="block h-auto max-w-full" />
