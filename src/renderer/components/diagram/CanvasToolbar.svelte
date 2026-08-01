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
    prepareImageExport?: () => Promise<() => void>
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
    prepareImageExport,
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

<!-- Add first and accent-filled, then zoom, then the tools — creation is the one
     thing on this bar worth spending the accent on, so it leads. -->
<Panel position="bottom-center">
  <div class="canvas-toolbar" role="toolbar" aria-label="Canvas controls">
    <div class="canvas-toolbar__group">
      <button
        type="button"
        class="canvas-toolbar__btn canvas-toolbar__add"
        onclick={onAddNode}
        title="Add node (⌥N)"
        aria-label="Add node"
      >
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
          <path d="M8 3v10M3 8h10" />
        </svg>
      </button>

      <button
        type="button"
        class="canvas-toolbar__btn"
        onclick={() => onAddGroup()}
        title="Add group (⌥G)"
        aria-label="Add group"
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <rect x="1.75" y="3.5" width="12.5" height="10" rx="2" stroke-dasharray="2.2 1.8" />
          <path d="M8 7v3M6.5 8.5h3" />
        </svg>
      </button>
    </div>

    <span class="canvas-toolbar__divider" aria-hidden="true"></span>

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
    </div>

    <span class="canvas-toolbar__divider" aria-hidden="true"></span>

    <div class="canvas-toolbar__group">
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

      <DiagramLayoutMenu onLayout={relayoutAndFit} current={layoutDirection} />

      <button
        type="button"
        class="canvas-toolbar__btn"
        class:canvas-toolbar__btn--on={minimapVisible}
        onclick={onToggleMinimap}
        title={minimapVisible ? 'Hide minimap' : 'Show minimap'}
        aria-label={minimapVisible ? 'Hide minimap' : 'Show minimap'}
        aria-pressed={minimapVisible}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <rect x="2" y="3" width="12" height="10" rx="1.5" />
          <rect x="9" y="8.5" width="4" height="3.5" rx="0.75" fill="currentColor" stroke="none" />
        </svg>
      </button>

      <DiagramExportMenu {getDoc} bgColor={exportBgColor} title={exportTitle} {prepareImageExport} />
    </div>

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
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
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
    gap: 0.1875rem;
    padding: 0.3125rem;
    border-radius: 0.6875rem;
    background: var(--solus-container-bg);
    border: 0.0625rem solid var(--solus-container-border);
    /* Shallower than the inspector's — this bar floats close to the board. */
    box-shadow: 0 0.5rem 1.625rem -0.5rem rgba(60, 40, 25, 0.24);
  }

  /* Related controls sit tighter to each other than to the dividers, so the bar
     reads as three clusters rather than one run of nine buttons. */
  .canvas-toolbar__group {
    display: flex;
    align-items: center;
    gap: 0.125rem;
  }

  /* :global so the shared button styling also reaches the trigger buttons
     rendered by DiagramLayoutMenu / DiagramExportMenu, which reuse this class
     across component boundaries. Scoped under .canvas-toolbar so it can't leak. */
  .canvas-toolbar :global(.canvas-toolbar__btn) {
    display: grid;
    place-items: center;
    width: 1.75rem;
    height: 1.75rem;
    border: none;
    border-radius: 0.4375rem;
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
    width: 0.875rem;
    height: 0.875rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* The one filled control on the bar: creating a node is the primary act, and
     primary is the only accent this feature spends outside the selection ring. */
  .canvas-toolbar :global(.canvas-toolbar__add) {
    width: 1.875rem;
    height: 1.875rem;
    border-radius: 0.5rem;
    background: var(--solus-accent);
    color: var(--solus-text-on-accent);
  }

  .canvas-toolbar :global(.canvas-toolbar__add:hover) {
    background: var(--solus-accent);
    color: var(--solus-text-on-accent);
    filter: brightness(0.93);
  }

  .canvas-toolbar :global(.canvas-toolbar__add:active) {
    background: var(--solus-accent);
  }

  .canvas-toolbar :global(.canvas-toolbar__add svg) {
    width: 0.9375rem;
    height: 0.9375rem;
    stroke-width: 1.8;
  }

  /* Mono and full-strength: the one read-out on a bar of glyphs. */
  .canvas-toolbar__zoom {
    width: 2.625rem;
    height: 1.75rem;
    padding: 0;
    border: none;
    border-radius: 0.4375rem;
    background: transparent;
    color: var(--solus-text-primary);
    font-family: var(--solus-code-font-family);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
    text-align: center;
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
    height: 1.375rem;
    margin: 0 0.3125rem;
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
