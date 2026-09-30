import * as Y from 'yjs'
import { z } from 'zod'
import type { DiagramDoc, DiagramEdge, DiagramNode } from './diagram-types'

/**
 * A diagram as a Yjs document (docs/plans/work-review-and-live-editing.md,
 * phase 3b). The root map `nodes` holds one `Y.Map` of fields per node, keyed by
 * id, and `edges` one per edge. Two people who edit different nodes never
 * conflict; two who set the same field get one winner on every client. A
 * position is one `{x, y}` value, so two drags cannot merge into a place
 * nobody chose. A node's `detail` is a nested map with its own `nodes` and
 * `edges`, one level deep, edited field by field like the root.
 *
 * The host and every client read and write through these functions, so they
 * agree on the model. Change `DIAGRAM_LIVE_SCHEMA_VERSION` with it.
 */

/** The order of a node in its level: a number between its neighbours'. */
const ORDER = '__order'
const DETAIL = 'detail'

type FieldMap = Y.Map<unknown>
type LevelMap = Y.Map<FieldMap>

/** The two root maps of a live diagram. */
export interface DiagramLevelMaps {
  nodes: LevelMap
  edges: LevelMap
}

/** A node's or an edge's fields, as the model stores them. */
type DiagramFields = Partial<DiagramNode> | Partial<DiagramEdge>

const orderSchema = z.number()

export function diagramLevelMaps(doc: Y.Doc): DiagramLevelMaps {
  return { nodes: doc.getMap('nodes'), edges: doc.getMap('edges') }
}

/** The diagram the live doc holds now. An edge whose end node is gone is dropped. */
export function readDiagramFromY(doc: Y.Doc): DiagramDoc {
  const { nodes, edges } = diagramLevelMaps(doc)
  return readLevel(nodes, edges, true)
}

/**
 * Make the live doc hold `diagram`, changing only what differs: a node or an
 * edge is added, removed, or has the fields that changed set. Run it inside a
 * transaction with the caller's origin.
 */
export function writeDiagramToY(doc: Y.Doc, diagram: DiagramDoc): void {
  const { nodes, edges } = diagramLevelMaps(doc)
  writeLevel(nodes, edges, diagram, true)
}

function readLevel(nodes: LevelMap, edges: LevelMap, withDetail: boolean): DiagramDoc {
  const ordered = [...nodes.entries()].sort(([aId, a], [bId, b]) => orderOf(a) - orderOf(b) || (aId < bId ? -1 : aId > bId ? 1 : 0))
  const outNodes: DiagramNode[] = []
  for (const [id, fields] of ordered) {
    const node: Partial<DiagramNode> = { id }
    copyFields(fields, node)
    const detail = withDetail ? fields.get(DETAIL) : undefined
    if (detail instanceof Y.Map) {
      const level = readLevel(levelOf(detail, 'nodes'), levelOf(detail, 'edges'), false)
      if (level.nodes.length > 0) node.detail = level
    }
    outNodes.push(asNode(node))
  }
  const present = new Set(outNodes.map((node) => node.id))
  const outEdges: DiagramEdge[] = []
  for (const [id, fields] of [...edges.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const edge: Partial<DiagramEdge> = { id }
    copyFields(fields, edge)
    const typed = asEdge(edge)
    if (present.has(typed.source) && present.has(typed.target)) outEdges.push(typed)
  }
  return { nodes: outNodes, edges: outEdges }
}

function writeLevel(nodes: LevelMap, edges: LevelMap, level: DiagramDoc, withDetail: boolean): void {
  const orders = nextOrders(nodes, level.nodes.map((node) => node.id))
  const kept = new Set<string>()
  for (const node of level.nodes) {
    kept.add(node.id)
    const fields = fieldMapIn(nodes, node.id)
    const { id: _id, detail, ...rest } = node
    writeFields(fields, rest, [ORDER, DETAIL])
    const order = orders.get(node.id)
    if (order !== undefined && fields.get(ORDER) !== order) fields.set(ORDER, order)
    if (withDetail && detail && detail.nodes.length > 0) {
      let detailMap = fields.get(DETAIL)
      if (!(detailMap instanceof Y.Map)) {
        detailMap = new Y.Map<unknown>()
        fields.set(DETAIL, detailMap)
      }
      if (detailMap instanceof Y.Map) writeLevel(levelOf(detailMap, 'nodes'), levelOf(detailMap, 'edges'), detail, false)
    } else if (fields.has(DETAIL)) {
      fields.delete(DETAIL)
    }
  }
  for (const id of Array.from(nodes.keys())) if (!kept.has(id)) nodes.delete(id)
  const keptEdges = new Set<string>()
  for (const edge of level.edges) {
    keptEdges.add(edge.id)
    const { id: _id, ...rest } = edge
    writeFields(fieldMapIn(edges, edge.id), rest, [])
  }
  for (const id of Array.from(edges.keys())) if (!keptEdges.has(id)) edges.delete(id)
}

/**
 * The `__order` each node should have. Nodes already in the live doc keep
 * theirs while their relative order is unchanged; a new node takes a number
 * between its neighbours'. A reorder renumbers the level.
 */
function nextOrders(nodes: LevelMap, ids: readonly string[]): Map<string, number> {
  const current = new Map<string, number>()
  for (const [id, fields] of nodes.entries()) {
    const order = orderSchema.safeParse(fields.get(ORDER))
    if (order.success) current.set(id, order.data)
  }
  const existing = ids.filter((id) => current.has(id))
  const inOrder = existing.every((id, index) => index === 0 || current.get(existing[index - 1]!)! < current.get(id)!)
  const orders = new Map<string, number>()
  if (!inOrder) {
    ids.forEach((id, index) => orders.set(id, index))
    return orders
  }
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index]!
    const known = current.get(id)
    if (known !== undefined) {
      orders.set(id, known)
      continue
    }
    const before = index > 0 ? orders.get(ids[index - 1]!) : undefined
    let after: number | undefined
    for (let next = index + 1; next < ids.length; next += 1) {
      after = current.get(ids[next]!)
      if (after !== undefined) break
    }
    orders.set(id, before === undefined ? (after === undefined ? index : after - 1) : after === undefined ? before + 1 : (before + after) / 2)
  }
  return orders
}

