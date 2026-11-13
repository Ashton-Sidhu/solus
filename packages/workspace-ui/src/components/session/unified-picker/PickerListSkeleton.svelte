<script lang="ts">
  import { Skeleton } from "../../ui/skeleton";

  /**
   * Placeholder rows for a list whose reads are still in flight. Each row has
   * the height and the inset of a real row (`pickerRowHeight`), so the list
   * arrives in place. The widths are fixed, not random: a skeleton that
   * changes on each render reads as motion.
   */
  interface Props {
    /** What is loading, for a reader who cannot see the rows. */
    label: string;
  }
  let { label }: Props = $props();

  const ROWS = [
    { title: "58%", detail: "32%" },
    { title: "74%", detail: "41%" },
    { title: "49%", detail: "27%" },
    { title: "66%", detail: "36%" },
    { title: "54%", detail: "44%" },
    { title: "70%", detail: "30%" },
  ];
</script>

<div class="flex flex-col" role="status" aria-label={label} data-testid="picker-list-skeleton">
  <!-- The section heading's line. -->
  <div class="flex h-8 items-center gap-3 px-3 pt-[5px]" aria-hidden="true">
    <Skeleton class="h-2 w-16 rounded-[0.1875rem]" />
    <span class="h-px flex-1 bg-(--solus-menu-hairline)"></span>
  </div>
  <!-- The rows fade down the list: the placeholder says "rows are coming",
       not "there are six". -->
  {#each ROWS as row, i (i)}
    <div class="flex h-11 items-center gap-3 pr-3 pl-6" style="opacity:{1 - i * 0.13}" aria-hidden="true">
      <span class="flex size-[1.625rem] shrink-0 items-center justify-center">
        <Skeleton class="size-3.5 rounded-[0.25rem]" style="animation-delay:{i * 80}ms" />
      </span>
      <span class="flex min-w-0 flex-1 flex-col gap-1.5">
        <Skeleton class="h-2.5 rounded-[0.25rem]" style="width:{row.title};animation-delay:{i * 80}ms" />
        <Skeleton class="h-2 rounded-[0.25rem]" style="width:{row.detail};animation-delay:{i * 80}ms" />
      </span>
      <Skeleton class="h-2 w-9 shrink-0 rounded-[0.25rem]" style="animation-delay:{i * 80}ms" />
    </div>
  {/each}
</div>
