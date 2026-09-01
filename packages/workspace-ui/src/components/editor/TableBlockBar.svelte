<script lang="ts">
  import type { Editor } from "@tiptap/core";
  import { fly } from "svelte/transition";
  import { portal } from "../portal";
  import {
    alignColumn,
    currentColumnAlign,
    nextAlign,
    type CellAlign,
  } from "./lib/table-align";

  interface Props {
    editor: Editor | null;
    /** Opens the full row/column menu — the same one right-click already uses,
     *  so the "···" never becomes a second, divergent verb list. */
    onMore: (coords: { x: number; y: number }) => void;
  }

  let { editor, onMore }: Props = $props();

  // A table needs row, column and whole-block verbs, which a selection bubble
  // can't carry. The bar attaches to the block and exists only while the caret
  // is inside it — the same rule as every other control in this editor.
  let anchor = $state<DOMRect | null>(null);
  let align = $state<CellAlign | null>(null);
  let moreEl: HTMLButtonElement | null = $state(null);

  $effect(() => {
    const ed = editor;
    if (!ed) return;

    let pending = false;
    const sync = () => {
      pending = false;
      if (!ed.isActive("table")) {
        anchor = null;
        return;
      }
      // The table element the caret sits in — measured, not computed, so the
      // bar tracks a horizontally scrolled wide table.
      const cell = ed.view.domAtPos(ed.state.selection.from).node;
      const el = (cell instanceof Element ? cell : cell.parentElement)?.closest("table");
      // Keep the freshly measured rect local. Reading `anchor` after assigning it
      // would make this effect depend on the state it writes, and every new
      // DOMRect would schedule the effect again until Svelte aborts the loop.
      const nextAnchor = el?.getBoundingClientRect() ?? null;
      anchor = nextAnchor;
      align = nextAnchor ? currentColumnAlign(ed) : null;
    };
    const schedule = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(sync);
    };

    // The bar belongs to a caret, so it leaves with focus and comes back with
    // it — a transaction alone doesn't fire when focus simply returns.
    const onBlur = () => {
      // Tiptap can emit blur while Svelte is mounting the portalled bar. Defer
      // the state write so it does not run inside Svelte's template reaction.
      requestAnimationFrame(() => {
        anchor = null;
      });
    };

    ed.on("selectionUpdate", schedule);
    ed.on("transaction", schedule);
    ed.on("focus", schedule);
    ed.on("blur", onBlur);
    sync();

    return () => {
      ed.off("selectionUpdate", schedule);
      ed.off("transaction", schedule);
      ed.off("focus", schedule);
      ed.off("blur", onBlur);
    };
  });

  function run(action: (chain: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>) {
    if (!editor) return;
    action(editor.chain().focus()).run();
  }

  function keepCaret(e: MouseEvent) {
    e.preventDefault();
  }

  // One button, three states: markdown only has the three, and the column moves
  // under the pointer as you cycle, so the result is its own label.
  function cycleAlign() {
    if (!editor) return;
    alignColumn(editor, nextAlign(align));
    editor.view.focus();
  }

  function openMore() {
    const rect = moreEl?.getBoundingClientRect();
    if (rect) onMore({ x: rect.left, y: rect.bottom + 4 });
  }
</script>

{#if anchor}
  <div
    use:portal={document.body}
    data-solus-ui
    data-testid="table-block-bar"
    class="doc-table-bar fixed z-[10000]"
    style="left:{anchor.right}px;top:{anchor.top}px"
    transition:fly={{ y: 3, duration: 110, opacity: 0 }}
  >
    <button type="button" class="doc-table-bar__btn" onmousedown={keepCaret} onclick={() => run((c) => c.toggleHeaderRow())}>
      Header row
    </button>
    <button
      type="button"
      class="doc-table-bar__btn"
      onmousedown={keepCaret}
      onclick={cycleAlign}
      title="Align column — {align ?? 'left'}"
    >
      Align
    </button>
    <span class="doc-table-bar__sep" aria-hidden="true"></span>
    <button type="button" class="doc-table-bar__btn doc-table-bar__btn--mono" onmousedown={keepCaret} onclick={() => run((c) => c.addRowAfter())}>
      + row
    </button>
    <button type="button" class="doc-table-bar__btn doc-table-bar__btn--mono" onmousedown={keepCaret} onclick={() => run((c) => c.addColumnAfter())}>
      + col
    </button>
    <button
      bind:this={moreEl}
      type="button"
      class="doc-table-bar__btn doc-table-bar__btn--icon"
      onmousedown={keepCaret}
      onclick={openMore}
      title="More table actions"
      aria-label="More table actions"
    >
      ···
    </button>
  </div>
{/if}

<style>
  .doc-table-bar {
    display: flex;
    align-items: center;
    gap: 0.125rem;
    padding: 0.25rem;
    border-radius: 0.5625rem;
    border: 0.0625rem solid var(--solus-popover-border);
    background: var(--solus-popover-bg);
    box-shadow: var(--solus-popover-shadow);
    backdrop-filter: blur(1.25rem) saturate(1.1);
    -webkit-backdrop-filter: blur(1.25rem) saturate(1.1);
    /* Sits on the block's top-right corner. The clearance is what the column
       grips occupy: at 6px the bar landed on the last column's grip and took
       every click meant for it. */
    transform: translate(-100%, calc(-100% - 2rem));
    white-space: nowrap;
  }
  .doc-table-bar__btn {
    height: 1.5rem;
    padding: 0 0.5625rem;
    border: none;
    border-radius: 0.375rem;
    background: transparent;
    font-family: inherit;
    font-size: var(--text-xs);
    color: color-mix(in srgb, var(--solus-text-primary) 86%, var(--solus-text-tertiary));
    cursor: pointer;
    transition:
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium);
  }
  .doc-table-bar__btn--mono {
    font-family: 'Geist Mono', var(--solus-code-font-family);
    font-size: var(--text-xs);
  }
  .doc-table-bar__btn--icon {
    min-width: 1.5rem;
    padding: 0 0.375rem;
    color: var(--solus-text-tertiary);
  }
  .doc-table-bar__btn:hover {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }
  .doc-table-bar__btn:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border);
    outline-offset: 0.0625rem;
  }
  .doc-table-bar__sep {
    width: 0.0625rem;
    height: 0.875rem;
    margin: 0 0.1875rem;
    background: var(--solus-container-border);
  }

  @media (prefers-reduced-motion: reduce) {
    .doc-table-bar__btn {
      transition: none !important;
    }
  }
</style>
