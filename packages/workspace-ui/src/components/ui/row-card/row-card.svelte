<script lang="ts">
  /** A card of rows, as Settings draws it: a soft border, the page background,
   *  and a hairline between one row and the next, inset sixteen pixels to the
   *  rows' text column. Each child is one row and brings its own padding. */
  import type { Snippet } from "svelte";

  let { children }: { children: Snippet } = $props();
</script>

<div
  class="overflow-hidden rounded-xl border border-border/50 bg-background text-foreground [&>*+*]:relative [&>*+*]:before:absolute [&>*+*]:before:inset-x-4 [&>*+*]:before:top-0 [&>*+*]:before:h-px [&>*+*]:before:bg-border/40"
>
  {@render children()}
</div>
