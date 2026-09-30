import type { Connection, Edge, Node, OnConnectEnd } from "@xyflow/svelte";
import type { DiagramEdge } from "@solus/contracts/diagram-types";
import { diagramEdgeData, type DiagramCanvas } from "./diagram-canvas.svelte";
import {
  absoluteBox,
  applyMembership,
  autoGrowGroups,
  centreOf,
  deepestGroupAt,
  groupMembershipUpdates,
  isSelfOrDescendant,
  pointInBox,
  pruneCyclicMemberships,
  sizeStyle,
  type Membership,
} from "./graph-layout";

type Pointer = { x: number; y: number };
type ResizeBox = { x: number; y: number; width: number; height: number };
type FinalConnectionState = Parameters<OnConnectEnd>[1];

// Lift a dragged subtree above the z-bands so it rides on top of whatever it
// is dragged over. The drop's re-projection restores resting z.
const DRAG_Z = 10000;
// Below this travel an endpoint drag reads as a click on the grab dot, not a
// rewire — otherwise a stray click would turn the end floating.
const RECONNECT_CLICK_TOLERANCE = 8;

function pointerOf(event: MouseEvent | TouchEvent): Pointer | null {
  if ("changedTouches" in event) {
    const t = event.changedTouches[0];
    return t ? { x: t.clientX, y: t.clientY } : null;
  }
  return { x: event.clientX, y: event.clientY };
}

function edgeFrom(connection: Connection): DiagramEdge {
  const edge: DiagramEdge = {
    id: `e-${connection.source}-${connection.target}-${Date.now()}`,
    source: connection.source,
    target: connection.target,
  };
  // An end without a handle (dropped on a node body) floats to the facing side.
  if (connection.sourceHandle) edge.sourceHandle = connection.sourceHandle;
  if (connection.targetHandle) edge.targetHandle = connection.targetHandle;
  return edge;
}

/**
 * What the pointer does on the canvas: dragging, resizing, connecting and
 * rewiring. While a gesture runs its geometry lives only on the projected
 * nodes and edges (and the drop hints on their DOM); it reaches the document
 * once, as one command, when the gesture ends.
 */
export class CanvasGestures {
  /** The end type a connection drag started from; reveals and filters handles. */
  connectingFrom = $state<"source" | "target" | null>(null);

  private readonly canvas: DiagramCanvas;
  private readonly root: () => HTMLElement | null;
  // xyflow fires onbeforeconnect for a valid handle drop, then onconnectend
  // for the teardown; the node-body fallback there must not add a second edge.
  private completedHandleConnectAt = 0;
  // Pointer-down of an endpoint drag of an existing edge, null when idle.
  private reconnectStart: Pointer | null = null;
  // The edge whose label is being dragged; its commit carries no id.
  private labelDragEdgeId: string | null = null;
  // Drop hints are DOM classes, so a gesture never churns the reactive graph.
  private hintedEls = new Set<HTMLElement>();
  private lastHintSig = "";
  private dragHintRaf = 0;
  private pendingDragNode: Node | null = null;
  private resizeHintRaf = 0;
  private pendingResize: { nodeId: string; box: ResizeBox } | null = null;

  constructor(canvas: DiagramCanvas, root: () => HTMLElement | null) {
    this.canvas = canvas;
    this.root = root;
  }

  // ── Drag ─────────────────────────────────────────────────────────────────

  // The whole subtree lifts: xyflow re-derives a child's z only on structural
  // changes, so lifting a group alone would paint its box over its children.
  dragStart(node: Node) {
    const byId = new Map(this.canvas.nodes.map((n) => [n.id, n]));
    this.canvas.nodes = this.canvas.nodes.map((n) =>
      isSelfOrDescendant(n.id, node.id, byId) ? { ...n, zIndex: DRAG_Z } : n,
    );
  }

  // Throttled to a frame: pointermove can outrun paint, and only the latest
  // position matters for the highlight.
  drag(node: Node) {
    this.pendingDragNode = node;
    if (this.dragHintRaf) return;
    this.dragHintRaf = requestAnimationFrame(() => {
      this.dragHintRaf = 0;
      const n = this.pendingDragNode;
      this.pendingDragNode = null;
      if (n) this.showDragHints(n);
    });
  }

