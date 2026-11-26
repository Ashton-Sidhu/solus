<script lang="ts">
  import MarkdownImage from "./MarkdownImage.svelte";

  /** An image in an agent reply shows in place and opens at full size on
   *  click. The turn's gallery below the reply still lists it. Other surfaces
   *  render `MarkdownImage` bare because their card owns the click. */
  let { href = "", title = undefined, text = "" }: { href?: string; title?: string; text?: string } = $props();
</script>

<MarkdownImage {href} {title} {text} expandable />
