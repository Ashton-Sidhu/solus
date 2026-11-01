<script lang="ts">
  import { ArrowLeft, ArrowRight } from "@lucide/svelte";
  import { getWorkspaceContext } from "../../contexts";
  import {
    HistorySwipe,
    swipeAreaBounds,
    swipeTargetAt,
    swipeWheelOf,
    type SwipeAreaBounds,
    type SwipeDirection,
    type SwipeIndicator,
    type SwipeStep,
  } from "./lib/history-swipe";

  // Two-finger horizontal trackpad swipes go back and forward. Desktop only:
  // a browser already swipes through its own history, which the web router
  // follows, so mounting this there would navigate twice.
  interface Props {
    onTrackpadScroll: (callback: (phase: "begin" | "end") => void) => () => void;
  }
  let { onTrackpadScroll }: Props = $props();

  const router = getWorkspaceContext().router;
  const canNavigate = (direction: SwipeDirection) =>
    direction === "back" ? router.canGoBack : router.canGoForward;

  /** The last indicator stays after the lift so it can fade out where it was. */
  let shown = $state<(SwipeIndicator & { bounds: SwipeAreaBounds; isTracking: boolean }) | null>(null);

  function apply(step: SwipeStep): void {
    if (step.navigate === "back") router.back();
    else if (step.navigate === "forward") router.forward();
    if (step.indicator) {
      const bounds = shown?.isTracking ? shown.bounds : swipeAreaBounds();
      shown = { ...step.indicator, bounds, isTracking: true };
    } else if (shown?.isTracking) {
      shown.isTracking = false;
    }
  }

  $effect(() => {
    const swipe = new HistorySwipe();
    const onWheel = (event: WheelEvent) =>
      apply(swipe.wheel(swipeWheelOf(event), () => swipeTargetAt(event.target, canNavigate)));
    const unsubscribe = onTrackpadScroll((phase) => {
      if (phase === "begin") swipe.scrollBegin();
      else apply(swipe.scrollEnd(performance.now()));
    });
    window.addEventListener("wheel", onWheel, { capture: true, passive: true });
    return () => {
      unsubscribe();
      window.removeEventListener("wheel", onWheel, { capture: true });
    };
  });
</script>

{#if shown}
  {@const isBack = shown.direction === "back"}
  <!-- A circle pinned to the edge of the main content that peeks in up to half
       its width. The arrow turns solid once a release would navigate. -->
  <div
    aria-hidden="true"
    class="pointer-events-none fixed z-50 overflow-hidden"
    style:left="{shown.bounds.left}px"
    style:top="{shown.bounds.top}px"
    style:width="{shown.bounds.width}px"
    style:height="{shown.bounds.height}px"
  >
    <div
      class="absolute flex size-14 items-center rounded-full border border-border bg-popover text-popover-foreground shadow-md dark:shadow-none {isBack
        ? 'left-0 justify-end pr-2'
        : 'right-0 justify-start pl-2'} {shown.isTracking
        ? ''
        : 'transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none'}"
      style:top="clamp(0px, calc({shown.clientY - shown.bounds.top}px - 1.75rem), calc(100% - 3.5rem))"
      style:opacity={shown.isTracking ? 1 : 0}
      style:transform="translateX({(isBack ? -1 : 1) * (100 - shown.progress * 50)}%)"
    >
      {#if isBack}
        <ArrowLeft size={16} class={shown.progress >= 1 ? "opacity-100" : "opacity-40"} />
      {:else}
        <ArrowRight size={16} class={shown.progress >= 1 ? "opacity-100" : "opacity-40"} />
      {/if}
    </div>
  </div>
{/if}
