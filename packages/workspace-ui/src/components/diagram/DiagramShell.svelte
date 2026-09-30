<script lang="ts">
  import "./DiagramShell.css";

  import { localApi } from "@solus/client-core/local-api";
  import { onDestroy, tick, untrack } from "svelte";
  import { SvelteFlow, MiniMap, Panel, MarkerType } from "@xyflow/svelte";
  import "@xyflow/svelte/dist/style.css";
  import { exportFileName } from "../pickers/lib/export-file-name";
  import { downloadPayload, type WorkExportRequest } from "../work/lib/work-export";
  import type { SessionMeta } from "@solus/contracts/types";
  import { getSurfaceContext, getSettingsContext, runtime } from "../../contexts";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { setMarkdownImageContext } from "../conversation/lib/markdown-image";
  import { toasts } from "../../lib/toasts";
  import DiagramCanvasBackground from "./DiagramCanvasBackground.svelte";
  import DiagramAlignmentGuides from "./DiagramAlignmentGuides.svelte";
  import DiagramCanvasStatus from "./DiagramCanvasStatus.svelte";
  import DiagramDrillCrumbs from "./DiagramDrillCrumbs.svelte";
  import DiagramEmptyState from "./DiagramEmptyState.svelte";
  import DiagramHeader from "./DiagramHeader.svelte";
  import DiagramLoadError from "./DiagramLoadError.svelte";
  import DiagramNodeInspector from "./inspector/DiagramNodeInspector.svelte";
  import DiagramNodeRail from "./inspector/DiagramNodeRail.svelte";
  import DiagramInspectorRail from "./inspector/DiagramInspectorRail.svelte";
  import DiagramEdgeInspector from "./inspector/DiagramEdgeInspector.svelte";
  import DiagramCommentsPanel from "./DiagramCommentsPanel.svelte";
  import DiagramThreadLayer from "./DiagramThreadLayer.svelte";
  import DiagramSearch from "./DiagramSearch.svelte";
  import CanvasToolbar from "./CanvasToolbar.svelte";
  import ContextMenu from "./ContextMenu.svelte";
  import PaneContextMenu from "./PaneContextMenu.svelte";
  import { parseDiagram, type DiagramAction, type DiagramDoc } from "@solus/contracts/diagram-types";
  import { isSafeUrl } from "@solus/contracts/diagram-sanitize";
  import { applyLayout, type LayoutDirection } from "@solus/contracts/diagram-layout";
  import { flowEdgeToDiagram } from "./diagram-flow-map";
  import { NODE_WIDTH_EST, NODE_HEIGHT_EST } from "./lib/graph-layout";
  import { hasDiagramClipboard } from "./lib/clipboard.svelte";
  import { DEFAULT_ARROW_COLOR } from "./lib/flow-builders";
  import { DIAGRAM_EDGE_TYPES, DIAGRAM_NODE_TYPES } from "./lib/canvas-registry";
  import {
    EDGE_INSPECTOR_TABS,
    nodeLinks,
    type EdgeInspectorTab,
    type EdgeUpdates,
  } from "./lib/inspector-model";
  import type { ThreadAnchor } from "./lib/thread-card-position";
  import { minimapSize } from "./lib/minimap-size";
  import { arrangementSelection, type Arrangement } from "./lib/selection-arrangement";
  import { DiagramDocument } from "./lib/diagram-document";
  import { DiagramLiveSession } from "./lib/diagram-live-session.svelte";
  import type { LiveEditorBinding } from "../editor/lib/live-editor";
  import { DiagramCanvas, diagramNodeData } from "./lib/diagram-canvas.svelte";
  import { CanvasGestures } from "./lib/canvas-gestures.svelte";
  import { DiagramSaver } from "./lib/diagram-save.svelte";
  import { DiagramThreads } from "./lib/diagram-threads.svelte";
  import { DiagramInspector } from "./lib/diagram-inspector.svelte";
  import { diagramCopyFormats, diagramExportFormats } from "./lib/diagram-work-formats";
  import { isUnread } from "../comments/lib/thread";
  import { setCommentViewer, workCommentViewer } from "../comments/lib/comment-viewer";
  import { useKeybinding, useScope } from "../../lib/keybindings/use-keybinding.svelte";
  import { getKeybindingsContext } from "../../lib/keybindings/dispatcher.svelte";

  interface Props {
    content: string;
    title: string;
    onSave: (content: string) => Promise<void>;
    onClose: () => void;
    /** Fires true when the canvas has unsaved edits, false once they're saved.
        Lets the host decide whether an agent update can safely refresh. */
    onDirtyChange?: (dirty: boolean) => void;
    /** Shared work actions (Chat / copy / overflow) — same contract as docs. */
    onOpenChat?: (mode: "resume" | "new") => void;
    originalSessionMeta?: SessionMeta | null;
    /** Work id — enables the header's History. */
    workId?: string;
    /** Delete the work (closes the pane + offers undo). */
    onDelete?: () => void;
    /** Duplicate the work into a new independent copy. */
    onDuplicate?: () => void | Promise<void>;
    /** Opens the save picker on a chosen format; absent when there is no host. */
    onExport?: (request: WorkExportRequest) => void;
    /** The save picker's filesystem is not this device's — see WorkHeaderActions. */
    hostIsRemote?: boolean;
    onRename?: (title: string) => void;
    /** Leave the diagram for the Workspace page it lives in. */
    onOpenWorkspace?: () => void;
    /** The diagram is edited live: the shared doc is the content. Read once. */
    live?: LiveEditorBinding | null;
  }

  let {
    content,
    title,
    onSave,
    onClose,
    onDirtyChange,
    onOpenChat,
    originalSessionMeta,
    workId,
    onDelete,
    onDuplicate,
    onExport,
    hostIsRemote = false,
    onRename,
    onOpenWorkspace,
    live: liveProp = null,
  }: Props = $props();
  const live = untrack(() => liveProp);
  const liveSession = live ? new DiagramLiveSession(live) : null;
  onDestroy(() => liveSession?.destroy());

  const theme = getSettingsContext();
  const keybindings = getKeybindingsContext();
  const session = getSurfaceContext();
  setMarkdownImageContext({
    cwd: () => undefined,
    serverId: () => workId ? session.worksStore.hostFor(workId) ?? undefined : undefined,
    ctx: () => undefined,
    api: () => {
      const serverId = workId ? session.worksStore.hostFor(workId) : null;
      return serverId ? serverConnections.apiFor(serverId) : undefined;
    },
  });

  // Who reads the threads: their own pins and cards carry no byline, other
  // people's do, and the verbs on someone else's appear only for the owner.
  const commentViewer = () => workCommentViewer(workId ? session.worksStore.hostFor(workId) : null, { kind: "work", id: workId ?? "" });
  setCommentViewer(commentViewer);
  const commentReader = $derived(commentViewer());

  const initialDiagram = (() => {
    try {
      const parsed = liveSession?.content() ?? parseDiagram(content);
      return {
        doc: applyLayout(parsed),
        parseFailed: false,
        hadNoPositions: parsed.nodes.some((node) => !node.position),
      };
    } catch {
      return {
        doc: { nodes: [], edges: [] } satisfies DiagramDoc,
        parseFailed: true,
        hadNoPositions: false,
      };
    }
  })();
  let diagramParseFailed = $state(initialDiagram.parseFailed);

  // The one document. The canvas projects the level being viewed from it;
  // saving, copying and exporting read it whole, detail included.
  // Live: each edit is written to the shared doc as the fields it changed, and
  // undo reverses only the reader's own edits; the host writes the body.
  const diagram = new DiagramDocument(initialDiagram.doc, (change) => {
    if (!live) saver.schedule();
    else if (change === "remote") canvas.showReplacedDocument();
  }, liveSession?.historyFor((next) => diagram.adopt(next)));
  const saver = new DiagramSaver({
    content: () => diagram.serialize(),
    save: (text) => onSave(text),
    onDirtyChange: (dirty) => onDirtyChange?.(dirty),
  });
  // The unreadable source stays what copy and JSON export hand out.
  const currentText = () => (diagramParseFailed ? content : diagram.serialize());

  // Transient UI state — never serialized
  const inspector = new DiagramInspector(() => (threads.commentsOpen = false));
  // The board's own box, so a thread card can be clamped inside it.
  let boardWidth = $state(0);
  let boardHeight = $state(0);
  let contextMenu = $state<{ x: number; y: number; targetId: string; type: "node" | "edge" } | null>(null);
  // Right-click on the empty canvas. Carries both the screen point (for menu
  // placement) and the flow point (where a new node lands).
  let paneMenu = $state<{ x: number; y: number; flowX: number; flowY: number } | null>(null);
  let minimapVisible = $state(true);
  let searchOpen = $state(false);
  // Root element — diagram shortcuts only fire while focus lives inside it.
  let shellEl = $state<HTMLDivElement | null>(null);
  let shellWidth = $state(0);
  // A touch cannot communicate whether it means “move this card” or “move the
  // board” until after it has moved. Default phones to navigation so one-finger
  // pan and pinch work even when the gesture starts over a node. The toolbar
  // exposes the inverse mode when the user intends to arrange cards.
  let touchNodeDragEnabled = $state(false);

  const threads = new DiagramThreads({
    surface: session,
    workId: () => workId,
    title: () => title,
    reader: () => commentReader,
    anchorLabel: anchorLabelFor,
    selectAnchor: (anchor) => {
      if (anchor.nodeId) inspector.showNode(anchor.nodeId, false);
      else if (anchor.edgeId) inspector.showEdge(anchor.edgeId, false);
    },
    revealNode: (nodeId) => canvas.revealNode(nodeId),
    closeDrawers: () => inspector.hide(),
    refreshPins: () => canvas.applyTransientState(),
  });

  // Callbacks every projected node and edge carries back to the shell.
  const nodeHandlers = {
    onLabelChange: (nodeId: string, label: string) => canvas.updateNode(nodeId, { label }),
    onAction: handleAction,
    onResize: (nodeId: string, width: number, height: number) => gestures.resize(nodeId, width, height),
    onResizeLive: (nodeId: string, box: { x: number; y: number; width: number; height: number }) =>
      gestures.resizeLive(nodeId, box),
    onContextMenu: handleContextMenuOpen,
    onSelect: handleNodeClick,
    onToggleCollapse: (groupId: string) => canvas.toggleCollapse(groupId),
    onOpenThread: (nodeId: string) => threads.openFirstOn(nodeId),
  };
  const edgeHandlers = {
    onLabelChange: (edgeId: string, label: string) => canvas.updateEdge(edgeId, { label: label || undefined }),
    onLabelOffsetChange: (edgeId: string, offset: { x: number; y: number }) => gestures.labelOffsetChange(edgeId, offset),
    onLabelOffsetCommit: () => gestures.labelOffsetCommit(),
    onBendOffsetChange: (edgeId: string, offset: number, axis?: "x" | "y") => gestures.bendChange(edgeId, offset, axis),
    onBendOffsetCommit: (edgeId: string) => gestures.bendCommit(edgeId),
    onContextMenu: handleContextMenuOpen,
  };
  // One handler per editable edge property, for the inspector tabs.
  const edgeUpdates: EdgeUpdates = {
    label: (id, label) => canvas.updateEdge(id, { label: label || undefined }),
    body: (id, body) => canvas.updateEdge(id, { body }),
    kind: (id, kind) => canvas.updateEdge(id, { kind }),
    color: (id, color) => canvas.updateEdge(id, { color }),
    width: (id, width) => canvas.updateEdge(id, { width }),
    dash: (id, dash) => canvas.updateEdge(id, { dash }),
    arrows: (id, arrows) => canvas.updateEdge(id, { arrows }),
    route: (id, route) => canvas.updateEdge(id, { route }),
    cardinality: (id, cardinality) => canvas.updateEdge(id, { cardinality }),
    labelOffset: (id, labelOffset) => canvas.updateEdge(id, { labelOffset }),
  };

  const canvas = new DiagramCanvas({
    document: diagram,
    nodeHandlers,
    edgeHandlers,
    pinFor: (nodeId) => threads.pinFor(nodeId),
    onLevelChange: (selectedNodeId) => {
      searchOpen = false;
      inspector.hide();
      contextMenu = null;
      // Pins belong to a level; a card over the level just left points at nothing.
      threads.closeFloating();
      if (selectedNodeId) inspector.showNode(selectedNodeId, false);
    },
    // A positionless diagram was auto-laid out with the LR default.
    initialLayout: initialDiagram.hadNoPositions ? "LR" : null,
  });
  const gestures = new CanvasGestures(canvas, () => shellEl);
  // Who else has which nodes selected, outlined in their colour; and ours, for them.
  const liveOutlineStyles = $derived(liveSession?.outlineStylesOn(canvas.path[0] ?? null) ?? "");
  $effect(() => {
    const selected = canvas.nodes.filter((node) => node.selected).map((node) => node.id);
    untrack(() => liveSession?.select(canvas.path[0] ?? null, selected));
  });
  // Positions assigned on load are content: save them (live: already in the doc).
  if (initialDiagram.hadNoPositions && !live) saver.schedule();
  // Flush a pending debounce on unmount so an edit made just before the shell
  // is torn down (tab close, mode switch) still reaches disk.
  onDestroy(() => saver.flush());

  const activeDrawerNode = $derived.by(() => {
    if (inspector.nodeId === null) return null;
    const node = canvas.nodes.find((candidate) => candidate.id === inspector.nodeId);
    return node ? diagramNodeData(node) : null;
  });

  const activeDrawerEdge = $derived.by(() => {
    if (inspector.edgeId === null) return null;
    const e = canvas.edges.find((x) => x.id === inspector.edgeId);
    if (!e) return null;
    return {
      ...flowEdgeToDiagram(e),
      sourceLabel: canvas.nodeLabel(e.source) ?? e.source,
      targetLabel: canvas.nodeLabel(e.target) ?? e.target,
    };
  });

  // Every edge touching the inspected node, for the Links tab and the degree
  // chip. Both read the same list so they can never disagree.
  const activeNodeLinks = $derived(
    inspector.nodeId === null
      ? []
      : nodeLinks(inspector.nodeId, canvas.edges, (id) => canvas.nodeLabel(id) ?? id),
  );
  const inspectedNodeThreads = $derived(threads.threadsOn(inspector.nodeId));
  const inspectedEdgeThreads = $derived(threads.threadsOn(inspector.edgeId));
  // Siblings leaving the same source share one vertical trunk.
  const edgeTrunkSiblings = $derived(
    activeDrawerEdge === null ? 0 : canvas.edges.filter((e) => e.source === activeDrawerEdge.source).length,
  );
  // Every floating overlay's offset is derived from one value — the inspector's
  // footprint (its width plus the inset it keeps from the board edge). The
  // centred toolbar biases by half of that so it optically centres on the
  // *visible* canvas. A desktop split pane keeps the full-height side
  // inspector; only touch clients use a bottom sheet when the pane is narrow.
  const inspectorUsesBottomSheet = $derived(runtime.isTouchDevice && shellWidth > 0 && shellWidth <= 768);
  const inspectorFootprint = $derived(
    inspectorUsesBottomSheet || (activeDrawerNode === null && activeDrawerEdge === null)
      ? 0
      : inspector.open
        ? 408
        : 84,
  );
  const chromeOffsets = $derived(
    `--chrome-inset-right:${inspectorFootprint}px;--chrome-centre-bias:${
      inspectorFootprint === 0 ? 0 : (inspectorFootprint - 16) / 2
    }px`,
  );
  // One-word read-out for the inspector footer — edits are live, so this is
  // the only save feedback that surface offers.
  const inspectorSaveState = $derived(
    liveSession ? liveSession.statusWord : saver.showSaving ? "saving…" : saver.saveFailed ? "save failed" : saver.lastSavedAt !== null ? "saved" : "",
  );
  const arrangementCount = $derived(arrangementSelection(canvas.nodes).length);
  const hasSelection = $derived(canvas.nodes.some((n) => n.selected) || canvas.edges.some((e) => e.selected));
  // Status, not a control — the layout menu in the toolbar is where you act.
  const layoutStatus = $derived(
    canvas.layoutDirection === null
      ? null
      : `Auto-layout · ${canvas.layoutPristine ? canvas.layoutDirection : "edited"}`,
  );

  function anchorLabelFor(anchor: ThreadAnchor): string | null {
    if (anchor.nodeId) return canvas.nodeLabel(anchor.nodeId);
    const edge = anchor.edgeId ? canvas.edges.find((e) => e.id === anchor.edgeId) : undefined;
    if (!edge) return null;
    const label = edge.label ?? "";
    return label || `${canvas.nodeLabel(edge.source) ?? edge.source} → ${canvas.nodeLabel(edge.target) ?? edge.target}`;
  }

  const exportBgColor = $derived(theme.isDark ? "#1a1916" : "#fefefc");
  let fullDiagramExports = $state(0);

  function imageOptions() {
    if (!canvas.flow || !shellEl) return null;
    return { flow: canvas.flow, root: shellEl, backgroundColor: exportBgColor, prepare: prepareImageExport };
  }

  const formatSources = { json: currentText, doc: () => diagram.snapshot(), image: imageOptions };
  const exportFormats = diagramExportFormats(formatSources);
  const copyFormats = diagramCopyFormats(formatSources);

  // Render every node (not only the visible ones) while an image is taken.
  async function prepareImageExport(): Promise<() => void> {
    fullDiagramExports += 1;
    await tick();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      fullDiagramExports -= 1;
    };
  }

  function downloadSourceJson() {
    downloadPayload(exportFileName(title, "json"), "application/json", { contents: content, encoding: "utf8" });
  }

  // The pane passes new content only for an accepted external save to a clean
  // editor. Replace the document (its undo describes the old content) and keep
  // the reader's level, instead of remounting the canvas.
  let acceptedContent = untrack(() => content);
  $effect(() => {
    const next = content;
    if (next === acceptedContent) return;
    acceptedContent = next;
    untrack(() => acceptSavedContent(next));
  });

  function acceptSavedContent(next: string) {
    // A live diagram's saved body is projected from the doc it already shows.
    if (live || saver.hasPendingSave || saver.isSaving || next === diagram.serialize()) return;
    try {
      diagram.replace(applyLayout(parseDiagram(next)));
      diagramParseFailed = false;
      canvas.showReplacedDocument();
    } catch {
      diagramParseFailed = true;
    }
  }

  function retryParse() {
    try {
      diagram.replace(applyLayout(parseDiagram(content)));
      diagramParseFailed = false;
      canvas.loadLevel();
    } catch {
      toasts.error("This diagram still could not be read");
    }
  }

  const defaultEdgeOptions = {
    type: "default",
    // Hit area: a transparent stroke wider than the 1.3px line, but narrow
    // enough that two edges sharing a trunk stay separately grabbable. Painted
    // on hover (see DiagramShell.css) — the line itself never thickens.
    interactionWidth: 13,
    markerEnd: {
      type: MarkerType.Arrow,
      width: 16,
      height: 16,
      strokeWidth: 1.3,
      color: DEFAULT_ARROW_COLOR,
    },
  };

  function handleAction(nodeId: string, action: DiagramAction) {
    switch (action.do) {
      case "expand":
        canvas.toggleExpanded(nodeId);
        break;
      case "focus":
        canvas.toggleFocus(nodeId);
        break;
      case "details":
        inspector.showNode(inspector.nodeId === nodeId ? null : nodeId, true);
        break;
      case "drilldown":
        canvas.drillInto(nodeId);
        break;
      case "openUrl":
        if (isSafeUrl(action.url)) void localApi.openExternal(action.url);
        break;
    }
  }

  function undo() {
    canvas.undo();
    shellEl?.focus({ preventScroll: true });
  }

  function redo() {
    canvas.redo();
    shellEl?.focus({ preventScroll: true });
  }

  function handleContextMenuOpen(targetId: string, type: "node" | "edge", x: number, y: number) {
    paneMenu = null;
    contextMenu = { x, y, targetId, type };
  }

  // Right-click on the empty canvas → the pane menu. Node/edge context menus
  // already stop propagation, so a contextmenu reaching the board came from the
  // bare pane surface.
  function handleBoardContextMenu(e: MouseEvent) {
    const t = e.target instanceof HTMLElement ? e.target : null;
    if (!t?.closest(".svelte-flow__pane")) return;
    e.preventDefault();
    contextMenu = null;
    const flow = canvas.flow?.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    paneMenu = { x: e.clientX, y: e.clientY, flowX: flow?.x ?? 0, flowY: flow?.y ?? 0 };
  }

  // ── Inspector chrome ──────────────────────────────────────────────────────
  // Collapse keeps the selection and the active tab; close drops the selection
  // (the ring comes off the card too, so the toolbar's delete is not left armed)
  // and hands focus back to the canvas so its shortcuts keep working.
  function collapseInspector() {
    inspector.open = false;
    shellEl?.focus();
  }

  function closeInspector() {
    if (inspector.nodeId !== null) canvas.deselectNodes();
    else canvas.deselectEdges();
    inspector.close();
    shellEl?.focus();
  }

  // ⌘\ — collapse whichever inspector is up, or reopen it.
  function toggleInspector() {
    if (!inspector.isShowing) return;
    if (inspector.open) collapseInspector();
    else inspector.open = true;
  }

  // Remove nodes and edges together, closing a drawer left pointing at one.
  function removeElements(nodeIds: Set<string>, edgeIds: Set<string>) {
    if (nodeIds.size === 0 && edgeIds.size === 0) return;
    canvas.removeElements(nodeIds, edgeIds);
    if (inspector.nodeId && nodeIds.has(inspector.nodeId)) inspector.nodeId = null;
    if (inspector.edgeId && !canvas.edges.some((e) => e.id === inspector.edgeId)) inspector.edgeId = null;
  }

  function deleteSelected() {
    removeElements(new Set(canvas.selectedNodeIds()), new Set(canvas.selectedEdgeIds()));
  }

  function deleteInspected() {
    if (inspector.nodeId !== null) removeElements(new Set([inspector.nodeId]), new Set());
    else if (inspector.edgeId !== null) removeElements(new Set(), new Set([inspector.edgeId]));
    shellEl?.focus();
  }

  // Selecting a node/edge opens its editor drawer so the side menu tracks the
  // current selection. In focus mode every card stays clickable: clicking one
  // moves the focus there. Selecting something else is an outside click as
  // far as the thread card is concerned.
  function handleNodeClick(nodeId: string) {
    canvas.moveFocusTo(nodeId);
    threads.closeFloating();
    inspector.showNode(nodeId, false);
  }

  function handleEdgeClick(edgeId: string) {
    threads.closeFloating();
    inspector.showEdge(edgeId, false);
  }

  // Clicking empty canvas clears the selection, so close the drawer to match.
  function handlePaneClick() {
    inspector.hide();
    threads.closeFloating();
  }

  function contextTargetNode() {
    if (contextMenu?.type !== "node") return null;
    const targetId = contextMenu.targetId;
    const node = canvas.nodes.find((n) => n.id === targetId);
    return node ? diagramNodeData(node) : null;
  }

  function handleContextMenuDelete() {
    if (!contextMenu) return;
    const { targetId, type } = contextMenu;
    if (type === "node") removeElements(new Set([targetId]), new Set());
    else removeElements(new Set(), new Set([targetId]));
  }

  function handleContextMenuEditDetails() {
    if (!contextMenu) return;
    if (contextMenu.type === "node") inspector.showNode(contextMenu.targetId, true);
    else inspector.showEdge(contextMenu.targetId, true);
  }

  function handleContextMenuSentToBack(value: boolean) {
    if (contextMenu?.type === "node") canvas.setSentToBack([contextMenu.targetId], value);
  }

  const contextTarget = $derived(contextTargetNode());
  // "Add/Open detail" applies to a top-level, non-group node on the root level.
  const contextTargetCanDetail = $derived(!!contextTarget && !canvas.isNested && !contextTarget.group);

  function addNode(at?: { x: number; y: number }) {
    // Opens the new node's drawer so its details are immediately settable.
    inspector.showNode(canvas.addNode(at), true);
  }

  function addGroup(at?: { x: number; y: number }) {
    inspector.showNode(canvas.addGroup(at), true);
  }

  function arrangeSelection(action: Arrangement) {
    if (canvas.arrange(action)) shellEl?.focus({ preventScroll: true });
  }

  // Search reveals a match hidden in a folded group by opening its ancestors.
  async function revealSearchNodes(nodeIds: string[]) {
    const byId = new Map(canvas.nodes.map((n) => [n.id, n]));
    const parents = new Set<string>();
    for (const id of nodeIds) {
      let parent = byId.get(id)?.parentId;
      while (parent) {
        parents.add(parent);
        parent = byId.get(parent)?.parentId;
      }
    }
    diagram.edit(() => {
      for (const id of parents) if (byId.get(id)?.data.collapsed) canvas.toggleCollapse(id);
    });
    await tick();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }

  function closeSearch() {
    searchOpen = false;
    canvas.setSearchMatches(null);
    shellEl?.focus({ preventScroll: true });
  }

  function toggleComments() {
    if (threads.commentsOpen) threads.commentsOpen = false;
    // Anchor to the node whose drawer is open, if any — likeliest target.
    else threads.openPanel(inspector.nodeId, false);
  }

  // Escape cascade: peel back the most specific overlay first, close last.
  function dismiss() {
    if (searchOpen) return closeSearch();
    if (contextMenu) return void (contextMenu = null);
    if (paneMenu) return void (paneMenu = null);
    // The floating card or composer goes before the inspector is touched at all.
    if (threads.openThreadId !== null || threads.composerAnchor !== null) return threads.closeFloating();
    if (threads.commentsOpen) return void (threads.commentsOpen = false);
    // Both inspectors peel back a step at a time: full panel → rail → gone.
    if (inspector.isShowing) return inspector.open ? collapseInspector() : closeInspector();
    if (canvas.focusedNodeId !== null) return canvas.clearFocus();
    if (canvas.isNested) return canvas.drillTo(canvas.path.length - 1);
    onClose();
  }

  // Canvas shortcuts fire only while focus is inside the shell and not in a
  // text field — so inline label edits and a split-view conversation pane keep
  // their own keys.
  function canvasActive(): boolean {
    const el = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return (
      !!shellEl?.contains(document.activeElement) &&
      !el?.closest?.("input,textarea,[contenteditable]") &&
      !(document.activeElement instanceof Element && document.activeElement.closest(".edge-label-display"))
    );
  }

  function handleShellKeydownCapture(e: KeyboardEvent) {
    keybindings.dispatch(e);
    if (e.defaultPrevented) e.stopPropagation();
  }

  useScope("diagram");

  // Focus the shell as soon as it mounts so canvas shortcuts (e.g. ⌥N to add a
  // node) fire immediately instead of leaking to the global scope.
  $effect(() => {
    shellEl?.focus({ preventScroll: true });
  });

  const guard = { enabled: canvasActive };
  useKeybinding("diagram.undo", undo, guard);
  useKeybinding("diagram.redo", redo, guard);
  useKeybinding("diagram.select-all", () => canvas.selectAll(), guard);
  useKeybinding("diagram.copy", () => canvas.copySelection(), guard);
  useKeybinding("diagram.paste", () => canvas.paste(), guard);
  useKeybinding("diagram.duplicate", () => canvas.duplicateSelection(), guard);
  useKeybinding("diagram.delete-forward", deleteSelected, guard);
  // addNode opens the new node's drawer and autofocuses its name input — same
  // as the toolbar button — so focus deliberately goes to the drawer.
  useKeybinding("diagram.add-node", () => addNode(), guard);
  useKeybinding("diagram.add-group", () => addGroup(), guard);
  useKeybinding("diagram.send-to-back", () => canvas.setSentToBack(canvas.selectedNodeIds(), true), guard);
  useKeybinding("diagram.bring-to-front", () => canvas.setSentToBack(canvas.selectedNodeIds(), false), guard);
  useKeybinding("diagram.search", () => { searchOpen = true; }, guard);
  useKeybinding("diagram.comments", toggleComments, guard);
  useKeybinding("diagram.toggle-inspector", toggleInspector, guard);
  useKeybinding("diagram.dismiss", dismiss, guard);
  useKeybinding("diagram.zoom-in", () => void canvas.flow?.zoomIn({ duration: 150 }), guard);
  useKeybinding("diagram.zoom-out", () => void canvas.flow?.zoomOut({ duration: 150 }), guard);
  useKeybinding("diagram.nudge-up", () => canvas.nudgeOrPan(0, -10, 0, 80), guard);
  useKeybinding("diagram.nudge-down", () => canvas.nudgeOrPan(0, 10, 0, -80), guard);
  useKeybinding("diagram.nudge-left", () => canvas.nudgeOrPan(-10, 0, 80, 0), guard);
  useKeybinding("diagram.nudge-right", () => canvas.nudgeOrPan(10, 0, -80, 0), guard);
  useKeybinding("diagram.nudge-up-fine", () => canvas.nudgeOrPan(0, -1, 0, 24), guard);
  useKeybinding("diagram.nudge-down-fine", () => canvas.nudgeOrPan(0, 1, 0, -24), guard);
  useKeybinding("diagram.nudge-left-fine", () => canvas.nudgeOrPan(-1, 0, 24, 0), guard);
  useKeybinding("diagram.nudge-right-fine", () => canvas.nudgeOrPan(1, 0, -24, 0), guard);

  // Every node draws the same swatch, so pass a constant string rather than a
  // per-node callback (which MiniMap would invoke for each node on every redraw).
  const miniMapNodeColor = "var(--solus-text-tertiary)";

  // A minimap is a hover-and-precision affordance: absent on a touch client,
  // and otherwise sized off the board (not the OS window) by `minimapSize`.
  const minimap = $derived(runtime.isTouchDevice ? null : minimapSize(boardWidth));
