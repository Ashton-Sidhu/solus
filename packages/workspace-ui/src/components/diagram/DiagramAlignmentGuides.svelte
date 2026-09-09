<script lang="ts">
  import { useStore } from '@xyflow/svelte'
  import { alignmentGuides, type AlignmentNode } from './lib/alignment-guides'

  const store = useStore()
  const guides = $derived.by(() => {
    if (!store.nodes.some(node => node.dragging)) return []
    const nodes: AlignmentNode[] = []
    for (const node of store.nodes) {
      const internal = store.nodeLookup.get(node.id)
      if (!internal?.measured?.width || !internal.measured.height) continue
      nodes.push({ id: node.id, parentId: node.parentId, dragging: node.dragging, hidden: node.hidden,
        ...internal.internals.positionAbsolute, width: internal.measured.width, height: internal.measured.height })
    }
    return alignmentGuides(nodes, store.viewport.zoom)
  })
</script>

{#if guides.length}
  <svg class="pointer-events-none absolute inset-0 z-30 size-full overflow-hidden" aria-hidden="true" data-diagram-editor-only data-diagram-alignment-guides>
    <g transform="translate({store.viewport.x} {store.viewport.y}) scale({store.viewport.zoom})">
      {#each guides as guide (guide.axis)}
        <line
          data-alignment-axis={guide.axis}
          x1={guide.axis === 'x' ? guide.position : guide.start}
          y1={guide.axis === 'y' ? guide.position : guide.start}
          x2={guide.axis === 'x' ? guide.position : guide.end}
          y2={guide.axis === 'y' ? guide.position : guide.end}
          stroke="var(--solus-accent)" stroke-width="1" stroke-dasharray="4 3" vector-effect="non-scaling-stroke"
        />
      {/each}
    </g>
  </svg>
{/if}
