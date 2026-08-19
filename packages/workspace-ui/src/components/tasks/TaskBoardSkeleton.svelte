<script lang="ts">
  import { BOARD_COLUMNS } from "./lib/tasks-api";
  import { Skeleton } from "../ui/skeleton";

  // Mirrors TaskBoard's column chrome (real labels, real wells) while the tasks
  // load, swapping cards for shimmer placeholders. A fixed per-column card plan
  // keeps the silhouette stable across renders (no random reflow); the widths
  // are title lengths as a percentage of the card.
  const PLAN = {
    in_progress: [72, 54, 64],
    in_review: [60, 78],
    todo: [66, 48, 70],
    done: [58],
  } satisfies Record<string, number[]>;
</script>

<div
  class="flex min-h-0 flex-1 items-stretch gap-2.5 overflow-hidden pt-1.5"
  aria-busy="true"
  aria-label="Loading tasks"
>
  {#each BOARD_COLUMNS as col (col.status)}
    <div
      class="flex h-full min-h-0 max-w-[21.25rem] min-w-[14rem] flex-1 basis-[15.25rem] flex-col"
    >
      <div class="flex h-[30px] shrink-0 items-center gap-2 pr-1 pl-0.5">
        <span
          class="text-xs font-normal text-muted-foreground uppercase"
        >
          {col.label}
        </span>
      </div>

      <div
        class="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden rounded-2xl bg-[var(--wash-1)] p-2 pb-5 shadow-[inset_0_0_0_.5px_color-mix(in_oklch,var(--foreground)_6%,transparent)]"
      >
        {#each PLAN[col.status] ?? [64] as width, i (i)}
          <div
            class="flex shrink-0 flex-col gap-2 rounded-2xl bg-card px-3 pt-[11px] pb-2.5 shadow-[0_0_0_.5px_var(--hairline-strong),0_1px_2px_-1px_rgba(24,20,16,.10),0_6px_14px_-10px_rgba(24,20,16,.20)]"
          >
            <Skeleton class="h-2 w-10 rounded-full" />
            <Skeleton
              class="h-2.5 w-(--skeleton-w) rounded-full"
              style="--skeleton-w: {width}%"
            />
            <Skeleton
              class="h-2.5 w-(--skeleton-w) rounded-full"
              style="--skeleton-w: {Math.max(28, width - 22)}%"
            />
          </div>
        {/each}
      </div>
    </div>
  {/each}
</div>
