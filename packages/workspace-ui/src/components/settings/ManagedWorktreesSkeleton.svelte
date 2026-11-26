<script lang="ts">
  /** The worktrees section while the host reads it: the toolbar, a group
   *  header, and a card of rows in the shape of the real ones, so the list
   *  replaces it without a jump. */
  import { RowCard } from "../ui/row-card";
  import { Skeleton } from "../ui/skeleton";

  // Title widths, so the rows do not read as one repeated bar.
  const TITLE_WIDTHS = [46, 62, 38];
</script>

<div class="flex flex-col gap-5" aria-busy="true" aria-label="Reading the worktrees">
  <div class="flex items-center gap-2">
    <Skeleton class="h-2.5 w-28 rounded-[0.1875rem] opacity-45" />
    <Skeleton class="ml-auto h-8 w-24 rounded-lg opacity-60" />
  </div>
  <div class="flex flex-col gap-2">
    <div class="flex items-center gap-2">
      <Skeleton class="h-3 w-16 rounded-[0.1875rem] opacity-70" />
      <Skeleton class="h-2.5 w-28 rounded-[0.1875rem] opacity-45" />
      <Skeleton class="ml-auto h-2.5 w-20 rounded-[0.1875rem] opacity-45" />
    </div>
    <RowCard>
      {#each TITLE_WIDTHS as width, i (i)}
        <div class="flex min-h-15 items-center gap-4 py-2.5 pr-2.5 pl-4">
          <div class="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton class="h-3 rounded-[0.1875rem] opacity-70" style="width:{width}%" />
            <Skeleton class="h-2.5 w-40 max-w-[70%] rounded-[0.1875rem] opacity-45" />
          </div>
          <Skeleton class="h-2.5 w-11 rounded-[0.1875rem] opacity-45 @max-[30rem]/pane:hidden" />
          <div class="flex gap-0.5">
            <Skeleton class="size-7 rounded-md opacity-35" />
            <Skeleton class="size-7 rounded-md opacity-35" />
          </div>
        </div>
      {/each}
    </RowCard>
  </div>
</div>
