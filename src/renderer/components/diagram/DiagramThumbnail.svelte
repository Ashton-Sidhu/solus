<script lang="ts">
  import { SvelteFlow, MarkerType, type Node, type Edge } from '@xyflow/svelte'
  import '@xyflow/svelte/dist/style.css'
  import DiagramNodeComponent from './nodes/DiagramNode.svelte'
  import DiagramEdgeComponent from './edges/DiagramEdge.svelte'
  import { parseDiagram } from '../../../shared/diagram-types'
  import { applyLayout } from '../../../shared/diagram-layout'
  import { getSettingsContext } from '../../contexts/settings.context.svelte'
  import { diagramAccent } from './diagram-colors'

  interface Props {
    content: string
  }

  let { content }: Props = $props()

  const theme = getSettingsContext()
  const nodeTypes = { default: DiagramNodeComponent }
  // Match the editor's custom edge + arrow styling so the preview doesn't drift
  // from what opens in the shell.
  const edgeTypes = { default: DiagramEdgeComponent }
  const edgeAccent = $derived(diagramAccent(theme.isDark))
  const defaultEdgeOptions = $derived({
    type: 'default',
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: edgeAccent },
  })

  // Lazy-mount: don't run a live flow renderer until the card scrolls into view.
  let cardEl: HTMLDivElement | undefined
  let visible = $state(false)

  $effect(() => {
    if (!cardEl || visible) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        visible = true
        observer.disconnect()
      }
    }, { rootMargin: '100px' })
    observer.observe(cardEl)
    return () => observer.disconnect()
  })

  const { nodes, edges }: { nodes: Node[]; edges: Edge[] } = $derived.by(() => {
    try {
      const doc = applyLayout(parseDiagram(content))
      return {
        nodes: doc.nodes.map((n) => ({
          id: n.id,
          type: 'default',
          position: n.position ?? { x: 0, y: 0 },
          data: {
            ...n,
            // Thumbnails are inert: no actions, always collapsed, not resizable
            expanded: false,
            dimmed: false,
            resizable: false,
          },
          draggable: false,
          selectable: false,
          connectable: false,
        })),
        edges: doc.edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          label: e.label,
          type: 'default',
          animated: e.kind === 'async' || (e.animated ?? false),
          className: e.kind === 'async' ? 'edge--async' : e.kind === 'data' ? 'edge--data' : undefined,
          ...(e.width != null ? { style: `stroke-width:${e.width}px` } : {}),
          data: { kind: e.kind },
        })),
      }
    } catch {
      return { nodes: [], edges: [] }
    }
  })
</script>

<div class="diagram-thumbnail" aria-hidden="true" bind:this={cardEl}>
  {#if visible}
    <SvelteFlow
      nodes={$state.snapshot(nodes)}
      edges={$state.snapshot(edges)}
      {nodeTypes}
      {edgeTypes}
      {defaultEdgeOptions}
      colorMode={theme.isDark ? 'dark' : 'light'}
      fitView
      panOnDrag={false}
      zoomOnScroll={false}
      zoomOnPinch={false}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      preventScrolling={false}
    />
  {/if}
</div>

<style>
  .diagram-thumbnail {
    width: 100%;
    height: 300px;
    pointer-events: none;
    overflow: hidden;
    border-radius: 0 0 0.625rem 0.625rem;
  }

  /* Clamp custom html bodies in thumbnails so they don't overflow the card */
  .diagram-thumbnail :global(.diagram-node__custom) {
    max-height: 3rem;
    overflow: hidden;
  }

  .diagram-thumbnail :global(.svelte-flow) {
    border-radius: 0;
    /* Override SvelteFlow's dark-mode background so the thumbnail canvas
       matches the plan-card surface (--plan-surface) it sits inside. */
    background: color-mix(in srgb, var(--solus-surface-primary) 30%, var(--solus-container-bg));
  }

  .diagram-thumbnail :global(.svelte-flow__node) {
    background: transparent;
    border: none;
    box-shadow: none;
    padding: 0;
    border-radius: 0;
  }

  .diagram-thumbnail :global(.svelte-flow__handle) {
    opacity: 0;
    pointer-events: none;
  }
</style>
