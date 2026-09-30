<script lang="ts">
  import { fade } from "svelte/transition";

  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  interface Props {
    /** 13px in the sidebar's margin, 12px on a session row — the same box as
     *  the status glyphs beside it, so the column stays aligned. */
    size?: number;
  }
  let { size = 13 }: Props = $props();
</script>

<!--
  A dashed ring for finished work you have not read yet. Finished work wants
  you, so it takes terracotta like the other marks that want you; the broken
  outline separates it from the solid glyphs of a question or a plan.

  It sits in the same margin column as the glyphs, and like them it is exempt
  from the list's focus falloff, so it holds at full contrast on a row that has
  otherwise stepped back.
-->
<span
  class="flex shrink-0 items-center justify-center text-(--primary)"
  style:width="{size}px"
  style:height="{size}px"
  role="img"
  aria-label="Unread"
  transition:fade={{ duration: reduceMotion ? 0 : 120 }}
>
  <svg viewBox="0 0 16 16" class="size-full" fill="none" aria-hidden="true">
    <circle
      cx="8"
      cy="8"
      r="6"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      pathLength="24"
      stroke-dasharray="1.6 1.4"
    />
  </svg>
</span>
