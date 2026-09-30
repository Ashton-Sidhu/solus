import type { EdgeInspectorTab, InspectorTab } from "./inspector-model";

/**
 * Which node or edge the side inspector shows, and how. The node and edge
 * inspectors are never up together. Collapsing to the rail keeps the
 * selection and the tab — it frees canvas, it doesn't dismiss.
 */
export class DiagramInspector {
  nodeId = $state<string | null>(null);
  edgeId = $state<string | null>(null);
  // An explicit edit intent (add / edit details) focuses the label input;
  // plain selection leaves focus on the canvas so its shortcuts keep working.
  autoFocus = $state(false);
  open = $state(true);
  // The tab persists across selection changes: inspecting five nodes in a row
  // on Data shouldn't snap back to Identity each time. The edge panel keeps
  // its own, because its tabs aren't the node's.
  tab = $state<InspectorTab>("identity");
  edgeTab = $state<EdgeInspectorTab>("identity");

  /** `onShow` runs whenever a node or edge is shown; the comments panel shares the space. */
  constructor(private readonly onShow: () => void) {}

  get isShowing(): boolean {
    return this.nodeId !== null || this.edgeId !== null;
  }

  /**
   * Show a node, or close with null. An edit intent needs the full panel on
   * the tab that owns the label — silently editing behind a collapsed rail
   * would look like nothing happened.
   */
  showNode(nodeId: string | null, autoFocus: boolean) {
    this.edgeId = null;
    this.onShow();
    this.autoFocus = autoFocus;
    this.nodeId = nodeId;
    if (autoFocus) {
      this.open = true;
      this.tab = "identity";
    }
  }

  showEdge(edgeId: string | null, autoFocus: boolean) {
    this.nodeId = null;
    this.onShow();
    this.autoFocus = autoFocus;
    this.edgeId = edgeId;
    if (autoFocus) {
      this.open = true;
      this.edgeTab = "identity";
    }
  }

  hide() {
    this.nodeId = null;
    this.edgeId = null;
  }

  /** Close, and reopen next time as the full panel rather than a rail nobody chose. */
  close() {
    this.hide();
    this.open = true;
  }
}
