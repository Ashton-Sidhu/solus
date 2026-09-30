import {
  findParentCycleBreaks,
  serializeDiagram,
  type DiagramDoc,
  type DiagramEdge,
  type DiagramNode,
} from '@solus/contracts/diagram-types'
import { applyLayout, reapplyLayout, type LayoutDirection, type NodeSize } from '@solus/contracts/diagram-layout'
import { DiagramHistory } from './diagram-history.svelte'

/** The undo history behind the model: whole-document snapshots when one
 *  person edits, the live doc's own undo when people edit together. */
export interface DiagramUndoHistory {
  readonly canUndo: boolean
  readonly canRedo: boolean
  record(doc: DiagramDoc, viewId?: string): void
  reset(doc: DiagramDoc): void
  rebase(doc: DiagramDoc): void
  undo(): { doc: DiagramDoc; viewId?: string } | null
  redo(): { doc: DiagramDoc; viewId?: string } | null
}

/**
 * Where an edit lands: the root diagram, or the `detail` sub-diagram of one
 * root node. `parseDiagram` keeps detail one level deep, so a path has at most
 * one step.
 */
export type ViewPath = readonly [] | readonly [detailOwnerId: string]
export const ROOT_VIEW: ViewPath = []

export interface Point { x: number; y: number }
export interface Size { width: number; height: number }

/** One diagram level as the model hands it out. Never mutate it: use a command. */
export interface ReadonlyDiagramDoc {
  readonly nodes: readonly DiagramNode[]
  readonly edges: readonly DiagramEdge[]
}

/** Content a node edit may change. Placement, nesting and detail have their own commands. */
export type NodeChanges = Partial<Omit<DiagramNode, 'id' | 'position' | 'width' | 'height' | 'parentId' | 'detail'>>
/** Content an edge edit may change. Its ends change through `reconnectEdge`. */
export type EdgeChanges = Partial<Omit<DiagramEdge, 'id' | 'source' | 'target' | 'sourceHandle' | 'targetHandle'>>

export interface EdgeEnds {
  source: string
  target: string
  /** Absent = the end floats to the side that faces the other node. */
  sourceHandle?: string
  targetHandle?: string
}

/**
 * The geometry of one node after a gesture. `parentId: null` detaches it to
 * the level; the position is then in that frame.
 */
export interface NodePlacement {
  position?: Point
  parentId?: string | null
  width?: number
  height?: number
}

/** Why the content changed, for the editor layer that saves it. `remote` is
 *  someone else's edit to a live diagram: shown, never saved again. */
export type DiagramChange = 'edit' | 'undo' | 'redo' | 'normalize' | 'remote'

const NODE_FIXED_KEYS = ['id', 'position', 'width', 'height', 'parentId', 'detail'] as const
const EDGE_FIXED_KEYS = ['id', 'source', 'target', 'sourceHandle', 'targetHandle'] as const
const EMPTY_VIEW: ReadonlyDiagramDoc = Object.freeze({ nodes: Object.freeze([]), edges: Object.freeze([]) })

/**
 * The editing model of one open diagram. It owns the one canonical document —
 * the root and every node's detail — and changes it only through typed
 * commands. The document is never mutated in place: a command replaces the
 * objects it changes, so an unchanged node keeps its identity and a canvas
 * projection can reuse what it drew for it.
 *
 * Commands inside `edit()` make one undo step. Selection, viewport, search,
 * navigation and save status are not the model's; nothing a view does to
 * itself records history.
 */
export class DiagramDocument {
  private doc: DiagramDoc
  private readonly history: DiagramUndoHistory
  private editDepth = 0
  private pendingEdit: ViewPath | null = null
  private readonly onChange: (change: DiagramChange) => void

  constructor(
    doc: DiagramDoc,
    onChange: (change: DiagramChange) => void = () => {},
    history: (initial: DiagramDoc) => DiagramUndoHistory = (initial) => new DiagramHistory(initial),
  ) {
    this.doc = structuredClone(doc)
    this.history = history(this.doc)
    this.onChange = onChange
  }

  get canUndo(): boolean { return this.history.canUndo }
  get canRedo(): boolean { return this.history.canRedo }

  /** The whole document, read-only. */
  get root(): ReadonlyDiagramDoc { return this.doc }

  /** One level, read-only. A node without detail has an empty view. */
  view(path: ViewPath): ReadonlyDiagramDoc {
    if (path.length === 0) return this.doc
    return this.doc.nodes.find((n) => n.id === path[0])?.detail ?? EMPTY_VIEW
  }

  node(path: ViewPath, nodeId: string): Readonly<DiagramNode> | undefined {
    return this.view(path).nodes.find((n) => n.id === nodeId)
  }

