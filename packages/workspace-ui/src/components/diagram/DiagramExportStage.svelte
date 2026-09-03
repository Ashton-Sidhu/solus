<script lang="ts">
  // An off-screen reading canvas that exists only to be photographed. A
  // publish that embeds a diagram needs the real graph — the same node, group
  // and edge components the editor and the embed card draw — whether or not
  // that diagram is open anywhere, so the publish mounts one of these, waits
  // for the nodes to be measured, captures the viewport, and unmounts it.
  import type { useSvelteFlow } from "@xyflow/svelte";
  import DiagramPreview from "./DiagramPreview.svelte";

  interface Props {
    content: string;
    title: string;
    /** Set the type for a page the reader cannot zoom, rather than for a canvas. */
    print?: boolean;
    /** The flow instance and the element to capture it from, once mounted. */
    onReady: (flow: ReturnType<typeof useSvelteFlow>, root: HTMLElement) => void;
  }

  let { content, title, print = false, onReady }: Props = $props();
  let root = $state<HTMLDivElement | null>(null);
</script>

<!-- Off-screen rather than hidden: `visibility: hidden` and `display: none`
     are cloned into the capture, and a zero-size box gives the canvas nothing
     to lay the graph out in. The size only frames the fit; the export reframes
     the whole graph from its bounds. -->
<div bind:this={root} class="diagram-export-stage" class:print aria-hidden="true">
  <DiagramPreview
    {content}
    {title}
    renderAllElements
    onFlowReady={(flow) => {
      if (root) onReady(flow, root);
    }}
  />
</div>

<style>
  .diagram-export-stage {
    position: fixed;
    top: 0;
    left: -20000px;
    width: 1200px;
    height: 800px;
    pointer-events: none;
  }

  /**
   * Type set for a page, not for a canvas. A reader pans and zooms the canvas,
   * so a card there can be wide and its label small; a page figure is fixed,
   * and the page bounds these drawings by width, so the label is set larger
   * against a narrower card. Measured on a 20-node architecture diagram: the
   * drawing packs 12% narrower and its titles land 21% larger on the page.
   *
   * The sizes are absolute rather than scaled by the app's font setting: a
   * published document should read the same whatever the publisher's display
   * is set to. Custom properties inherit, so setting them here is enough —
   * the node reads `--diagram-node-scale` and derives its type from the two
   * tokens below.
   */
  .print {
    --diagram-node-scale: 0.8;
    --text-caption: 20px;
    --text-footnote: 15px;
  }
</style>
