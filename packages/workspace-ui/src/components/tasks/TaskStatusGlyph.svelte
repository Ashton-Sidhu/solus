<script lang="ts">
  import type { TaskStatusCategory } from "@solus/contracts/task-sources";
  import { CATEGORY_META } from "./lib/tasks-api";

  /** The board's status mark ("Tasks page" spec, board layout): one ring that
   *  fills as work advances — empty for an open task, half for an active one,
   *  solid for a done one.
   *
   *  It reads as progress rather than as five unrelated colours, which is why
   *  the column head can drop the uppercase micro-label and the card can carry
   *  its status in 12px without a second word. */
  interface Props {
    category: TaskStatusCategory;
    size?: number;
  }
  let { category, size = 12 }: Props = $props();

  // The wedge, drawn from the centre clockwise from 12 o'clock inside the r=4.3
  // ring. Open is deliberately pathless — an empty ring *is* the state.
  const FILL = {
    open: "",
    active: "M6 6L6 2.2A3.8 3.8 0 0 1 6 9.8Z",
    done: "M6 2.2A3.8 3.8 0 1 1 5.99 2.2Z",
  } satisfies Record<TaskStatusCategory, string>;

  // Mixed toward the foreground so the mark stays legible at 12px against both
  // the card and the column wash, in either theme.
  const color = $derived(
    category === "open"
      ? "var(--muted-foreground)"
      : `color-mix(in oklch, var(${CATEGORY_META[category].token}) 70%, var(--foreground))`,
  );
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 12 12"
  class="shrink-0"
  style:color={color}
  aria-hidden="true"
>
  <circle cx="6" cy="6" r="4.3" fill="none" stroke="currentColor" stroke-width="1.3" opacity=".8" />
  {#if FILL[category]}
    <path d={FILL[category]} fill="currentColor" />
  {/if}
</svg>
