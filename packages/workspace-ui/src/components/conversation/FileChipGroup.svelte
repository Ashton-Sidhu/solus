<script lang="ts">
  import type { Snippet } from "svelte";

  /** A file chip and the punctuation after it, kept on one line. */
  let { children }: { children?: Snippet } = $props();
</script>

<span class="whitespace-nowrap">{@render children?.()}</span>
