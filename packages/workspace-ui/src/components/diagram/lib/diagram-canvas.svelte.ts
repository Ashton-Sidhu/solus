import type { Edge, Node, useSvelteFlow } from "@xyflow/svelte";
import type { DiagramEdge, DiagramNode } from "@solus/contracts/diagram-types";
import type { LayoutDirection } from "@solus/contracts/diagram-layout";
import {
  ROOT_VIEW,
  type DiagramDocument,
  type EdgeChanges,
  type EdgeEnds,
  type NodeChanges,
  type NodePlacement,
  type Point,
  type ViewPath,
} from "./diagram-document";
import { flowNodeToDiagram } from "../diagram-flow-map";
import { toFlowEdges, toFlowNodes } from "./flow-builders";
import { absoluteBox, autoGrowGroups, GROUP_H, GROUP_W, orderParentsFirst } from "./graph-layout";
import { arrangeNodes, type Arrangement } from "./selection-arrangement";
import { buildClipboardPaste, setDiagramClipboard } from "./clipboard.svelte";
import { anchorNodeId } from "./inspector-model";
import type { PinSummary } from "./comment-threads";

export type FlowControls = ReturnType<typeof useSvelteFlow>;

export interface DiagramFlowNodeData extends DiagramNode {
  expanded?: boolean;
  dimmed?: boolean;
  commentPin?: PinSummary | null;
}

export function diagramNodeData(node: Node): DiagramFlowNodeData {
  // SAFETY: every flow node on the canvas is projected from a DiagramNode by toFlowNodes.
  const data = node.data as Partial<DiagramFlowNodeData>;
  // SAFETY: the same projection always sets `id` and `label`, the two required fields.
  return data as DiagramFlowNodeData;
}

export function diagramEdgeData(edge: Edge): Partial<DiagramEdge> {
  // SAFETY: every flow edge on the canvas is projected from a DiagramEdge by toFlowEdges.
  return (edge.data ?? {}) as Partial<DiagramEdge>;
}

export interface DrillCrumb { id: string; label: string }

const NEW_NODE_ZOOM_STEP = 0.3;
const NEW_NODE_ZOOM_CAP = 1.5;

interface CanvasOptions {
  document: DiagramDocument;
  /** Callbacks every projected node carries back to the shell. */
  nodeHandlers: object;
  edgeHandlers: object;
  /** The comment pin a node wears, from the diagram's threads. */
  pinFor: (nodeId: string) => PinSummary | null;
  /** A level was entered or left. Overlays anchored to the old level close; the node it mounted with selected, if any, is named. */
  onLevelChange: (selectedNodeId: string | null) => void;
  /** Set when the diagram arrived without positions and was laid out on load. */
  initialLayout: LayoutDirection | null;
}

/**
 * The canvas of one open diagram. It projects the level the reader is on from
 * the `DiagramDocument` into xyflow nodes and edges, and turns what the reader
 * does on the canvas into document commands. After each command only the
 * nodes and edges whose content changed are projected again; the rest keep the
 * objects xyflow already drew (and their selection and measured size).
 *
 * Everything else here is view state — the level, focus, search dimming,
 * expanded cards, the layout read-out — and never reaches the document.
 */
export class DiagramCanvas {
  nodes = $state.raw<Node[]>([]);
  edges = $state.raw<Edge[]>([]);
  path = $state.raw<ViewPath>(ROOT_VIEW);
  drillPath = $state.raw<DrillCrumb[]>([]);
  focusedNodeId = $state<string | null>(null);
  // Null until a layout is actually applied: authored positions had no
  // direction, so no option should read as "current".
  layoutDirection = $state<LayoutDirection | null>(null);
  // Cleared once a node is placed by hand: the graph is then part auto, part
  // hand-placed, and the status pill should say so.
  layoutPristine = $state(false);
  flow: FlowControls | null = null;

  readonly document: DiagramDocument;
  private readonly options: CanvasOptions;
  private readonly expandedNodeIds = new Set<string>();
  private matchedNodeIds: Set<string> | null = null;
  // The document objects each projected node and edge was built from. Same
  // object = same content, so its flow object is reused as-is.
  private nodeSources = new Map<string, DiagramNode>();
  private edgeSources = new Map<string, DiagramEdge>();

  constructor(options: CanvasOptions) {
    this.options = options;
    this.document = options.document;
    this.layoutDirection = options.initialLayout;
    this.layoutPristine = options.initialLayout !== null;
    this.project();
  }

  get isNested(): boolean { return this.path.length > 0; }