  /**
   * Drop: every dragged node re-nests by its own centre, a dragged open group
   * swallows same-level nodes under it, and groups grow around what landed in
   * them. Moves, nesting and growth are one undo step.
   */
  dragStop(node: Node) {
    this.clearDropHints();
    this.canvas.layoutPristine = false;
    const nodes = this.canvas.nodes;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const dragged = byId.get(node.id);
    if (!dragged) return;
    const updates = new Map<string, Membership>();
    // Inner (swallowing) groups first, then the landing parent, so a parent
    // grows to fit a child group that just grew.
    const grow = new Set<string>();
    // Dragging an unselected node moves only it.
    const moving = dragged.selected ? nodes.filter((n) => n.selected) : [dragged];
    for (const m of moving) {
      // A folded group is a header chip: it neither swallows nor grows.
      if (m.data.group && !m.data.collapsed) {
        for (const [id, u] of groupMembershipUpdates(m, nodes, byId, { swallow: true, eject: false })) {
          if (!moving.some((x) => x.id === id)) updates.set(id, u);
        }
        grow.add(m.id);
      }
      const landed = this.resolveNesting(m, nodes, byId, updates);
      if (landed) grow.add(landed);
    }
    // A drag that both swallows a group and nests into it would close a cycle.
    pruneCyclicMemberships(updates, byId);
    this.canvas.commitGeometry(autoGrowGroups(applyMembership(nodes, updates), grow));
  }

  // Into the deepest group under the node's centre, or out onto the level.
  private resolveNesting(
    n: Node,
    nodes: Node[],
    byId: Map<string, Node>,
    updates: Map<string, Membership>,
  ): string | undefined {
    const box = absoluteBox(n, byId);
    const target = deepestGroupAt(nodes, box.x + box.w / 2, box.y + box.h / 2, n.id, byId);
    const currentParent = n.parentId ?? undefined;
    if ((target?.id ?? undefined) === currentParent) return currentParent;
    if (target) {
      const g = absoluteBox(target, byId);
      updates.set(n.id, { parentId: target.id, position: { x: box.x - g.x, y: box.y - g.y } });
      return target.id;
    }
    updates.set(n.id, { parentId: undefined, position: { x: box.x, y: box.y } });
    return undefined;
  }

  private showDragHints(node: Node) {
    const nodes = this.canvas.nodes;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const memberIds = new Set<string>();
    const ejectIds = new Set<string>();
    let targetId: string | null = null;
    if (node.data.group && !node.data.collapsed) {
      for (const [id] of groupMembershipUpdates(node, nodes, byId, { swallow: true, eject: false })) memberIds.add(id);
    } else if (!node.data.group) {
      const { cx, cy } = centreOf(node, byId);
      const target = deepestGroupAt(nodes, cx, cy, node.id, byId);
      targetId = target?.id ?? null;
      const current = node.parentId ?? undefined;
      if (current && (target?.id ?? undefined) !== current) ejectIds.add(node.id);
    }
    this.applyHints(targetId, memberIds, ejectIds);
  }

  // ── Resize ───────────────────────────────────────────────────────────────

  /**
   * End of a resize. xyflow already moved the origin for a top/left handle. A
   * group re-resolves membership against its new box — swallowing what it grew
   * over, ejecting what it shrank off — without auto-growing past the size the
   * user chose.
   */
  resize(nodeId: string, width: number, height: number) {
    this.clearDropHints();
    let next = this.canvas.nodes.map((n) =>
      n.id === nodeId ? { ...n, width, height, style: sizeStyle(width, height), data: { ...n.data, width, height } } : n,
    );
    const group = next.find((n) => n.id === nodeId);
    if (group?.data.group) {
      const byId = new Map(next.map((n) => [n.id, n]));
      next = applyMembership(next, groupMembershipUpdates(group, next, byId, { swallow: true, eject: true }));
    }
    this.canvas.commitGeometry(next);
  }

