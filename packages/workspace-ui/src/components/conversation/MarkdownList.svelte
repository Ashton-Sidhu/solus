<script lang="ts">
  import type { Snippet } from "svelte";

  /** A list in message markdown. `dir="auto"` takes the direction of the
   *  list's first letter, so the markers and the indent of a Hebrew or Arabic
   *  list go on the right. The text of each item takes its own direction from
   *  `unicode-bidi: plaintext` in the prose styles. */
  let { ordered = false, start = 1, children }: {
    ordered?: boolean;
    start?: number;
    children?: Snippet;
  } = $props();
</script>

{#if ordered}
  <ol {start} dir="auto">{@render children?.()}</ol>
{:else}
  <ul dir="auto">{@render children?.()}</ul>
{/if}
