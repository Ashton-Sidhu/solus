<script lang="ts">
  import { Skeleton } from "../ui/skeleton";

  // Stands in for DiagramShell while its chunk (xyflow, the node/edge registry,
  // the layout engine) loads. It draws the shell's own chrome for real — the
  // control strip, the inset board with its dot grid, the floating canvas bar —
  // and ghosts only what the document decides: the graph itself. So the swap is
  // a fade inside the board rather than a whole surface appearing.

  // Fixed positions, in board percentages: a small left-to-right graph, the
  // shape most diagrams open on. Never randomised — the placeholder must not
  // reshuffle if it re-renders while the chunk is still in flight.
  const NODES = [
    { x: 6, y: 36, w: 21, h: 17, lines: [62, 84] },
    { x: 39, y: 11, w: 23, h: 19, lines: [54, 88] },
    { x: 39, y: 60, w: 23, h: 19, lines: [70, 80] },
    { x: 73, y: 36, w: 21, h: 17, lines: [58, 86] },
  ];
  // Drawn between the same anchors, mid-side to mid-side, as the real edges.
  const EDGES = [
    "M 27 44.5 C 33 44.5, 33 20.5, 39 20.5",
    "M 27 44.5 C 33 44.5, 33 69.5, 39 69.5",
    "M 62 20.5 C 68 20.5, 67 44.5, 73 44.5",
    "M 62 69.5 C 68 69.5, 67 44.5, 73 44.5",
  ];
</script>

<div class="flex h-full flex-col bg-(--solus-container-bg)" role="status" aria-label="Loading diagram">
  <!-- The de-chromed control strip, at the real one's height, gap and insets —
       centred in the chrome row so its ghosts land on the same optical line as
       the pane's floating chrome cluster. One ghost per control the strip opens
       with — Copy, the ⋯ menu, the Ask Solus button. The save status is not one
       of them: nothing has saved yet, so the real strip is empty there. -->
  <div
    class="flex h-(--solus-chrome-row-h,2.5rem) shrink-0 items-center gap-1.5"
    style="padding-left:max(1rem, var(--solus-chrome-lead-inset, 0px));padding-right:max(1rem, var(--solus-pane-chrome-inset, 0px))"
    aria-hidden="true"
  >
    <div class="min-w-2 flex-auto"></div>
    <Skeleton class="h-6 w-[2.75rem] rounded-[0.375rem]" />
    <Skeleton class="size-6 rounded-[0.375rem]" />
    <Skeleton class="mr-0.5 ml-1 h-6 w-[6.75rem] rounded-[0.4375rem]" />
  </div>

  <div class="min-h-0 flex-1 p-3">
    <!-- The board is real chrome: same inset, radius, hairline and dot grid as
         the canvas that replaces it, so only its contents change. -->
    <div class="diagram-skeleton-board relative h-full overflow-hidden rounded-2xl border border-(--solus-container-border)">
      <svg class="diagram-skeleton-edges" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {#each EDGES as d, i (i)}
          <path {d} vector-effect="non-scaling-stroke" />
        {/each}
      </svg>

      {#each NODES as node, i (i)}
        <div
          class="diagram-skeleton-node absolute flex flex-col justify-center gap-1.5 rounded-[0.625rem] border border-(--solus-tool-border) bg-(--solus-container-bg) px-3"
          style="left:{node.x}%;top:{node.y}%;width:{node.w}%;height:{node.h}%;animation-delay:{i * 80}ms"
          aria-hidden="true"
        >
          <Skeleton
            class="h-2 rounded-full"
            style="width:{node.lines[0]}%;animation-delay:{i * 110}ms"
          />
          <Skeleton
            class="h-1.5 rounded-full opacity-65"
            style="width:{node.lines[1]}%;animation-delay:{i * 110 + 70}ms"
          />
        </div>
      {/each}

      <!-- The canvas bar floats bottom-centre, where the real toolbar sits. -->
      <div
        class="diagram-skeleton-toolbar absolute bottom-[0.9375rem] left-1/2 flex -translate-x-1/2 items-center gap-0.75 rounded-[0.6875rem] border border-(--solus-container-border) bg-(--solus-container-bg) p-[0.3125rem]"
        aria-hidden="true"
      >
        {#each [0, 1, 2, 3, 4, 5] as i (i)}
          <Skeleton class="size-7 rounded-[0.4375rem]" style="animation-delay:{i * 60}ms" />
        {/each}
      </div>
    </div>
  </div>
</div>

<style>
  /* The same dot grid the real Background paints (22px gap, 1.4px dots), so the
     board reads as the canvas from the first frame. */
  .diagram-skeleton-board {
    background-color: var(--solus-container-bg);
    background-image: radial-gradient(circle, rgba(42, 38, 24, 0.1) 0.7px, transparent 0.7px);
    background-size: 1.375rem 1.375rem;
  }
  :global(.dark) .diagram-skeleton-board {
    background-image: radial-gradient(circle, rgba(255, 255, 255, 0.08) 0.7px, transparent 0.7px);
  }

  .diagram-skeleton-edges {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  .diagram-skeleton-edges path {
    fill: none;
    stroke: var(--diagram-edge-stroke, #c3b7a6);
    stroke-width: 0.09375rem;
    opacity: 0.5;
  }
  :global(.dark) .diagram-skeleton-edges path {
    stroke: rgba(255, 255, 255, 0.2);
  }

  .diagram-skeleton-node {
    box-shadow: 0 0.0625rem 0.125rem rgba(60, 40, 25, 0.05);
    animation: diagram-skeleton-in var(--duration-modal, 260ms) var(--ease-premium) backwards;
  }
  .diagram-skeleton-toolbar {
    box-shadow: 0 0.5rem 1.625rem -0.5rem rgba(60, 40, 25, 0.24);
  }

  @keyframes diagram-skeleton-in {
    from {
      opacity: 0;
      transform: translateY(0.25rem);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .diagram-skeleton-node {
      animation: none;
    }
  }
</style>
