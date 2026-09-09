<script lang="ts">
  import { getSmoothStepPath, getStraightPath, Position } from "@xyflow/system";
  import {
    BaseEdge,
    EdgeLabel,
    EdgeReconnectAnchor,
    useStore,
  } from "@xyflow/svelte";
  import type { Edge, EdgeProps } from "@xyflow/svelte";
  import { z } from "zod";
  import type { DiagramEdge as DiagramEdgeContract } from "@solus/contracts/diagram-types";
  import {
    facingAnchor,
    type AnchorSide,
  } from "@solus/contracts/diagram-edge-anchor";
  import { canvasRoutes } from "../lib/edge-routing.svelte";
  import { onDestroy } from "svelte";
  import { EditableLabel } from "../editable-label.svelte";

  type DiagramFlowEdgeData = Pick<
    DiagramEdgeContract,
    "bendOffset" | "bendAxis" | "cardinality" | "color" | "route" | "labelOffset" | "width" | "kind"
  > & {
    floatingSource?: boolean;
    floatingTarget?: boolean;
    onLabelChange?: (id: string, label: string) => void;
    onContextMenu?: (
      id: string,
      kind: "edge",
      clientX: number,
      clientY: number,
    ) => void;
    onLabelOffsetChange?: (id: string, offset: { x: number; y: number }) => void;
    onLabelOffsetCommit?: () => void;
    onBendOffsetChange?: (id: string, offset: number, axis?: 'x' | 'y') => void;
    onBendOffsetCommit?: (id: string) => void;
  };

  type DiagramFlowEdge = Edge<DiagramFlowEdgeData>;

  let {
    id,
    source,
    target,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    label,
    labelStyle,
    markerStart,
    markerEnd,
    style,
    interactionWidth,
    selected,
    data,
  }: EdgeProps<DiagramFlowEdge> = $props();

  const store = useStore();
  const routes = canvasRoutes(store);
  const drawing = $derived(routes.drawings.get(id));

  // Max |bendOffset| (canvas px) a dragged middle segment can travel from centre.
  const BEND_OFFSET_LIMIT = 4000;
  // Hit-area (px) of each reconnect grab dot.
  const RECONNECT_HANDLE_SIZE = 34;
  // Lift (px) applied to a selected edge's label so it clears the reconnect dots.


  // Live geometry of both endpoints. Used to "float" an endpoint that has no
  // explicit handle to the side facing the other node — otherwise xyflow anchors
  // it to the first-declared (Left) handle, pointing the arrow backwards.
  // Looked up reactively by the CURRENT source/target ids — useInternalNode
  // captures the id at mount, so a reversed/rewired edge would keep floating
  // to its old endpoints. Reading store.nodes retriggers on measure/drag.
  const sourceNode = $derived.by(() => {
    void store.nodes;
    return store.nodeLookup.get(source);
  });
  const targetNode = $derived.by(() => {
    void store.nodes;
    return store.nodeLookup.get(target);
  });

  const SIDE_TO_POSITION = {
    left: Position.Left,
    right: Position.Right,
    top: Position.Top,
    bottom: Position.Bottom,
  } satisfies Record<AnchorSide, Position>;

  function rectOf(n: typeof sourceNode) {
    if (!n?.measured?.width || !n.measured.height) return null;
    const { x, y } = n.internals.positionAbsolute;
    return { x, y, width: n.measured.width, height: n.measured.height };
  }

  // Resolve the effective endpoints: each floating end snaps to the facing side
  // of its node; non-floating ends keep xyflow's handle-derived coordinates.
  const ends = $derived.by(() => {
    const s = rectOf(sourceNode);
    const t = rectOf(targetNode);
    let sx = sourceX,
      sy = sourceY,
      sPos = sourcePosition;
    let tx = targetX,
      ty = targetY,
      tPos = targetPosition;
    if (s && t) {
      if (data?.floatingSource) {
        const a = facingAnchor(s, t);
        sx = a.x;
        sy = a.y;
        sPos = SIDE_TO_POSITION[a.side];
      }
      if (data?.floatingTarget) {
        const a = facingAnchor(t, s);
        tx = a.x;
        ty = a.y;
        tPos = SIDE_TO_POSITION[a.side];
      }
    }
    if (drawing) {
      const first = drawing.points[0], last = drawing.points.at(-1)!;
      return { sx: first.x, sy: first.y, sPos: SIDE_TO_POSITION[drawing.sourceSide], tx: last.x, ty: last.y, tPos: SIDE_TO_POSITION[drawing.targetSide] };
    }
    return { sx, sy, sPos, tx, ty, tPos };
  });

  // The middle segment of a smooth-step edge runs perpendicular to the endpoints'
  // facing: horizontal-facing ends (Left/Right) produce a VERTICAL mid-segment the
  // user slides left/right; vertical-facing ends produce a HORIZONTAL one slid
  // up/down. `bendOffset` is the signed displacement (canvas px) of that segment
  // from its centered default — fed straight to getSmoothStepPath's centerX/centerY
  // so dragging the segment tracks the cursor 1:1 (the old `offset` param only
  // changed the corner inset, which is why moving the bend felt indirect).
  const horizontal = $derived(
    ends.sPos === Position.Left || ends.sPos === Position.Right,
  );
  const midX = $derived((ends.sx + ends.tx) / 2);
  const midY = $derived((ends.sy + ends.ty) / 2);
  const bend = $derived(data?.bendOffset ?? 0);
  const centerX = $derived(horizontal ? midX + bend : midX);
  const centerY = $derived(horizontal ? midY : midY + bend);
  const bendGuide: { start: { x: number; y: number }; end: { x: number; y: number }; axis: 'x' | 'y'; offset: number } = $derived(drawing?.bend ?? {
    start: { x: horizontal ? centerX : ends.sx, y: horizontal ? ends.sy : centerY },
    end: { x: horizontal ? centerX : ends.tx, y: horizontal ? ends.ty : centerY },
    axis: horizontal ? 'x' : 'y', offset: bend,
  });
  const gripX = $derived((bendGuide.start.x + bendGuide.end.x) / 2);
  const gripY = $derived((bendGuide.start.y + bendGuide.end.y) / 2);

  // Routing style: 'straight' draws a direct line; 'step' is a sharp-cornered
  // orthogonal path; 'smooth' (the default) keeps the rounded step corners. The
  // draggable bend only applies to the two stepped variants.
  const route = $derived(data?.route ?? "smooth");

  let [path, labelX, labelY] = $derived.by(() => {
    if (drawing) return [drawing.path, drawing.label.x, drawing.label.y] as const;
    if (route === "straight") {
      return getStraightPath({
        sourceX: ends.sx,
        sourceY: ends.sy,
        targetX: ends.tx,
        targetY: ends.ty,
      });
    }
    return getSmoothStepPath({
      sourceX: ends.sx,
      sourceY: ends.sy,
      targetX: ends.tx,
      targetY: ends.ty,
      sourcePosition: ends.sPos,
      targetPosition: ends.tPos,
      centerX,
      centerY,
      borderRadius: route === "step" ? 0 : undefined,
    });
  });

  // Crow's-foot cardinality markers. Cardinality is source→target ordered ('1-n',
  // 'n-1', etc.). We split into per-end symbols and compute a rotation angle so a
  // canonical glyph (drawn pointing right from origin) is rotated to face along the
  // edge at each endpoint. Both source and target use the same Position→angle map
  // because the canonical +x axis is "along the edge, away from the node" at each end.
  const cardinality = $derived(data?.cardinality)
  const sourceEnd = $derived(cardinality ? cardinality[0] : null)  // '1' or 'n'
  const targetEnd = $derived(cardinality ? cardinality[2] : null)  // '1' or 'n'
  const markerColor = $derived(
    data?.color ?? (selected ? 'var(--solus-accent)' : 'var(--diagram-edge-arrow)')
  )

  function positionAngle(pos: Position): number {
    if (pos === Position.Bottom) return 90
    if (pos === Position.Left) return 180
    if (pos === Position.Top) return 270
    return 0  // Right
  }

  const sourceAngle = $derived(positionAngle(ends.sPos))
  const targetAngle = $derived(positionAngle(ends.tPos))

  // Edges allow an empty label (clears it), unlike nodes.
  const editor = new EditableLabel({
    getLabel: () => z.string().catch("").parse(label),
    onCommit: (v) => data?.onLabelChange?.(id, v),
    allowEmpty: true,
  });

  // Manual double-click detection. We can't rely on the native `dblclick`
  // event here: the first click selects the edge, which re-renders the edge <g>
  // and breaks the browser's dblclick pairing — so dblclick never fires. The
  // individual `click` events still fire reliably (that's why selection works),
  // so we pair them ourselves in component state, which survives the re-render.
  // We listen on the whole edge group so an empty (label-less) edge can still be
  // double-clicked to add a label, without rendering a placeholder box.
  const DOUBLE_CLICK_MS = 400;
  let lastClickAt = 0;

  function handleEdgeClick(e: MouseEvent) {
    // Read-only canvases pass no commit handler; there is nothing to open.
    if (!data?.onLabelChange) return;
    const now = Date.now();
    if (now - lastClickAt < DOUBLE_CLICK_MS) {
      lastClickAt = 0;
      editor.start(e);
    } else {
      lastClickAt = now;
    }
  }

  function handleContextMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    data?.onContextMenu?.(id, "edge", e.clientX, e.clientY);
  }

  let stopBendDrag: (() => void) | undefined;
  onDestroy(() => stopBendDrag?.());
  function handleBendPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const axis = bendGuide.axis;
    const isHorizontal = axis === 'x';
    const startClient = isHorizontal ? e.clientX : e.clientY;
    const startOffset = bendGuide.offset;

    function onMove(moveEvent: PointerEvent) {
      const zoom = store.viewport.zoom || 1;
      // Screen delta → canvas delta. The segment moves with the cursor 1:1:
      // rightward drag slides a vertical segment right, downward drag slides a
      // horizontal segment down (no axis-flipping sign to second-guess).
      const delta =
        (isHorizontal ? moveEvent.clientX : moveEvent.clientY) - startClient;
      const next = Math.max(
        -BEND_OFFSET_LIMIT,
        Math.min(BEND_OFFSET_LIMIT, Math.round(startOffset + delta / zoom)),
      );
      data?.onBendOffsetChange?.(id, next, axis);
    }

    function onUp() {
      stopBendDrag?.();
      // Record the complete drag as one undo step.
      data?.onBendOffsetCommit?.(id);
    }
    stopBendDrag = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      stopBendDrag = undefined;
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    window.addEventListener("pointercancel", onUp, { once: true });
  }
  function measureLabel(element: HTMLElement) {
    const observer = new ResizeObserver(() => {
      const size = { width: element.offsetWidth, height: element.offsetHeight };
      const previous = routes.labelSizes.get(id);
      if (size.width && size.height && (previous?.width !== size.width || previous?.height !== size.height)) routes.labelSizes.set(id, size);
    });
    observer.observe(element);
    return { destroy() { observer.disconnect(); routes.labelSizes.delete(id); } };
  }
  let labelDragged = false;
  let stopLabelDrag: (() => void) | undefined;
  onDestroy(() => stopLabelDrag?.());
  function startLabelDrag(event: PointerEvent) {
    if (!data?.onLabelOffsetChange || event.button !== 0 || !drawing) return;
    const start = { x: event.clientX, y: event.clientY };
    const initial = { x: drawing.label.x - drawing.anchor.x, y: drawing.label.y - drawing.anchor.y };
    labelDragged = false;
    const move = (e: PointerEvent) => {
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!labelDragged && Math.hypot(dx, dy) < 4) return;
      labelDragged = true;
      const zoom = store.viewport.zoom || 1;
      data?.onLabelOffsetChange?.(id, { x: Math.max(-4000, Math.min(4000, initial.x + dx / zoom)), y: Math.max(-4000, Math.min(4000, initial.y + dy / zoom)) });
    };
    const finish = () => { stopLabelDrag?.(); if (labelDragged) data?.onLabelOffsetCommit?.(); };
    stopLabelDrag = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish); stopLabelDrag = undefined; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish, { once: true });
    window.addEventListener('pointercancel', finish, { once: true });
  }
  function moveLabelByKey(e: KeyboardEvent) {
    const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!delta || !drawing || !data?.onLabelOffsetChange) return;
    e.preventDefault(); e.stopPropagation();
    const step = e.shiftKey ? 1 : 10;
    data.onLabelOffsetChange(id, { x: Math.max(-4000, Math.min(4000, drawing.label.x - drawing.anchor.x + delta[0] * step)), y: Math.max(-4000, Math.min(4000, drawing.label.y - drawing.anchor.y + delta[1] * step)) });
    data.onLabelOffsetCommit?.();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<g style:--edge-ink={data?.color ?? "var(--diagram-edge-stroke)"} style:--edge-marker-ink={data?.color ?? "var(--diagram-edge-arrow)"} style:--edge-weight={data?.width ?? (data?.kind === "data" ? 1.75 : 1.3)} oncontextmenu={handleContextMenu} onclick={handleEdgeClick}>
  <BaseEdge
    {path}
    {labelX}
    {labelY}
    {markerStart}
    {markerEnd}
    {interactionWidth}
    {style}
  />

  <!-- Crow's-foot cardinality markers. The canonical glyph is drawn along +x
       (away from the node, into the edge); rotate() aligns it to the actual edge
       direction at each endpoint. A "one" end is a single perpendicular bar; a
       "many" end is a crow's foot whose three prongs spread at the entity
       boundary (ERD convention) and converge toward the edge. -->
  {#if sourceEnd}
    <g class="diagram-cardinality" transform="translate({ends.sx},{ends.sy}) rotate({sourceAngle})">
      {#if sourceEnd === 'n'}
        {@render crowFoot()}
      {:else}
        {@render oneBar()}
      {/if}
    </g>
  {/if}
  {#if targetEnd}
    <g class="diagram-cardinality" transform="translate({ends.tx},{ends.ty}) rotate({targetAngle})">
      {#if targetEnd === 'n'}
        {@render crowFoot()}
      {:else}
        {@render oneBar()}
      {/if}
    </g>
  {/if}

  <!-- Draggable endpoint anchors enable rewiring the edge to a different
       node/handle (incl. moving it to a different side of the same node); the
       store applies the rewire and fires onreconnect. Only shown while the edge
       is selected — a click reveals the grab dots, and the always-on 25px
       hotspots would otherwise sit on top of the node handles and block drawing
       fresh edges from those sides. The dot auto-hides mid-drag (anchor only
       renders children when not reconnecting). -->
  {#if selected && data?.onLabelChange}
    <EdgeReconnectAnchor
      type="source"
      position={{ x: ends.sx, y: ends.sy }}
      class="edge-reconnect-anchor"
      size={RECONNECT_HANDLE_SIZE}
      dragThreshold={0}
    >
      <span class="edge-reconnect-dot"></span>
    </EdgeReconnectAnchor>
    <EdgeReconnectAnchor
      type="target"
      position={{ x: ends.tx, y: ends.ty }}
      class="edge-reconnect-anchor"
      size={RECONNECT_HANDLE_SIZE}
      dragThreshold={0}
    >
      <span class="edge-reconnect-dot"></span>
    </EdgeReconnectAnchor>
    <!-- Grab strip lying directly on the movable middle segment, spanning its
         full length so the user can grab the "part that goes up and down"
         anywhere along it (not just a midpoint dot). A fat transparent line
         catches the pointer; a thin accent line shows where it lives. A straight
         edge has no stepped middle segment, so the bend grab is hidden there. -->
    {#if route !== "straight"}
    <line
      data-diagram-editor-only class="edge-bend-hit nodrag nopan"
      x1={bendGuide.start.x}
      y1={bendGuide.start.y}
      x2={bendGuide.end.x}
      y2={bendGuide.end.y}
      style:cursor={bendGuide.axis === 'x' ? "ew-resize" : "ns-resize"}
      onpointerdown={handleBendPointerDown}
      onclick={(e) => e.stopPropagation()}
    />
    <line
      data-diagram-editor-only class="edge-bend-guide-bg"
      x1={gripX - (bendGuide.axis === 'y' ? 8 : 0)}
      y1={gripY - (bendGuide.axis === 'x' ? 8 : 0)}
      x2={gripX + (bendGuide.axis === 'y' ? 8 : 0)}
      y2={gripY + (bendGuide.axis === 'x' ? 8 : 0)}
    />
    <line
      data-diagram-editor-only class="edge-bend-guide"
      x1={gripX - (bendGuide.axis === 'y' ? 8 : 0)}
      y1={gripY - (bendGuide.axis === 'x' ? 8 : 0)}
      x2={gripX + (bendGuide.axis === 'y' ? 8 : 0)}
      y2={gripY + (bendGuide.axis === 'x' ? 8 : 0)}
    />
    {/if}
  {/if}

  {#if label && drawing && Math.hypot(drawing.label.x - drawing.anchor.x, drawing.label.y - drawing.anchor.y) > 24}
    <line x1={drawing.anchor.x} y1={drawing.anchor.y} x2={drawing.label.x} y2={drawing.label.y}
      stroke="var(--diagram-edge-stroke)" stroke-width="1" stroke-dasharray="2 3" pointer-events="none" />
  {/if}

  <!-- Only render a label chip when there's text to show (or while editing).
       An empty edge stays a plain line — double-click it to add a label. -->
  {#if editor.editing}
    <EdgeLabel x={labelX} y={labelY}>
      <input
        bind:this={editor.inputEl}
        bind:value={editor.value}
        class="edge-label-input"
        onblur={editor.commit}
        onkeydown={editor.onInputKeydown}
        onclick={(e) => e.stopPropagation()}
      />
    </EdgeLabel>
  {:else if label && data?.onLabelChange}
    <EdgeLabel x={labelX} y={labelY} selectEdgeOnClick>
      <button
        type="button"
        class="edge-label-display nodrag nopan"
        class:edge-label-display--selected={selected}
        aria-label="Edit edge label"
        use:measureLabel
        onpointerdown={startLabelDrag}
        onclick={(e) => { if (labelDragged) { e.stopPropagation(); labelDragged = false; return; } editor.start(e); }}
        onkeydown={moveLabelByKey}
        title="Drag to move label. Arrow keys move it; Enter edits it."
        >{label}</button
      >
    </EdgeLabel>
  {:else if label}
    <!-- Read-only: the same chip, minus the edit affordance. -->
    <EdgeLabel x={labelX} y={labelY}>
      <span use:measureLabel class="edge-label-display edge-label-display--static">{label}</span>
    </EdgeLabel>
  {/if}
</g>

<!-- Cardinality endpoint glyphs, drawn in canonical orientation (origin at the
     node boundary, +x pointing away into the edge). Prongs of the crow's foot
     spread at the node (x≈2) and converge into the edge (x≈14). -->
{#snippet crowFoot()}
  <line x1="14" y1="0" x2="2" y2="-6" stroke={markerColor} stroke-width="1.5" stroke-linecap="round" fill="none" />
  <line x1="14" y1="0" x2="2" y2="0"  stroke={markerColor} stroke-width="1.5" stroke-linecap="round" fill="none" />
  <line x1="14" y1="0" x2="2" y2="6"  stroke={markerColor} stroke-width="1.5" stroke-linecap="round" fill="none" />
{/snippet}

{#snippet oneBar()}
  <line x1="10" y1="-6" x2="10" y2="6" stroke={markerColor} stroke-width="1.5" stroke-linecap="round" fill="none" />
{/snippet}

<style>
  /* Edge labels stay unboxed so they remain part of the connector rather than
     reading as separate canvas cards. */
  .edge-label-display {
    padding: 0.0625rem 0.3125rem;
    border-radius: 0.3125rem;
    font-size: 12px;
    font-weight: 500;
    color: var(--diagram-edge-label);
    background: var(--solus-container-bg);
    border: none;
    box-shadow: none;
    cursor: text;
    max-width: 240px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 18px;
    touch-action: none;
    transition: color var(--duration-base) var(--ease-premium);
  }

  /* Fat transparent hit line along the whole movable segment — a wide, forgiving
     grab target so the segment is easy to catch anywhere along its length. */
  .edge-bend-hit {
    stroke: transparent;
    stroke-width: 18;
    stroke-linecap: round;
    fill: none;
    pointer-events: stroke;
    touch-action: none;
  }

  /* A compact selected-state grip marks the movable middle segment without
     repainting its full length in accent. The larger invisible hit line above
     remains forgiving anywhere along the segment. */
  .edge-bend-guide-bg,
  .edge-bend-guide {
    stroke-linecap: round;
    fill: none;
    pointer-events: none;
  }

  .edge-bend-guide-bg {
    stroke: var(--solus-container-bg);
    stroke-width: 7;
  }

  .edge-bend-guide {
    stroke: var(--solus-accent);
    stroke-width: 3;
    transition:
      stroke-width var(--duration-quick) var(--ease-premium),
      opacity var(--duration-quick) var(--ease-premium);
  }

  .edge-bend-hit:hover ~ .edge-bend-guide {
    stroke-width: 4;
  }

  .edge-label-display:not(.edge-label-display--static):hover {
    color: var(--solus-text-secondary);
  }

  /* Nothing to click on a reading canvas, so the chip doesn't offer a caret. */
  .edge-label-display--static {
    cursor: default;
  }

  .edge-label-display--selected {
    color: var(--solus-accent);
  }

  /* Reconnect grab points. The anchor wrapper is portaled into xyflow's
     edge-label layer, so it carries no Svelte scope hash — style it globally and
     centre the dot inside its 25px hotspot. */
  /* !important: xyflow stamps the edge's own z-index (1) inline on the
     wrapper, which would leave the anchor UNDER the node wrappers (z 2) — a
     grab on an endpoint would then hit the node's stacked connection handle
     and draw a brand-new edge instead of moving this one. */
  :global(.edge-reconnect-anchor) {
    display: grid;
    place-items: center;
    cursor: grab;
    z-index: 40 !important;
  }
  :global(.edge-reconnect-anchor:active) {
    cursor: grabbing;
  }

  /* The visible dot mirrors the node connection handles (accent fill, ring) so
     it reads as the same "grab to wire" affordance. */
  .edge-reconnect-dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: var(--solus-accent);
    border: 0.09375rem solid var(--solus-container-bg);
    box-shadow: none;
    transition: box-shadow var(--duration-quick) var(--ease-premium);
    pointer-events: none;
  }

  :global(.edge-reconnect-anchor:hover) .edge-reconnect-dot {
    box-shadow:
      0 0 0 0.1875rem var(--solus-accent-soft),
      0 0.0625rem 0.125rem rgba(0, 0, 0, 0.18);
  }

  .edge-label-input {
    min-width: 4rem;
    max-width: 10rem;
    padding: 0.125rem 0.375rem;
    border: 0.0625rem solid var(--solus-accent-border);
    border-radius: 0.25rem;
    background: var(--solus-container-bg);
    color: var(--solus-text-primary);
    font-size: 12px;
    font-weight: 500;
    outline: none;
    box-shadow: 0 0 0 0.125rem var(--solus-accent-soft);
  }
</style>
