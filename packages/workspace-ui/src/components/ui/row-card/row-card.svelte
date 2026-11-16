<script lang="ts">
  /** A card of rows, as Settings draws it: a border and a soft shadow that lift
   *  it off the page (a raised surface instead in dark mode), and a hairline
   *  between one row and the next, inset sixteen pixels to the
   *  rows' text column. Each child is one row and brings its own padding. */
  import type { Snippet } from "svelte";

  let { children }: { children: Snippet } = $props();
</script>

<div
  class="overflow-hidden rounded-xl border border-border bg-background shadow-[0_1px_2px_rgb(0_0_0/0.04),0_4px_12px_-6px_rgb(0_0_0/0.08)] dark:bg-card dark:shadow-none text-foreground [&>*+*]:relative [&>*+*]:before:absolute [&>*+*]:before:inset-x-4 [&>*+*]:before:top-0 [&>*+*]:before:h-px [&>*+*]:before:bg-border/70"
>
  {@render children()}
</div>