  resizeLive(nodeId: string, box: ResizeBox) {
    this.pendingResize = { nodeId, box };
    if (this.resizeHintRaf) return;
    this.resizeHintRaf = requestAnimationFrame(() => {
      this.resizeHintRaf = 0;
      const pending = this.pendingResize;
      this.pendingResize = null;
      if (pending) this.showResizeHints(pending.nodeId, pending.box);
    });
  }

  // The in-flight box is in the group's parent frame; lift it to absolute.
  private showResizeHints(nodeId: string, params: ResizeBox) {
    const nodes = this.canvas.nodes;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const group = byId.get(nodeId);
    if (!group?.data.group) return;
    const abs = absoluteBox(group, byId);
    const box = {
      x: params.x + (abs.x - group.position.x),
      y: params.y + (abs.y - group.position.y),
      w: params.width,
      h: params.height,
    };
    const level = group.parentId ?? undefined;
    const memberIds = new Set<string>();
    const ejectIds = new Set<string>();
    for (const n of nodes) {
      if (n.id === nodeId || isSelfOrDescendant(nodeId, n.id, byId)) continue;
      const b = absoluteBox(n, byId);
      const inside = pointInBox(b.x + b.w / 2, b.y + b.h / 2, box);
      const isChild = (n.parentId ?? undefined) === nodeId;
      if (!isChild && (n.parentId ?? undefined) === level && inside) memberIds.add(n.id);
      else if (isChild && !inside) ejectIds.add(n.id);
    }
    this.applyHints(null, memberIds, ejectIds);
  }

  // ── Drop hints ───────────────────────────────────────────────────────────

  clearDropHints() {
    // A queued frame must not re-apply a stale highlight after the gesture.
    if (this.dragHintRaf) cancelAnimationFrame(this.dragHintRaf);
    if (this.resizeHintRaf) cancelAnimationFrame(this.resizeHintRaf);
    this.dragHintRaf = 0;
    this.resizeHintRaf = 0;
    this.pendingDragNode = null;
    this.pendingResize = null;
    for (const el of this.hintedEls) el.classList.remove("is-drop-target", "is-will-nest", "is-will-eject");
    this.hintedEls.clear();
    this.lastHintSig = "";
  }

  private applyHints(targetId: string | null, memberIds: Set<string>, ejectIds: Set<string>) {
    const sig = `${targetId ?? ""}|${[...memberIds].sort().join(",")}|${[...ejectIds].sort().join(",")}`;
    if (sig === this.lastHintSig) return;
    this.clearDropHints();
    this.lastHintSig = sig;
    if (targetId) this.setNodeHint(targetId, "is-drop-target");
    for (const id of memberIds) this.setNodeHint(id, "is-will-nest");
    for (const id of ejectIds) this.setNodeHint(id, "is-will-eject");
  }

  private setNodeHint(id: string, cls: string) {
    const el = this.root()?.querySelector<HTMLElement>(`.svelte-flow__node[data-id="${id}"]`);
    if (!el) return;
    el.classList.add(cls);
    this.hintedEls.add(el);
  }

  // ── Connect and rewire ───────────────────────────────────────────────────

  connectStart(handleType: "source" | "target" | null | undefined) {
    this.connectingFrom = handleType ?? "source";
  }

  /** A valid handle drop. The edge goes into the document; xyflow adds nothing itself. */
  beforeConnect(connection: Connection): false {
    this.completedHandleConnectAt = Date.now();
    this.canvas.addEdge(edgeFrom(connection));
    return false;
  }

  // A release that missed every handle still connects when it is over a node
  // card: the loose end attaches floating.
  connectEnd(event: MouseEvent | TouchEvent, state: FinalConnectionState) {
    this.connectingFrom = null;
    if (Date.now() - this.completedHandleConnectAt < 1000) {
      this.completedHandleConnectAt = 0;
      return;
    }
    // Endpoint drags of an existing edge end here too; reconnectEnd owns them.
    if (this.reconnectStart) return;
    if (state.isValid || !state.fromNode || !state.fromHandle) return;
    const nodeId = this.nodeIdAtPoint(event);
    if (!nodeId || nodeId === state.fromNode.id) return;
    const fromIsSource = state.fromHandle.type === "source";
    this.canvas.addEdge(
      edgeFrom({
        source: fromIsSource ? state.fromNode.id : nodeId,
        target: fromIsSource ? nodeId : state.fromNode.id,
        sourceHandle: fromIsSource ? state.fromHandle.id ?? null : null,
        targetHandle: fromIsSource ? null : state.fromHandle.id ?? null,
      }),
    );
  }

