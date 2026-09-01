<script lang="ts">
  import { CaretLeftIcon } from "phosphor-svelte";
  import { tooltip } from "../../lib/tooltip";

  interface Props {
    mountFileTree: (node: HTMLDivElement) => { destroy: () => void };
    onToggleTree: () => void;
  }

  let { mountFileTree, onToggleTree }: Props = $props();
</script>

<div
  class="diff-tree-column relative flex h-full w-full flex-col border-r border-(--solus-container-border)"
>
  <button
    type="button"
    onclick={onToggleTree}
    aria-label="Hide file tree"
    class="tree-collapse-btn absolute top-[0.875rem] left-3 z-10 w-5 h-5 flex items-center justify-center rounded cursor-pointer text-(--solus-text-tertiary)"
    use:tooltip={"Hide file tree (⌥T)"}
  >
    <span
      class="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
      aria-hidden="true"
    ></span>
    <CaretLeftIcon size={12} weight="bold" />
  </button>
  <div
    use:mountFileTree
    class="diff-tree flex-1 min-h-0 overflow-auto"
    style="-webkit-overflow-scrolling:touch; overscroll-behavior-y:contain"
    aria-label="Changed files"
  ></div>
</div>

<style>
  .diff-tree-column {
    min-width: min(12rem, 45vw);
  }
  .tree-collapse-btn {
    transition:
      color 120ms ease,
      background-color 120ms ease;
  }
  .tree-collapse-btn:hover {
    color: var(--solus-text-primary);
    background: var(--solus-surface-hover);
  }
  .tree-collapse-btn:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.125rem;
  }
  .diff-tree {
    --trees-bg-override: transparent;
    --trees-fg-override: var(--solus-text-secondary);
    --trees-fg-muted-override: var(--solus-text-tertiary);
    --trees-bg-muted-override: var(--solus-surface-hover);
    --trees-accent-override: var(--solus-accent);
    --trees-border-color-override: var(--solus-container-border);
    --trees-selected-fg-override: var(--solus-text-primary);
    --trees-selected-bg-override: var(--solus-accent-light);
    --trees-selected-focused-border-color-override: transparent;
    --trees-focus-ring-color-override: var(--solus-accent);
    --trees-scrollbar-thumb-override: var(--solus-scroll-thumb);
    --trees-font-family-override:
      -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui,
      sans-serif;
    --trees-font-size-override: 0.75rem;
    --trees-padding-inline-override: 0.625rem;
    --trees-density-override: 0.75;
    --trees-scrollbar-gutter-override: 0.1875rem;
    --trees-search-bg-override: var(--solus-input-bg-soft);
    --trees-search-fg-override: var(--solus-text-primary);
    --trees-status-added-override: var(--solus-status-complete);
    --trees-status-modified-override: var(--solus-accent);
    --trees-status-deleted-override: var(--solus-status-error);
  }
</style>
