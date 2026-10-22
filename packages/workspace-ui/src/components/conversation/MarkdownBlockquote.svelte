<script lang="ts">
  import type { Snippet } from "svelte";

  /** A quote in message markdown. `dir="auto"` takes the direction of the
   *  quote's first letter, so the rule and the indent of a Hebrew or Arabic
   *  quote go on the right. */
  let { children }: { children?: Snippet } = $props();
</script>

<blockquote dir="auto">{@render children?.()}</blockquote>