  // ── Projection ───────────────────────────────────────────────────────────

  /** Bring the canvas in line with the document at the current level. */
  project() {
    const view = this.document.view(this.path);
    const previousNodes = new Map(this.nodes.map((n) => [n.id, n]));
    const previousEdges = new Map(this.edges.map((e) => [e.id, e]));
    const nodeSources = new Map<string, DiagramNode>();
    const edgeSources = new Map<string, DiagramEdge>();
    const nodes = view.nodes.map((source) => {
      nodeSources.set(source.id, source);
      const previous = previousNodes.get(source.id);
      if (previous && this.nodeSources.get(source.id) === source) return previous;
      const [node] = toFlowNodes([source], this.expandedNodeIds, this.options.nodeHandlers);
      if (previous?.selected) node.selected = true;
      if (previous?.measured) node.measured = previous.measured;
      return node;
    });
    const edges = view.edges.map((source) => {
      edgeSources.set(source.id, source);
      const previous = previousEdges.get(source.id);
      if (previous && this.edgeSources.get(source.id) === source) return previous;
      const [edge] = toFlowEdges([source], this.options.edgeHandlers);
      if (previous?.selected) edge.selected = true;
      return edge;
    });
    this.nodeSources = nodeSources;
    this.edgeSources = edgeSources;
    // Parents ahead of children (an xyflow rule); this also settles resting z.
    this.nodes = orderParentsFirst(nodes);
    this.edges = edges;
    this.recomputeHidden();
    this.applyTransientState();
  }

  /**
   * Re-derive the view-only flags (expanded, dimmed, comment pin). Only nodes
   * whose flags change are reallocated, so a focus or search toggle does not
   * re-render the whole graph.
   */
  applyTransientState() {
    let neighborIds: Set<string> | null = null;
    const focused = this.focusedNodeId;
    if (focused !== null) {
      neighborIds = new Set<string>();
      for (const e of this.edges) {
        if (e.source === focused) neighborIds.add(e.target);
        if (e.target === focused) neighborIds.add(e.source);
      }
    }
    this.nodes = this.nodes.map((n) => {
      const expanded = this.expandedNodeIds.has(n.id);
      const focusDimmed = neighborIds !== null && n.id !== focused && !neighborIds.has(n.id);
      const searchDimmed = this.matchedNodeIds !== null && !this.matchedNodeIds.has(n.id);
      const dimmed = focusDimmed || searchDimmed;
      const pin = this.options.pinFor(n.id);
      const current = diagramNodeData(n).commentPin;
      if (
        n.data.expanded === expanded &&
        n.data.dimmed === dimmed &&
        current?.tone === pin?.tone &&
        current?.count === pin?.count &&
        current?.unread === pin?.unread
      ) {
        return n;
      }
      return { ...n, data: { ...n.data, expanded, dimmed, commentPin: pin } };
    });
  }

  // A node is hidden while any ancestor group is collapsed; an edge while
  // either end is. Derived from each group's `collapsed`, never saved.
  private recomputeHidden() {
    const byId = new Map(this.nodes.map((n) => [n.id, n]));
    const isHidden = (n: Node): boolean => {
      let p = n.parentId ? byId.get(n.parentId) : undefined;
      while (p) {
        if (p.data.group && p.data.collapsed) return true;
        p = p.parentId ? byId.get(p.parentId) : undefined;
      }
      return false;
    };
    const hiddenIds = new Set<string>();
    this.nodes = this.nodes.map((n) => {
      const h = isHidden(n);
      if (h) hiddenIds.add(n.id);
      return (n.hidden ?? false) === h ? n : { ...n, hidden: h };
    });
    this.edges = this.edges.map((e) => {
      const h = hiddenIds.has(e.source) || hiddenIds.has(e.target);
      return (e.hidden ?? false) === h ? e : { ...e, hidden: h };
    });
  }

  toggleExpanded(nodeId: string) {
    if (this.expandedNodeIds.has(nodeId)) this.expandedNodeIds.delete(nodeId);
    else this.expandedNodeIds.add(nodeId);
    this.applyTransientState();
  }

  toggleFocus(nodeId: string) {
    this.focusedNodeId = this.focusedNodeId === nodeId ? null : nodeId;
    this.applyTransientState();
  }

  /** In focus mode, clicking another card walks the focus there. */
  moveFocusTo(nodeId: string) {
    if (this.focusedNodeId === null || this.focusedNodeId === nodeId) return;
    this.focusedNodeId = nodeId;
    this.applyTransientState();
  }

