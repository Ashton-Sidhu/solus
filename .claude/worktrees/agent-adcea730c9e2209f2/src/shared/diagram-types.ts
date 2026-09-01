export type DiagramAction =
  | { do: 'expand' }
  | { do: 'details' }
  | { do: 'focus' }
  | { do: 'drilldown' }
  | { do: 'openUrl'; url: string }
  | { do: 'openFile'; path: string }

const VALID_ACTION_DO = new Set([
  'expand',
  'details',
  'focus',
  'drilldown',
  'openUrl',
  'openFile',
])

const VALID_FIELD_KEY = new Set(['pk', 'fk', 'unique'])

const VALID_CARDINALITY = new Set(['1-1', '1-n', 'n-1', 'n-n'])

export const DIAGRAM_NODE_SHAPES = ['rectangle', 'circle', 'diamond'] as const
export type DiagramNodeShape = (typeof DIAGRAM_NODE_SHAPES)[number]

const VALID_SHAPE = new Set<DiagramNodeShape>(DIAGRAM_NODE_SHAPES)

/**
 * A typed column of a data-model entity. A node carrying `fields` renders as an
 * entity (a table) rather than a service card — presence of `fields` is the
 * discriminator, there is no explicit flag.
 */
export interface DiagramField {
  name: string
  /** Column type, e.g. "uuid", "varchar(255)". Free-form, rendered muted. */
  type?: string
  /** Key role: primary, foreign, or unique. Invalid values are stripped. */
  key?: 'pk' | 'fk' | 'unique'
  nullable?: boolean
  /** Documentary FK annotation, e.g. "users.id". Rendered verbatim, not synthesised into an edge. */
  ref?: string
}

export interface DiagramNode {
  id: string
  label: string
  meta?: Record<string, string>
  position?: { x: number; y: number }
  width?: number
  height?: number
  /**
   * Node icon. Use an Iconify `prefix:name` for real brand/service/protocol
   * logos — `logos:postgresql` (full colour) or `simple-icons:redis`
   * (monochrome). Any other string falls back to a curated abstract glyph or is
   * rendered as an emoji.
   */
  icon?: string
  /** Marks this node as a subflow container that other nodes nest within. */
  group?: boolean
  /**
   * Collapses a group container to just its header, hiding its children (and any
   * edges touching them). Only meaningful when `group` is true. Transient `hidden`
   * flags on the children are derived from this — never persisted.
   */
  collapsed?: boolean
  /**
   * Custom accent colour (CSS colour string) for the node card / group container.
   * Tints the icon chip, badges and entity key glyphs. Omitted = the theme accent.
   */
  color?: string
  /**
   * Outline shape of the node card. 'rectangle' (the default) is the rounded
   * card; 'circle' and 'diamond' are decorative silhouettes that only apply to
   * simple label nodes (a node with badges/fields/body etc. stays a rectangle).
   * Invalid values are stripped; groups never carry it.
   */
  shape?: DiagramNodeShape
  /**
   * Pins this node to the back layer (below other nodes and edges). Set via the
   * "Send to back" action — handy for pushing a group container behind the
   * edges and nodes it would otherwise cover.
   */
  sentToBack?: boolean
  /** Id of the group this node is nested inside. Its `position` is then relative to that group. */
  parentId?: string
  subtitle?: string
  badges?: string[]
  metrics?: Record<string, string>
  /**
   * Typed columns of a data-model entity. When present (and `group` is not set),
   * the node renders as an entity table instead of a service card.
   */
  fields?: DiagramField[]
  tags?: string[]
  body?: string
  html?: string
  actions?: { on: 'click'; action: DiagramAction }[]
  /**
   * A nested sub-diagram revealed when the node is drilled into (click to
   * navigate, breadcrumb to return). One level only: nodes inside a `detail`
   * doc must not carry their own `detail` — `parseDiagram` strips deeper nesting.
   */
  detail?: DiagramDoc
}

export interface DiagramEdge {
  id: string
  source: string
  target: string
  label?: string
  kind?: 'sync' | 'async' | 'data'
  /** Custom stroke colour (CSS colour string). Omitted = default accent. */
  color?: string
  /** Stroke width in px, used to weight an edge. Omitted = kind-based default. */
  width?: number
  /**
   * Which ends carry an arrowhead. 'end' (the default) points at the target,
   * 'start' at the source, 'both' is bidirectional, 'none' is a plain line.
   */
  arrows?: 'none' | 'start' | 'end' | 'both'
  /**
   * Relationship cardinality, source → target ordered. Drives per-end crow's-foot
   * markers. Values outside the four-value set are stripped in `parseDiagram`.
   */
  cardinality?: '1-1' | '1-n' | 'n-1' | 'n-n'
  /**
   * Routing style of the edge path. 'smooth' (the default) is a rounded
   * orthogonal step, 'step' is a sharp-cornered orthogonal step, 'straight' is a
   * direct line between endpoints. Omitted = 'smooth'.
   */
  shape?: 'smooth' | 'step' | 'straight'
  /** Smooth-step bend offset in canvas px. Omitted = xyflow default. */
  bendOffset?: number
  animated?: boolean
  sourceHandle?: string
  targetHandle?: string
}

export interface DiagramDoc {
  nodes: DiagramNode[]
  edges: DiagramEdge[]
}

