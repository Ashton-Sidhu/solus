<script lang="ts">
  import type { TaskStatus } from "../../../shared/task-types";
  import { STATUS_META } from "./lib/tasks-api";

  /** The board's status mark ("Tasks page" spec, board layout): one ring that
   *  fills clockwise as work advances — empty for Todo, half for In progress,
   *  three-quarters for In review, solid for Done.
   *
   *  It reads as progress rather than as five unrelated colours, which is why
   *  the column head can drop the uppercase micro-label and the card can carry
   *  its status in 12px without a second word. */
  interface Props {
    status: TaskStatus;
    size?: number;
  }
  let { status, size = 12 }: Props = $props();

  // The wedge, drawn from the centre clockwise from 12 o'clock inside the r=4.3
  // ring. Todo is deliberately pathless — an empty ring *is* the state.
  const FILL: Record<TaskStatus, string> = {
    inbox: "",
    todo: "",
    in_progress: "M6 6L6 2.2A3.8 3.8 0 0 1 6 9.8Z",
    in_review: "M6 6L6 2.2A3.8 3.8 0 1 1 2.2 6Z",
    done: "M6 2.2A3.8 3.8 0 1 1 5.99 2.2Z",
    dropped: "M6 2.2A3.8 3.8 0 1 1 5.99 2.2Z",
  };

  // Mixed toward the foreground so the mark stays legible at 12px against both
  // the card and the column wash, in either theme.
  const color = $derived(
    status === "inbox" || status === "todo" || status === "dropped"
      ? "var(--muted-foreground)"
      : `color-mix(in oklch, var(${STATUS_META[status].token}) 70%, var(--foreground))`,
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
  {#if FILL[status]}
    <path d={FILL[status]} fill="currentColor" />
  {/if}
</svg>