  /** A valid drop of a dragged endpoint. The document rewires the edge. */
  beforeReconnect(rewired: Edge, previous: Edge): false {
    this.canvas.reconnectEdge(previous.id, {
      source: rewired.source,
      target: rewired.target,
      sourceHandle: rewired.sourceHandle ?? undefined,
      targetHandle: rewired.targetHandle ?? undefined,
    });
    return false;
  }

  reconnectDragStart(event: MouseEvent | TouchEvent) {
    this.reconnectStart = pointerOf(event);
  }

  // An endpoint dropped on a node body rather than a handle attaches floating.
  reconnectEnd(
    event: MouseEvent | TouchEvent,
    edge: Edge,
    handleType: "source" | "target",
    state: FinalConnectionState,
  ) {
    const start = this.reconnectStart;
    this.reconnectStart = null;
    if (state.isValid) return; // applied by beforeReconnect
    const p = pointerOf(event);
    if (!start || !p || Math.hypot(p.x - start.x, p.y - start.y) < RECONNECT_CLICK_TOLERANCE) return;
    const nodeId = this.nodeIdAtPoint(event);
    if (!nodeId) return; // released over empty canvas — the edge snaps back
    const saved = this.canvas.document.edge(this.canvas.path, edge.id);
    if (!saved) return;
    // handleType names the fixed end; the other one moved.
    const movedTarget = handleType === "source";
    if (nodeId === (movedTarget ? saved.source : saved.target)) return; // no self-loops
    this.canvas.reconnectEdge(edge.id, movedTarget
      ? { source: saved.source, sourceHandle: saved.sourceHandle, target: nodeId }
      : { source: nodeId, target: saved.target, targetHandle: saved.targetHandle });
  }

  // Topmost node under a screen point. Overlays that could shadow a node are
  // hit-transparent during a connection drag (see the --connecting CSS).
  private nodeIdAtPoint(event: MouseEvent | TouchEvent): string | null {
    const p = pointerOf(event);
    if (!p) return null;
    for (const el of document.elementsFromPoint(p.x, p.y)) {
      const nodeEl = el.closest(".svelte-flow__node");
      if (nodeEl && this.root()?.contains(nodeEl)) return nodeEl.getAttribute("data-id");
    }
    return null;
  }

  // ── Edge handles ─────────────────────────────────────────────────────────

  // Live during a bend or label drag: only the projected edge moves. The
  // pointer-up commit is the one undo step and the one save.
  bendChange(edgeId: string, bendOffset: number, bendAxis?: "x" | "y") {
    this.patchDrawnEdge(edgeId, { bendOffset, bendAxis });
  }

  bendCommit(edgeId: string) {
    const edge = this.canvas.edges.find((e) => e.id === edgeId);
    if (!edge) return;
    const { bendOffset, bendAxis } = diagramEdgeData(edge);
    this.canvas.updateEdge(edgeId, { bendOffset, bendAxis });
  }

  labelOffsetChange(edgeId: string, labelOffset: DiagramEdge["labelOffset"]) {
    this.labelDragEdgeId = edgeId;
    this.patchDrawnEdge(edgeId, { labelOffset });
  }

  labelOffsetCommit() {
    const edgeId = this.labelDragEdgeId;
    this.labelDragEdgeId = null;
    const edge = edgeId ? this.canvas.edges.find((e) => e.id === edgeId) : undefined;
    if (edge) this.canvas.updateEdge(edge.id, { labelOffset: diagramEdgeData(edge).labelOffset });
  }

  private patchDrawnEdge(edgeId: string, data: Partial<DiagramEdge>) {
    this.canvas.edges = this.canvas.edges.map((e) => (e.id === edgeId ? { ...e, data: { ...e.data, ...data } } : e));
  }
}
