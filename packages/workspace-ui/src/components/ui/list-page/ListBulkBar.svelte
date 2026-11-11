<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ListSelection } from "./list-selection.svelte";

  /**
   * The bar that floats over a list while a selection is held: the count, Clear,
   * and the page's own actions.
   * ── The record rung (`@max-[30rem]/pane`) ──
   * One line of controls is a desktop pill. At 393px it was wider than the pane,
   * so it clipped at both edges and painted over the row underneath with no
   * inset for the home indicator. The ladder: the count and Clear take a line of
   * their own, and the actions wrap rather than clip. A control that does not
   * fit gets its own line; it never loses its label.
   */
  interface Props {
    selection: ListSelection;
    children: Snippet;
  }
  let { selection, children }: Props = $props();
</script>

<div
  class="pointer-events-none absolute inset-x-0 bottom-14 z-10 flex justify-center px-4 @max-[30rem]/pane:bottom-0 @max-[30rem]/pane:px-2 @max-[30rem]/pane:pb-[max(0.5rem,env(safe-area-inset-bottom,0px))]"
>
  <div
    class="pointer-events-auto flex items-center gap-1.5 rounded-full border border-(--solus-popover-border) bg-(--solus-popover-bg) px-2 py-1.5 shadow-[var(--solus-popover-shadow)] @max-[30rem]/pane:w-full @max-[30rem]/pane:flex-col @max-[30rem]/pane:items-stretch @max-[30rem]/pane:gap-2 @max-[30rem]/pane:rounded-2xl @max-[30rem]/pane:p-2.5"
    role="toolbar"
    aria-label="Bulk actions"
  >
    <!-- `contents` keeps the wide pill one flat line; at the rung this
         becomes the header line, with Clear held to the right by the
         `order-last` that also puts it at the end of the pill. -->
    <div
      class="contents @max-[30rem]/pane:flex @max-[30rem]/pane:items-center @max-[30rem]/pane:justify-between"
    >
      <span class="px-1.5 font-medium tabular-nums whitespace-nowrap">
        {selection.size} selected
      </span>
      <button
        type="button"
        class="order-last cursor-pointer rounded-full border-0 bg-transparent px-2 py-1 text-xs font-medium whitespace-nowrap text-(--solus-text-tertiary) transition-colors duration-100 hover:bg-(--solus-surface-hover) @max-[30rem]/pane:h-9 @max-[30rem]/pane:px-3 @max-[30rem]/pane:text-workspace-chrome"
        onclick={() => selection.clear()}
        title="Clear selection (Esc)"
      >
        Clear
      </button>
    </div>
    <span
      class="h-4 w-px bg-(--solus-container-border) @max-[30rem]/pane:hidden"
      aria-hidden="true"
    ></span>
    <div
      class="contents @max-[30rem]/pane:flex @max-[30rem]/pane:flex-wrap @max-[30rem]/pane:items-center @max-[30rem]/pane:gap-1.5"
    >
      {@render children()}
    </div>
  </div>
</div>