  edge(path: ViewPath, edgeId: string): Readonly<DiagramEdge> | undefined {
    return this.view(path).edges.find((e) => e.id === edgeId)
  }

  /** A detached copy of the whole document; changing it changes nothing here. */
  snapshot(): DiagramDoc { return structuredClone(this.doc) }

  /** The saved `{nodes, edges}` form, including every node's detail. */
  serialize(): string { return serializeDiagram(this.doc) }

  /** Group commands into one undo step (a drag, a paste, a multi-node action). */
  edit<T>(commands: () => T): T {
    this.editDepth += 1
    try {
      return commands()
    } finally {
      this.editDepth -= 1
      if (this.editDepth === 0 && this.pendingEdit) {
        const path = this.pendingEdit
        this.pendingEdit = null
        this.commit(path)
      }
    }
  }

  // ── Nodes ────────────────────────────────────────────────────────────────

  addNode(path: ViewPath, node: DiagramNode): boolean {
    return this.write(path, (view) => {
      if (view.nodes.some((n) => n.id === node.id)) return false
      const added = structuredClone(node)
      const parent = added.parentId ? view.nodes.find((n) => n.id === added.parentId) : undefined
      if (!parent?.group) delete added.parentId
      // Detail is one level deep; a node inside a detail cannot carry its own.
      if (path.length > 0) delete added.detail
      view.nodes.push(added)
      return true
    })
  }

  updateNode(path: ViewPath, nodeId: string, changes: NodeChanges): boolean {
    const patch: Partial<DiagramNode> = { ...changes }
    for (const key of NODE_FIXED_KEYS) delete patch[key]
    return this.replaceNode(path, nodeId, (node) => withChanges(node, structuredClone(patch)))
  }

  moveNode(path: ViewPath, nodeId: string, position: Point): boolean {
    return this.placeNodes(path, new Map([[nodeId, { position }]]))
  }

  resizeNode(path: ViewPath, nodeId: string, size: Size, position?: Point): boolean {
    return this.placeNodes(path, new Map([[nodeId, { ...size, position }]]))
  }

  /** Nest a node in a group (or detach it with `null`); `position` is in the new frame. */
  setParent(path: ViewPath, nodeId: string, parentId: string | null, position: Point): boolean {
    return this.placeNodes(path, new Map([[nodeId, { parentId, position }]]))
  }

  /**
   * Apply the geometry of a gesture at once. Nesting only lands in a group, and
   * a change that would put a node inside itself is dropped, so the parent
   * chain stays a tree whatever order the gesture resolved it in.
   */
  placeNodes(path: ViewPath, placements: ReadonlyMap<string, NodePlacement>): boolean {
    if (placements.size === 0) return false
    return this.write(path, (view) => {
      const before = new Map(view.nodes.map((n) => [n.id, n]))
      let changed = false
      view.nodes = view.nodes.map((node) => {
        const placement = placements.get(node.id)
        if (!placement) return node
        const next = placed(node, placement, before)
        if (next !== node) changed = true
        return next
      })
      // A cycle can only come from the new nesting, so drop every re-nesting
      // placement: the tree it came from had none.
      if (findParentCycleBreaks(view.nodes).size > 0) {
        view.nodes = view.nodes.map((n) => (n.parentId === before.get(n.id)?.parentId ? n : before.get(n.id)!))
      }
      return changed
    })
  }

  removeNode(path: ViewPath, nodeId: string): boolean {
    return this.removeElements(path, [nodeId], [])
  }

  /**
   * Remove nodes and edges together. A removed node takes its edges with it; a
   * removed group keeps its children, which move up to the nearest surviving
   * ancestor without moving on the canvas. A detail left with nothing in it is
   * dropped with its last node.
   */
  removeElements(path: ViewPath, nodeIds: Iterable<string>, edgeIds: Iterable<string>): boolean {
    const removedNodes = new Set(nodeIds)
    const removedEdges = new Set(edgeIds)
    return this.write(path, (view) => {
      const byId = new Map(view.nodes.map((n) => [n.id, n]))
      const nodes = view.nodes
        .filter((n) => !removedNodes.has(n.id))
        .map((n) => (n.parentId && removedNodes.has(n.parentId) ? liftOutOf(n, removedNodes, byId) : n))
      const edges = view.edges.filter(
        (e) => !removedEdges.has(e.id) && !removedNodes.has(e.source) && !removedNodes.has(e.target),
      )
      if (nodes.length === view.nodes.length && edges.length === view.edges.length) return false
      view.nodes = nodes
      view.edges = edges
      return true
    })
  }

