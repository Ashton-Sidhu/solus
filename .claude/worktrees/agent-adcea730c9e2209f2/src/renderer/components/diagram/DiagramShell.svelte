<script lang="ts">
  import "./DiagramShell.css";

  import { onDestroy } from "svelte";
  import {
    SvelteFlow,
    Background,
    BackgroundVariant,
    MiniMap,
    Panel,
    MarkerType,
    type Edge,
    type Node,
  } from "@xyflow/svelte";
  import "@xyflow/svelte/dist/style.css";
  import { ChatsCircleIcon, CheckIcon, GraphIcon, XIcon } from "phosphor-svelte";
  import WorkHeaderActions from "../work/WorkHeaderActions.svelte";
  import FrameExpandButton from "../layout/FrameExpandButton.svelte";
  import type { PaneSlot } from "../../contexts/pane-view.store.svelte";
  import type { PlanComment, SessionMeta, WorkStorage } from "../../shared/types";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { formatInlineComments } from "../../contexts/session.utils";
  import { uuid } from "../../../shared/uuid";
  import { toasts } from "../../contexts/toast.store.svelte";
  import { formatSavedAgo } from "../document-shell/saveStatus";
  import DiagramNodeComponent from "./nodes/DiagramNode.svelte";
  import DiagramGroupNode from "./nodes/DiagramGroupNode.svelte";
  import DiagramEdgeComponent from "./edges/DiagramEdge.svelte";
  import DiagramDetailsDrawer from "./DiagramDetailsDrawer.svelte";
  import DiagramEdgeDrawer from "./DiagramEdgeDrawer.svelte";
  import DiagramCommentsPanel from "./DiagramCommentsPanel.svelte";
  import DiagramSearch from "./DiagramSearch.svelte";
  import CanvasToolbar from "./CanvasToolbar.svelte";
  import ContextMenu from "./ContextMenu.svelte";
  import PaneContextMenu from "./PaneContextMenu.svelte";
  import {
    parseDiagram,
    serializeDiagram,
  } from "../../../shared/diagram-types";
  import type {
    DiagramNode,
    DiagramEdge,
    DiagramDoc,
    DiagramAction,
  } from "../../../shared/diagram-types";
  import { isSafeUrl } from "../../../shared/diagram-sanitize";
  import { flowNodeToDiagram, flowEdgeToDiagram } from "./diagram-flow-map";
  import {
    COLLAPSED_H,
    GROUP_H,
    GROUP_W,
    absoluteBox,
    applyMembership,
    autoGrowGroups,
    centreOf,
    deepestGroupAt,
    detachChildrenOf,
    groupMembershipUpdates,
    isSelfOrDescendant,
    orderParentsFirst,
    pointInBox,
    pruneCyclicMemberships,
    sizeStyle,
    type Membership,
    NODE_WIDTH_EST,
    NODE_HEIGHT_EST,
  } from "./lib/graph-layout";
  import {
    buildClipboardPaste,
    hasDiagramClipboard,
    setDiagramClipboard,
  } from "./lib/clipboard.svelte";
  import {
    DEFAULT_EDGE_COLOR,
    edgeRenderProps,
    toFlowEdges,
    toFlowNodes,
  } from "./lib/flow-builders";
  import {
    applyLayout,
    reapplyLayout,
    type LayoutDirection,
  } from "../../../shared/diagram-layout";
  import { getSettingsContext } from "../../contexts/settings.context.svelte";
  import {
    useKeybinding,
    useScope,
  } from "../../lib/keybindings/use-keybinding.svelte";
  import { getKeybindingsContext } from "../../lib/keybindings/dispatcher.svelte";

  interface Props {
    content: string;
    title: string;
    onSave: (content: string) => Promise<void>;
    onClose: () => void;
    /** Fires true when the canvas has unsaved edits, false once they're saved.
        Lets the host decide whether an agent update can safely refresh. */
    onDirtyChange?: (dirty: boolean) => void;
    /** Shared work-header actions (Chat / split / copy) — same contract as docs. */
    inline?: boolean;
    slot?: PaneSlot;
    onOpenInSplit?: () => void;
    onOpenChat?: (mode: "resume" | "new") => void;
    originalSessionMeta?: SessionMeta | null;
    /** Work id — enables the "View changes" revision diff. */
    workId?: string;
    /** Restore the previous snapshot. */
    onRevert?: () => void;
    /** Delete the work (closes the pane + offers undo). */
    onDelete?: () => void;
    /** Duplicate the work into a new independent copy. */
    onDuplicate?: () => void | Promise<void>;
    workStorage?: WorkStorage;
    onPromoteToProject?: () => void | Promise<void>;
    promoting?: boolean;
    /** Rename the work title. */
    onRename?: (title: string) => void;
  }

  let {
    content,
    title,
    onSave,
    onClose,
    onDirtyChange,
    inline = false,
    slot = "primary",
    onOpenInSplit,
    onOpenChat,
    originalSessionMeta,
    workId,
    onRevert,
    onDelete,
    onDuplicate,
    workStorage,
    onPromoteToProject,
    promoting = false,
    onRename,
  }: Props = $props();

  // Click-to-rename (mirrors DocumentShell). Only the root title is editable.
  let renaming = $state(false);
  let renameValue = $state("");
  function startRename() {
    if (!onRename) return;
    renameValue = title;
    renaming = true;
  }
  function commitRename() {
    if (!renaming) return;
    renaming = false;
    const next = renameValue.trim();
    if (next && next !== title) onRename?.(next);
  }
  function renameKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      (e.target as HTMLInputElement)?.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      renaming = false;
    }
  }

  let copied = $state(false);
  function copyDiagram() {
    navigator.clipboard
      .writeText(serializeDiagram(fullDoc()))
      .then(() => {
        copied = true;
        setTimeout(() => (copied = false), 1800);
      })
      .catch(() => toasts.error("Copy failed"));
  }

  const theme = getSettingsContext();
  const keybindings = getKeybindingsContext();
  const session = getWorkspaceContext();

  // Load the annotation sidecar whenever the open work changes (mirrors
  // DocumentModal).
  $effect(() => {
    const id = workId;
    if (!id) {
      loadedAnnotationsFor = null;
      return;
    }
    if (id === loadedAnnotationsFor) return;
    loadedAnnotationsFor = id;
    void session.worksStore.loadAnnotations(id).then(() => {
      if (loadedAnnotationsFor !== id) return;
      applyTransientState();
    });
  });

  function persistComments() {
    if (!workId) return;
    if (commentsSaveTimer) clearTimeout(commentsSaveTimer);
    const id = workId;
    commentsSaveTimer = setTimeout(() => {
      const ann = {
        version: 1 as const,
        workId: id,
        comments: $state.snapshot(session.worksStore.annotationComments(id)) as PlanComment[],
        updatedAt: Date.now(),
      };
      void window.solus.saveWorkAnnotations(ann);
    }, 400);
  }

  function openComments(nodeId: string | null, autoFocus: boolean) {
    activeDrawerNodeId = null;
    activeDrawerEdgeId = null;
    commentDraftNodeId = nodeId;
    commentsAutoFocus = autoFocus;
    commentsOpen = true;
  }

  function toggleComments() {
    if (commentsOpen) {
      commentsOpen = false;
      return;
    }
    // Anchor to the node whose drawer is open, if any — likeliest target.
    openComments(activeDrawerNodeId, false);
  }

  function nodeLabelFor(nodeId: string): string | null {
    const label = nodes.find((n) => n.id === nodeId)?.data.label;
    return typeof label === "string" ? label : null;
  }

  function addComment(text: string) {
    if (!workId) return;
    session.worksStore.addAnnotationComment(workId, {
      id: uuid(),
      selectedText: commentDraftNodeId
        ? (nodeLabelFor(commentDraftNodeId) ?? commentDraftNodeId)
        : title,
      comment: text,
      ...(commentDraftNodeId ? { nodeId: commentDraftNodeId } : {}),
    });
    persistComments();
    applyTransientState();
  }

  function editComment(commentId: string, text: string) {
    if (!workId) return;
    session.worksStore.editAnnotationComment(workId, commentId, text);
    persistComments();
  }

  function deleteComment(commentId: string) {
    if (!workId) return;
    session.worksStore.deleteAnnotationComment(workId, commentId);
    persistComments();
    applyTransientState();
  }

  // Center the canvas on a comment's node (keeping the current zoom — xyflow's
  // setCenter would otherwise jump to max zoom) and select it.
  function scrollToComment(commentId: string) {
    const nodeId = comments.find((c) => c.id === commentId)?.nodeId;
    if (!nodeId || !flowControls) return;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const node = byId.get(nodeId);
    if (!node) return; // anchored node was deleted or lives in another view
    const box = absoluteBox(node, byId);
    nodes = nodes.map((n) =>
      (n.selected ?? false) === (n.id === nodeId) ? n : { ...n, selected: n.id === nodeId },
    );
    void flowControls.setCenter(box.x + box.w / 2, box.y + box.h / 2, {
      zoom: flowControls.getViewport().zoom,
      duration: 300,
    });
  }

  // Hand the comments to the agent as a chat message (same flow as
  // DocumentModal): they're cleared here because the agent now owns them.
  async function sendCommentsToAgent() {
    if (!workId || comments.length === 0) return;
    const body = formatInlineComments($state.snapshot(comments) as PlanComment[]);
    const msg = `Please address these comments on the diagram "${title}" (work_id: ${workId}):\n${body}`;
    session.worksStore.clearAnnotationComments(workId);
    persistComments();
    applyTransientState();
    const boundTabId = session.tabOrder.find(
      (t) => session.sessionFor(t)?.boundWorkId === workId,
    );
    if (boundTabId) session.selectTab(boundTabId);
    else await session.openChatForWork(workId, "new");
    session.sendMessage(msg);
  }
  let flowControls:
    | {
        getViewport: () => { x: number; y: number; zoom: number };
        setViewport: (
          viewport: { x: number; y: number; zoom: number },
          options?: { duration?: number },
        ) => Promise<boolean>;
        zoomIn: (options?: { duration?: number }) => Promise<boolean>;
        zoomOut: (options?: { duration?: number }) => Promise<boolean>;
        fitView: (options?: {
          duration?: number;
          padding?: number;
        }) => Promise<boolean>;
        setCenter: (
          x: number,
          y: number,
          options?: { zoom?: number; duration?: number },
        ) => Promise<boolean>;
        screenToFlowPosition: (pos: {
          x: number;
          y: number;
        }) => { x: number; y: number };
      }
    | null = null;

  const nodeTypes = { default: DiagramNodeComponent, group: DiagramGroupNode };
  const edgeTypes = { default: DiagramEdgeComponent };

  // Full backing document. The live `nodes`/`edges` arrays mirror the CURRENT
  // view — the root doc, or a node's `detail` sub-diagram once drilled in. View
  // edits are written back into rootDoc before every save (see fullDoc()).
  let rootDoc: DiagramDoc = (() => {
    try {
      return applyLayout(parseDiagram(content));
    } catch {
      return { nodes: [], edges: [] };
    }
  })();

  // Drill trail into nested detail sub-diagrams. Empty = root. One level deep
  // only, so at most one entry — kept as a list for the breadcrumb.
  let drillPath = $state<{ id: string; label: string }[]>([]);

  const hadNoPositions = (() => {
    try {
      return parseDiagram(content).nodes.some((n) => !n.position);
    } catch {
      return false;
    }
  })();

  // Transient UI state — never serialized
  let expandedNodeIds = $state(new Set<string>());
  let focusedNodeId = $state<string | null>(null);
  let matchedNodeIds = $state<Set<string> | null>(null);
  let activeDrawerNodeId = $state<string | null>(null);
  let activeDrawerEdgeId = $state<string | null>(null);
  // True when the drawer is opened via an explicit edit intent (add / edit
  // details) — drives whether the drawer auto-focuses its label input. Plain
  // selection leaves it false so canvas keyboard shortcuts keep working.
  let drawerAutoFocus = $state(false);
  // Node-anchored comments, persisted to the work-annotations sidecar (same
  // store DocumentModal uses for docs) and surfaced to the agent via read_work.
  const comments = $derived(workId ? session.worksStore.annotationComments(workId) : []);
  let commentsOpen = $state(false);
  // Node the composer is pre-anchored to; null = whole-diagram comment.
  let commentDraftNodeId = $state<string | null>(null);
  let commentsAutoFocus = $state(false);
  let commentsSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let loadedAnnotationsFor: string | null = null;
  let contextMenu = $state<{
    x: number;
    y: number;
    targetId: string;
    type: "node" | "edge";
  } | null>(null);
  // Right-click / double-click on the empty canvas. Carries both the screen
  // point (for menu placement) and the flow point (where a new node lands).
  let paneMenu = $state<{
    x: number;
    y: number;
    flowX: number;
    flowY: number;
  } | null>(null);
  let minimapVisible = $state(true);
  let searchOpen = $state(false);
  // The end type a connection drag started from (null when idle) — set for both
  // a new edge and a dragged endpoint of an existing edge. Non-null reveals
  // every node's connection handles (`:hover` alone won't surface them mid-drag
  // because the pointer is captured), and the type drives disabling same-type
  // handles so the drop lands on the compatible half of each side's stacked
  // source/target pair (see the --from-* CSS rules).
  let connectingFrom = $state<"source" | "target" | null>(null);
  // Root element — diagram shortcuts only fire while focus lives inside it.
  let shellEl = $state<HTMLDivElement | null>(null);

  const activeDrawerNode = $derived(
    activeDrawerNodeId !== null
      ? ((nodes.find((n) => n.id === activeDrawerNodeId)?.data as
          | DiagramNode
          | undefined) ?? null)
      : null,
  );

  const activeDrawerEdge = $derived.by(() => {
    if (activeDrawerEdgeId === null) return null;
    const e = edges.find((x) => x.id === activeDrawerEdgeId);
    if (!e) return null;
    return {
      ...flowEdgeToDiagram(e),
      sourceLabel:
        (nodes.find((n) => n.id === e.source)?.data.label as string) ??
        e.source,
      targetLabel:
        (nodes.find((n) => n.id === e.target)?.data.label as string) ??
        e.target,
    };
  });

  let saveTimeout: ReturnType<typeof setTimeout> | undefined;

  // Save-state surfacing, mirroring DocumentShell: a debounce-armed pending
  // flag and an in-flight flag combine into "Saving…", otherwise we show the
  // last-saved timestamp kept fresh by a slow ticking clock.
  let isSaving = $state(false);
  let hasPendingSave = $state(false);
  let saveFailed = $state(false);
  let lastSavedAt = $state<number | null>(null);
  let savedStatusNow = $state(Date.now());
  const showSaving = $derived(hasPendingSave || isSaving);

  $effect(() => {
    if (lastSavedAt === null) return;
    const interval = setInterval(() => {
      savedStatusNow = Date.now();
    }, 10_000);
    return () => clearInterval(interval);
  });

  // Callbacks stamped onto every flow node's data so the node component can
  // reach back into the shell. Re-applied wherever the nodes array is rebuilt
  // (toFlowNodes, applyTransientState, add/paste). The handlers are hoisted
  // function declarations, so referencing them here is safe despite order.
  const NODE_HANDLERS = {
    onLabelChange: handleLabelChange,
    onAction: handleAction,
    onResize: handleResize,
    onResizeLive: handleResizeLive,
    onContextMenu: handleContextMenuOpen,
    onSelect: handleNodeClick,
    onToggleCollapse: handleToggleCollapse,
    onOpenComments: (id: string) => openComments(id, false),
  };

  const EDGE_HANDLERS = {
    onLabelChange: handleEdgeLabelChange,
    onBendOffsetChange: handleEdgeBendOffsetChange,
    onBendOffsetCommit: handleEdgeBendOffsetCommit,
    onContextMenu: handleContextMenuOpen,
  };

  const exportBgColor = $derived(theme.isDark ? "#1a1916" : "#fefefc");
  const defaultEdgeOptions = {
    type: "default",
    markerEnd: {
      type: MarkerType.ArrowClosed,
      width: 16,
      height: 16,
      color: DEFAULT_EDGE_COLOR,
    },
  };

  function buildFlowNodes(diagNodes: DiagramNode[]): Node[] {
    return toFlowNodes(diagNodes, expandedNodeIds, NODE_HANDLERS);
  }

  function buildFlowEdges(diagEdges: DiagramEdge[]): Edge[] {
    return toFlowEdges(diagEdges, EDGE_HANDLERS);
  }

  let nodes = $state.raw(buildFlowNodes(rootDoc.nodes));
  let edges = $state.raw(buildFlowEdges(rootDoc.edges));
  // Apply edge-level hidden flags for any group saved in the collapsed state
  // (node-level hidden is already set by toFlowNodes).
  recomputeHidden();

  // Undo/redo history for the CURRENT view. Each entry is a plain DiagramDoc
  // snapshot (the shape currentDoc() returns); restoring rebuilds the live flow
  // arrays. History is per-view — drilling in/out resets it (loadView).
  let undoStack = $state<DiagramDoc[]>([]);
  let redoStack = $state<DiagramDoc[]>([]);
  // The last snapshot we committed to history — the state an undo returns to.
  let committed: DiagramDoc = currentDoc();
  // True while undo/redo is reapplying a snapshot, so the resulting save isn't
  // recorded as a fresh history step.
  let isRestoring = false;

  $effect(() => {
    const indexById = new Map(nodes.map((n, i) => [n.id, i]));
    // Every parent must precede its child in the array (xyflow requirement);
    // re-order if any mutation left a child ahead of its parent.
    if (
      nodes.some((n, index) => {
        if (!n.parentId) return false;
        const pi = indexById.get(n.parentId);
        return pi !== undefined && pi > index;
      })
    ) {
      nodes = orderParentsFirst(nodes);
    }
  });

  const hasSelection = $derived(
    nodes.some((n) => n.selected) || edges.some((e) => e.selected),
  );

  if (hadNoPositions) {
    scheduleSave();
  }

  function applyTransientState() {
    let neighborIds: Set<string> | null = null;
    if (focusedNodeId !== null) {
      neighborIds = new Set<string>();
      for (const e of edges) {
        if (e.source === focusedNodeId) neighborIds.add(e.target);
        if (e.target === focusedNodeId) neighborIds.add(e.source);
      }
    }

    const commentCountByNode = new Map<string, number>();
    for (const c of comments) {
      if (c.nodeId) commentCountByNode.set(c.nodeId, (commentCountByNode.get(c.nodeId) ?? 0) + 1);
    }

    // Only reallocate nodes whose transient flags actually changed. Returning the
    // same reference for unchanged nodes keeps xyflow (and every DiagramNode's
    // derived chain) from re-rendering the whole graph on each focus/search/expand
    // toggle. NODE_HANDLERS are stamped at build and never change, so they're not
    // re-spread here — they're already present on n.data.
    nodes = nodes.map((n) => {
      const expanded = expandedNodeIds.has(n.id);
      const focusDimmed =
        neighborIds !== null &&
        n.id !== focusedNodeId &&
        !neighborIds.has(n.id);
      const searchDimmed = matchedNodeIds !== null && !matchedNodeIds.has(n.id);
      const dimmed = focusDimmed || searchDimmed;
      const commentCount = commentCountByNode.get(n.id) ?? 0;
      if (
        n.data.expanded === expanded &&
        n.data.dimmed === dimmed &&
        (n.data.commentCount ?? 0) === commentCount
      ) {
        return n;
      }
      return { ...n, data: { ...n.data, expanded, dimmed, commentCount } };
    });
  }

  // Recompute the transient `hidden` flag on nodes and edges from the current
  // set of collapsed groups: a node is hidden when any ancestor group is
  // collapsed, and an edge is hidden when either endpoint is. Never persisted —
  // derived purely from each group's `collapsed` flag.
  function recomputeHidden() {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const isHidden = (n: Node): boolean => {
      let p = n.parentId ? byId.get(n.parentId) : undefined;
      while (p) {
        if (p.data.group && p.data.collapsed) return true;
        p = p.parentId ? byId.get(p.parentId) : undefined;
      }
      return false;
    };
    const hiddenIds = new Set<string>();
    nodes = nodes.map((n) => {
      const h = isHidden(n);
      if (h) hiddenIds.add(n.id);
      return (n.hidden ?? false) === h ? n : { ...n, hidden: h };
    });
    edges = edges.map((e) => {
      const h = hiddenIds.has(e.source) || hiddenIds.has(e.target);
      return (e.hidden ?? false) === h ? e : { ...e, hidden: h };
    });
  }

  // Fold a group shut (or open it back up). Collapsing shrinks the box to its
  // header height (the real height stays on data for restore) and hides every
  // descendant via recomputeHidden.
  function handleToggleCollapse(groupId: string) {
    const target = nodes.find((n) => n.id === groupId);
    if (!target?.data.group) return;
    const collapsed = !target.data.collapsed;
    const expandedH = (target.data.height as number | undefined) ?? GROUP_H;
    const w = (target.width as number | undefined) ?? GROUP_W;
    const renderH = collapsed ? COLLAPSED_H : expandedH;
    nodes = nodes.map((n) =>
      n.id === groupId
        ? {
            ...n,
            height: renderH,
            style: sizeStyle(w, renderH),
            data: { ...n.data, collapsed: collapsed || undefined },
          }
        : n,
    );
    recomputeHidden();
    scheduleSave();
  }

  function handleAction(nodeId: string, action: DiagramAction) {
    switch (action.do) {
      case "expand": {
        if (expandedNodeIds.has(nodeId)) expandedNodeIds.delete(nodeId);
        else expandedNodeIds.add(nodeId);
        applyTransientState();
        break;
      }
      case "focus": {
        focusedNodeId = focusedNodeId === nodeId ? null : nodeId;
        applyTransientState();
        break;
      }
      case "details": {
        openNodeDrawer(activeDrawerNodeId === nodeId ? null : nodeId, true);
        break;
      }
      case "drilldown": {
        drillInto(nodeId);
        break;
      }
      case "openUrl": {
        if (isSafeUrl(action.url)) {
          (window as any).solus?.openExternal(action.url);
        }
        break;
      }
    }
  }

  function clearFocus() {
    focusedNodeId = null;
    applyTransientState();
  }

  function currentDoc(): DiagramDoc {
    return {
      nodes: nodes.map(flowNodeToDiagram),
      edges: edges.map(flowEdgeToDiagram),
    };
  }

  function resetHistory() {
    undoStack = [];
    redoStack = [];
    committed = currentDoc();
  }

  function restoreSnapshot(doc: DiagramDoc) {
    isRestoring = true;
    nodes = buildFlowNodes(doc.nodes);
    edges = buildFlowEdges(doc.edges);
    recomputeHidden();
    committed = currentDoc();
    scheduleSave();
    isRestoring = false;
  }

  function undo() {
    if (undoStack.length === 0) return;
    redoStack = [...redoStack, committed];
    const prev = undoStack[undoStack.length - 1];
    undoStack = undoStack.slice(0, -1);
    restoreSnapshot(prev);
  }

  function redo() {
    if (redoStack.length === 0) return;
    undoStack = [...undoStack, committed];
    const next = redoStack[redoStack.length - 1];
    redoStack = redoStack.slice(0, -1);
    restoreSnapshot(next);
  }

  // Write the current view (live nodes/edges) back into rootDoc at drillPath, so
  // a save/copy/export captures edits made at any depth.
  function persistView() {
    const view = currentDoc();
    if (drillPath.length === 0) {
      rootDoc = view;
      return;
    }
    // One level only: the owning node lives at the root.
    const owner = rootDoc.nodes.find((n) => n.id === drillPath[0].id);
    if (owner) owner.detail = view;
  }

  // The complete document (root + every persisted detail) — used for save,
  // copy and JSON/Mermaid export so nested detail is never dropped.
  function fullDoc(): DiagramDoc {
    persistView();
    return rootDoc;
  }

  // Swap the canvas to a different view, resetting view-local transient state
  // (selection, focus, search, open drawers) and re-fitting once laid out.
  function loadView(view: DiagramDoc) {
    expandedNodeIds = new Set();
    focusedNodeId = null;
    matchedNodeIds = null;
    searchOpen = false;
    activeDrawerNodeId = null;
    activeDrawerEdgeId = null;
    contextMenu = null;
    nodes = buildFlowNodes(view.nodes);
    edges = buildFlowEdges(view.edges);
    recomputeHidden();
    resetHistory();
    requestAnimationFrame(
      () => void flowControls?.fitView({ duration: 300, padding: 0.2 }),
    );
  }

  // Enter a node's detail sub-diagram. One level only — ignored if already
  // drilled in or the node has no detail.
  function drillInto(nodeId: string) {
    if (drillPath.length > 0) return;
    const node = nodes.find((n) => n.id === nodeId);
    const detail = node?.data.detail as DiagramDoc | undefined;
    if (!detail || !node) return;
    persistView(); // capture root edits before swapping away
    const laid = applyLayout(detail);
    const owner = rootDoc.nodes.find((n) => n.id === nodeId);
    if (owner) owner.detail = laid; // keep dagre's positions on the backing doc
    drillPath = [
      ...drillPath,
      { id: nodeId, label: (node.data.label as string) || "Detail" },
    ];
    loadView(laid);
    scheduleSave(); // persist any freshly assigned detail positions
  }

  // Navigate the breadcrumb back to `depth` levels deep (0 = root).
  function drillTo(depth: number) {
    if (depth >= drillPath.length) return;
    persistView();
    // Don't leave behind an empty detail husk the user opened but never filled.
    const leaving = rootDoc.nodes.find((n) => n.id === drillPath[0].id);
    if (leaving?.detail && !leaving.detail.nodes.length) delete leaving.detail;
    drillPath = drillPath.slice(0, depth);
    const view =
      drillPath.length === 0
        ? rootDoc
        : (rootDoc.nodes.find((n) => n.id === drillPath[0].id)?.detail ?? {
            nodes: [],
            edges: [],
          });
    loadView(view);
  }

  function scheduleSave() {
    // Record the pre-change snapshot before persisting this edit, unless we're
    // mid undo/redo (the snapshot is already the one we just reapplied).
    if (!isRestoring) {
      undoStack = [...undoStack, committed];
      if (undoStack.length > 100) undoStack = undoStack.slice(-100);
      redoStack = [];
      committed = currentDoc();
    }
    clearTimeout(saveTimeout);
    hasPendingSave = true;
    onDirtyChange?.(true);
    saveTimeout = setTimeout(() => void performSave(), 600);
  }

  async function performSave() {
    hasPendingSave = false;
    isSaving = true;
    try {
      await onSave(serializeDiagram(fullDoc()));
      saveFailed = false;
      lastSavedAt = Date.now();
      savedStatusNow = lastSavedAt;
      onDirtyChange?.(false);
    } catch {
      // Keep the dirty flag on failure — clearing it would let the host treat
      // unsaved edits as clean (and an agent refresh clobber them). The header
      // shows a retry affordance and any further edit re-arms the save.
      saveFailed = true;
    } finally {
      isSaving = false;
    }
  }

  function retrySave() {
    clearTimeout(saveTimeout);
    void performSave();
  }

  // Flush a pending debounce on unmount so an edit made just before the shell
  // is torn down (tab close, mode switch) still reaches disk.
  onDestroy(() => {
    if (hasPendingSave) {
      clearTimeout(saveTimeout);
      void performSave();
    }
  });

  function handleNodesChange(changes: any[]) {
    if (changes.some((c: any) => c.type === "position" && !c.dragging)) {
      scheduleSave();
    }
  }

  function handleEdgesChange(changes: any[]) {
    if (changes.some((c: any) => c.type === "remove" || c.type === "add")) {
      scheduleSave();
    }
  }

  // xyflow fires onconnect for valid handle drops, then onconnectend for the
  // gesture teardown. The node-body fallback below also creates an edge, so mark
  // completed handle drops and let the following connectend no-op.
  let completedHandleConnectAt = 0;

  function buildEdge(connection: any): Edge {
    return {
      id: `e-${connection.source}-${connection.target}-${Date.now()}`,
      source: connection.source,
      target: connection.target,
      ...(connection.sourceHandle
        ? { sourceHandle: connection.sourceHandle }
        : {}),
      ...(connection.targetHandle
        ? { targetHandle: connection.targetHandle }
        : {}),
      type: "default",
      data: {
        // An end without an explicit handle (dropped on a node body, not a
        // dot) floats to the side facing the other node (see DiagramEdge).
        floatingSource: !connection.sourceHandle,
        floatingTarget: !connection.targetHandle,
        onLabelChange: handleEdgeLabelChange,
        onBendOffsetChange: handleEdgeBendOffsetChange,
        onBendOffsetCommit: handleEdgeBendOffsetCommit,
        onContextMenu: handleContextMenuOpen,
      },
    };
  }

  // xyflow adds the edge we return here on a valid handle drop, so we shape it
  // (with our data) instead of pushing a second copy in onconnect — doing both
  // is what produced duplicate edges.
  function handleBeforeConnect(connection: any): Edge {
    completedHandleConnectAt = Date.now();
    return buildEdge(connection);
  }

  function handleConnect() {
    scheduleSave();
  }

  // Stamp the floating flags onto the rewired edge before xyflow applies it.
  // They're otherwise only computed in toFlowEdges, so a stale flag would keep
  // rendering a moved endpoint at the facing side instead of the handle the
  // user dropped it on.
  function handleBeforeReconnect(newEdge: Edge): Edge {
    return {
      ...newEdge,
      data: {
        ...newEdge.data,
        floatingSource: !newEdge.sourceHandle,
        floatingTarget: !newEdge.targetHandle,
      },
    };
  }

  // xyflow's EdgeReconnectAnchor already rewired source/target/handles on the
  // bound edges array (shaped by handleBeforeReconnect); we just persist.
  function handleReconnect() {
    scheduleSave();
  }

  function pointerOf(
    event: MouseEvent | TouchEvent,
  ): { x: number; y: number } | null {
    if ("changedTouches" in event) {
      const t = event.changedTouches[0];
      return t ? { x: t.clientX, y: t.clientY } : null;
    }
    return { x: event.clientX, y: event.clientY };
  }

  // Topmost diagram node under a screen point. Overlays that could shadow a
  // node (edge labels, the side drawer) are hit-transparent while a connection
  // drag is live (see the --connecting CSS), so they're skipped here too.
  function nodeIdAtPoint(event: MouseEvent | TouchEvent): string | null {
    const p = pointerOf(event);
    if (!p) return null;
    for (const el of document.elementsFromPoint(p.x, p.y)) {
      const nodeEl = el.closest(".svelte-flow__node");
      if (nodeEl && shellEl?.contains(nodeEl)) {
        return nodeEl.getAttribute("data-id");
      }
    }
    return null;
  }

  // In-flight endpoint drag of an existing edge: the pointer-down position,
  // used to tell a real drag from a click on the grab dot. Null when idle.
  // Plain (non-reactive) — only read inside the drag-end handlers.
  let reconnectDrag: { x: number; y: number } | null = null;

  function handleReconnectStart(event: MouseEvent | TouchEvent) {
    reconnectDrag = pointerOf(event);
  }

  // A release that missed every handle still lands the connection when it's
  // over a node card: the loose end attaches floating, so it anchors to the
  // side facing the other node.
  function handleConnectEnd(
    event: MouseEvent | TouchEvent,
    connectionState: any,
  ) {
    connectingFrom = null;
    if (Date.now() - completedHandleConnectAt < 1000) {
      completedHandleConnectAt = 0;
      return;
    }
    // Endpoint drags of an existing edge also end here; their drop is resolved
    // in handleReconnectEnd so a failed reconnect never spawns a second edge.
    if (reconnectDrag) return;
    if (
      connectionState.isValid ||
      !connectionState.fromNode ||
      !connectionState.fromHandle
    ) {
      return;
    }
    const nodeId = nodeIdAtPoint(event);
    if (!nodeId || nodeId === connectionState.fromNode.id) return;
    const fromIsSource = connectionState.fromHandle.type === "source";
    // No handle was hit, so xyflow never added an edge — push it ourselves.
    edges = [
      ...edges,
      buildEdge({
        source: fromIsSource ? connectionState.fromNode.id : nodeId,
        target: fromIsSource ? nodeId : connectionState.fromNode.id,
        sourceHandle: fromIsSource ? connectionState.fromHandle.id : null,
        targetHandle: fromIsSource ? null : connectionState.fromHandle.id,
      }),
    ];
    scheduleSave();
  }

  // Below this travel the gesture reads as a click on the grab dot, not a
  // rewire — without it, a stray click would convert the endpoint to floating.
  const RECONNECT_CLICK_TOLERANCE = 8;

  function handleReconnectEnd(
    event: MouseEvent | TouchEvent,
    edge: Edge,
    handleType: "source" | "target",
    connectionState: any,
  ) {
    const start = reconnectDrag;
    reconnectDrag = null;
    // A valid handle drop was already applied by the anchor (via onreconnect).
    if (connectionState.isValid) return;
    const p = pointerOf(event);
    if (!start || !p) return;
    if (Math.hypot(p.x - start.x, p.y - start.y) < RECONNECT_CLICK_TOLERANCE) {
      return;
    }
    const nodeId = nodeIdAtPoint(event);
    if (!nodeId) return; // released over empty canvas — the edge snaps back
    // handleType names the fixed end the drag was anchored to; the other moved.
    const draggedEnd = handleType === "source" ? "target" : "source";
    const current = edges.find((e) => e.id === edge.id);
    if (!current) return;
    const fixedNodeId =
      draggedEnd === "target" ? current.source : current.target;
    if (nodeId === fixedNodeId) return; // no self-loops
    edges = edges.map((e) => {
      if (e.id !== edge.id) return e;
      return draggedEnd === "target"
        ? {
            ...e,
            target: nodeId,
            targetHandle: undefined,
            data: { ...e.data, floatingTarget: true },
          }
        : {
            ...e,
            source: nodeId,
            sourceHandle: undefined,
            data: { ...e.data, floatingSource: true },
          };
    });
    scheduleSave();
  }

  function handleResize(nodeId: string, width: number, height: number) {
    clearDropHints();
    // Write the new size (xyflow has already committed any origin shift from a
    // top/left handle into the bound node's position, so spreading `n` keeps it).
    let next = nodes.map((n) =>
      n.id === nodeId
        ? {
            ...n,
            width,
            height,
            style: sizeStyle(width, height),
            data: { ...n.data, width, height },
          }
        : n,
    );
    // Resizing a group re-resolves membership against the new box: it swallows
    // same-level nodes it grew over (#2) and ejects children it shrank off (#3).
    // No auto-grow — a manual resize respects the size the user dragged to.
    const group = next.find((n) => n.id === nodeId);
    if (group?.data.group) {
      const byId = new Map(next.map((n) => [n.id, n]));
      const updates = groupMembershipUpdates(group, next, byId, {
        swallow: true,
        eject: true,
      });
      next = orderParentsFirst(applyMembership(next, updates));
    }
    nodes = next;
    scheduleSave();
  }

  // Live highlight while a group is being resized: light up the nodes its box
  // would swallow and the children it would eject, using the in-flight resize
  // params (x/y are in the group's parent frame, so lift to absolute first).
  // Throttled to one run per frame for the same reason as handleNodeDrag — the
  // resize handle fires continuously but only the latest box matters.
  let resizeHintRaf = 0;
  let pendingResize: {
    nodeId: string;
    params: { x: number; y: number; width: number; height: number };
  } | null = null;
  function handleResizeLive(
    nodeId: string,
    params: { x: number; y: number; width: number; height: number },
  ) {
    pendingResize = { nodeId, params };
    if (resizeHintRaf) return;
    resizeHintRaf = requestAnimationFrame(() => {
      resizeHintRaf = 0;
      const p = pendingResize;
      pendingResize = null;
      if (p) computeResizeHints(p.nodeId, p.params);
    });
  }

  function computeResizeHints(
    nodeId: string,
    params: { x: number; y: number; width: number; height: number },
  ) {
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
      if (n.id === nodeId) continue;
      if (isSelfOrDescendant(nodeId, n.id, byId)) continue;
      const b = absoluteBox(n, byId);
      const inside = pointInBox(b.x + b.w / 2, b.y + b.h / 2, box);
      const isChild = (n.parentId ?? undefined) === nodeId;
      if (!isChild && (n.parentId ?? undefined) === level && inside) memberIds.add(n.id);
      else if (isChild && !inside) ejectIds.add(n.id);
    }
    applyHints(null, memberIds, ejectIds);
  }

  // --- Live drag/resize highlighting -------------------------------------
  // Driven by DOM classes on the node wrappers rather than the reactive `nodes`
  // array, so a gesture never churns the derived chain mid-drag. Cleared on
  // drag/resize stop. `lastHintSig` skips redundant DOM writes between frames.
  let hintedEls = new Set<HTMLElement>();
  let lastHintSig = "";

  function clearDropHints() {
    // Cancel any queued live-hint frame so it can't re-apply a stale highlight
    // after a drag/resize has ended (both stop paths call clearDropHints).
    if (dragHintRaf) {
      cancelAnimationFrame(dragHintRaf);
      dragHintRaf = 0;
    }
    pendingDragNode = null;
    if (resizeHintRaf) {
      cancelAnimationFrame(resizeHintRaf);
      resizeHintRaf = 0;
    }
    pendingResize = null;
    for (const el of hintedEls) {
      el.classList.remove("is-drop-target", "is-will-nest", "is-will-eject");
    }
    hintedEls.clear();
    lastHintSig = "";
  }

  function setNodeHint(id: string, cls: string) {
    const el = shellEl?.querySelector<HTMLElement>(
      `.svelte-flow__node[data-id="${id}"]`,
    );
    if (!el) return;
    el.classList.add(cls);
    hintedEls.add(el);
  }

  function applyHints(
    targetId: string | null,
    memberIds: Set<string>,
    ejectIds: Set<string>,
  ) {
    const sig = `${targetId ?? ""}|${[...memberIds].sort().join(",")}|${[...ejectIds].sort().join(",")}`;
    if (sig === lastHintSig) return;
    clearDropHints();
    lastHintSig = sig;
    if (targetId) setNodeHint(targetId, "is-drop-target");
    for (const id of memberIds) setNodeHint(id, "is-will-nest");
    for (const id of ejectIds) setNodeHint(id, "is-will-eject");
  }

  function handleLabelChange(nodeId: string, label: string) {
    nodes = nodes.map((n) =>
      n.id === nodeId ? { ...n, data: { ...n.data, label } } : n,
    );
    scheduleSave();
  }

  function handleEdgeLabelChange(edgeId: string, label: string) {
    edges = edges.map((e) =>
      e.id === edgeId ? { ...e, label: label || undefined } : e,
    );
    scheduleSave();
  }

  // Live during a bend drag: update only the dragged edge, no history/save. The
  // drag fires this every pointermove, so snapshotting the whole doc (and pushing
  // an undo entry) here would spam the undo stack with dozens of frames per drag
  // and re-serialize every node/edge each frame. One commit on pointer-up records
  // the single undo step and schedules the save (see handleEdgeBendOffsetCommit).
  function handleEdgeBendOffsetChange(edgeId: string, bendOffset: number) {
    edges = edges.map((e) =>
      e.id === edgeId ? { ...e, data: { ...e.data, bendOffset } } : e,
    );
  }

  function handleEdgeBendOffsetCommit() {
    scheduleSave();
  }

  function handleContextMenuOpen(
    targetId: string,
    type: "node" | "edge",
    x: number,
    y: number,
  ) {
    paneMenu = null;
    contextMenu = { x, y, targetId, type };
  }

  // Right-click on the empty canvas → the pane menu. Node/edge context menus
  // already stop propagation, so a contextmenu reaching the board came from the
  // bare pane surface. Screen point places the menu; flow point seeds new nodes.
  function handleBoardContextMenu(e: MouseEvent) {
    const t = e.target as HTMLElement | null;
    if (!t?.closest(".svelte-flow__pane")) return;
    e.preventDefault();
    contextMenu = null;
    const flow = flowControls?.screenToFlowPosition({
      x: e.clientX,
      y: e.clientY,
    });
    paneMenu = {
      x: e.clientX,
      y: e.clientY,
      flowX: flow?.x ?? 0,
      flowY: flow?.y ?? 0,
    };
  }

  // Double-click the empty canvas to drop a node centred on the cursor.
  // Open the node (or edge) editor drawer, closing the other kind so only one is
  // ever shown. `autoFocus` drives whether the drawer grabs its label input —
  // true for an explicit edit intent (add / edit details), false for plain
  // selection so canvas keyboard shortcuts keep working. Pass null to close.
  function openNodeDrawer(id: string | null, autoFocus: boolean) {
    activeDrawerEdgeId = null;
    commentsOpen = false;
    drawerAutoFocus = autoFocus;
    activeDrawerNodeId = id;
  }

  function openEdgeDrawer(id: string | null, autoFocus: boolean) {
    activeDrawerNodeId = null;
    commentsOpen = false;
    drawerAutoFocus = autoFocus;
    activeDrawerEdgeId = id;
  }

  // Selecting a node/edge opens its editor drawer so the side menu tracks the
  // current selection (mirrors how the session sidebar follows the active item).
  function handleNodeClick(nodeId: string) {
    // In focus mode every card stays clickable: clicking any node moves the
    // focus there, so dimmed cards are a way to walk the graph rather than
    // dead zones only escapable via the clear-focus pill.
    if (focusedNodeId !== null && focusedNodeId !== nodeId) {
      focusedNodeId = nodeId;
      applyTransientState();
    }
    openNodeDrawer(nodeId, false);
  }

  function handleEdgeClick(edgeId: string) {
    openEdgeDrawer(edgeId, false);
  }

  // Clicking empty canvas clears the selection, so close the drawer to match.
  function handlePaneClick() {
    activeDrawerNodeId = null;
    activeDrawerEdgeId = null;
  }

  // Remove a set of nodes and edges together: nodes drop with their incident
  // edges (and any edge in `edgeIds`), groups detach their children to the
  // canvas first, and a drawer left pointing at a removed item is closed.
  function removeNodesAndEdges(nodeIds: Set<string>, edgeIds: Set<string>) {
    if (nodeIds.size === 0 && edgeIds.size === 0) return;
    if (activeDrawerNodeId && nodeIds.has(activeDrawerNodeId)) {
      activeDrawerNodeId = null;
    }
    // Deleting a group keeps its children — detach them to the canvas first.
    nodes = detachChildrenOf(nodes, nodeIds);
    nodes = nodes.filter((n) => !nodeIds.has(n.id));
    edges = edges.filter(
      (e) =>
        !edgeIds.has(e.id) && !nodeIds.has(e.source) && !nodeIds.has(e.target),
    );
    // Close the edge drawer if its edge was removed (directly or via its node).
    if (activeDrawerEdgeId && !edges.some((e) => e.id === activeDrawerEdgeId)) {
      activeDrawerEdgeId = null;
    }
    scheduleSave();
  }

  function handleContextMenuDelete() {
    if (!contextMenu) return;
    const { targetId, type } = contextMenu;
    if (type === "node") removeNodesAndEdges(new Set([targetId]), new Set());
    else removeNodesAndEdges(new Set(), new Set([targetId]));
  }

  function handleContextMenuEditDetails() {
    if (!contextMenu) return;
    if (contextMenu.type === "node") openNodeDrawer(contextMenu.targetId, true);
    else openEdgeDrawer(contextMenu.targetId, true);
  }

  // Detach a single child from its group, converting its parent-relative
  // position back to absolute so it stays put on the canvas.
  function handleContextMenuRemoveFromGroup() {
    if (!contextMenu || contextMenu.type !== "node") return;
    const child = nodes.find((n) => n.id === contextMenu!.targetId);
    if (!child?.parentId) return;
    const parent = nodes.find((n) => n.id === child.parentId);
    const px = parent?.position.x ?? 0;
    const py = parent?.position.y ?? 0;
    reparentNode(child.id, undefined, {
      x: child.position.x + px,
      y: child.position.y + py,
    });
  }

  // Pin/unpin a set of nodes to the back layer. Re-ordering applies the new
  // sentToBack z-index and keeps parents ahead of their children.
  function setSentToBack(ids: Set<string>, value: boolean) {
    if (ids.size === 0) return;
    nodes = orderParentsFirst(
      nodes.map((n) =>
        ids.has(n.id)
          ? { ...n, data: { ...n.data, sentToBack: value || undefined } }
          : n,
      ),
    );
    scheduleSave();
  }

  function handleContextMenuSendToBack() {
    if (!contextMenu || contextMenu.type !== "node") return;
    setSentToBack(new Set([contextMenu.targetId]), true);
  }

  function handleContextMenuBringToFront() {
    if (!contextMenu || contextMenu.type !== "node") return;
    setSentToBack(new Set([contextMenu.targetId]), false);
  }

  // Keyboard path: act on the current selection (mirrors nudge/delete).
  function sendSelectionToBack(value: boolean) {
    setSentToBack(
      new Set(nodes.filter((n) => n.selected).map((n) => n.id)),
      value,
    );
  }

  // Whether the context target is already pinned to the back (drives the menu
  // label: "Send to back" vs. "Bring to front").
  const contextTargetSentToBack = $derived(
    contextMenu?.type === "node" &&
      !!nodes.find((n) => n.id === contextMenu!.targetId)?.data.sentToBack,
  );

  // The context-menu "Remove from group" item only applies to a nested node.
  const contextTargetHasParent = $derived(
    contextMenu?.type === "node" &&
      !!nodes.find((n) => n.id === contextMenu!.targetId)?.parentId,
  );

  // "Add/Open detail" applies to a top-level, non-group node. One level only, so
  // it's hidden once already inside a detail (drillPath non-empty).
  const contextTargetCanDetail = $derived(
    contextMenu?.type === "node" &&
      drillPath.length === 0 &&
      !nodes.find((n) => n.id === contextMenu!.targetId)?.data.group,
  );

  const contextTargetHasDetail = $derived(
    contextMenu?.type === "node" &&
      !!(
        nodes.find((n) => n.id === contextMenu!.targetId)?.data
          .detail as DiagramDoc | undefined
      )?.nodes?.length,
  );

  // Open a node's detail sub-diagram, creating an empty one to fill in if it
  // doesn't have one yet. Shared by the context menu and the node drawer.
  function openOrCreateDetail(id: string) {
    if (drillPath.length > 0) return; // one level only
    const node = nodes.find((n) => n.id === id);
    if (!node || node.data.group) return;
    if (!((node.data.detail as DiagramDoc | undefined)?.nodes?.length)) {
      nodes = nodes.map((n) =>
        n.id === id
          ? { ...n, data: { ...n.data, detail: { nodes: [], edges: [] } } }
          : n,
      );
    }
    drillInto(id);
  }

  function handleContextMenuOpenDetail() {
    if (!contextMenu || contextMenu.type !== "node") return;
    openOrCreateDetail(contextMenu.targetId);
  }

  // Strip a node's detail sub-diagram (drops the nested nodes/edges entirely).
  function removeDetail(id: string) {
    nodes = nodes.map((n) =>
      n.id === id ? { ...n, data: { ...n.data, detail: undefined } } : n,
    );
    scheduleSave();
  }

  function handleUpdateNode(id: string, patch: Partial<DiagramNode>) {
    nodes = nodes.map((n) =>
      n.id === id ? { ...n, data: { ...n.data, ...patch } } : n,
    );
    scheduleSave();
  }

  // Mirror toFlowEdges' kind→visual mapping so a type change looks identical to
  // a freshly-parsed edge of that kind. Async uses dash rhythm by default;
  // continuous motion remains opt-in through the persisted animated flag.
  function handleEdgeKindChange(
    id: string,
    kind: NonNullable<DiagramEdge["kind"]>,
  ) {
    const isAsync = kind === "async";
    const isData = kind === "data";
    edges = edges.map((e) =>
      e.id === id
        ? {
            ...e,
            animated: (e.data?.animated as boolean | undefined) ?? false,
            className: isAsync
              ? "edge--async"
              : isData
                ? "edge--data"
                : undefined,
            data: { ...e.data, kind },
          }
        : e,
    );
    scheduleSave();
  }

  // Re-derive an edge's inline render props (stroke colour, width, arrowheads)
  // after one of them changes, preserving the untouched two from its data. The
  // patch carries exactly the changed key; clearing it to undefined restores the
  // kind-based CSS default (no inline stroke/width, neutral arrowhead).
  function patchEdgeRender(
    id: string,
    patch: {
      color?: string | undefined;
      width?: number | undefined;
      arrows?: DiagramEdge["arrows"];
    },
  ) {
    edges = edges.map((e) => {
      if (e.id !== id) return e;
      const color =
        "color" in patch ? patch.color : (e.data?.color as string | undefined);
      const width =
        "width" in patch ? patch.width : (e.data?.width as number | undefined);
      const arrows =
        "arrows" in patch
          ? patch.arrows
          : (e.data?.arrows as DiagramEdge["arrows"]);
      return {
        ...e,
        ...edgeRenderProps(color, width, arrows),
        data: { ...e.data, ...patch },
      };
    });
    scheduleSave();
  }

  function handleEdgeColorChange(id: string, color: string | undefined) {
    patchEdgeRender(id, { color });
  }

  function handleEdgeWidthChange(id: string, width: number | undefined) {
    patchEdgeRender(id, { width });
  }

  function handleEdgeArrowsChange(
    id: string,
    arrows: NonNullable<DiagramEdge["arrows"]>,
  ) {
    patchEdgeRender(id, { arrows });
  }

  // Set an edge's routing style (smooth / step / straight). Purely a path-shape
  // change, so only the data flag moves — the renderer (DiagramEdge) redraws.
  function handleEdgeShapeChange(
    id: string,
    shape: NonNullable<DiagramEdge["shape"]>,
  ) {
    edges = edges.map((e) =>
      e.id === id ? { ...e, data: { ...e.data, shape } } : e,
    );
    scheduleSave();
  }

  // Cardinality drives the crow's-foot endpoint markers. When set it also
  // suppresses the standard arrowhead (the foot replaces it); clearing it
  // restores the edge's own arrow setting — mirroring toFlowEdges' suppression.
  function handleEdgeCardinalityChange(
    id: string,
    cardinality: DiagramEdge["cardinality"],
  ) {
    edges = edges.map((e) => {
      if (e.id !== id) return e;
      const color = e.data?.color as string | undefined;
      const width = e.data?.width as number | undefined;
      const arrows = e.data?.arrows as DiagramEdge["arrows"];
      return {
        ...e,
        ...edgeRenderProps(color, width, cardinality ? "none" : arrows),
        data: { ...e.data, cardinality },
      };
    });
    scheduleSave();
  }

  // Centre of existing top-level content, so a new node lands near the graph
  // rather than off-screen. Children are skipped — their positions are
  // parent-relative and would skew the average.
  function canvasCentre(): { x: number; y: number } {
    const top = nodes.filter((n) => !n.parentId);
    if (!top.length) return { x: 120, y: 120 };
    const xs = top.map((n) => n.position.x);
    const ys = top.map((n) => n.position.y);
    return {
      x: (Math.min(...xs) + Math.max(...xs)) / 2,
      y: (Math.min(...ys) + Math.max(...ys)) / 2,
    };
  }

  function deselect(n: Node): Node {
    return n.selected ? { ...n, selected: false } : n;
  }

  function addNode(at?: { x: number; y: number }) {
    const id = `node-${Date.now()}`;
    // When exactly one group is selected, drop the new node inside it (parented,
    // relative position below the header) instead of onto the free canvas. An
    // explicit drop point (pane menu) always lands on the canvas.
    const selectedGroups = nodes.filter((n) => n.selected && n.data.group);
    const parent = !at && selectedGroups.length === 1 ? selectedGroups[0] : null;
    const position = parent ? { x: 24, y: 56 } : (at ?? canvasCentre());
    const newNode: Node = {
      id,
      type: "default",
      position,
      ...(parent ? { parentId: parent.id } : {}),
      selected: true,
      data: {
        id,
        label: "New Service",
        icon: "service",
        ...(parent ? { parentId: parent.id } : {}),
        expanded: false,
        dimmed: false,
        ...NODE_HANDLERS,
      },
    };
    // Deselect everything else, select the new node, and open its drawer so its
    // details are immediately settable. Keep parents ahead of children.
    nodes = orderParentsFirst([...nodes.map(deselect), newNode]);
    openNodeDrawer(id, true);
    scheduleSave();
  }

  function addGroup(at?: { x: number; y: number }) {
    const id = `group-${Date.now()}`;
    const centre = at ?? canvasCentre();
    const newNode: Node = {
      id,
      type: "group",
      position: { x: centre.x - GROUP_W / 2, y: centre.y - GROUP_H / 2 },
      width: GROUP_W,
      height: GROUP_H,
      style: sizeStyle(GROUP_W, GROUP_H),
      selected: true,
      data: {
        id,
        label: "New Group",
        icon: "group",
        group: true,
        width: GROUP_W,
        height: GROUP_H,
        expanded: false,
        dimmed: false,
        ...NODE_HANDLERS,
      },
    };
    nodes = orderParentsFirst([...nodes.map(deselect), newNode]);
    openNodeDrawer(id, true);
    scheduleSave();
  }

  // Set or clear a node's parent. `position` is the node's new position in the
  // appropriate frame (relative to the new parent, or absolute when detaching).
  function reparentNode(
    id: string,
    parentId: string | undefined,
    position: { x: number; y: number },
  ) {
    nodes = orderParentsFirst(applyMembership(nodes, new Map([[id, { parentId, position }]])));
    scheduleSave();
  }

  // Lift the dragged node above the z-bands while it moves so it tracks on top
  // of whatever it's dragged over (standard "in hand" affordance) — otherwise a
  // group, which rests behind every leaf, would slide *under* the things it's
  // being dragged onto. handleNodeDragStop's orderParentsFirst restores resting
  // z on drop.
  //
  // We lift the dragged node AND its whole subtree: xyflow only re-derives a
  // child's parentZ+1 clamp on structural changes, not on the position-only
  // updates a drag emits, so lifting the group alone would leave its children at
  // their old (lower) z and the group box would paint over them mid-drag. With
  // the subtree lifted together, auto's clamp still stacks each child above its
  // parent inside the block.
  const DRAG_Z = 10000;
  function handleNodeDragStart(node: Node) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    nodes = nodes.map((n) =>
      isSelfOrDescendant(n.id, node.id, byId) ? { ...n, zIndex: DRAG_Z } : n,
    );
  }

  // Resolve the own-nesting of one dragged node: into the deepest group under
  // its centre, or detached if dragged out onto the free canvas. Records the
  // change in `updates` (and which group it landed in, for auto-grow). Returns
  // the resolved parent id (or undefined).
  function resolveNesting(
    n: Node,
    byId: Map<string, Node>,
    updates: Map<string, Membership>,
  ): string | undefined {
    const box = absoluteBox(n, byId);
    const target = deepestGroupAt(nodes, box.x + box.w / 2, box.y + box.h / 2, n.id, byId);
    const currentParent = n.parentId ?? undefined;
    if ((target?.id ?? undefined) === currentParent) return currentParent;
    if (target) {
      const g = absoluteBox(target, byId);
      updates.set(n.id, {
        parentId: target.id,
        position: { x: box.x - g.x, y: box.y - g.y },
      });
      return target.id;
    }
    updates.set(n.id, { parentId: undefined, position: { x: box.x, y: box.y } });
    return undefined;
  }

  // Drag-to-nest: on drop, re-resolve membership for the dragged selection.
  // (The shell lives outside the SvelteFlow provider, so we can't use the
  // useSvelteFlow hook here — hence the manual AABB centre-in-box test.)
  function handleNodeDragStop(node: Node) {
    clearDropHints();
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const dragged = byId.get(node.id);
    if (!dragged) return;

    const updates = new Map<string, Membership>();
    // Groups to auto-grow afterwards so freshly nested/swallowed cards never sit
    // clipped by the box. Inner (swallowing) groups first, then the landing
    // parent, so a parent grows to fit a child group that just grew.
    const grow = new Set<string>();

    // (1) Every dragged node (a multi-selection moves together) re-nests by its
    // own centre. A child whose centre left its parent detaches here (#1); one
    // whose centre is still inside but body pokes out stays put and grows (#8).
    // Drag of an unselected node moves only it, so scope to the selection only
    // when the dragged node is part of it.
    const moving = dragged.selected
      ? nodes.filter((n) => n.selected)
      : [dragged];
    for (const m of moving) {
      // (2) A dragged group also swallows same-level nodes whose centre falls in
      // its box — a subgroup can absorb its siblings, never steal from another
      // group. Resolve this before the group's own nesting so swallowed children
      // are counted by the later grow.
      // A folded group is a header chip, not an open container, so it neither
      // swallows siblings nor grows around them while collapsed.
      if (m.data.group && !m.data.collapsed) {
        for (const [id, u] of groupMembershipUpdates(m, nodes, byId, {
          swallow: true,
          eject: false,
        })) {
          if (!moving.some((x) => x.id === id)) updates.set(id, u);
        }
        grow.add(m.id);
      }
      const landed = resolveNesting(m, byId, updates);
      if (landed) grow.add(landed);
    }

    // Drop any update that would nest a node inside its own descendant before it
    // can be applied — otherwise a single drag can both swallow a group and nest
    // into it, forming a parentId cycle that hangs every later parent-walk.
    pruneCyclicMemberships(updates, byId);

    // Apply membership, then grow the affected groups, then one reorder/save.
    // The reorder also resets the drag-lifted z-index (DRAG_Z) to resting.
    let next = applyMembership(nodes, updates);
    next = autoGrowGroups(next, grow);
    nodes = orderParentsFirst(next);
    scheduleSave();
  }

  // Live drop/eject highlight while dragging — see clearDropHints/applyHints.
  // The hint computation scans every node (build byId + deepestGroupAt parent
  // walks), so throttle it to one run per frame: pointermove can fire faster than
  // paint, and only the latest position matters for the highlight.
  let dragHintRaf = 0;
  let pendingDragNode: Node | null = null;
  function handleNodeDrag(node: Node) {
    pendingDragNode = node;
    if (dragHintRaf) return;
    dragHintRaf = requestAnimationFrame(() => {
      dragHintRaf = 0;
      const n = pendingDragNode;
      pendingDragNode = null;
      if (n) computeDragHints(n);
    });
  }

  function computeDragHints(node: Node) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const memberIds = new Set<string>();
    const ejectIds = new Set<string>();
    let targetId: string | null = null;
    if (node.data.group && !node.data.collapsed) {
      // A dragged group lights up the same-level nodes it will swallow.
      for (const [id] of groupMembershipUpdates(node, nodes, byId, {
        swallow: true,
        eject: false,
      })) {
        memberIds.add(id);
      }
    } else if (!node.data.group) {
      const { cx, cy } = centreOf(node, byId);
      const target = deepestGroupAt(nodes, cx, cy, node.id, byId);
      targetId = target?.id ?? null;
      // A child whose centre has left its parent will pop out on release.
      const cur = node.parentId ?? undefined;
      if (cur && (target?.id ?? undefined) !== cur) ejectIds.add(node.id);
    }
    applyHints(targetId, memberIds, ejectIds);
  }

  function selectAll() {
    nodes = nodes.map((n) => (n.selected ? n : { ...n, selected: true }));
    edges = edges.map((e) => (e.selected ? e : { ...e, selected: true }));
  }

  function copySelected() {
    const sel = nodes.filter((n) => n.selected);
    if (!sel.length) return;
    const selIds = new Set(sel.map((n) => n.id));
    // Only edges fully inside the selection come along.
    const internal = edges.filter(
      (e) => selIds.has(e.source) && selIds.has(e.target),
    );
    setDiagramClipboard(
      sel.map((n) => $state.snapshot(n) as Node),
      internal.map((e) => $state.snapshot(e) as Edge),
    );
  }

  function pasteClipboard() {
    const pasted = buildClipboardPaste(NODE_HANDLERS, EDGE_HANDLERS);
    if (!pasted) return;
    // Keep parents ahead of their children on the rebuilt array.
    nodes = orderParentsFirst([...nodes.map(deselect), ...pasted.nodes]);
    edges = [
      ...edges.map((e) => (e.selected ? { ...e, selected: false } : e)),
      ...pasted.edges,
    ];
    scheduleSave();
  }

  function duplicateSelected() {
    copySelected();
    pasteClipboard();
  }

  function panCanvasBy(dx: number, dy: number) {
    if (!flowControls) return;
    const viewport = flowControls.getViewport();
    void flowControls.setViewport(
      {
        ...viewport,
        x: viewport.x + dx,
        y: viewport.y + dy,
      },
      { duration: 120 },
    );
  }

  function nudgeOrPanBy(dx: number, dy: number, panDx: number, panDy: number) {
    if (!nodes.some((n) => n.selected)) {
      panCanvasBy(panDx, panDy);
      return;
    }
    nodes = nodes.map((n) =>
      n.selected
        ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }
        : n,
    );
    scheduleSave();
  }

  function onSearchMatched(ids: Set<string> | null) {
    matchedNodeIds = ids;
    applyTransientState();
  }

  function closeSearch() {
    searchOpen = false;
    matchedNodeIds = null;
    applyTransientState();
  }

  // Null until a layout is actually applied: a diagram loaded with author-placed
  // positions had no direction applied, so no option should read as "current".
  // A positionless diagram was auto-laid out with the LR default, so reflect that.
  let layoutDirection = $state<LayoutDirection | null>(hadNoPositions ? "LR" : null);

  function relayout(direction: LayoutDirection = layoutDirection ?? "LR") {
    layoutDirection = direction;
    const laid = reapplyLayout(currentDoc(), direction);
    nodes = buildFlowNodes(laid.nodes);
    applyTransientState();
    scheduleSave();
  }

  function deleteSelected() {
    removeNodesAndEdges(
      new Set(nodes.filter((n) => n.selected).map((n) => n.id)),
      new Set(edges.filter((e) => e.selected).map((e) => e.id)),
    );
  }

  // Escape cascade: peel back the most specific overlay first, close last.
  function dismiss() {
    if (searchOpen) {
      closeSearch();
      return;
    }
    if (contextMenu) {
      contextMenu = null;
      return;
    }
    if (paneMenu) {
      paneMenu = null;
      return;
    }
    if (commentsOpen) {
      commentsOpen = false;
      return;
    }
    if (activeDrawerEdgeId !== null) {
      activeDrawerEdgeId = null;
      return;
    }
    if (activeDrawerNodeId !== null) {
      activeDrawerNodeId = null;
      return;
    }
    if (focusedNodeId !== null) {
      clearFocus();
      return;
    }
    if (drillPath.length > 0) {
      drillTo(drillPath.length - 1);
      return;
    }
    onClose();
  }

  function isTextEntryFocused(): boolean {
    const el = document.activeElement as HTMLElement | null;
    return !!el?.closest?.("input,textarea,[contenteditable]");
  }

  // Canvas shortcuts fire only while focus is inside the shell and not in a
  // text field — so inline label edits and a split-view conversation pane keep
  // their own keys (matches the old focus-scoped onkeydown behaviour).
  function canvasActive(): boolean {
    return (
      !!shellEl?.contains(document.activeElement) && !isTextEntryFocused()
    );
  }

  function handleShellKeydownCapture(e: KeyboardEvent) {
    keybindings.dispatch(e);
    if (e.defaultPrevented) e.stopPropagation();
  }

  useScope("diagram");

  // Focus the shell as soon as it mounts so canvas shortcuts (e.g. ⌥N to add a
  // node) fire immediately. Without this, focus stays outside the shell and ⌥N
  // leaks to the global scope, toggling the project panel instead.
  $effect(() => {
    shellEl?.focus({ preventScroll: true });
  });

  const guard = { enabled: canvasActive };
  useKeybinding("diagram.undo", undo, guard);
  useKeybinding("diagram.redo", redo, guard);
  useKeybinding("diagram.select-all", selectAll, guard);
  useKeybinding("diagram.copy", copySelected, guard);
  useKeybinding("diagram.paste", pasteClipboard, guard);
  useKeybinding("diagram.duplicate", duplicateSelected, guard);
  useKeybinding("diagram.delete-forward", deleteSelected, guard);
  // addNode opens the new node's drawer and autofocuses its name input — same as
  // the toolbar button — so we deliberately hand focus to the drawer, not back
  // to the canvas.
  useKeybinding("diagram.add-node", () => addNode(), guard);
  useKeybinding("diagram.add-group", () => addGroup(), guard);
  useKeybinding("diagram.send-to-back", () => sendSelectionToBack(true), guard);
  useKeybinding("diagram.bring-to-front", () => sendSelectionToBack(false), guard);
  useKeybinding("diagram.search", () => (searchOpen = true), guard);
  useKeybinding("diagram.comments", toggleComments, guard);
  useKeybinding("diagram.dismiss", dismiss, guard);
  useKeybinding("diagram.zoom-in", () => flowControls?.zoomIn({ duration: 150 }), guard);
  useKeybinding("diagram.zoom-out", () => flowControls?.zoomOut({ duration: 150 }), guard);
  useKeybinding("diagram.nudge-up", () => nudgeOrPanBy(0, -10, 0, 80), guard);
  useKeybinding("diagram.nudge-down", () => nudgeOrPanBy(0, 10, 0, -80), guard);
  useKeybinding("diagram.nudge-left", () => nudgeOrPanBy(-10, 0, 80, 0), guard);
  useKeybinding("diagram.nudge-right", () => nudgeOrPanBy(10, 0, -80, 0), guard);
  useKeybinding("diagram.nudge-up-fine", () => nudgeOrPanBy(0, -1, 0, 24), guard);
  useKeybinding("diagram.nudge-down-fine", () => nudgeOrPanBy(0, 1, 0, -24), guard);
  useKeybinding("diagram.nudge-left-fine", () => nudgeOrPanBy(-1, 0, 24, 0), guard);
  useKeybinding("diagram.nudge-right-fine", () => nudgeOrPanBy(1, 0, -24, 0), guard);

  // Every node draws the same swatch, so pass a constant string rather than a
  // per-node callback (which MiniMap would invoke for each node on every redraw).
  const miniMapNodeColor = "var(--solus-text-tertiary)";
