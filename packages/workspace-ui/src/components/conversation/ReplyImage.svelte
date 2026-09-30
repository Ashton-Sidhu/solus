<script lang="ts">
  import MarkdownImage from "./MarkdownImage.svelte";

  /** An image in an agent reply opens at full size on click. Other surfaces
   *  render `MarkdownImage` bare because their card owns the click. */
  let { href = "", title = undefined, text = "" }: { href?: string; title?: string; text?: string } = $props();
</script>

<MarkdownImage {href} {title} {text} expandable />
