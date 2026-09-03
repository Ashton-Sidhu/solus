<script lang="ts">
  import type { Editor } from "@tiptap/core";
  import { CellSelection, moveTableColumn, moveTableRow } from "@tiptap/pm/tables";
  import { portal } from "../portal";
  import { growTable } from "./tableFlow";
  import {
    endCellsFor,
    measureTableGrips,
    tableChromeAffordances,
    type Box,
    type ChromeKind,
    type TableGripGeometry,
  } from "./lib/table-grips";
  import {
    measureSelectionRing,
    selectedBandOf,
    type SelectedBand,
  } from "./lib/table-selection";
  import {
    DRAG_LIFT_PX,
    DRAG_SETTLE_MS,
    DRAG_SPRING_MS,
    DRAG_THRESHOLD_PX,
    dropIndexFor,
    landingShift,
    siblingShift,
    type Band,
  } from "./lib/table-drag";

  interface Props {
    editor: Editor | null;
    /** Opens the same row/column menu right-click already uses — scoped to the
     *  grip's own axis — so the grips never grow a second, divergent verb
     *  list. */
    onMenu: (coords: { x: number; y: number; axis: "row" | "column" }) => void;
  }

  let { editor, onMenu }: Props = $props();

  /** Beyond this a table is hairlines and type, exactly as at rest. The
   *  overlay is portalled, so a pointer leaving the prose for a grip in the
   *  gutter has to keep the chrome alive across the gap. */
  const REVEAL_RADIUS_PX = 48;

  // The table the chrome belongs to: the one the pointer is near, or the one
  // the caret is in. A table nobody is editing still offers its grips to a
  // hand reaching for them.
  let table = $state<HTMLTableElement | null>(null);
  let geometry = $state<TableGripGeometry | null>(null);
  // The ring belongs to the table the caret is in, never the one under the
  // pointer: reaching for a second table's grips must not move the selection
  // the reader made in the first.
  let ring = $state<Box | null>(null);
  // Read back from the document on every sync, never remembered: the grips and
  // the selection must not be able to disagree about which band is live.
  let selected = $state<SelectedBand | null>(null);
  // Typing is not reaching: the grips go quiet until the pointer moves again.
  // The ring stays, because it marks the cell the typing lands in.
  let quiet = $state(false);
  // Where the pointer is, in viewport px. The overlay hands it to CSS, and each
  // grip grades its own ink from its distance to it — no per-grip work here.
  let pointer = $state<{ x: number; y: number } | null>(null);
  let drag = $state<{
    axis: "row" | "column";
    from: number;
    to: number;
  } | null>(null);

  const affordances = $derived(geometry ? tableChromeAffordances(geometry) : []);

  function bandsFor(axis: "row" | "column"): Band[] {
    if (!geometry) return [];
    const source = axis === "row" ? geometry.rows : geometry.columns;
    return source.map((grip) => ({
      index: grip.index,
      start: grip.start,
      size: grip.length,
    }));
  }

  /** A header row that can be dropped into the body loses the table its head. */
  const firstMovableRow = $derived(
    table?.rows[0]?.cells[0]?.tagName === "TH" ? 1 : 0,
  );

  // The overlay is portalled to the body, so the pointer moving from the prose
  // onto a grip *leaves* the editor. Both surfaces therefore report the pointer,
  // and a leave only counts when it goes to neither of them.
  let overlayEl: HTMLDivElement | null = $state(null);
  let caretTable: HTMLTableElement | null = null;
  let hoverTable: HTMLTableElement | null = null;
  let syncPending = false;

  function syncGeometry() {
    syncPending = false;
    const next = hoverTable ?? caretTable;
    table = next;
    geometry = measureTableGrips(next);
    ring = measureSelectionRing(caretTable);
    // A band belongs to the table the caret is in, like the ring: reaching for
    // a second table's grips must not read as a selection in it.
    selected = next === caretTable ? selectedBandOf(caretTable) : null;
  }
  function scheduleSync() {
    if (syncPending) return;
    syncPending = true;
    requestAnimationFrame(syncGeometry);
  }

  // The ring and the selected band belong to a caret the reader can see. When
  // focus leaves the editor — a click in the chrome, another pane — the
  // document keeps its selection but the table stops showing it as live;
  // focus coming back restores it from the same selection.
  function readCaretTable() {
    const ed = editor;
    if (!ed || !ed.isFocused || !ed.isActive("table")) {
      caretTable = null;
      return;
    }
    const node = ed.view.domAtPos(ed.state.selection.from).node;
    const el = (node instanceof Element ? node : node.parentElement)?.closest("table");
    caretTable = el instanceof HTMLTableElement ? el : null;
  }

  function withinReveal(el: HTMLElement, x: number, y: number): boolean {
    const rect = el.getBoundingClientRect();
    return (
      x >= rect.left - REVEAL_RADIUS_PX &&
      x <= rect.right + REVEAL_RADIUS_PX &&
      y >= rect.top - REVEAL_RADIUS_PX &&
      y <= rect.bottom + REVEAL_RADIUS_PX
    );
  }

  function trackPointer(e: PointerEvent) {
    if (drag) return;
    quiet = false;
    pointer = { x: e.clientX, y: e.clientY };
    const el = (e.target instanceof Element ? e.target : null)?.closest("table");
    if (el instanceof HTMLTableElement) hoverTable = el;
    else if (hoverTable && !withinReveal(hoverTable, e.clientX, e.clientY)) hoverTable = null;
    scheduleSync();
  }

  /** A leave that lands on the other half of the same surface is not a leave. */
  function leaveTowards(e: PointerEvent) {
    if (drag) return;
    const to = e.relatedTarget;
    if (to instanceof Node && (overlayEl?.contains(to) || editor?.view.dom.contains(to))) {
      return;
    }
    hoverTable = null;
    quiet = true;
    pointer = null;
    scheduleSync();
  }

  $effect(() => {
    const ed = editor;
    if (!ed) return;

    const onEditorChange = () => {
      readCaretTable();
      scheduleSync();
    };
    const onUpdate = () => {
      quiet = true;
    };

    ed.on("selectionUpdate", onEditorChange);
    ed.on("transaction", onEditorChange);
    ed.on("focus", onEditorChange);
    ed.on("blur", onEditorChange);
    ed.on("update", onUpdate);
    ed.view.dom.addEventListener("pointermove", trackPointer);
    ed.view.dom.addEventListener("pointerleave", leaveTowards);
    // A table can move without a transaction — the pane resizing, the rail
    // opening, the document scrolling under it.
    window.addEventListener("resize", scheduleSync);
    window.addEventListener("scroll", scheduleSync, true);
    onEditorChange();

    return () => {
      ed.off("selectionUpdate", onEditorChange);
      ed.off("transaction", onEditorChange);
      ed.off("focus", onEditorChange);
      ed.off("blur", onEditorChange);
      ed.off("update", onUpdate);
      ed.view.dom.removeEventListener("pointermove", trackPointer);
      ed.view.dom.removeEventListener("pointerleave", leaveTowards);
      window.removeEventListener("resize", scheduleSync);
      window.removeEventListener("scroll", scheduleSync, true);
    };
  });

  /** Position of the cell node itself, not of its content. */
  function cellPos(cell: HTMLTableCellElement): number | null {
    if (!editor) return null;
    try {
      return editor.view.posAtDOM(cell, 0) - 1;
    } catch {
      return null;
    }
  }

  function select(axis: "row" | "column", index: number) {
    if (!editor || !table) return;
    const ends = endCellsFor(table, axis, index);
    if (!ends) return;
    const from = cellPos(ends[0]);
    const to = cellPos(ends[1]);
    if (from === null || to === null) return;
    const { doc, tr } = editor.state;
    const selection =
      axis === "row"
        ? CellSelection.rowSelection(doc.resolve(from), doc.resolve(to))
        : CellSelection.colSelection(doc.resolve(from), doc.resolve(to));
    editor.view.dispatch(tr.setSelection(selection));
    editor.view.focus();
  }

  // ── Direct manipulation. The band follows the pointer 1:1; its siblings
  // spring apart to open the slot; the drop settles into the landing place
  // before the document transaction runs, so the commit is never a jump.

  function cellsOf(axis: "row" | "column", index: number): HTMLElement[] {
    if (!table) return [];
    if (axis === "row") return table.rows[index] ? [table.rows[index]] : [];
    return Array.from(table.rows)
      .map((row) => row.cells[index])
      .filter((cell): cell is HTMLTableCellElement => !!cell);
  }

  function paintDrag(shiftFor: (index: number) => number, settling: boolean) {
    if (!table || !drag) return;
    const bands = bandsFor(drag.axis);
    const axis = drag.axis === "row" ? "Y" : "X";
    for (const band of bands) {
      const lifted = band.index === drag.from;
      const shift = shiftFor(band.index);
      for (const el of cellsOf(drag.axis, band.index)) {
        el.style.transition = settling
          ? `transform ${DRAG_SETTLE_MS}ms var(--ease-premium)`
          : lifted
            ? "none"
            : `transform ${DRAG_SPRING_MS}ms var(--ease-premium)`;
        el.style.transform = lifted
          ? `translate${axis}(${shift}px) translateY(${-DRAG_LIFT_PX}px)`
          : `translate${axis}(${shift}px)`;
        el.style.position = lifted ? "relative" : "";
        el.style.zIndex = lifted ? "2" : "";
        el.style.boxShadow = lifted ? "var(--solus-popover-shadow)" : "";
      }
    }
  }

  function clearDragPaint(axis: "row" | "column") {
    if (!table) return;
    const count = axis === "row" ? table.rows.length : (table.rows[0]?.cells.length ?? 0);
    for (let index = 0; index < count; index++) {
      for (const el of cellsOf(axis, index)) {
        el.style.removeProperty("transition");
        el.style.removeProperty("transform");
        el.style.removeProperty("position");
        el.style.removeProperty("z-index");
        el.style.removeProperty("box-shadow");
      }
    }
  }

  function moveBand(axis: "row" | "column", from: number, to: number) {
    if (!editor || from === to) return;
    const command = axis === "row" ? moveTableRow : moveTableColumn;
    command({ from, to })(editor.state, editor.view.dispatch);
  }

  function onGripPointerDown(
    e: PointerEvent & { currentTarget: HTMLElement },
    axis: "row" | "column",
    index: number,
  ) {
    e.preventDefault();
    const grab = axis === "row" ? e.clientY : e.clientX;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    let started = false;

    const move = (moveEvent: PointerEvent) => {
      const at = axis === "row" ? moveEvent.clientY : moveEvent.clientX;
      if (!started) {
        if (Math.abs(at - grab) < DRAG_THRESHOLD_PX) return;
        started = true;
        select(axis, index);
        drag = { axis, from: index, to: index };
      }
      if (!drag) return;
      const bands = bandsFor(axis);
      const dragged = bands.find((band) => band.index === drag!.from);
      if (!dragged) return;
      drag.to = dropIndexFor(bands, at, axis === "row" ? firstMovableRow : 0);
      const delta = at - grab;
      paintDrag(
        (bandIndex) =>
          bandIndex === drag!.from
            ? delta
            : siblingShift(bandIndex, drag!.from, drag!.to, dragged.size),
        false,
      );
    };

    const finish = () => {
      target.releasePointerCapture?.(e.pointerId);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", finish);
      target.removeEventListener("pointercancel", finish);
      if (!started) {
        // A press that never moved is the click: select, and select again for
        // the menu. One grip, two steps.
        if (selected?.axis === axis && selected.index === index) {
          onMenu({ x: e.clientX, y: e.clientY, axis });
        } else {
          select(axis, index);
        }
        return;
      }
      if (!drag) return;
      const { from, to } = drag;
      const bands = bandsFor(axis);
      const rest = landingShift(bands, from, to);
      const dragged = bands.find((band) => band.index === from);
      paintDrag(
        (bandIndex) =>
          bandIndex === from
            ? rest
            : siblingShift(bandIndex, from, to, dragged?.size ?? 0),
        true,
      );
      const settled = drag;
      drag = null;
      setTimeout(() => {
        clearDragPaint(settled.axis);
        moveBand(settled.axis, from, to);
        // The band the reader just moved stays the selected one — as a real
        // cell selection, so the next click on its grip opens the menu.
        select(settled.axis, to);
      }, DRAG_SETTLE_MS);
    };

    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", finish);
    target.addEventListener("pointercancel", finish);
  }

  /** The insert tabs append at the end, which is where they sit. */
  function insertAtEnd(kind: ChromeKind) {
    if (!editor || !table) return;
    const axis = kind === "insert-row" ? "row" : "column";
    // The last cell of the last row is where "after" means "at the end" on both
    // axes, and where the caret has to start for the grow to land in the new
    // band rather than beside it.
    const lastRow = table.rows[table.rows.length - 1];
    const cell = lastRow?.cells[lastRow.cells.length - 1];
    if (!cell) return;
    const pos = cellPos(cell);
    if (pos === null) return;
    editor.chain().focus().setTextSelection(pos + 1).run();
    growTable(editor, axis);
  }