  /** Drop a root node's detail sub-diagram and everything in it. */
  removeDetail(nodeId: string): boolean {
    return this.replaceNode(ROOT_VIEW, nodeId, (node) => {
      if (!node.detail) return node
      const { detail: _detail, ...rest } = node
      return rest
    })
  }

  // ── Edges ────────────────────────────────────────────────────────────────

  addEdge(path: ViewPath, edge: DiagramEdge): boolean {
    return this.write(path, (view) => {
      if (view.edges.some((e) => e.id === edge.id)) return false
      if (!view.nodes.some((n) => n.id === edge.source) || !view.nodes.some((n) => n.id === edge.target)) return false
      view.edges.push(structuredClone(edge))
      return true
    })
  }

  updateEdge(path: ViewPath, edgeId: string, changes: EdgeChanges): boolean {
    const patch: Partial<DiagramEdge> = { ...changes }
    for (const key of EDGE_FIXED_KEYS) delete patch[key]
    return this.replaceEdge(path, edgeId, (edge) => withChanges(edge, structuredClone(patch)))
  }

  reconnectEdge(path: ViewPath, edgeId: string, ends: EdgeEnds): boolean {
    const nodes = this.view(path).nodes
    if (!nodes.some((n) => n.id === ends.source) || !nodes.some((n) => n.id === ends.target)) return false
    return this.replaceEdge(path, edgeId, (edge) =>
      withChanges(edge, {
        source: ends.source,
        target: ends.target,
        sourceHandle: ends.sourceHandle,
        targetHandle: ends.targetHandle,
      }),
    )
  }

  removeEdge(path: ViewPath, edgeId: string): boolean {
    return this.removeElements(path, [], [edgeId])
  }

  // ── Layout ───────────────────────────────────────────────────────────────

  /**
   * Lay one level out again in `direction`. Manual bends and pinned handles
   * describe the old placement, so they go; every other field stays.
   */
  applyLayout(path: ViewPath, direction: LayoutDirection, measured?: ReadonlyMap<string, NodeSize>): boolean {
    return this.write(path, (view) => {
      const unpinned: DiagramDoc = {
        nodes: view.nodes,
        edges: view.edges.map(({ bendOffset: _b, bendAxis: _a, sourceHandle: _s, targetHandle: _t, ...edge }) => edge),
      }
      const laid = reapplyLayout(unpinned, direction, { measured })
      view.nodes = laid.nodes
      view.edges = laid.edges
      return true
    })
  }

  /**
   * Give positions to the nodes of a level that has none, as opening the level
   * requires. This is not an edit: it records no undo step, but the new
   * positions are content and are reported for saving.
   */
  normalizeView(path: ViewPath): boolean {
    const view = this.view(path)
    if (!view.nodes.some((n) => !n.position)) return false
    const laid = applyLayout({ nodes: [...view.nodes], edges: [...view.edges] })
    this.setView(path, laid)
    this.history.rebase(this.doc)
    this.onChange('normalize')
    return true
  }

  // ── History and replacement ──────────────────────────────────────────────

  /** Undo one step. Returns the level where it happened, or null when there is nothing to undo. */
  undo(): ViewPath | null {
    return this.restore(this.history.undo(), 'undo')
  }

  redo(): ViewPath | null {
    return this.restore(this.history.redo(), 'redo')
  }

  /**
   * Take accepted content from outside (a reload of a clean editor). The
   * local undo steps described the old content, so they go with it.
   */
  replace(doc: DiagramDoc): void {
    this.doc = structuredClone(doc)
    this.history.reset(this.doc)
    this.pendingEdit = null
  }

