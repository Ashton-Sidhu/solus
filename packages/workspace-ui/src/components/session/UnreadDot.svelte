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
  A filled disc. The status glyphs are silhouettes because each has to say
  *which* thing it wants; unread has only one thing to say, so it spends a shape
  with no interior detail and lets colour do the work — and a disc satisfies that
  better than the ring this used to be, because at 6px a 1.25px stroke leaves
  under half the mark's area inked. That was survivable while every title around
  it sat at full ink; once the list started muting rows that are not being read,
  it was the smallest thing on the row being asked to carry the loudest state.
  The colour is unchanged: it is already tuned to the lightest blue that clears
  3:1 over the hovered sidebar, and brighter reads as a smudge.

  It sits in the same margin column as the glyphs, and like them it is exempt
  from the list's focus falloff — the whole point is that it holds at full
  contrast on a row that has otherwise stepped back, which is why the fill stays
  the mark's full colour rather than a mix.
-->
<span
  class="flex shrink-0 items-center justify-center"
  style:width="{size}px"
  style:height="{size}px"
  role="img"
  aria-label="Unread"
  transition:fade={{ duration: reduceMotion ? 0 : 120 }}
>
  <span class="block size-full rounded-full bg-(--solus-status-unread)"></span>
</span>
