<script lang="ts">
  import { useSvelteFlow, useViewport } from "@xyflow/svelte";

  interface Props {
    /** Hands the flow instance to a host that lives outside the SvelteFlow
        provider and so cannot call the hook itself. */
    onFlowReady?: (flow: ReturnType<typeof useSvelteFlow>) => void;
  }

  let { onFlowReady }: Props = $props();

  const flow = useSvelteFlow();
  const viewport = useViewport();

  const zoomPct = $derived(Math.round(viewport.current.zoom * 100));

  $effect(() => {
    onFlowReady?.(flow);
  });
</script>

<!-- Zoom out, the read-out, zoom in, fit. Every canvas offers exactly these,
     whether or not it can be edited — the styling comes from the shared
     `.canvas-toolbar__*` chrome in DiagramShell.css. -->
<div class="canvas-toolbar__group">
  <button
    type="button"
    class="canvas-toolbar__btn"
    onclick={() => void flow.zoomOut({ duration: 150 })}
    title="Zoom out"
    aria-label="Zoom out"
  >
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 8h10" /></svg>
  </button>

  <button
    type="button"
    class="canvas-toolbar__zoom"
    onclick={() => void flow.setZoom(1, { duration: 150 })}
    title="Reset zoom to 100%"
    aria-label="Reset zoom to 100%, current zoom {zoomPct}%"
  >
    {zoomPct}%
  </button>

  <button
    type="button"
    class="canvas-toolbar__btn"
    onclick={() => void flow.zoomIn({ duration: 150 })}
    title="Zoom in"
    aria-label="Zoom in"
  >
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
  </button>

  <button
    type="button"
    class="canvas-toolbar__btn"
    onclick={() => void flow.fitView({ duration: 300, padding: 0.2 })}
    title="Fit to view"
    aria-label="Fit to view"
  >
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M2 5.5V2.5h3M14 5.5v-3h-3M2 10.5v3h3M14 10.5v3h-3" />
    </svg>
  </button>
</div>