  clearFocus() {
    this.focusedNodeId = null;
    this.applyTransientState();
  }

  setSearchMatches(ids: Set<string> | null) {
    this.matchedNodeIds = ids;
    this.applyTransientState();
  }

  nodeLabel(nodeId: string): string | null {
    const node = this.nodes.find((candidate) => candidate.id === nodeId);
    return node ? diagramNodeData(node).label : null;
  }

  // ── Selection (view state) ───────────────────────────────────────────────

  selectOnly(nodeId: string) {
    this.nodes = this.nodes.map((n) =>
      (n.selected ?? false) === (n.id === nodeId) ? n : { ...n, selected: n.id === nodeId },
    );
  }

  deselectNodes() {
    this.nodes = this.nodes.map((n) => (n.selected ? { ...n, selected: false } : n));
  }

  deselectEdges() {
    this.edges = this.edges.map((e) => (e.selected ? { ...e, selected: false } : e));
  }

  selectAll() {
    this.nodes = this.nodes.map((n) => (n.selected ? n : { ...n, selected: true }));
    this.edges = this.edges.map((e) => (e.selected ? e : { ...e, selected: true }));
  }

  selectedNodeIds(): string[] { return this.nodes.filter((n) => n.selected).map((n) => n.id); }
  selectedEdgeIds(): string[] { return this.edges.filter((e) => e.selected).map((e) => e.id); }

  /** Centre a node at the current zoom (xyflow's setCenter would jump to max zoom) and select it. */
  revealNode(nodeId: string) {
    const byId = new Map(this.nodes.map((n) => [n.id, n]));
    const node = byId.get(nodeId);
    if (!node || !this.flow) return; // deleted, or on another level
    const box = absoluteBox(node, byId);
    this.selectOnly(nodeId);
    void this.flow.setCenter(box.x + box.w / 2, box.y + box.h / 2, {
      zoom: this.flow.getViewport().zoom,
      duration: 300,
    });
  }

  // ── Levels ───────────────────────────────────────────────────────────────

  /** Enter a node's detail sub-diagram. One level only; a node without detail is ignored. */
  drillInto(nodeId: string) {
    const node = this.isNested ? undefined : this.document.node(ROOT_VIEW, nodeId);
    if (node?.detail) this.enterDetail(node);
  }

  /** Open a node's detail, starting an empty one to fill in. Groups have none. */
  openOrCreateDetail(nodeId: string) {
    const node = this.isNested ? undefined : this.document.node(ROOT_VIEW, nodeId);
    if (node && !node.group) this.enterDetail(node);
  }

  /** Go back up the breadcrumb to `depth` (0 = root), reselecting the node drilled from. */
  drillTo(depth: number) {
    if (depth >= this.path.length) return;
    const drilledFrom = this.path[depth];
    this.path = ROOT_VIEW;
    this.drillPath = this.drillPath.slice(0, depth);
    this.loadLevel(drilledFrom);
  }

  private enterDetail(node: Readonly<DiagramNode>) {
    this.path = [node.id];
    this.drillPath = [{ id: node.id, label: node.label || "Detail" }];
    // A detail authored without positions gets them now; that is not an edit.
    this.document.normalizeView(this.path);
    this.loadLevel(anchorNodeId(this.document.view(this.path)));
  }

  /** The document was replaced by accepted saved content. Keep the reader's
   *  level and viewport; a detail that no longer exists returns to the root. */
  showReplacedDocument() {
    const ownerId = this.path[0];
    if (ownerId !== undefined && !this.document.node(ROOT_VIEW, ownerId)?.detail) {
      this.drillTo(0);
      return;
    }
    this.project();
  }

  /** Reset view state and draw the current level afresh, fitted once laid out. */
  loadLevel(selectId?: string | null) {
    this.expandedNodeIds.clear();
    this.focusedNodeId = null;
    this.matchedNodeIds = null;
    this.nodes = [];
    this.edges = [];
    this.nodeSources.clear();
    this.edgeSources.clear();
    this.project();
    const selected = selectId && this.nodes.some((n) => n.id === selectId) ? selectId : null;
    if (selected) this.selectOnly(selected);
    this.options.onLevelChange(selected);
    requestAnimationFrame(() => void this.flow?.fitView({ duration: 300, padding: 0.2 }));
  }

  // ── Undo ─────────────────────────────────────────────────────────────────

  undo() { this.restore(this.document.undo()); }
  redo() { this.restore(this.document.redo()); }

