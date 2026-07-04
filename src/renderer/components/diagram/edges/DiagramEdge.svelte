<script lang="ts">
  import { getSmoothStepPath, getStraightPath, Position } from "@xyflow/system";
  import {
    BaseEdge,
    EdgeLabel,
    EdgeReconnectAnchor,
    useStore,
  } from "@xyflow/svelte";
  import type { EdgeProps } from "@xyflow/svelte";
  import {
    facingAnchor,
    type AnchorSide,
  } from "../../../../shared/diagram-edge-anchor";
  import { EditableLabel } from "../editable-label.svelte";

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
  }: EdgeProps = $props();

  const store = useStore();

  // Max |bendOffset| (canvas px) a dragged middle segment can travel from centre.
  const BEND_OFFSET_LIMIT = 4000;
  // Hit-area (px) of each reconnect grab dot.
  const RECONNECT_HANDLE_SIZE = 34;
  // Lift (px) applied to a selected edge's label so it clears the reconnect dots.
  const SELECTED_LABEL_OFFSET = 22;

  // Live geometry of both endpoints. Used to "float" an endpoint that has no
  // explicit handle to the side facing the other node — otherwise xyflow anchors
  // it to the first-declared (Left) handle, pointing the arrow backwards.
  // Looked up reactively by the CURRENT source/target ids — useInternalNode
  // captures the id at mount, so a reversed/rewired edge would keep floating
  // to its old endpoints. Reading store.nodes retriggers on measure/drag.
  const sourceNode = $derived.by(() => {
    store.nodes;
    return store.nodeLookup.get(source);
  });
  const targetNode = $derived.by(() => {
    store.nodes;
    return store.nodeLookup.get(target);
  });

  const SIDE_TO_POSITION: Record<AnchorSide, Position> = {
    left: Position.Left,
    right: Position.Right,
    top: Position.Top,
    bottom: Position.Bottom,
  };

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
  const bend = $derived((data?.bendOffset as number | undefined) ?? 0);
  const centerX = $derived(horizontal ? midX + bend : midX);
  const centerY = $derived(horizontal ? midY : midY + bend);

  // Routing style: 'straight' draws a direct line; 'step' is a sharp-cornered
  // orthogonal path; 'smooth' (the default) keeps the rounded step corners. The
  // draggable bend only applies to the two stepped variants.
  const shape = $derived((data?.shape as "smooth" | "step" | "straight" | undefined) ?? "smooth");

  let [path, labelX, labelY] = $derived.by(() => {
    if (shape === "straight") {
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
      borderRadius: shape === "step" ? 0 : undefined,
    });
  });

  // Crow's-foot cardinality markers. Cardinality is source→target ordered ('1-n',
  // 'n-1', etc.). We split into per-end symbols and compute a rotation angle so a
  // canonical glyph (drawn pointing right from origin) is rotated to face along the
  // edge at each endpoint. Both source and target use the same Position→angle map
  // because the canonical +x axis is "along the edge, away from the node" at each end.
  const cardinality = $derived(data?.cardinality as '1-1' | '1-n' | 'n-1' | 'n-n' | undefined)
  const sourceEnd = $derived(cardinality ? cardinality[0] : null)  // '1' or 'n'
  const targetEnd = $derived(cardinality ? cardinality[2] : null)  // '1' or 'n'
  const markerColor = $derived((data?.color as string | undefined) ?? 'var(--solus-accent)')

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
    getLabel: () => (typeof label === "string" ? label : ""),
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

  function handleBendPointerDown(e: PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const isHorizontal = horizontal;
    const startClient = isHorizontal ? e.clientX : e.clientY;
    const startOffset = (data?.bendOffset as number | undefined) ?? 0;

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
      data?.onBendOffsetChange?.(id, next);
    }

    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      // The move handler updates the offset live without touching history; record
      // the single undo step and schedule the save now that the drag has settled.
      data?.onBendOffsetCommit?.(id);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    window.addEventListener("pointercancel", onUp, { once: true });
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<g oncontextmenu={handleContextMenu} onclick={handleEdgeClick}>
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
    <g transform="translate({ends.sx},{ends.sy}) rotate({sourceAngle})">
      {#if sourceEnd === 'n'}
        {@render crowFoot()}
      {:else}
        {@render oneBar()}
      {/if}
    </g>
  {/if}
  {#if targetEnd}
    <g transform="translate({ends.tx},{ends.ty}) rotate({targetAngle})">
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
  {#if selected}
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
    {#if shape !== "straight"}
    <line
      class="edge-bend-hit nodrag nopan"
      x1={horizontal ? centerX : ends.sx}
      y1={horizontal ? ends.sy : centerY}
      x2={horizontal ? centerX : ends.tx}
      y2={horizontal ? ends.ty : centerY}
      style:cursor={horizontal ? "ew-resize" : "ns-resize"}
      onpointerdown={handleBendPointerDown}
      onclick={(e) => e.stopPropagation()}
    />
    <line
      class="edge-bend-guide"
      x1={horizontal ? centerX : ends.sx}
      y1={horizontal ? ends.sy : centerY}
      x2={horizontal ? centerX : ends.tx}
      y2={horizontal ? ends.ty : centerY}
    />
    {/if}
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
  {:else if label}
    <EdgeLabel x={labelX} y={selected ? labelY - SELECTED_LABEL_OFFSET : labelY} selectEdgeOnClick>
      <button
        type="button"
        class="edge-label-display nodrag nopan"
        aria-label="Edit edge label"
        onclick={editor.start}>{label}</button
      >
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
  .edge-label-display {
    padding: 0.125rem 0.375rem;
    border-radius: 0.3125rem;
    font-size: 0.6875rem;
    font-weight: 500;
    color: var(--solus-text-secondary);
    background: var(--solus-container-bg);
    border: 0.0625rem solid var(--solus-tool-border);
    box-shadow: 0 0.0625rem 0.125rem rgba(0, 0, 0, 0.06);
    cursor: text;
    white-space: nowrap;
    transition:
      border-color var(--duration-base) var(--ease-premium),
      background var(--duration-base) var(--ease-premium);
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

  /* Thin accent guide showing the segment is grabbable; thickens on hover. */
  .edge-bend-guide {
    stroke: var(--solus-accent);
    stroke-width: 2;
    stroke-linecap: round;
    fill: none;
    opacity: 0.55;
    pointer-events: none;
    transition:
      stroke-width var(--duration-quick) var(--ease-premium),
      opacity var(--duration-quick) var(--ease-premium);
  }

  .edge-bend-hit:hover + .edge-bend-guide {
    stroke-width: 3;
    opacity: 0.9;
  }

  .edge-label-display:hover {
    border-color: var(--solus-accent-border);
    background: var(--solus-surface-hover);
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
    width: 0.625rem;
    height: 0.625rem;
    border-radius: 50%;
    background: var(--solus-accent);
    border: 0.09375rem solid var(--solus-container-bg);
    box-shadow: 0 0.0625rem 0.125rem rgba(0, 0, 0, 0.18);
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
    font-size: 0.6875rem;
    font-weight: 500;
    outline: none;
    box-shadow: 0 0 0 0.125rem var(--solus-accent-soft);
  }
</style>
