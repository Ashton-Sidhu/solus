<script lang="ts">
  import { Panel, useSvelteFlow, useViewport } from '@xyflow/svelte'
  import DiagramExportMenu from './DiagramExportMenu.svelte'
  import DiagramLayoutMenu from './DiagramLayoutMenu.svelte'
  import type { DiagramDoc } from '../../../shared/diagram-types'
  import type { LayoutDirection } from '../../../shared/diagram-layout'

  interface Props {
    onAddNode: () => void
    onAddGroup: () => void
    onRelayout: (direction: LayoutDirection) => void
    layoutDirection: LayoutDirection | null
    onDeleteSelected?: () => void
    hasSelection?: boolean
    getDoc: () => DiagramDoc
    exportBgColor: string
    exportTitle: string
    minimapVisible: boolean
    onToggleMinimap: () => void
    onFlowReady?: (flow: ReturnType<typeof useSvelteFlow>) => void
  }

  let {
    onAddNode,
    onAddGroup,
    onRelayout,
    layoutDirection,
    onDeleteSelected,
    hasSelection = false,
    getDoc,
    exportBgColor,
    exportTitle,
    minimapVisible,
    onToggleMinimap,
    onFlowReady,
  }: Props = $props()

  const flow = useSvelteFlow()
  const viewport = useViewport()

  const isMac = navigator.platform.includes('Mac')

  $effect(() => {
    onFlowReady?.(flow)
  })

  const zoomPct = $derived(Math.round(viewport.current.zoom * 100))

  function relayoutAndFit(direction: LayoutDirection) {
    onRelayout(direction)
    requestAnimationFrame(() => void flow.fitView({ duration: 300, padding: 0.2 }))
  }
</script>

<Panel position="bottom-center">
  <div class="canvas-toolbar" role="toolbar" aria-label="Canvas controls">
    <button
      type="button"
      class="canvas-toolbar__btn"
      onclick={() => void flow.zoomOut({ duration: 150 })}
      title="Zoom out"
      aria-label="Zoom out"
    >
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M3 8h10" /></svg>
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
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
    </button>

    <button
      type="button"
      class="canvas-toolbar__btn"
      onclick={() => void flow.fitView({ duration: 300, padding: 0.2 })}
      title="Fit to view"
      aria-label="Fit to view"
    >
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <path d="M5 2H2v3M11 2h3v3M5 14H2v-3M11 14h3v-3" />
      </svg>
    </button>

    <span class="canvas-toolbar__divider" aria-hidden="true"></span>

    <button
      type="button"
      class="canvas-toolbar__btn"
      onclick={() => onAddNode()}
      title="Add node (⌥N)"
      aria-label="Add node"
    >
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" />
        <path d="M8 5.5v5M5.5 8h5" />
      </svg>
    </button>

    <button
      type="button"
      class="canvas-toolbar__btn"
      onclick={() => onAddGroup()}
      title="Add group (⌥G)"
      aria-label="Add group"
    >
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <rect x="1.75" y="3.5" width="12.5" height="10" rx="2" stroke-dasharray="2.2 1.8" />
        <path d="M8 7v3M6.5 8.5h3" />
      </svg>
    </button>

    <DiagramLayoutMenu onLayout={relayoutAndFit} current={layoutDirection} />

    <span class="canvas-toolbar__divider" aria-hidden="true"></span>

    <button
      type="button"
      class="canvas-toolbar__btn"
      class:canvas-toolbar__btn--on={minimapVisible}
      onclick={onToggleMinimap}
      title={minimapVisible ? 'Hide minimap' : 'Show minimap'}
      aria-label={minimapVisible ? 'Hide minimap' : 'Show minimap'}
      aria-pressed={minimapVisible}
    >
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <rect x="2" y="3" width="12" height="10" rx="1.5" />
        <rect x="9" y="8.5" width="4" height="3.5" rx="0.75" fill="currentColor" stroke="none" />
      </svg>
    </button>

    <DiagramExportMenu {getDoc} bgColor={exportBgColor} title={exportTitle} />

    {#if onDeleteSelected}
      <span class="canvas-toolbar__divider" aria-hidden="true"></span>

      <button
        type="button"
        class="canvas-toolbar__btn canvas-toolbar__btn--delete"
        class:canvas-toolbar__btn--disabled={!hasSelection}
        onclick={onDeleteSelected}
        disabled={!hasSelection}
        title="Delete selected ({isMac ? '⌫' : 'Del'})"
        aria-label="Delete selected"
      >
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
          <path d="M3 4.5h10M6.5 4.5V3a1 1 0 011-1h1a1 1 0 011 1v1.5" />
          <path d="M4 4.5l.5 8.5a1 1 0 001 1h5a1 1 0 001-1l.5-8.5" />
          <path d="M6.5 7v4M9.5 7v4" />
        </svg>
      </button>
    {/if}
  </div>
</Panel>

<style>
  .canvas-toolbar {
    display: flex;
    align-items: center;
    gap: 0.125rem;
    padding: 0.25rem;
    border-radius: 0.875rem;
    background: var(--solus-container-bg);
    border: 0.0625rem solid var(--solus-container-border);
    box-shadow: var(--solus-container-shadow);
  }

  /* :global so the shared button styling also reaches the trigger buttons
     rendered by DiagramLayoutMenu / DiagramExportMenu, which reuse this class
     across component boundaries. Scoped under .canvas-toolbar so it can't leak. */
  .canvas-toolbar :global(.canvas-toolbar__btn) {
    display: grid;
    place-items: center;
    width: 1.875rem;
    height: 1.875rem;
    border: none;
    border-radius: 0.625rem;
    background: transparent;
    color: var(--solus-text-secondary);
    cursor: pointer;
    transition:
      background var(--duration-base) var(--ease-premium),
      color var(--duration-base) var(--ease-premium),
      scale var(--duration-quick) var(--ease-premium);
  }

  .canvas-toolbar :global(.canvas-toolbar__btn:hover) {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }

  .canvas-toolbar :global(.canvas-toolbar__btn:active) {
    background: var(--solus-surface-active);
    scale: 0.96;
  }

  .canvas-toolbar :global(.canvas-toolbar__btn svg) {
    width: 0.9375rem;
    height: 0.9375rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .canvas-toolbar__zoom {
    min-width: 3rem;
    height: 1.875rem;
    padding: 0 0.5rem;
    border: none;
    border-radius: 0.625rem;
    background: transparent;
    color: var(--solus-text-secondary);
    font-size: 0.75rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    transition:
      background var(--duration-base) var(--ease-premium),
      color var(--duration-base) var(--ease-premium),
      scale var(--duration-quick) var(--ease-premium);
  }

  .canvas-toolbar__zoom:hover {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }

  .canvas-toolbar__zoom:active {
    scale: 0.96;
  }

  .canvas-toolbar__divider {
    width: 0.0625rem;
    height: 1.125rem;
    margin: 0 0.1875rem;
    background: var(--solus-container-border);
  }

  .canvas-toolbar :global(.canvas-toolbar__btn--on) {
    background: var(--solus-accent-light);
    color: var(--solus-accent);
  }

  .canvas-toolbar :global(.canvas-toolbar__btn--disabled) {
    opacity: 0.35;
    pointer-events: none;
  }

  .canvas-toolbar :global(.canvas-toolbar__btn--delete:not(.canvas-toolbar__btn--disabled):hover) {
    color: var(--solus-status-error);
  }
</style>
