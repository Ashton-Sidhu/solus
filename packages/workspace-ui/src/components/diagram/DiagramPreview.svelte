<script lang="ts">
  // A reading canvas: the real graph, none of the editing. It renders the same
  // node, group and edge components the full shell does — so a preview and the
  // thing it previews can never drift — with every authoring affordance left
  // unwired: no drag, no connect, no resize, no selection, no label editing.
  // What survives is what reading needs: pan, zoom, expand a card, and drill
  // into a node's detail sub-diagram.
  import "./DiagramShell.css";
  import "@xyflow/svelte/dist/style.css";
  import {
    SvelteFlow,
    Panel,
    type Edge,
    type Node,
    type useSvelteFlow,
  } from "@xyflow/svelte";
  import { localApi } from "@solus/client-core/local-api";
  import { applyLayout } from "@solus/contracts/diagram-layout";
  import { parseDiagram } from "@solus/contracts/diagram-types";
  import type { DiagramAction, DiagramDoc } from "@solus/contracts/diagram-types";
  import { isSafeUrl } from "@solus/contracts/diagram-sanitize";
  import { getSettingsContext, runtime } from "../../contexts";
  import CanvasZoomControls from "./CanvasZoomControls.svelte";
  import DiagramCanvasBackground from "./DiagramCanvasBackground.svelte";
  import DiagramDrillCrumbs from "./DiagramDrillCrumbs.svelte";
  import { toFlowEdges, toFlowNodes } from "./lib/flow-builders";
  import { DIAGRAM_EDGE_TYPES, DIAGRAM_NODE_TYPES } from "./lib/canvas-registry";

  interface Props {
    content: string;
    /** Root label for the drill crumb — the work's own title. */
    title?: string;
    /**
     * Keep every node and edge in the DOM however large the graph. Reading a
     * big graph virtualizes; capturing one as an image cannot.
     */
    renderAllElements?: boolean;
    /** Hands the flow instance to a host that captures or drives the canvas. */
    onFlowReady?: (flow: ReturnType<typeof useSvelteFlow>) => void;
    /** Node and edge ids to outline as changed, for the history comparison. */
    marks?: { added: ReadonlySet<string>; removed: ReadonlySet<string>; changed: ReadonlySet<string> };
  }

  let { content, title = "Diagram", renderAllElements = false, onFlowReady, marks }: Props = $props();

  function markClass(id: string): string | undefined {
    if (marks?.added.has(id)) return "diagram-mark diagram-mark--added";
    if (marks?.removed.has(id)) return "diagram-mark diagram-mark--removed";
    if (marks?.changed.has(id)) return "diagram-mark diagram-mark--changed";
    return undefined;
  }

  const theme = getSettingsContext();
  const nodeTypes = DIAGRAM_NODE_TYPES;
  const edgeTypes = DIAGRAM_EDGE_TYPES;

  let nodes = $state.raw<Node[]>([]);
  let edges = $state.raw<Edge[]>([]);
  // Same shape the shell's trail uses, so both feed the shared crumbs.
  let drillPath = $state<{ id: string; label: string }[]>([]);
  let parseFailed = $state(false);

  // Plain (non-reactive) view model: the flow arrays above are the reactive
  // surface, and rebuilding from these is always explicit.
  let rootDoc: DiagramDoc = { nodes: [], edges: [] };
  let viewDoc: DiagramDoc = rootDoc;
  let expandedNodeIds = new Set<string>();
  let flowControls: ReturnType<typeof useSvelteFlow> | null = null;

  const isEmpty = $derived(!parseFailed && nodes.length === 0);

  // Handlers the read-only cards get. `resizable: false` is what hides the
  // resize frame; the absent onLabelChange/onSelect are what keep the cards
  // inert everywhere else.
  const nodeHandlers = {
    resizable: false,
    onAction: handleAction,
    onToggleCollapse: toggleCollapse,
  };

  $effect(() => {
    loadContent(content);
  });

  function loadContent(json: string) {
    try {
      rootDoc = applyLayout(parseDiagram(json));
      parseFailed = false;
    } catch {
      rootDoc = { nodes: [], edges: [] };
      parseFailed = true;
    }
    expandedNodeIds = new Set();
    drillPath = [];
    showView(rootDoc);
  }

  function showView(doc: DiagramDoc) {
    viewDoc = doc;
    nodes = toFlowNodes(doc.nodes, expandedNodeIds, nodeHandlers);
    edges = toFlowEdges(doc.edges, {});
    if (marks && drillPath.length === 0) {
      nodes = nodes.map((node) => ({ ...node, class: [node.class, markClass(node.id)].filter(Boolean).join(" ") }));
      edges = edges.map((edge) => ({ ...edge, class: [edge.class, markClass(edge.id)].filter(Boolean).join(" ") }));
    }
    // The canvas keeps the previous view's viewport until told otherwise, so a
    // swapped view has to re-fit or it opens scrolled off its own graph.
    requestAnimationFrame(() =>
      flowControls?.fitView({ padding: 0.2, duration: 200 }),
    );
  }

  function handleAction(nodeId: string, action: DiagramAction) {
    switch (action.do) {
      case "expand": {
        const node = nodes.find((n) => n.id === nodeId);
        if (!node) return;
        // Mutate the one card rather than rebuilding the graph: expansion is a
        // per-node display state and nothing else in the view depends on it.
        const expanded = !expandedNodeIds.has(nodeId);
        if (expanded) expandedNodeIds.add(nodeId);
        else expandedNodeIds.delete(nodeId);
        nodes = nodes.map((n) =>
          n.id === nodeId ? { ...n, data: { ...n.data, expanded } } : n,
        );
        break;
      }
      case "drilldown": {
        drillInto(nodeId);
        break;
      }
      case "openUrl": {
        if (isSafeUrl(action.url)) void localApi.openExternal(action.url);
        break;
      }
      // `focus` and `details` belong to the editor's inspector, which a reading
      // canvas has no room for. Opening the diagram is the way to those.
      default:
        break;
    }
  }

  // One level only, matching the shell: a node's detail sub-diagram is a view,
  // not a tree to wander.
  function drillInto(nodeId: string) {
    if (drillPath.length > 0) return;
    const node = rootDoc.nodes.find((n) => n.id === nodeId);
    const detail = node?.detail;
    if (!node || !detail?.nodes.length) return;
    node.detail = applyLayout(detail);
    expandedNodeIds = new Set();
    drillPath = [{ id: node.id, label: node.label }];
    showView(node.detail);
  }

  // Only depth 0 is reachable while the trail is one level deep, which is the
  // depth the shell allows too.
  function drillTo(depth: number) {
    if (depth >= drillPath.length) return;
    expandedNodeIds = new Set();
    drillPath = [];
    showView(rootDoc);
  }

  function toggleCollapse(nodeId: string) {
    const node = viewDoc.nodes.find((n) => n.id === nodeId);
    if (!node?.group) return;
    node.collapsed = node.collapsed ? undefined : true;
    // Collapsing hides descendants and shrinks the box — both are computed by
    // the node builder, so the view is rebuilt rather than patched.
    nodes = toFlowNodes(viewDoc.nodes, expandedNodeIds, nodeHandlers);
  }
