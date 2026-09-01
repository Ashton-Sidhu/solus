<script lang="ts">
  import { taskTabs, type TaskTabCounts, type TaskTabId } from "./lib/task-tabs";

  /**
   * The task page's four sections as a strip, for a pane too narrow to scroll
   * them past each other without losing the composer at its foot.
   *
   * Underlined text tabs, not pills. The strip is the only navigation on the
   * page at this rung, so it has to read as the page's own spine: four labels
   * on one 44px band with the current one carrying a 2px seam of brand under
   * it. A row of filled pills would read as four filters instead, next to the
   * filter chips the sections below it actually use.
   */
  interface Props {
    tab: TaskTabId;
    counts: TaskTabCounts;
    onSelect: (tab: TaskTabId) => void;
  }
  let { tab, counts, onSelect }: Props = $props();

  const tabs = $derived(taskTabs(counts));
</script>

<div
  class="no-drag flex h-11 shrink-0 items-stretch gap-4 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:h-0"
  role="tablist"
  aria-label="Task sections"
>
  {#each tabs as spec (spec.id)}
    {@const isActive = spec.id === tab}
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      class="flex shrink-0 cursor-pointer items-center gap-1.5 border-0 bg-transparent px-0 text-workspace-chrome transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] {isActive
        ? 'font-semibold tracking-[-0.008em] text-foreground shadow-[inset_0_-2px_0_var(--primary)]'
        : 'font-normal text-muted-foreground hover:text-foreground'}"
      onclick={() => onSelect(spec.id)}
    >
      {spec.label}
      <!-- Zero is not drawn: an empty section is worth knowing about once, by
           opening it, not on every glance at the strip. -->
      {#if spec.count}
        <span class="font-mono text-xs tabular-nums opacity-70"
          >{spec.count}</span
        >
      {/if}
    </button>
  {/each}
</div>
