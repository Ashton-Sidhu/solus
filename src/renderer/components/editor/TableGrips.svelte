<script lang="ts">
  import type { Editor } from "@tiptap/core";
  import { CellSelection } from "@tiptap/pm/tables";
  import { portal } from "../portal";
  import { endCellsFor, measureTableGrips, type TableGripGeometry } from "./lib/table-grips";

  interface Props {
    editor: Editor | null;
    /** Opens the same row/column menu right-click already uses — scoped to the
     *  grip's own axis — so the grips never grow a second, divergent verb
     *  list. */
    onMenu: (coords: { x: number; y: number; axis: "row" | "column" }) => void;
  }

  let { editor, onMenu }: Props = $props();

  // Grips belong to the table the caret is in — the same rule as the block
  // bar, and the same rule the design states for every structured-block
  // control: they exist only while the caret is inside the block.
  let table = $state<HTMLTableElement | null>(null);
  let geometry = $state<TableGripGeometry | null>(null);
  let selected = $state<{ axis: "row" | "column"; index: number } | null>(null);

  $effect(() => {
    const ed = editor;
    if (!ed) return;

    let pending = false;
    const sync = () => {
      pending = false;
      if (!ed.isActive("table")) {
        table = null;
        geometry = null;
        selected = null;
        return;
      }
      const node = ed.view.domAtPos(ed.state.selection.from).node;
      const el = (node instanceof Element ? node : node.parentElement)?.closest("table");
      const nextTable = (el as HTMLTableElement | null) ?? null;
      table = nextTable;
      geometry = measureTableGrips(nextTable);
    };
    const schedule = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(sync);
    };
    const onBlur = () => {
      table = null;
      geometry = null;
      selected = null;
    };

    ed.on("selectionUpdate", schedule);
    ed.on("transaction", schedule);
    ed.on("focus", schedule);
    ed.on("blur", onBlur);
    // A table can move without a transaction — the pane resizing, the rail
    // opening, the document scrolling under it.
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    sync();

    return () => {
      ed.off("selectionUpdate", schedule);
      ed.off("transaction", schedule);
      ed.off("focus", schedule);
      ed.off("blur", onBlur);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
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
    selected = { axis, index };
  }

  // Click selects; clicking the same grip again opens the menu. One grip, two
  // steps — rather than a grip plus a separate affordance for its verbs.
  function handleGrip(e: MouseEvent, axis: "row" | "column", index: number) {
    e.preventDefault();
    if (selected?.axis === axis && selected.index === index) {
      onMenu({ x: e.clientX, y: e.clientY, axis });
      return;
    }
    select(axis, index);
  }
</script>

{#if geometry}
  <div use:portal={document.body} data-solus-ui class="doc-table-grips" aria-hidden="true">
    {#each geometry.columns as column (column.index)}
      <button
        type="button"
        class="doc-table-grip doc-table-grip--col"
        class:doc-table-grip--on={selected?.axis === "column" && selected.index === column.index}
        style="left:{column.start}px;top:{geometry.table.top}px;width:{Math.max(8, column.length - 6)}px"
        onmousedown={(e) => handleGrip(e, "column", column.index)}
        tabindex="-1"
        aria-label="Column {column.index + 1}"
      ></button>
    {/each}
    {#each geometry.rows as row (row.index)}
      <button
        type="button"
        class="doc-table-grip doc-table-grip--row"
        class:doc-table-grip--on={selected?.axis === "row" && selected.index === row.index}
        style="top:{row.start}px;left:{geometry.table.left}px;height:{Math.max(8, row.length - 4)}px"
        onmousedown={(e) => handleGrip(e, "row", row.index)}
        tabindex="-1"
        aria-label="Row {row.index + 1}"
      ></button>
    {/each}
  </div>
{/if}

<style>
  .doc-table-grips {
    position: fixed;
    inset: 0;
    z-index: 9999;
    /* A layer of bars, not a surface — everything but the bars stays the
       document's to click. */
    pointer-events: none;
  }
  /* 4px ink bars in the table's own gutters. Faint until the pointer finds
     them, so a table at rest is still hairlines and type. */
  .doc-table-grip {
    position: fixed;
    padding: 0;
    border: none;
    border-radius: 999px;
    background: color-mix(in srgb, var(--solus-text-tertiary) 22%, transparent);
    cursor: pointer;
    pointer-events: auto;
    transition: background var(--duration-quick) var(--ease-premium);
  }
  .doc-table-grip--col {
    height: 0.25rem;
    /* A full gutter above the table's top rule — close enough to belong to it,
       far enough that the block bar can sit above without covering it. */
    transform: translateY(-1.625rem);
  }
  /* The gutter beside a block holds two controls, in this order: row grip,
     block drag handle, then the text. Tucked in at 12px the bars sat on top of
     the drag handle instead of beside it — and because this layer paints above
     the editor, a table could never be picked up. 18px is the design's gap and
     is exactly the width the handle needs. */
  .doc-table-grip--row {
    width: 0.25rem;
    transform: translateX(-1.375rem);
  }
  /* A 4px bar is a 4px target, so each bar takes the pointer from the empty
     half of its gutter as well. Only that half: growing it along its own
     length would blur the boundary with the next bar, and growing the row bars
     inward would put them back over the drag handle. */
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
  .doc-table-grip:hover {
    background: color-mix(in srgb, var(--solus-text-tertiary) 45%, transparent);
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

  @media (prefers-reduced-motion: reduce) {
    .doc-table-grip {
      transition: none !important;
    }
  }
</style>
