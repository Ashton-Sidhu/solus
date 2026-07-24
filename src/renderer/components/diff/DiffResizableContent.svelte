<script lang="ts">
  import type { Snippet } from "svelte";
  import { runtime } from "../../contexts";
  import {
    paneBoundsPercent,
    percentToPixels,
    pixelsToPercent,
  } from "../../lib/resizablePane";
  import * as Resizable from "../ui/resizable";
  import DiffFileTreeColumn from "./DiffFileTreeColumn.svelte";

  interface Props {
    panelWidth: number;
    treeCollapsed: boolean;
    mountFileTree: (node: HTMLDivElement) => { destroy: () => void };
    onToggleTree: () => void;
    children: Snippet;
  }

  let {
    panelWidth,
    treeCollapsed,
    mountFileTree,
    onToggleTree,
    children,
  }: Props = $props();

  const TREE_MIN_WIDTH = 192;
  const DIFF_CONTENT_MIN_WIDTH = 360;
  const TREE_WIDTH_KEY = "solus-diff-tree-width";
  let treeWidth = $state(Number(localStorage.getItem(TREE_WIDTH_KEY)) || 272);
  let isTreeResizing = $state(false);

  const treeMaxWidth = $derived(
    panelWidth > 0
      ? Math.max(
          TREE_MIN_WIDTH,
          Math.min(
            Math.floor(panelWidth * 0.4),
            panelWidth - DIFF_CONTENT_MIN_WIDTH,
          ),
        )
      : 360,
  );
  const treeBounds = $derived(
    paneBoundsPercent(panelWidth, TREE_MIN_WIDTH, treeMaxWidth),
  );
  const treeDefaultSize = $derived(
    panelWidth > 0 ? pixelsToPercent(treeWidth, panelWidth) : 30,
  );

  function clampTreeWidth(width: number) {
    return Math.min(treeMaxWidth, Math.max(TREE_MIN_WIDTH, width));
  }

  function persistTreeWidth() {
    localStorage.setItem(TREE_WIDTH_KEY, String(treeWidth));
  }

  function handleTreeLayout(layout: number[]) {
    if (layout.length !== 2 || panelWidth <= 0) return;
    treeWidth = clampTreeWidth(percentToPixels(layout[0], panelWidth));
    if (!isTreeResizing) persistTreeWidth();
  }

  function handleTreeDragging(dragging: boolean) {
    isTreeResizing = dragging;
    if (!dragging) persistTreeWidth();
  }
</script>

<Resizable.PaneGroup
  direction="horizontal"
  keyboardResizeBy={2}
  class="flex-1 min-h-0 min-w-0"
  onLayoutChange={handleTreeLayout}
>
  {#if !treeCollapsed && !runtime.isMobileViewport}
    <Resizable.Pane
      order={1}
      defaultSize={treeDefaultSize}
      minSize={treeBounds.min}
      maxSize={treeBounds.max}
    >
      <DiffFileTreeColumn {mountFileTree} onToggleTree={onToggleTree} />
    </Resizable.Pane>
    <Resizable.Handle
      aria-label="Resize file tree"
      onDraggingChange={handleTreeDragging}
    />
  {/if}
  <Resizable.Pane order={2} minSize={treeCollapsed ? 100 : 0}>
    {@render children()}
  </Resizable.Pane>
</Resizable.PaneGroup>
