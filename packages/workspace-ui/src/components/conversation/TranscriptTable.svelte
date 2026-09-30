<script lang="ts">
  import type { Snippet } from "svelte";

  /** A reply's table scrolls sideways in its own box, so a wide table never
   *  pushes past the prose column. */
  let { children }: { children?: Snippet } = $props();
</script>

<div class="transcript-table"><table>{@render children?.()}</table></div>
