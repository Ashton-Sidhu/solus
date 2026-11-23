<script lang="ts">
  import { prefersReducedMotion } from "svelte/motion";
  import { DOT_MARKS, type DotMarkName } from "@solus/client-core/dot-marks";
  import {
    DOT_MATRIX_BOX_PX,
    dotAnimationKeyframes,
    dotCellOffset,
    dotSizePx,
    planDotMarkSwitch,
  } from "./lib/dot-matrix";

  interface Props {
    /** The dot mark to show. The one on screen finishes its cycle first. */
    mark: DotMarkName;
    /** The box of the grid, in px. 13px is the box of the line glyphs. */
    size?: number;
    label?: string;
  }
  let { mark, size = DOT_MATRIX_BOX_PX, label }: Props = $props();

  // Written only by the switch below: the mark that the grid draws now.
  // svelte-ignore state_referenced_locally
  let shown = $state<DotMarkName>(mark);
  const definition = $derived(DOT_MARKS[shown]);

  // One timeout for each change, never a loop: the new mark waits for the
  // end of the cycle on screen, and a mark replaced inside that wait never
  // shows, because the timeout reads the newest `mark`.
  $effect(() => {
    const decision = planDotMarkSwitch({
      shown,
      requested: mark,
      shownDurationMs: DOT_MARKS[shown].durationMs,
      timelineMs: Number(document.timeline.currentTime ?? 0),
      reducedMotion: prefersReducedMotion.current,
    });
    if (decision.kind === "keep") return;
    if (decision.kind === "now") {
      shown = mark;
      return;
    }
    const timeout = setTimeout(() => {
      shown = mark;
    }, decision.delayMs);
    return () => clearTimeout(timeout);
  });

  /** Run one dot's keyframes from the timeline origin, so every copy of a
   *  mark is in phase however late its row mounted. */
  function animateDot(
    element: HTMLElement,
    dot: { keyframes: Keyframe[]; durationMs: number },
  ) {
    const animation = element.animate(dot.keyframes, {
      duration: dot.durationMs,
      iterations: Infinity,
    });
    animation.startTime = 0;
    return { destroy: () => animation.cancel() };
  }
</script>

<!-- Colour is `currentColor`: the parent sets it. Only `transform: scale`
     moves, so the compositor does the work. -->
<span
  class="relative inline-block shrink-0"
  style:width="{size}px"
  style:height="{size}px"
  role={label ? "img" : undefined}
  aria-label={label}
  aria-hidden={label ? undefined : "true"}
>
  {#key shown}
    {#each definition.dots as dot (dot.cell.join(","))}
      {#if prefersReducedMotion.current}
        <span
          class="absolute rounded-full bg-current"
          style:left="{dotCellOffset(dot.cell[1], size)}px"
          style:top="{dotCellOffset(dot.cell[0], size)}px"
          style:width="{dotSizePx(size)}px"
          style:height="{dotSizePx(size)}px"
          style:transform="scale({definition.stillScale})"
        ></span>
      {:else}
        <span
          class="absolute rounded-full bg-current"
          style:left="{dotCellOffset(dot.cell[1], size)}px"
          style:top="{dotCellOffset(dot.cell[0], size)}px"
          style:width="{dotSizePx(size)}px"
          style:height="{dotSizePx(size)}px"
          use:animateDot={{ keyframes: dotAnimationKeyframes(dot.keyframes), durationMs: definition.durationMs }}
        ></span>
      {/if}
    {/each}
  {/key}
</span>