</script>

{#if geometry}
  <div
    bind:this={overlayEl}
    use:portal={document.body}
    data-solus-ui
    class="doc-table-chrome"
    class:doc-table-chrome--quiet={quiet || !pointer}
    class:doc-table-chrome--dragging={!!drag}
    style="--pointer-x:{pointer?.x ?? 0};--pointer-y:{pointer?.y ?? 0}"
  >
    <!-- One ring for whatever is selected. Extents animate rather than redraw,
         so growing a selection reads as the same ring moving. A dragged band
         carries its cells out from under it, so it goes quiet for the drag. -->
    {#if ring && !drag}
      <span
        class="doc-table-selection"
        style="left:{ring.left}px;top:{ring.top}px;width:{ring.width}px;height:{ring.height}px"
      ></span>
    {/if}
    {#each affordances as affordance (affordance.key)}
      {#if affordance.kind === "row" || affordance.kind === "column"}
        {@const axis = affordance.kind === "row" ? "row" : "column"}
        <button
          type="button"
          class="doc-table-grip"
          class:doc-table-grip--row={axis === "row"}
          class:doc-table-grip--col={axis === "column"}
          class:doc-table-grip--on={selected?.axis === axis &&
            selected.index === affordance.index}
          class:doc-table-grip--lifted={drag?.axis === axis &&
            drag.from === affordance.index}
          style="--box-left:{affordance.box.left};--box-top:{affordance.box.top};--box-w:{affordance
            .box.width};--box-h:{affordance.box.height}"
          onpointerdown={(e) => onGripPointerDown(e, axis, affordance.index)}
          onpointermove={trackPointer}
          onpointerleave={leaveTowards}
          tabindex="-1"
          aria-label="{axis === 'row' ? 'Row' : 'Column'} {affordance.index + 1}"
        ></button>
      {:else}
        <button
          type="button"
          class="doc-table-insert"
          style="--box-left:{affordance.box.left};--box-top:{affordance.box.top};--box-w:{affordance
            .box.width};--box-h:{affordance.box.height}"
          onpointerdown={(e) => e.preventDefault()}
          onpointermove={trackPointer}
          onpointerleave={leaveTowards}
          onclick={() => insertAtEnd(affordance.kind)}
          tabindex="-1"
          aria-label={affordance.kind === "insert-row" ? "Add row" : "Add column"}
        >+</button>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .doc-table-chrome {
    position: fixed;
    inset: 0;
    z-index: 9999;
    /* A layer of bars, not a surface — everything but the bars stays the
       document's to click. */
    pointer-events: none;
  }
  /* A 1px terracotta hairline floated off the cell bounds — the ring is drawn
     here, in the overlay, rather than on the cell, so selecting never changes
     cell padding and a range gets one ring instead of a border per cell. */
  .doc-table-selection {
    position: fixed;
    border: 0.0625rem solid var(--solus-accent);
    border-radius: 0.3125rem;
    pointer-events: none;
    transition:
      left var(--duration-quick) var(--ease-premium),
      top var(--duration-quick) var(--ease-premium),
      width var(--duration-quick) var(--ease-premium),
      height var(--duration-quick) var(--ease-premium);
  }
  /* 4px ink bars in the table's own gutters, and two tabs on the outer border.
     Every box is positioned and sized from the geometry module, so the chrome
     never enters layout and the table's box is identical with and without it.

     Ink is graded by distance, in CSS. The overlay carries the pointer as two
     unitless custom properties and each affordance carries its own box, so
     the grade is one `hypot()` per element: nothing beyond the reveal radius,
     a continuous ramp up to the ambient ceiling on approach — there is no
     moment of appearance — and full ink only under the pointer or on the
     selected band. The values stay unitless so the arithmetic works in every
     engine; the box is converted back to px only where it is painted. */
  .doc-table-grip,
  .doc-table-insert {
    --reveal-radius: 48;
    --ambient-ceiling: 0.3;
    --dx: max(
      var(--box-left) - var(--pointer-x),
      0,
      var(--pointer-x) - (var(--box-left) + var(--box-w))
    );
    --dy: max(
      var(--box-top) - var(--pointer-y),
      0,
      var(--pointer-y) - (var(--box-top) + var(--box-h))
    );
    --distance: hypot(var(--dx), var(--dy));
    position: fixed;
    left: calc(var(--box-left) * 1px);
    top: calc(var(--box-top) * 1px);
    width: calc(var(--box-w) * 1px);
    height: calc(var(--box-h) * 1px);
    pointer-events: auto;
    opacity: clamp(
      0,
      var(--ambient-ceiling) * (1 - var(--distance) / var(--reveal-radius)),
      var(--ambient-ceiling)
    );
    transition: opacity var(--duration-quick) var(--ease-premium);
  }
  .doc-table-grip:hover,
  .doc-table-insert:hover,
  .doc-table-grip--on {
    opacity: 1;
  }
  /* Typing is not reaching, and an absent pointer reaches for nothing: the
     grips fade out and stop taking clicks until the pointer moves again. The
     ring stays, because it marks the cell the typing lands in. */
  .doc-table-chrome--quiet .doc-table-grip,
  .doc-table-chrome--quiet .doc-table-insert {
    opacity: 0;
    pointer-events: none;
  }
  /* While a band is in flight it is the only thing lit, so the eye follows
     the drag rather than the table's furniture. */
  .doc-table-chrome--dragging .doc-table-grip,
  .doc-table-chrome--dragging .doc-table-insert {
    opacity: 0;
  }
  .doc-table-chrome--dragging .doc-table-grip--lifted {
    opacity: 1;
  }
  .doc-table-grip {
    padding: 0;
    border: none;
    border-radius: 9999px;
    background: var(--solus-text-tertiary);
    cursor: grab;
  }
  .doc-table-grip:active {
    cursor: grabbing;
  }
  /* A 4px bar is a 4px target, so each bar takes the pointer from the empty
     half of its gutter as well. Only that half: growing it along its own
     length would blur the boundary with the next bar, and growing the row bars
     inward would put them back over the block drag handle. */
  .doc-table-grip::before {
    content: "";
    position: absolute;
    inset: 0;
  }
  .doc-table-grip--row::before {
    left: -0.5rem;
  }
  .doc-table-grip--col::before {
    bottom: -0.5rem;
  }
  /* Selected: terracotta, matching the cell ring — the accent means "this is
     what the next verb acts on", in the table as everywhere else. */
  .doc-table-grip--on {
    background: var(--solus-accent);
  }
  .doc-table-grip:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border);
    outline-offset: 0.125rem;
  }
  .doc-table-insert {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border-radius: 9999px;
    border: 0.0625rem dashed color-mix(in srgb, var(--solus-text-tertiary) 55%, transparent);
    background: var(--solus-container-bg);
    color: var(--solus-text-tertiary);
    font-family: inherit;
    font-size: var(--text-xs);
    line-height: 1;
    cursor: pointer;
  }
  .doc-table-insert:hover {
    color: var(--solus-accent);
    border-color: var(--solus-accent-border);
  }
  .doc-table-insert:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border);
    outline-offset: 0.125rem;
  }

  @media (prefers-reduced-motion: reduce) {
    .doc-table-selection,
    .doc-table-grip,
    .doc-table-insert {
      transition: none !important;
    }
  }
</style>
