<script lang="ts">
  import { Minus as ZoomOutIcon, Plus as ZoomInIcon } from "@lucide/svelte";
  import { useSvelteFlow, useViewport } from "@xyflow/svelte";
  import { Button } from "../../ui/button";

  /**
   * Zoom out and in of a flow canvas, with the zoom between. It moves at
   * once, with no animation. It lives inside the canvas's Svelte Flow.
   */
  let { minZoom, maxZoom }: { minZoom: number; maxZoom: number } = $props();

  const flow = useSvelteFlow();
  const viewport = useViewport();
  const zoom = $derived(viewport.current.zoom);
</script>

<div class="flex items-center gap-0.5 rounded-[10px] border border-(--hairline-strong) bg-background p-0.75 dark:bg-card" role="group" aria-label="Zoom">
  <Button variant="ghost" size="icon-sm" class="text-(--solus-text-secondary) pointer-coarse:tap-area" aria-label="Zoom out" disabled={zoom <= minZoom + 0.001} onclick={() => void flow.zoomOut({ duration: 0 })}>
    <ZoomOutIcon size={14} aria-hidden="true" />
  </Button>
  <span class="min-w-9 px-1 text-center text-xs text-(--solus-text-tertiary) tabular-nums" aria-live="polite">{Math.round(zoom * 100)}%</span>
  <Button variant="ghost" size="icon-sm" class="text-(--solus-text-secondary) pointer-coarse:tap-area" aria-label="Zoom in" disabled={zoom >= maxZoom - 0.001} onclick={() => void flow.zoomIn({ duration: 0 })}>
    <ZoomInIcon size={14} aria-hidden="true" />
  </Button>
</div>
