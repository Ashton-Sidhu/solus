<script lang="ts">
  import { fade } from "svelte/transition";

  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  interface Props {
    /** 7px in the sidebar's margin, 6px on a session row. Contrast alone does
     *  not carry a mark this small — the ratios are measured against a target
     *  big enough to register in peripheral vision, so the two travel together
     *  and shrinking this undoes the colour work. */
    size?: number;
  }
  let { size = 7 }: Props = $props();
</script>

<!--
  A solid dot, not an outline mark. The status glyphs are silhouettes because
  each has to say *which* thing it wants; unread has only one thing to say, so
  it spends a shape with no interior to read and lets colour do the work. It
  sits in the same margin column as the glyphs, and like them it is exempt from
  the list's focus falloff — the whole point is that it holds at full contrast
  on a row that has otherwise stepped back.
-->
<span
  class="flex shrink-0 items-center justify-center"
  style:width="{size}px"
  style:height="{size}px"
  role="img"
  aria-label="Unread"
  transition:fade={{ duration: reduceMotion ? 0 : 120 }}
>
  <span
    class="block size-full rounded-full bg-(--solus-status-unread)"
  ></span>
</span>
