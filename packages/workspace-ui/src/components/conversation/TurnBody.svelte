<script lang="ts">
  import type { Snippet } from "svelte";

  let { visible, children }: { visible: boolean; children: Snippet } = $props();
  let hasMounted = $state(false);

  // Historical turns start folded. Build their contents only when first shown,
  // then retain them so folding live work or reopening a turn preserves state.
  $effect(() => {
    if (visible) hasMounted = true;
  });
</script>

{#if visible || hasMounted}
  {@render children()}
{/if}
