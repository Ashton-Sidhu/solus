<script lang="ts">
  import { STATUS_META, BOARD_COLUMNS } from "./lib/tasks-api";

  // Mirrors TaskBoard's column chrome (real labels + status dots) while the task
  // list loads, swapping cards for shimmer placeholders. A fixed per-column card
  // plan keeps the silhouette stable across renders (no random reflow).
  const SHELL =
    "h-2.5 rounded-[0.375rem] bg-[linear-gradient(90deg,var(--solus-surface-hover)_25%,transparent_50%,var(--solus-surface-hover)_75%)] [background-size:25rem_100%] animate-[skeleton-shimmer_1.5s_ease-in-out_infinite]";
  // Card title widths per column (% of row), one entry per placeholder card.
  const PLAN: Record<string, number[]> = {
    open: [72, 54, 64],
    in_progress: [60, 78],
    done: [66, 48],
  };
</script>

<div
  class="flex h-full min-h-0 gap-3 overflow-x-hidden pb-1"
  aria-busy="true"
  aria-label="Loading tasks"
>
  {#each BOARD_COLUMNS as col (col.status)}
    <div
      class="flex min-h-0 min-w-[15.5rem] max-w-[20rem] flex-1 flex-col rounded-xl border border-transparent bg-(--solus-surface-hover)/35"
    >
      <!-- Column header (real label + dot, like the live board) -->
      <div class="flex items-center gap-2 px-3 pb-1.5 pt-2.5">
        <span class="block size-2 rounded-full {STATUS_META[col.status].dotClass}"></span>
        <span class="text-[0.75rem] font-semibold text-(--solus-text-primary)">{col.label}</span>
      </div>

      <!-- Placeholder cards -->
      <div class="flex min-h-0 flex-1 flex-col gap-2.5 px-1.5 pb-2">
        {#each PLAN[col.status] as width (width)}
          <div
            class="rounded-[0.625rem] border border-(--solus-popover-border)/80 bg-(--solus-popover-bg) px-2.5 py-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.05),0_1px_1px_rgba(0,0,0,0.03)]"
          >
            <div class="flex flex-col gap-2">
              <div class={SHELL} style="width:{width}%"></div>
              <div class={SHELL} style="width:{Math.max(28, width - 22)}%"></div>
            </div>
          </div>
        {/each}
      </div>
    </div>
  {/each}
</div>
