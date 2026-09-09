import { onDestroy } from 'svelte'
import type { useStore } from '@xyflow/svelte'
import { SvelteMap } from 'svelte/reactivity'
import { flowEdgeToDiagram } from '../diagram-flow-map'
import { routeEdges, type RouteNode, type RouteEdge } from './edge-routing'

type FlowStore = ReturnType<typeof useStore>
/** One routing computation per mounted canvas, shared by all its edges. */
class CanvasRoutes {
  labelSizes = new SvelteMap<string, { width: number; height: number }>()
  constructor(private store: FlowStore) {}
  private geometry = $derived.by(() => {
    const nodes: RouteNode[] = []
    for (const node of this.store.nodes) {
      if (node.hidden) continue
      const internal = this.store.nodeLookup.get(node.id)
      const position = internal?.internals.positionAbsolute ?? node.position
      nodes.push({ id: node.id, ...position, width: internal?.measured?.width ?? node.width ?? 192,
        height: internal?.measured?.height ?? node.height ?? 56, group: !!node.data.group && !node.data.collapsed })
    }
    return JSON.stringify({ nodes, edges: this.store.edges.filter(e => !e.hidden).map(e => {
      const { id, source, target, sourceHandle, targetHandle, label, route, bendOffset, bendAxis, labelOffset } = flowEdgeToDiagram(e)
      return { id, source, target, sourceHandle, targetHandle, label, route, bendOffset, bendAxis, labelOffset, labelSize: this.labelSizes.get(e.id) }
    }) })
  })
  drawings = $derived.by(() => {
    // Serialize our own typed projection so selection/color-only updates compare
    // equal and do not invalidate routing across all mounted edges.
    const graph: { nodes: RouteNode[]; edges: RouteEdge[] } = JSON.parse(this.geometry)
    return routeEdges(graph.nodes, graph.edges)
  })
}
interface RoutingEntry { routes: CanvasRoutes; dispose: () => void; users: number }
const canvases = new WeakMap<FlowStore, RoutingEntry>()
export function canvasRoutes(store: FlowStore): CanvasRoutes {
  let entry = canvases.get(store)
  if (!entry) {
    let routes!: CanvasRoutes
    // Edge replacement during undo must not destroy the shared derived owner.
    const dispose = $effect.root(() => { routes = new CanvasRoutes(store) })
    entry = { routes, dispose, users: 0 }
    canvases.set(store, entry)
  }
  const current = entry
  current.users++
  onDestroy(() => {
    if (--current.users === 0) { current.dispose(); canvases.delete(store) }
  })
  return current.routes
}
