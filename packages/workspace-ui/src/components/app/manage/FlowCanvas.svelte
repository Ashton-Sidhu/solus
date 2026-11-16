<script lang="ts">
  import { Background, BackgroundVariant, Panel, SvelteFlow, type Edge, type Node, type NodeTypes } from "@xyflow/svelte";
  import "@xyflow/svelte/dist/style.css";
  import { runtime } from "../../../contexts";
  import FlowZoomControl from "./FlowZoomControl.svelte";
  import { canvasTakesTouch } from "./lib/flow";

  /**
   * The one card of a Manage section that holds a node diagram: the run graph
   * of Workflows and the flow of Signals (docs/plans/apps.md §9.2). A
   * read-only Svelte Flow canvas on a dot grid: the nodes do not move or
   * connect, and the controls inside them are the only things to press. It
   * fits its nodes when it mounts, and again when `fitKey` changes. The
   * page scrolls past it; a drag pans and the zoom control zooms. On a touch
   * device one finger scrolls the page and two fingers pan and pinch. Svelte
   * Flow's own colours are set to the Solus tokens, so light and dark work.
   */
  interface Props {
    nodes: Node[];
    edges: Edge[];
    nodeTypes: NodeTypes;
    /** What the canvas shows, read aloud. */
    label: string;
    /** A new value fits the view to the nodes again: another run, another signal, another layout. */
    fitKey: string;
    /** The height of the card, which Svelte Flow needs. */
    class: string;
    testId: string;
  }
  let { nodes: givenNodes, edges, nodeTypes, label, fitKey, class: className, testId }: Props = $props();

  // Svelte Flow writes the measured size of each node back to its nodes.
  let nodes = $derived(givenNodes);

  const MIN_ZOOM = 0.4;
  const MAX_ZOOM = 1.5;
  // The user decided to hide the Svelte Flow attribution badge.
  const PRO_OPTIONS = { hideAttribution: true };

  /** A one-finger touch never reaches Svelte Flow on a touch device, so the browser scrolls the page with it. */
  function holdTouch(event: TouchEvent) {
    if (!canvasTakesTouch(event.touches.length, runtime.isTouchDevice)) event.stopPropagation();
  }
</script>

<div
  class="relative min-w-0 overflow-hidden rounded-2xl border border-(--hairline-strong) bg-background shadow-[0_1px_2px_rgb(0_0_0/0.03),0_6px_20px_rgb(0_0_0/0.04)] [--xy-background-color:transparent] [--xy-background-pattern-color:var(--hairline-strongest)] [--xy-edge-stroke-width:1.5] [--xy-edge-stroke:color-mix(in_oklch,var(--foreground)_22%,transparent)] [--xy-handle-background-color:transparent] [--xy-handle-border-color:transparent] dark:bg-card dark:shadow-none pointer-coarse:[&_.svelte-flow\_\_pane]:[touch-action:pan-x_pan-y]! {className}"
  role="group"
  aria-label={label}
  data-testid={testId}
  ontouchstartcapture={holdTouch}
>
  {#key fitKey}
    <SvelteFlow
      bind:nodes={() => nodes, (next) => (nodes = next)}
      {edges}
      {nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
      minZoom={MIN_ZOOM}
      maxZoom={MAX_ZOOM}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      nodesFocusable={false}
      edgesFocusable={false}
      disableKeyboardA11y
      deleteKey={null}
      selectionKey={null}
      multiSelectionKey={null}
      zoomOnScroll={false}
      zoomOnDoubleClick={false}
      preventScrolling={false}
      proOptions={PRO_OPTIONS}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1.5} />
      <Panel position="bottom-right">
        <FlowZoomControl minZoom={MIN_ZOOM} maxZoom={MAX_ZOOM} />
      </Panel>
    </SvelteFlow>
  {/key}
</div>