function fieldMapIn(level: LevelMap, id: string): FieldMap {
  const existing = level.get(id)
  if (existing instanceof Y.Map) return existing
  const created = new Y.Map<unknown>()
  level.set(id, created)
  return created
}

function levelOf(parent: Y.Map<unknown>, key: 'nodes' | 'edges'): LevelMap {
  const existing = parent.get(key)
  if (existing instanceof Y.Map) {
    // SAFETY: a level map is only ever created here, as a map of field maps.
    return existing as LevelMap
  }
  const created = new Y.Map<FieldMap>()
  parent.set(key, created)
  return created
}

/** Copy a node's or an edge's stored fields onto `target`, leaving out the model's own keys. */
function copyFields(fields: FieldMap, target: DiagramFields): void {
  for (const [key, value] of fields.entries()) {
    if (key === ORDER || key === DETAIL || key === 'id' || value === undefined) continue
    Reflect.set(target, key, structuredClone(value))
  }
}

/** Set each field whose value differs, and delete the fields `values` no longer has. */
function writeFields(fields: FieldMap, values: DiagramFields, reserved: readonly string[]): void {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined)
  const next = new Set(entries.map(([key]) => key))
  for (const [key, value] of entries) {
    // Field values are JSON: equal text is an equal value, and an equal value is not written.
    if (JSON.stringify(fields.get(key)) !== JSON.stringify(value)) fields.set(key, structuredClone(value))
  }
  for (const key of Array.from(fields.keys())) {
    if (!next.has(key) && !reserved.includes(key)) fields.delete(key)
  }
}

function orderOf(fields: FieldMap): number {
  const order = orderSchema.safeParse(fields.get(ORDER))
  return order.success ? order.data : Number.MAX_SAFE_INTEGER
}

function asNode(node: Partial<DiagramNode>): DiagramNode {
  // SAFETY: every field was written by `writeDiagramToY` from a DiagramNode (or by
  // a host with the same schema version); the host checks the projection with
  // `parseDiagram` before it is stored.
  return node as DiagramNode
}

function asEdge(edge: Partial<DiagramEdge>): DiagramEdge {
  // SAFETY: as `asNode`, for an edge.
  return edge as DiagramEdge
}