</script>

<div class="diagram-shell diagram-preview">
  <div class="diagram-shell__board diagram-preview__board">
    {#if parseFailed}
      <div class="diagram-preview__notice">This diagram could not be read.</div>
    {:else if isEmpty}
      <div class="diagram-preview__notice">Empty diagram</div>
    {:else}
      <!-- The wheel drives the canvas while the pointer is over it, exactly as
           it does in the full editor — the document does not scroll underneath.
           Touch is the exception: one finger still scrolls the page, or a
           reader on a phone could never swipe past an embedded diagram. -->
      <SvelteFlow
        bind:nodes
        bind:edges
        {nodeTypes}
        {edgeTypes}
        colorMode={theme.isDark ? "dark" : "light"}
        zIndexMode="auto"
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={runtime.isTouchDevice ? [1, 2] : true}
        deleteKey={null}
        onlyRenderVisibleElements={!renderAllElements && nodes.length + edges.length > 150}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <DiagramCanvasBackground />

        <!-- The editor's bar minus everything that edits: the same cluster, in
             the corner a reading surface can spare. -->
        <Panel position="bottom-right">
          <div class="canvas-toolbar" role="toolbar" aria-label="Diagram controls">
            <CanvasZoomControls
              onFlowReady={(flow) => {
                flowControls = flow;
                onFlowReady?.(flow);
              }}
            />
          </div>
        </Panel>

        {#if drillPath.length > 0}
          <Panel position="top-left">
            <DiagramDrillCrumbs
              rootLabel={title}
              path={drillPath}
              onNavigate={drillTo}
            />
          </Panel>
        {/if}
      </SvelteFlow>
    {/if}
  </div>
</div>

<style>
  /* The shell's own rules give the board its frame; the preview only decides how
     tall it is (its host does) and that it never grows chrome of its own. */
  .diagram-preview {
    height: 100%;
    min-height: 0;
  }

  .diagram-preview__board {
    border: none;
    border-radius: 0;
  }

  /* History marks: an outline in the change's colour, never a fill, so the
     card stays readable in both themes. */
  .diagram-preview :global(.svelte-flow__node.diagram-mark) {
    border-radius: 0.75rem;
    outline: 0.125rem solid var(--diagram-mark-color);
    outline-offset: 0.25rem;
  }
  .diagram-preview :global(.svelte-flow__edge.diagram-mark path) {
    stroke: var(--diagram-mark-color) !important;
  }
  .diagram-preview :global(.diagram-mark--added) {
    --diagram-mark-color: var(--solus-diff-added-text);
  }
  .diagram-preview :global(.diagram-mark--removed) {
    --diagram-mark-color: var(--solus-diff-removed-text);
  }
  .diagram-preview :global(.diagram-mark--changed) {
    --diagram-mark-color: var(--solus-accent);
  }

  .diagram-preview__notice {
    display: grid;
    place-items: center;
    height: 100%;
    font-size: var(--text-xs);
    color: var(--solus-text-tertiary);
  }

</style>