  /**
   * Take a live diagram's content after someone else changed it. Nodes and
   * edges that did not change keep their identity, so the canvas redraws only
   * what moved. The reader's own undo steps stay: they undo only their edits.
   */
  adopt(next: DiagramDoc): void {
    this.doc = reconcileDoc(this.doc, next)
    this.onChange('remote')
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private restore(snapshot: ReturnType<DiagramUndoHistory['undo']>, change: DiagramChange): ViewPath | null {
    if (!snapshot) return null
    this.doc = snapshot.doc
    this.onChange(change)
    const owner = snapshot.viewId ? this.doc.nodes.find((n) => n.id === snapshot.viewId) : undefined
    return owner?.detail ? [owner.id] : ROOT_VIEW
  }

  private replaceNode(path: ViewPath, nodeId: string, change: (node: DiagramNode) => DiagramNode): boolean {
    return this.write(path, (view) => {
      const index = view.nodes.findIndex((n) => n.id === nodeId)
      if (index < 0) return false
      const next = change(view.nodes[index])
      if (next === view.nodes[index]) return false
      view.nodes[index] = next
      return true
    })
  }

  private replaceEdge(path: ViewPath, edgeId: string, change: (edge: DiagramEdge) => DiagramEdge): boolean {
    return this.write(path, (view) => {
      const index = view.edges.findIndex((e) => e.id === edgeId)
      if (index < 0) return false
      const next = change(view.edges[index])
      if (next === view.edges[index]) return false
      view.edges[index] = next
      return true
    })
  }

  /**
   * Run a change against fresh copies of one level's arrays and store the
   * result as new objects. A change in a detail also replaces its owner node,
   * so no earlier read-only view ever changes under its holder.
   */
  private write(path: ViewPath, change: (view: DiagramDoc) => boolean): boolean {
    if (path.length > 0 && !this.doc.nodes.some((n) => n.id === path[0])) return false
    const current = this.view(path)
    const draft: DiagramDoc = { nodes: [...current.nodes], edges: [...current.edges] }
    if (!change(draft)) return false
    this.setView(path, draft)
    if (this.editDepth > 0) this.pendingEdit = path
    else this.commit(path)
    return true
  }

  private setView(path: ViewPath, view: DiagramDoc): void {
    if (path.length === 0) {
      this.doc = view
      return
    }
    const ownerId = path[0]
    this.doc = {
      nodes: this.doc.nodes.map((n) => {
        if (n.id !== ownerId) return n
        if (view.nodes.length > 0) return { ...n, detail: view }
        const { detail: _detail, ...rest } = n
        return rest
      }),
      edges: this.doc.edges,
    }
  }

  private commit(path: ViewPath): void {
    this.history.record(this.doc, path[0])
    this.onChange('edit')
  }
}

/** `next`, reusing each object of `previous` that is equal to its counterpart. */
function reconcileDoc(previous: DiagramDoc, next: DiagramDoc): DiagramDoc {
  const nodes = new Map(previous.nodes.map((node) => [node.id, node]))
  const edges = new Map(previous.edges.map((edge) => [edge.id, edge]))
  return {
    nodes: next.nodes.map((node) => {
      const before = nodes.get(node.id)
      if (!before) return node
      const detail = node.detail && before.detail ? reconcileDoc(before.detail, node.detail) : node.detail
      const candidate = detail === node.detail ? node : { ...node, detail }
      return JSON.stringify(before) === JSON.stringify(candidate) ? before : candidate
    }),
    edges: next.edges.map((edge) => {
      const before = edges.get(edge.id)
      return before && JSON.stringify(before) === JSON.stringify(edge) ? before : edge
    }),
  }
}

/** A copy with `changes` applied; an `undefined` value clears the field. */
function withChanges<T extends object>(item: T, changes: Partial<T>): T {
  const next = { ...item }
  let changed = false
  // SAFETY: `changes` is a Partial<T>, so each of its own keys is a key of T.
  for (const key of Object.keys(changes) as (keyof T)[]) {
    const value = changes[key]
    if (value === undefined) {
      if (!(key in next)) continue
      delete next[key]
    } else {
      if (Object.is(next[key], value)) continue
      // SAFETY: `value` was read from changes[key] and is not undefined here.
      next[key] = value as T[keyof T]
    }
    changed = true
  }
  return changed ? next : item
}

function placed(node: DiagramNode, placement: NodePlacement, byId: Map<string, DiagramNode>): DiagramNode {
  const changes: Partial<DiagramNode> = {}
  if (placement.position) {
    const { x, y } = placement.position
    if (node.position?.x !== x || node.position?.y !== y) changes.position = { x, y }
  }
  if (placement.width !== undefined) changes.width = placement.width
  if (placement.height !== undefined) changes.height = placement.height
  if (placement.parentId === null) changes.parentId = undefined
  else if (placement.parentId !== undefined && placement.parentId !== node.id && byId.get(placement.parentId)?.group) {
    changes.parentId = placement.parentId
  }
  return withChanges(node, changes)
}

// A child of a removed group, re-expressed in the frame of its nearest
// surviving ancestor so it stays where it was drawn.
function liftOutOf(node: DiagramNode, removed: Set<string>, byId: Map<string, DiagramNode>): DiagramNode {
  let x = node.position?.x ?? 0
  let y = node.position?.y ?? 0
  let ancestor = node.parentId ? byId.get(node.parentId) : undefined
  while (ancestor && removed.has(ancestor.id)) {
    x += ancestor.position?.x ?? 0
    y += ancestor.position?.y ?? 0
    ancestor = ancestor.parentId ? byId.get(ancestor.parentId) : undefined
  }
  const { parentId: _parentId, ...rest } = node
  return ancestor ? { ...rest, parentId: ancestor.id, position: { x, y } } : { ...rest, position: { x, y } }
}