</script>

<div
  bind:this={shellEl}
  class="diagram-shell"
  tabindex="-1"
  onkeydowncapture={handleShellKeydownCapture}
>
  <div class="diagram-shell__header">
      <div class="diagram-shell__header-meta">
        {#if inline}
          <FrameExpandButton variant="sidebar" />
        {/if}
        <GraphIcon size={14} class="diagram-shell__title-icon" />
        {#if drillPath.length === 0}
          {#if renaming}
            <!-- svelte-ignore a11y_autofocus -->
            <input
              class="diagram-shell__title-input"
              bind:value={renameValue}
              onblur={commitRename}
              onkeydown={renameKeydown}
              autofocus
              aria-label="Rename diagram"
              data-testid="rename-work-input"
            />
          {:else if onRename}
            <button
              type="button"
              class="diagram-shell__title diagram-shell__title--editable"
              onclick={startRename}
              title="Rename"
              data-testid="rename-work"
            >{title}</button>
          {:else}
            <span class="diagram-shell__title">{title}</span>
          {/if}
        {:else}
          <button
            type="button"
            class="diagram-shell__crumb diagram-shell__crumb--root"
            onclick={() => drillTo(0)}
            title="Back to {title} (Esc)"
          >
            {title}
          </button>
          {#each drillPath as crumb, i}
            <span class="diagram-shell__crumb-sep" aria-hidden="true">›</span>
            {#if i === drillPath.length - 1}
              <span class="diagram-shell__title diagram-shell__crumb--current">
                {crumb.label}
              </span>
            {:else}
              <button
                type="button"
                class="diagram-shell__crumb"
                onclick={() => drillTo(i + 1)}
                title="Back to {crumb.label}"
              >
                {crumb.label}
              </button>
            {/if}
          {/each}
        {/if}
        <div class="diagram-shell__save-status">
        {#if showSaving}
          <span class="diagram-shell__save-dot" aria-hidden="true"></span>
          <span>Saving…</span>
        {:else if saveFailed}
          <button
            type="button"
            class="diagram-shell__save-retry"
            onclick={retrySave}
            title="The last save failed — click to retry"
          >
            Save failed — retry
          </button>
        {:else if lastSavedAt !== null}
          <CheckIcon size={11} />
          <span>{formatSavedAgo(lastSavedAt, savedStatusNow)}</span>
        {/if}
      </div>
    </div>
    <div class="diagram-shell__header-actions">
      {#if workId}
        <button
          type="button"
          class="diagram-shell__comments-btn"
          class:diagram-shell__comments-btn--on={commentsOpen}
          onclick={toggleComments}
          title="Comments (⌥C)"
          aria-label="Toggle comments"
          aria-pressed={commentsOpen}
        >
          <ChatsCircleIcon size={13} />
          {#if comments.length > 0}
            <span class="diagram-shell__comments-count">{comments.length}</span>
          {/if}
        </button>
      {/if}
      <WorkHeaderActions
        {inline}
        paneSlot={slot}
        {onOpenInSplit}
        {onOpenChat}
        {originalSessionMeta}
        iconOnly={slot === "secondary"}
        {copied}
        copy={copyDiagram}
        {workId}
        {title}
        currentContent={content}
        docType="diagram"
        {onRevert}
        {onDelete}
        {onDuplicate}
        {workStorage}
        {onPromoteToProject}
        {promoting}
      />
      <button
        type="button"
        class="diagram-shell__close"
        data-testid="diagram-shell-close"
        onclick={onClose}
        title="Close (Esc)"
      >
        <XIcon size={16} />
      </button>
      {#if inline}
        <FrameExpandButton variant="projectPanel" />
      {/if}
    </div>
  </div>

  <div class="diagram-shell__canvas">
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="diagram-shell__board"
      class:diagram-shell__board--connecting={connectingFrom !== null}
      class:diagram-shell__board--from-source={connectingFrom === "source"}
      class:diagram-shell__board--from-target={connectingFrom === "target"}
      oncontextmenu={handleBoardContextMenu}
    >
      <SvelteFlow
        bind:nodes
        bind:edges
        {nodeTypes}
        {edgeTypes}
        {defaultEdgeOptions}
        colorMode={theme.isDark ? "dark" : "light"}
        zIndexMode="auto"
        elevateNodesOnSelect={false}
        elevateEdgesOnSelect={false}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2}
        maxZoom={2.5}
        deleteKey={null}
        connectionRadius={40}
        attributionPosition="bottom-left"
        onnodeschange={handleNodesChange}
        onedgeschange={handleEdgesChange}
        onbeforeconnect={handleBeforeConnect}
        onconnect={handleConnect}
        onconnectstart={(_, { handleType }) =>
          (connectingFrom = handleType ?? "source")}
        onconnectend={handleConnectEnd}
        onreconnect={handleReconnect}
        onbeforereconnect={handleBeforeReconnect}
        onreconnectstart={handleReconnectStart}
        onreconnectend={handleReconnectEnd}
        onnodeclick={({ node }) => handleNodeClick(node.id)}
        onnodedragstart={({ targetNode }) =>
          targetNode && handleNodeDragStart(targetNode)}
        onnodedrag={({ targetNode }) =>
          targetNode && handleNodeDrag(targetNode)}
        onnodedragstop={({ targetNode }) =>
          targetNode && handleNodeDragStop(targetNode)}
        onedgeclick={({ edge }) => handleEdgeClick(edge.id)}
        onpaneclick={handlePaneClick}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={22}
          size={1.4}
          patternColor={theme.isDark
            ? "rgba(255,255,255,0.08)"
            : "rgba(42,38,24,0.10)"}
        />
        <CanvasToolbar
          onAddNode={addNode}
          onAddGroup={addGroup}
          onRelayout={relayout}
          {layoutDirection}
          onDeleteSelected={deleteSelected}
          {hasSelection}
          getDoc={fullDoc}
          {exportBgColor}
          exportTitle={title}
          {minimapVisible}
          onToggleMinimap={() => {
            minimapVisible = !minimapVisible;
          }}
          onFlowReady={(flow) => {
            flowControls = flow;
          }}
        />

        {#if searchOpen}
          <DiagramSearch
            onMatchedChange={onSearchMatched}
            onClose={closeSearch}
          />
        {/if}

        {#if drillPath.length > 0}
          <Panel position="top-left">
            <button
              type="button"
              class="drill-back-pill"
              onclick={() => drillTo(drillPath.length - 1)}
              title="Back to {drillPath.length > 1
                ? drillPath[drillPath.length - 2].label
                : title} (Esc)"
            >
              <svg
                viewBox="0 0 16 16"
                width="12"
                height="12"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M10 3L5 8l5 5" />
              </svg>
              Back
            </button>
          </Panel>
        {/if}

        {#if focusedNodeId !== null}
          <Panel position="top-right">
            <button
              type="button"
              class="clear-focus-pill"
              onclick={clearFocus}
              title="Clear focus (Esc)"
            >
              <svg
                viewBox="0 0 16 16"
                width="11"
                height="11"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                aria-hidden="true"
              >
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
              Clear focus
            </button>
          </Panel>
        {/if}
        {#if minimapVisible}
          <MiniMap
            class="diagram-minimap"
            position="bottom-right"
            nodeColor={miniMapNodeColor}
            nodeStrokeColor="transparent"
            nodeBorderRadius={3}
            bgColor={exportBgColor}
            maskColor={theme.isDark
              ? "rgba(0,0,0,0.45)"
              : "rgba(250,243,228,0.55)"}
            pannable
            zoomable
          />
        {/if}
      </SvelteFlow>

      {#if nodes.length === 0}
        <div class="diagram-empty">
          <div class="diagram-empty__card">
            <svg
              viewBox="0 0 16 16"
              width="28"
              height="28"
              fill="none"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <rect x="1.5" y="3" width="6" height="4.5" rx="1" />
              <rect x="8.5" y="8.5" width="6" height="4.5" rx="1" />
              <path d="M4.5 7.5v1.5a1 1 0 001 1h3" />
            </svg>
            <p class="diagram-empty__title">No nodes yet</p>
            <p class="diagram-empty__hint">
              Add a node to start building your diagram.
            </p>
            <button
              type="button"
              class="diagram-btn diagram-empty__cta"
              onclick={() => addNode()}>Add node</button
            >
          </div>
        </div>
      {/if}

      {#if contextMenu}
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          type={contextMenu.type}
          onAddComment={workId
            ? () => {
                if (contextMenu) openComments(contextMenu.targetId, true);
              }
            : undefined}
          showRemoveFromGroup={contextTargetHasParent}
          onRemoveFromGroup={handleContextMenuRemoveFromGroup}
          sentToBack={contextTargetSentToBack}
          onSendToBack={handleContextMenuSendToBack}
          onBringToFront={handleContextMenuBringToFront}
          showDetail={contextTargetCanDetail}
          hasDetail={contextTargetHasDetail}
          onOpenDetail={handleContextMenuOpenDetail}
          onDelete={handleContextMenuDelete}
          onEditDetails={handleContextMenuEditDetails}
          onClose={() => {
            contextMenu = null;
          }}
        />
      {/if}

      {#if paneMenu}
        <PaneContextMenu
          x={paneMenu.x}
          y={paneMenu.y}
          canPaste={hasDiagramClipboard()}
          onAddNode={() => {
            addNode({
              x: paneMenu!.flowX - NODE_WIDTH_EST / 2,
              y: paneMenu!.flowY - NODE_HEIGHT_EST / 2,
            });
          }}
          onAddGroup={() => {
            addGroup({ x: paneMenu!.flowX, y: paneMenu!.flowY });
          }}
          onPaste={pasteClipboard}
          onSelectAll={selectAll}
          onFitView={() =>
            void flowControls?.fitView({ duration: 300, padding: 0.2 })}
          onAutoLayout={() => relayout()}
          onClose={() => {
            paneMenu = null;
          }}
        />
      {/if}

      {#if activeDrawerNode}
        <DiagramDetailsDrawer
          node={activeDrawerNode}
          autoFocus={drawerAutoFocus}
          canDetail={drillPath.length === 0 && !activeDrawerNode.group}
          hasDetail={!!activeDrawerNode.detail?.nodes?.length}
          onOpenDetail={() => {
            if (activeDrawerNodeId) openOrCreateDetail(activeDrawerNodeId);
          }}
          onRemoveDetail={() => {
            if (activeDrawerNodeId) removeDetail(activeDrawerNodeId);
          }}
          onClose={() => {
            activeDrawerNodeId = null;
            // Hand focus back to the canvas so shortcuts keep working — after
            // an Escape/✕ close it would otherwise fall to <body>.
            shellEl?.focus();
          }}
          onUpdateNode={handleUpdateNode}
        />
      {/if}

      {#if activeDrawerEdge}
        <DiagramEdgeDrawer
          edge={activeDrawerEdge}
          autoFocus={drawerAutoFocus}
          sourceLabel={activeDrawerEdge.sourceLabel}
          targetLabel={activeDrawerEdge.targetLabel}
          onClose={() => {
            activeDrawerEdgeId = null;
            shellEl?.focus();
          }}
          onUpdateLabel={handleEdgeLabelChange}
          onUpdateKind={handleEdgeKindChange}
          onUpdateColor={handleEdgeColorChange}
          onUpdateWidth={handleEdgeWidthChange}
          onUpdateArrows={handleEdgeArrowsChange}
          onUpdateShape={handleEdgeShapeChange}
          onUpdateCardinality={handleEdgeCardinalityChange}
        />
      {/if}

      {#if commentsOpen}
        <DiagramCommentsPanel
          {comments}
          draftAnchorLabel={commentDraftNodeId
            ? (nodeLabelFor(commentDraftNodeId) ?? commentDraftNodeId)
            : null}
          onClearAnchor={() => (commentDraftNodeId = null)}
          autoFocus={commentsAutoFocus}
          onAdd={addComment}
          onEdit={editComment}
          onDelete={deleteComment}
          onScrollTo={scrollToComment}
          onSendToAgent={sendCommentsToAgent}
          onClose={() => {
            commentsOpen = false;
            shellEl?.focus();
          }}
        />
      {/if}
    </div>
  </div>
</div>
