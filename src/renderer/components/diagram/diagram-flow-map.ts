import type { Edge as FlowEdge, Node as FlowNode } from '@xyflow/svelte'
import type { DiagramEdge, DiagramNode } from '../../../shared/diagram-types'

// Single source of truth for turning a live xyflow Node/Edge back into a plain
// DiagramNode/DiagramEdge. Previously this field-by-field mapping was hand-copied
// across currentDoc(), relayout() and the edge-drawer derivation — so adding a
// field meant remembering every copy, and forgetting one silently dropped it on
// save or relayout. Keep these the only place the reverse mapping lives.
//
// The forward direction (Diagram → Flow) stays in DiagramShell: it attaches
// component-scoped handlers and z-index layering that don't belong in a helper.

export function flowNodeToDiagram(n: FlowNode): DiagramNode {
  // SAFETY: DiagramShell creates each xyflow node from a DiagramNode and xyflow preserves its data payload.
  const d = n.data as DiagramNode
  // A collapsed group renders at a shrunken header height (n.height), but its
  // real (expanded) height is preserved on data.height — persist that so the box
  // restores to size on expand.
  const collapsedGroup = !!d.group && !!d.collapsed
  return {
    id: n.id,
    label: d.label,
    meta: d.meta,
    position: n.position,
    width: n.width,
    height: collapsedGroup ? d.height : n.height,
    icon: d.icon,
    color: d.color,
    silhouette: d.silhouette,
    group: d.group || undefined,
    collapsed: d.collapsed || undefined,
    sentToBack: d.sentToBack || undefined,
    parentId: n.parentId ?? undefined,
    subtitle: d.subtitle,
    badges: d.badges,
    metrics: d.metrics,
    fields: d.fields,
    tags: d.tags,
    body: d.body,
    html: d.html,
    actions: d.actions,
    detail: d.detail,
  }
}

export function flowEdgeToDiagram(e: FlowEdge): DiagramEdge {
  // SAFETY: DiagramShell creates each xyflow edge from a DiagramEdge and xyflow preserves its data payload.
  const d = (e.data ?? {}) as Partial<DiagramEdge>
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.label,
    body: d.body,
    kind: d.kind,
    color: d.color,
    width: d.width,
    dash: d.dash,
    arrows: d.arrows,
    route: d.route,
    cardinality: d.cardinality,
    bendOffset: d.bendOffset,
    animated: e.animated,
    sourceHandle: e.sourceHandle ?? undefined,
    targetHandle: e.targetHandle ?? undefined,
  }
}
