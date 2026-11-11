<script lang="ts">
  import { Columns3Cog as KanbanIcon, List as ListIcon } from "@lucide/svelte";

  /** The layout control re-plots the task view on screen rather than replacing
   *  it, so it stays visible beside sort. */
  interface Props {
    layout: "list" | "board";
  }
  let { layout = $bindable() }: Props = $props();
</script>

<div
  class="flex h-8 shrink-0 items-center gap-0.5 rounded-lg bg-[var(--wash-2)] p-1 @max-[30rem]/pane:h-10"
  role="group"
  aria-label="Layout"
>
  <button
    type="button"
    class="grid size-6 cursor-pointer place-items-center rounded-md border-0 transition-colors @max-[30rem]/pane:size-8 {layout ===
    'list'
      ? 'bg-card text-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_12%,transparent)]'
      : 'bg-transparent text-muted-foreground hover:text-foreground'}"
    onclick={() => (layout = "list")}
    aria-pressed={layout === "list"}
    aria-label="List layout"
    title="List"
  >
    <ListIcon size={14} weight="bold" />
  </button>
  <button
    type="button"
    class="grid size-6 cursor-pointer place-items-center rounded-md border-0 transition-colors @max-[30rem]/pane:size-8 {layout ===
    'board'
      ? 'bg-card text-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_12%,transparent)]'
      : 'bg-transparent text-muted-foreground hover:text-foreground'}"
    onclick={() => (layout = "board")}
    aria-pressed={layout === "board"}
    aria-label="Board layout"
    title="Board"
  >
    <KanbanIcon size={14} weight="bold" />
  </button>
</div>