export function parseDiagram(json: string): DiagramDoc {
  const parsed = JSON.parse(json) as DiagramDoc
  if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
    throw new Error('Invalid diagram: missing nodes or edges arrays')
  }
  normalizeDoc(parsed, true)
  return parsed
}

// Normalize one doc level (the root or a node's `detail`): repair anything
// recoverable rather than throwing, because this also runs on persisted
// content at load time — a throw there blanks the canvas.
function normalizeDoc(doc: DiagramDoc, allowDetail: boolean): void {
  // xyflow requires unique, non-empty node ids and crashes rendering on
  // duplicates — keep the first occurrence, drop the rest. A non-string label
  // would throw inside layout's width estimate, so coerce it.
  const ids = new Set<string>()
  doc.nodes = doc.nodes.filter((n) => {
    if (!n || typeof n.id !== 'string' || !n.id || ids.has(n.id)) return false
    ids.add(n.id)
    if (typeof n.label !== 'string') n.label = ''
    return true
  })
  // A parentId pointing at a node that doesn't exist would never resolve in
  // xyflow's relative positioning — detach to top level.
  for (const node of doc.nodes) {
    if (node.parentId && !ids.has(node.parentId)) delete node.parentId
  }
  normalizeNodes(doc.nodes, allowDetail)
  // Drop edges whose endpoints aren't declared nodes (they'd error in the
  // renderer; mermaid export already skips them) and duplicate edge ids; strip
  // any cardinality outside the supported set.
  const edgeIds = new Set<string>()
  doc.edges = doc.edges.filter((e) => {
    if (!e || !ids.has(e.source) || !ids.has(e.target)) return false
    if (typeof e.id === 'string' && e.id) {
      if (edgeIds.has(e.id)) return false
      edgeIds.add(e.id)
    }
    return true
  })
  for (const edge of doc.edges) {
    if (edge.cardinality && !VALID_CARDINALITY.has(edge.cardinality)) delete edge.cardinality
  }
}

// Ids of nodes whose `parentId` closes a cycle (e.g. two groups each nested in
// the other). Following such a parentId loops forever in every parent-walking
// pass — layout, hit-testing, render, even xyflow's own absolute-position
// resolve — and hard-freezes the single-threaded renderer with no error logged.
// Callers detach these nodes to the top level so the graph is always a DAG.
// Pure: classic DFS with an on-stack marker, no mutation.
export function findParentCycleBreaks(nodes: { id: string; parentId?: string }[]): Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const state = new Map<string, 1 | 2>() // 1 = on the current DFS stack, 2 = fully visited
  const cut = new Set<string>()
  const visit = (n: { id: string; parentId?: string }): void => {
    state.set(n.id, 1)
    const parent = n.parentId ? byId.get(n.parentId) : undefined
    if (parent) {
      const s = state.get(parent.id)
      if (s === 1) cut.add(n.id) // parent is still on the stack → this edge closes a cycle
      else if (s !== 2) visit(parent)
    }
    state.set(n.id, 2)
  }
  for (const n of nodes) if (!state.has(n.id)) visit(n)
  return cut
}

// Drop unknown action.do values, break any cyclic parentId, and validate any
// nested `detail` sub-diagram. `allowDetail` enforces the one-level rule: a node
// inside a detail doc may not itself carry a detail, so any deeper nesting is
// stripped here.
function normalizeNodes(nodes: DiagramNode[], allowDetail: boolean): void {
  // Detach nodes whose parentId forms a cycle before anything walks the chain —
  // a persisted cycle would otherwise freeze the app the moment it loads.
  const cut = findParentCycleBreaks(nodes)
  if (cut.size) for (const node of nodes) if (cut.has(node.id)) delete node.parentId
  for (const node of nodes) {
    if (node.actions) {
      node.actions = node.actions.filter((a) => a.action?.do && VALID_ACTION_DO.has(a.action.do))
    }
    // Shape is a card-only affordance: groups are pure containers, and any
    // value outside the supported set is dropped so the renderer only sees one
    // it knows. 'rectangle' is the implicit default, so strip it too — keep data sparse.
    if (node.shape && (node.group || !VALID_SHAPE.has(node.shape) || node.shape === 'rectangle')) {
      delete node.shape
    }
    if (node.fields) {
      // Groups are pure containers — they never carry entity fields.
      if (node.group) {
        delete node.fields
      } else {
        node.fields = node.fields.filter((f) => f?.name?.trim())
        for (const f of node.fields) if (f.key && !VALID_FIELD_KEY.has(f.key)) delete f.key
        if (!node.fields.length) delete node.fields
      }
    }
    if (!node.detail) continue
    if (
      !allowDetail ||
      !Array.isArray(node.detail.nodes) ||
      !Array.isArray(node.detail.edges)
    ) {
      delete node.detail
      continue
    }
    // Full normalization, not just nodes — detail edges need the same
    // dangling-ref and cardinality treatment as root edges.
    normalizeDoc(node.detail, false)
  }
}

export function serializeDiagram(doc: DiagramDoc): string {
  return JSON.stringify(doc)
}

export function summarizeDiagram(doc: DiagramDoc): string {
  const n = doc.nodes.length
  const e = doc.edges.length
  return `${n} ${n === 1 ? 'node' : 'nodes'} · ${e} ${e === 1 ? 'connection' : 'connections'}`
}