</script>

<div
  bind:this={shellEl}
  bind:clientWidth={shellWidth}
  class="diagram-shell"
  class:diagram-shell--bottom-inspector={inspectorUsesBottomSheet}
  tabindex="-1"
  onkeydowncapture={handleShellKeydownCapture}
>
  <DiagramHeader
    {title}
    {saver}
    liveState={live?.live ?? null}
    {currentText}
    {content}
    {workId}
    {onRename}
    {onOpenWorkspace}
    {onOpenChat}
    {originalSessionMeta}
    {onDelete}
    {onDuplicate}
    {exportFormats}
    {copyFormats}
    {onExport}
    {hostIsRemote}
  />

  <!-- `inert` holds the canvas during the agent edit lock; the header says why. The
       outline rules are DOM text, never markup, and each value is checked. -->
  <div class="diagram-shell__canvas" inert={liveSession?.readOnly ?? false}>
    {#if liveOutlineStyles}<svelte:element this={"style"}>{liveOutlineStyles}</svelte:element>{/if}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="diagram-shell__board"
      class:diagram-shell__board--connecting={gestures.connectingFrom !== null}
      class:diagram-shell__board--from-source={gestures.connectingFrom === "source"}
      class:diagram-shell__board--from-target={gestures.connectingFrom === "target"}
      style={chromeOffsets}
      bind:clientWidth={boardWidth}
      bind:clientHeight={boardHeight}
      oncontextmenu={handleBoardContextMenu}
    >
      {#if diagramParseFailed}
        <DiagramLoadError onRetry={retryParse} onDownload={downloadSourceJson} />
      {:else}
      <SvelteFlow
        bind:nodes={canvas.nodes}
        bind:edges={canvas.edges}
        nodeTypes={DIAGRAM_NODE_TYPES}
        edgeTypes={DIAGRAM_EDGE_TYPES}
        {defaultEdgeOptions}
        colorMode={theme.isDark ? "dark" : "light"}
        zIndexMode="auto"
        elevateNodesOnSelect={false}
        elevateEdgesOnSelect={false}
        onlyRenderVisibleElements={fullDiagramExports === 0 && canvas.nodes.length + canvas.edges.length > 150}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2}
        maxZoom={2.5}
        nodesDraggable={!runtime.isTouchDevice || touchNodeDragEnabled}
        deleteKey={null}
        connectionRadius={40}
        proOptions={{ hideAttribution: true }}
        onbeforeconnect={(connection) => gestures.beforeConnect(connection)}
        onconnectstart={(_, { handleType }) => gestures.connectStart(handleType)}
        onconnectend={(event, state) => gestures.connectEnd(event, state)}
        onbeforereconnect={(rewired, previous) => gestures.beforeReconnect(rewired, previous)}
        onreconnectstart={(event) => gestures.reconnectDragStart(event)}
        onreconnectend={(event, edge, handleType, state) => gestures.reconnectEnd(event, edge, handleType, state)}
        onnodeclick={({ node }) => handleNodeClick(node.id)}
        onnodedragstart={({ targetNode }) => targetNode && gestures.dragStart(targetNode)}
        onnodedrag={({ targetNode }) => targetNode && gestures.drag(targetNode)}
        onnodedragstop={({ targetNode }) => targetNode && gestures.dragStop(targetNode)}
        onedgeclick={({ edge }) => handleEdgeClick(edge.id)}
        onpaneclick={handlePaneClick}
      >
        <DiagramCanvasBackground />
        <DiagramAlignmentGuides />
        <CanvasToolbar
          onAddNode={() => addNode()}
          onAddGroup={() => addGroup()}
          onRelayout={(direction: LayoutDirection) => canvas.relayout(direction)}
          canUndo={diagram.canUndo}
          canRedo={diagram.canRedo}
          onUndo={undo}
          onRedo={redo}
          onDuplicate={() => canvas.duplicateSelection()}
          onSearch={() => (searchOpen = true)}
          onArrange={arrangeSelection}
          onSelectAll={() => canvas.selectAll()}
          {arrangementCount}
          layoutDirection={canvas.layoutDirection}
          onDeleteSelected={deleteSelected}
          {hasSelection}
          getDoc={() => diagram.snapshot()}
          {minimapVisible}
          minimapFits={minimap !== null}
          isTouchDevice={runtime.isTouchDevice}
          {touchNodeDragEnabled}
          onToggleTouchNodeDrag={() => {
            touchNodeDragEnabled = !touchNodeDragEnabled;
          }}
          onToggleMinimap={() => {
            minimapVisible = !minimapVisible;
          }}
          onFlowReady={(flow) => {
            canvas.flow = flow;
          }}
        />

        {#if searchOpen}
          <DiagramSearch
            onMatchedChange={(ids) => canvas.setSearchMatches(ids)}
            onReveal={revealSearchNodes}
            onClose={closeSearch}
          />
        {/if}

        {#if canvas.isNested}
          <Panel position="top-left">
            <DiagramDrillCrumbs
              rootLabel={title}
              path={canvas.drillPath}
              onNavigate={(depth) => canvas.drillTo(depth)}
              rootTitle="Back to {title} (Esc)"
            />
          </Panel>
        {/if}

        <DiagramCanvasStatus
          threadTotal={threads.counts.total}
          threadUnread={threads.counts.unread}
          onOpenThreads={() => threads.openFirstUnread()}
          isFocused={canvas.focusedNodeId !== null}
          onClearFocus={() => canvas.clearFocus()}
          {layoutStatus}
          layoutPristine={canvas.layoutPristine}
        />
        <DiagramThreadLayer
          {threads}
          nodes={canvas.nodes}
          edges={canvas.edges}
          composerLabel={threads.composerAnchor ? (anchorLabelFor(threads.composerAnchor) ?? title) : ""}
          pane={{ width: boardWidth, height: boardHeight }}
          {inspectorFootprint}
          onCancelComposer={() => shellEl?.focus()}
        />

        {#if minimapVisible && minimap}
          <MiniMap
            class="diagram-minimap"
            position="bottom-right"
            width={minimap.width}
            height={minimap.height}
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
      {/if}

      {#if !diagramParseFailed && canvas.nodes.length === 0}
        <DiagramEmptyState onAddNode={() => addNode()} />
      {/if}

      {#if contextMenu}
        {@const menu = contextMenu}
        <ContextMenu
          x={menu.x}
          y={menu.y}
          type={menu.type}
          onAddComment={workId
            ? () =>
                // A thread rides the thing you right-clicked, so it is written
                // on the canvas beside it rather than in a panel across the pane.
                threads.openComposer(menu.type === "edge" ? { edgeId: menu.targetId } : { nodeId: menu.targetId })
            : undefined}
          showRemoveFromGroup={!!contextTarget?.parentId}
          onRemoveFromGroup={() => canvas.removeFromGroup(menu.targetId)}
          sentToBack={!!contextTarget?.sentToBack}
          onSendToBack={() => handleContextMenuSentToBack(true)}
          onBringToFront={() => handleContextMenuSentToBack(false)}
          showDetail={contextTargetCanDetail}
          hasDetail={!!contextTarget?.detail?.nodes.length}
          onOpenDetail={() => canvas.openOrCreateDetail(menu.targetId)}
          onDelete={handleContextMenuDelete}
          onDuplicate={() => canvas.duplicateSelection()}
          onEditDetails={handleContextMenuEditDetails}
          onClose={() => {
            contextMenu = null;
          }}
        />
      {/if}

      {#if paneMenu}
        {@const menu = paneMenu}
        <PaneContextMenu
          x={menu.x}
          y={menu.y}
          canPaste={hasDiagramClipboard()}
          onAddNode={() => addNode({ x: menu.flowX - NODE_WIDTH_EST / 2, y: menu.flowY - NODE_HEIGHT_EST / 2 })}
          onAddGroup={() => addGroup({ x: menu.flowX, y: menu.flowY })}
          onPaste={() => canvas.paste()}
          onSelectAll={() => canvas.selectAll()}
          onFitView={() => void canvas.flow?.fitView({ duration: 300, padding: 0.2 })}
          onAutoLayout={() => canvas.relayout()}
          onClose={() => {
            paneMenu = null;
          }}
        />
      {/if}

      {#if activeDrawerNode && inspector.open}
        <DiagramNodeInspector
          node={activeDrawerNode}
          links={activeNodeLinks}
          tab={inspector.tab}
          onTabChange={(tab) => (inspector.tab = tab)}
          saveState={inspectorSaveState}
          autoFocus={inspector.autoFocus}
          canDetail={!canvas.isNested && !activeDrawerNode.group}
          hasDetail={!!activeDrawerNode.detail?.nodes?.length}
          onOpenDetail={() => {
            if (inspector.nodeId) canvas.openOrCreateDetail(inspector.nodeId);
          }}
          onRemoveDetail={() => {
            if (inspector.nodeId) canvas.removeDetail(inspector.nodeId);
          }}
          onOpenEdge={(edgeId) => inspector.showEdge(edgeId, false)}
          onCollapse={collapseInspector}
          onClose={closeInspector}
          onDelete={deleteInspected}
          onUpdateNode={(nodeId, changes) => canvas.updateNode(nodeId, changes)}
          threads={inspectedNodeThreads}
          diagramThreadCount={threads.counts.total}
          showResolved={threads.showResolved}
          onShowResolvedChange={(show) => threads.setShowResolved(show)}
          onOpenThread={(commentId) => threads.openCard(commentId)}
          onShowAllThreads={() => threads.openPanel(null, false)}
          now={threads.now}
        />
      {:else if activeDrawerNode}
        <DiagramNodeRail
          node={activeDrawerNode}
          tab={inspector.tab}
          hasUnreadThreads={inspectedNodeThreads.some((t) => isUnread(t, commentReader))}
          onExpand={(tab) => {
            if (tab) inspector.tab = tab;
            inspector.open = true;
          }}
        />
      {/if}

      {#if activeDrawerEdge && inspector.open}
        <DiagramEdgeInspector
          edge={activeDrawerEdge}
          sourceLabel={activeDrawerEdge.sourceLabel}
          targetLabel={activeDrawerEdge.targetLabel}
          tab={inspector.edgeTab}
          onTabChange={(tab) => (inspector.edgeTab = tab)}
          trunkSiblings={edgeTrunkSiblings}
          saveState={inspectorSaveState}
          autoFocus={inspector.autoFocus}
          update={edgeUpdates}
          onOpenEndpoint={(nodeId) => inspector.showNode(nodeId, false)}
          onReverse={() => {
            if (inspector.edgeId) canvas.reverseEdge(inspector.edgeId);
          }}
          onCollapse={collapseInspector}
          onClose={closeInspector}
          onDelete={deleteInspected}
          threads={inspectedEdgeThreads}
          diagramThreadCount={threads.counts.total}
          showResolved={threads.showResolved}
          onShowResolvedChange={(show) => threads.setShowResolved(show)}
          onOpenThread={(commentId) => threads.openCard(commentId)}
          onShowAllThreads={() => threads.openPanel(null, false)}
          now={threads.now}
        />
      {:else if activeDrawerEdge}
        <DiagramInspectorRail
          kindWord="Edge"
          label={activeDrawerEdge.label ||
            `${activeDrawerEdge.sourceLabel} → ${activeDrawerEdge.targetLabel}`}
          tint={activeDrawerEdge.color ?? "var(--solus-accent)"}
          tabs={EDGE_INSPECTOR_TABS}
          tab={inspector.edgeTab}
          hasUnreadThreads={inspectedEdgeThreads.some((t) => isUnread(t, commentReader))}
          onExpand={(name) => {
            if (name) inspector.edgeTab = name as EdgeInspectorTab;
            inspector.open = true;
          }}
        >
          {#snippet tile()}
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3.6 4h4a2 2 0 0 1 2 2v5.4M7.6 9.4l2 2 2-2" />
              <circle cx="3.6" cy="4" r="1.4" />
            </svg>
          {/snippet}
        </DiagramInspectorRail>
      {/if}

      {#if threads.commentsOpen}
        <DiagramCommentsPanel
          comments={threads.comments}
          draftAnchorLabel={threads.commentDraftNodeId
            ? (canvas.nodeLabel(threads.commentDraftNodeId) ?? threads.commentDraftNodeId)
            : null}
          onClearAnchor={() => (threads.commentDraftNodeId = null)}
          autoFocus={threads.commentsAutoFocus}
          onAdd={(text) => threads.addPanelComment(text)}
          onEdit={(commentId, text) => threads.editComment(commentId, text)}
          onDelete={(commentId) => threads.deleteComment(commentId)}
          onScrollTo={(commentId) => threads.revealComment(commentId)}
          onSendToAgent={session.workspace ? () => threads.sendToAgent() : null}
          onClose={() => {
            threads.commentsOpen = false;
            shellEl?.focus();
          }}
        />
      {/if}
    </div>
  </div>
</div>
