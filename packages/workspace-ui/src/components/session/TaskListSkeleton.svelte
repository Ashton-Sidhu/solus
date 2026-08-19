<script lang="ts">
  import { Skeleton } from "../ui/skeleton";

  // Each placeholder occupies the exact height and inset of a real task row, so
  // the list arrives in place instead of pushing itself down a line. Widths are
  // fixed rather than random: a skeleton that reshuffles on every render reads
  // as motion, and motion asks to be watched.
  const ROWS = [
    { width: "72%", delay: 0 },
    { width: "54%", delay: 80 },
    { width: "83%", delay: 160 },
    { width: "47%", delay: 240 },
    { width: "66%", delay: 320 },
    { width: "58%", delay: 400 },
  ];
</script>

<!-- The column fades out down the list rather than ending on a hard edge: the
     placeholder says "tasks are coming", not "there are exactly six". -->
<div class="flex flex-col gap-0.5" role="status" aria-label="Loading tasks">
  {#each ROWS as row, i (i)}
    <div
      class="flex h-[2.625rem] items-center pr-2 pl-[0.625rem]"
      style="opacity:{1 - i * 0.14}"
    >
      <Skeleton
        class="h-[0.6875rem] rounded-[0.25rem]"
        style="width:{row.width};animation-delay:{row.delay}ms"
      />
    </div>
  {/each}
</div>