  // An undo on this level keeps the reader's place; one made on another level
  // takes them there.
  private restore(path: ViewPath | null) {
    if (!path) return;
    if (path[0] === this.path[0]) {
      this.project();
      return;
    }
    this.path = path;
    this.drillPath = path.length
      ? [{ id: path[0], label: this.document.node(ROOT_VIEW, path[0])?.label || "Detail" }]
      : [];
    this.loadLevel();
  }

  // ── Content commands ─────────────────────────────────────────────────────

  updateNode(nodeId: string, changes: NodeChanges) {
    if (this.document.updateNode(this.path, nodeId, changes)) this.project();
  }

  updateEdge(edgeId: string, changes: EdgeChanges) {
    if (this.document.updateEdge(this.path, edgeId, changes)) this.project();
  }

  reconnectEdge(edgeId: string, ends: EdgeEnds) {
    if (this.document.reconnectEdge(this.path, edgeId, ends)) this.project();
  }

  addEdge(edge: DiagramEdge) {
    if (this.document.addEdge(this.path, edge)) this.project();
  }

  /** Swap the ends; pinned handles go with them so the sides stay the same. */
  reverseEdge(edgeId: string) {
    const edge = this.document.edge(this.path, edgeId);
    if (!edge) return;
    this.reconnectEdge(edgeId, {
      source: edge.target,
      target: edge.source,
      sourceHandle: edge.targetHandle,
      targetHandle: edge.sourceHandle,
    });
  }

  removeElements(nodeIds: Iterable<string>, edgeIds: Iterable<string>) {
    if (this.document.removeElements(this.path, nodeIds, edgeIds)) this.project();
  }

  removeDetail(nodeId: string) {
    if (this.document.removeDetail(nodeId)) this.project();
  }

  /** Fold a group to its header, or open it again. The saved height stays for the restore. */
  toggleCollapse(groupId: string) {
    const group = this.document.node(this.path, groupId);
    if (group?.group) this.updateNode(groupId, { collapsed: !group.collapsed || undefined });
  }

  /** Pin nodes to the back layer, or bring them forward again. */
  setSentToBack(nodeIds: Iterable<string>, value: boolean) {
    const changed = this.document.edit(() => {
      let any = false;
      for (const id of nodeIds) any = this.document.updateNode(this.path, id, { sentToBack: value || undefined }) || any;
      return any;
    });
    if (changed) this.project();
  }

  /** Detach a child from its group without moving it on the canvas. */
  removeFromGroup(nodeId: string) {
    const child = this.nodes.find((n) => n.id === nodeId);
    if (!child?.parentId) return;
    const parent = this.nodes.find((n) => n.id === child.parentId);
    const position = {
      x: child.position.x + (parent?.position.x ?? 0),
      y: child.position.y + (parent?.position.y ?? 0),
    };
    if (this.document.setParent(this.path, nodeId, null, position)) this.project();
  }

  /**
   * Add a node, selected. With exactly one group selected (and no drop point)
   * it lands inside that group; otherwise at `at` or the centre of the graph.
   * Returns the new id.
   */
  addNode(at?: Point): string {
    const id = `node-${Date.now()}`;
    const selectedGroups = this.nodes.filter((n) => n.selected && n.data.group);
    const parent = !at && selectedGroups.length === 1 ? selectedGroups[0] : null;
    const node: DiagramNode = {
      id,
      label: "New Node",
      icon: "service",
      position: parent ? { x: 24, y: 56 } : (at ?? this.canvasCentre()),
    };
    if (parent) node.parentId = parent.id;
    this.document.addNode(this.path, node);
    this.project();
    this.selectOnly(id);
    this.zoomToward(id);
    return id;
  }

  addGroup(at?: Point): string {
    const id = `group-${Date.now()}`;
    const centre = at ?? this.canvasCentre();
    this.document.addNode(this.path, {
      id,
      label: "New Group",
      icon: "group",
      group: true,
      width: GROUP_W,
      height: GROUP_H,
      position: { x: centre.x - GROUP_W / 2, y: centre.y - GROUP_H / 2 },
    });
    this.project();
    this.selectOnly(id);
    return id;
  }

  copySelection() {
    // Canvas order puts parents first, so a paste can nest children again.
    const ids = this.selectedNodeIds();
    if (!ids.length) return;
    const selected = new Set(ids);
    const view = this.document.view(this.path);
    const byId = new Map(view.nodes.map((n) => [n.id, n]));
    setDiagramClipboard(
      ids.flatMap((id) => byId.get(id) ?? []),
      view.edges.filter((e) => selected.has(e.source) && selected.has(e.target)),
    );
  }

