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
  class="-mx-1.5 flex gap-3 overflow-x-hidden pb-2"
  aria-busy="true"
  aria-label="Loading tasks"
>
  {#each BOARD_COLUMNS as col (col.status)}
    <div class="flex min-w-[15.5rem] max-w-[20rem] flex-1 flex-col p-1.5">
      <!-- Column header (real label + dot, like the live board) -->
      <div class="flex items-center gap-2 px-2 pb-2.5 pt-1">
        <span class="block size-2 shrink-0 rounded-full {STATUS_META[col.status].dotClass}"></span>
        <span class="text-[0.8125rem] font-semibold tracking-[-0.01em] text-(--solus-text-primary)">{col.label}</span>
        <span class="h-[1.0625rem] w-[1.375rem] rounded-full bg-(--solus-surface-hover)"></span>
      </div>

      <!-- Placeholder cards -->
      <div class="flex flex-col gap-2">
        {#each PLAN[col.status] as width (width)}
          <div
            class="rounded-[0.625rem] bg-(--solus-popover-bg) px-3 py-3 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_2px_8px_rgba(0,0,0,0.04)] ring-1 ring-black/5 dark:shadow-none dark:ring-white/10"
          >
            <div class="flex flex-col gap-2">
              <div class="{SHELL} w-(--skeleton-w)" style="--skeleton-w: {width}%"></div>
              <div class="{SHELL} w-(--skeleton-w)" style="--skeleton-w: {Math.max(28, width - 22)}%"></div>
            </div>
          </div>
        {/each}
      </div>
    </div>
  {/each}
</div>
