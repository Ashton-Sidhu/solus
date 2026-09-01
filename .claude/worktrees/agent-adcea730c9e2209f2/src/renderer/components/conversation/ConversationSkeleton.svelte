<script lang="ts">
  import { Skeleton } from "../ui/skeleton";

  // Simulate a realistic mixed conversation layout
  type SkeletonRow =
    | { kind: "user"; width: number }
    | { kind: "assistant"; lines: number[] }
    | { kind: "tool"; width: number };

  const rows: SkeletonRow[] = [
    { kind: "user", width: 55 },
    { kind: "assistant", lines: [85, 72, 60] },
    { kind: "tool", width: 48 },
    { kind: "user", width: 38 },
    { kind: "assistant", lines: [90, 78, 55, 40] },
    { kind: "user", width: 62 },
    { kind: "assistant", lines: [80, 68] },
  ];
</script>

<div
  class="flex w-full flex-col gap-2 overflow-hidden px-4 pt-3 pb-8"
  style="max-width:var(--solus-reading-max);margin-inline:auto"
  role="status"
  aria-label="Loading conversation"
>
  {#each rows as row, i (i)}
    {#if row.kind === "user"}
      <div class="flex justify-end py-1">
        <Skeleton
          class="h-8 rounded-2xl opacity-70"
          style="width:{row.width}%; animation-delay:{i * 80}ms"
        />
      </div>
    {:else if row.kind === "assistant"}
      <div class="py-2 pl-3 border-l-2 border-(--solus-assistant-left-border)">
        <div class="flex flex-col gap-2">
          {#each row.lines as lineWidth, j (j)}
            <Skeleton
              class="h-3 rounded-sm opacity-70"
              style="width:{lineWidth}%; animation-delay:{(i * 80) + (j * 60)}ms"
            />
          {/each}
        </div>
      </div>
    {:else if row.kind === "tool"}
      <div class="py-1">
        <Skeleton
          class="h-7 rounded-lg opacity-70"
          style="width:{row.width}%; animation-delay:{i * 80}ms; opacity:0.5"
        />
      </div>
    {/if}
  {/each}
</div>