  paste() {
    const pasted = buildClipboardPaste();
    if (!pasted) return;
    this.document.edit(() => {
      for (const node of pasted.nodes) this.document.addNode(this.path, node);
      for (const edge of pasted.edges) this.document.addEdge(this.path, edge);
    });
    this.project();
    const pastedIds = new Set(pasted.nodes.map((n) => n.id));
    this.nodes = this.nodes.map((n) =>
      (n.selected ?? false) === pastedIds.has(n.id) ? n : { ...n, selected: pastedIds.has(n.id) },
    );
    this.deselectEdges();
  }

  duplicateSelection() {
    this.copySelection();
    this.paste();
  }

  /** Arrow keys move the selection; with nothing selected they pan the board. */
  nudgeOrPan(dx: number, dy: number, panDx: number, panDy: number) {
    const selected = this.nodes.filter((n) => n.selected);
    if (!selected.length) {
      if (!this.flow) return;
      const viewport = this.flow.getViewport();
      void this.flow.setViewport({ ...viewport, x: viewport.x + panDx, y: viewport.y + panDy }, { duration: 120 });
      return;
    }
    this.document.edit(() => {
      for (const n of selected) {
        this.document.moveNode(this.path, n.id, { x: n.position.x + dx, y: n.position.y + dy });
      }
    });
    this.project();
  }

  arrange(action: Arrangement): boolean {
    const arranged = arrangeNodes(this.nodes, action);
    if (arranged === this.nodes) return false;
    this.layoutPristine = false;
    const groups = new Set(arranged.filter((n) => n.data.group).reverse().map((n) => n.id));
    this.commitGeometry(autoGrowGroups(arranged, groups));
    return true;
  }

  relayout(direction: LayoutDirection = this.layoutDirection ?? "LR") {
    this.layoutDirection = direction;
    this.layoutPristine = true;
    const measured = new Map(
      this.nodes
        .filter((n) => !n.data.group && n.measured?.width && n.measured?.height)
        .map((n) => [n.id, { w: n.measured!.width!, h: n.measured!.height! }]),
    );
    this.document.applyLayout(this.path, direction, measured);
    this.project();
  }

  /**
   * Save the geometry a gesture resolved on the canvas: every drawn position,
   * parent and size that differs from the document, as one command.
   */
  commitGeometry(drawn: readonly Node[]) {
    const placements = new Map<string, NodePlacement>();
    for (const node of drawn) {
      const saved = this.document.node(this.path, node.id);
      if (!saved) continue;
      const size = flowNodeToDiagram(node);
      const placement: NodePlacement = {};
      const reparented = (node.parentId ?? null) !== (saved.parentId ?? null);
      if (reparented) placement.parentId = node.parentId ?? null;
      if (reparented || node.position.x !== saved.position?.x || node.position.y !== saved.position?.y) {
        placement.position = node.position;
      }
      if (size.width !== undefined && size.width !== saved.width) placement.width = size.width;
      if (size.height !== undefined && size.height !== saved.height) placement.height = size.height;
      if (Object.keys(placement).length) placements.set(node.id, placement);
    }
    this.document.placeNodes(this.path, placements);
    // Always re-project: it also drops the lift a drag gave the moved nodes.
    this.project();
  }

  // Centre of the top-level content, so a new node lands near the graph.
  // Children are parent-relative and would skew the average.
  private canvasCentre(): Point {
    const top = this.nodes.filter((n) => !n.parentId);
    if (!top.length) return { x: 120, y: 120 };
    const xs = top.map((n) => n.position.x);
    const ys = top.map((n) => n.position.y);
    return {
      x: (Math.min(...xs) + Math.max(...xs)) / 2,
      y: (Math.min(...ys) + Math.max(...ys)) / 2,
    };
  }

  // Gently centre and enlarge a new node without disturbing input focus.
  private zoomToward(nodeId: string) {
    const controls = this.flow;
    if (!controls) return;
    const byId = new Map(this.nodes.map((n) => [n.id, n]));
    const node = byId.get(nodeId);
    if (!node) return;
    const box = absoluteBox(node, byId);
    const currentZoom = controls.getViewport().zoom;
    const zoom =
      currentZoom >= NEW_NODE_ZOOM_CAP ? currentZoom : Math.min(currentZoom + NEW_NODE_ZOOM_STEP, NEW_NODE_ZOOM_CAP);
    requestAnimationFrame(() => {
      void controls.setCenter(box.x + box.w / 2, box.y + box.h / 2, { zoom, duration: 300 });
    });
  }
}
