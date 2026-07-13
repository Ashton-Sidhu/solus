import type { Edge as FlowEdge, Node as FlowNode } from '@xyflow/svelte'
import type { DiagramEdge, DiagramField, DiagramNode, DiagramDoc } from '../../../shared/diagram-types'

// Single source of truth for turning a live xyflow Node/Edge back into a plain
// DiagramNode/DiagramEdge. Previously this field-by-field mapping was hand-copied
// across currentDoc(), relayout() and the edge-drawer derivation — so adding a
// field meant remembering every copy, and forgetting one silently dropped it on
// save or relayout. Keep these the only place the reverse mapping lives.
//
// The forward direction (Diagram → Flow) stays in DiagramShell: it attaches
// component-scoped handlers and z-index layering that don't belong in a helper.

export function flowNodeToDiagram(n: FlowNode): DiagramNode {
  const d = n.data as Record<string, unknown>
  // A collapsed group renders at a shrunken header height (n.height), but its
  // real (expanded) height is preserved on data.height — persist that so the box
  // restores to size on expand.
  const collapsedGroup = !!d.group && !!d.collapsed
  return {
    id: n.id,
    label: d.label as string,
    meta: d.meta as Record<string, string> | undefined,
    position: n.position,
    width: n.width,
    height: collapsedGroup ? (d.height as number | undefined) : n.height,
    icon: d.icon as string | undefined,
    color: d.color as string | undefined,
    shape: d.shape as DiagramNode['shape'],
    group: (d.group as boolean | undefined) || undefined,
    collapsed: (d.collapsed as boolean | undefined) || undefined,
    sentToBack: (d.sentToBack as boolean | undefined) || undefined,
    parentId: (n.parentId ?? undefined) as string | undefined,
    subtitle: d.subtitle as string | undefined,
    badges: d.badges as string[] | undefined,
    metrics: d.metrics as Record<string, string> | undefined,
    fields: d.fields as DiagramField[] | undefined,
    tags: d.tags as string[] | undefined,
    body: d.body as string | undefined,
    html: d.html as string | undefined,
    actions: d.actions as DiagramNode['actions'],
    detail: d.detail as DiagramDoc | undefined,
  }
}

export function flowEdgeToDiagram(e: FlowEdge): DiagramEdge {
  const d = (e.data ?? {}) as Record<string, unknown>
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    label: typeof e.label === 'string' ? e.label : undefined,
    kind: d.kind as DiagramEdge['kind'],
    color: d.color as string | undefined,
    width: d.width as number | undefined,
    arrows: d.arrows as DiagramEdge['arrows'],
    shape: d.shape as DiagramEdge['shape'],
    cardinality: d.cardinality as DiagramEdge['cardinality'],
    bendOffset: d.bendOffset as number | undefined,
    animated: e.animated,
    sourceHandle: (e.sourceHandle ?? undefined) as string | undefined,
    targetHandle: (e.targetHandle ?? undefined) as string | undefined,
  }
}
