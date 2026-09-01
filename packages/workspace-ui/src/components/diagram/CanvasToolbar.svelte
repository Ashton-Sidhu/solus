<script lang="ts">
  import { Panel, useSvelteFlow } from '@xyflow/svelte'
  import CanvasZoomControls from './CanvasZoomControls.svelte'
  import DiagramLayoutMenu from './DiagramLayoutMenu.svelte'
  import type { DiagramDoc } from '@solus/contracts/diagram-types'
  import type { LayoutDirection } from '@solus/contracts/diagram-layout'

  interface Props {
    onAddNode: () => void
    onAddGroup: () => void
    onRelayout: (direction: LayoutDirection) => void
    layoutDirection: LayoutDirection | null
    onDeleteSelected?: () => void
    hasSelection?: boolean
    getDoc: () => DiagramDoc
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
    minimapVisible,
    onToggleMinimap,
    onFlowReady,
  }: Props = $props()

  const flow = useSvelteFlow()

  const isMac = navigator.platform.includes('Mac')

  $effect(() => {
    onFlowReady?.(flow)
  })

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

    <!-- Zoom and fit are the controls every canvas has, editable or not, so the
         reading preview renders this same cluster. -->
    <CanvasZoomControls />

    <span class="canvas-toolbar__divider" aria-hidden="true"></span>

    <div class="canvas-toolbar__group">
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
