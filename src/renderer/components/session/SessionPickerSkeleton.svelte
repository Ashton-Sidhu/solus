<script lang="ts">
  import { Skeleton } from "../ui/skeleton";

  const TITLE_WIDTHS = [72, 54, 81, 46, 68, 58, 77, 50];
  const META_WIDTHS = [38, 28, 44, 32, 40, 30, 46, 34];

</script>

<div class="flex flex-col pb-1 pt-2" role="status" aria-label="Loading sessions">
  <div class="flex h-[1.625rem] items-end px-5 pb-1 pt-2.5">
    <Skeleton class="h-2 w-[22%] rounded-[0.1875rem] opacity-70" />
  </div>
  {#each Array(5) as _, i (i)}
    <div class="flex h-[2.875rem] items-center px-2">
      <Skeleton class="ml-3 mr-2.5 size-[0.875rem] shrink-0 rounded-full opacity-60" />
      <div class="flex min-w-0 flex-1 flex-col gap-1.5 pr-3">
        <Skeleton
          class="h-[0.6875rem] rounded-[0.25rem] opacity-85"
          style="width:{TITLE_WIDTHS[i % TITLE_WIDTHS.length]}%"
        />
        <Skeleton
          class="h-[0.5625rem] rounded-[0.1875rem] opacity-55"
          style="width:{META_WIDTHS[i % META_WIDTHS.length]}%"
        />
      </div>
    </div>
  {/each}
  <div class="flex h-[1.625rem] items-end px-5 pb-1 pt-2.5">
    <Skeleton
      class="h-2 rounded-[0.1875rem] opacity-70"
      style="width:34%"
    />
  </div>
  {#each Array(3) as _, i (i)}
    <div class="flex h-[2.875rem] items-center px-2">
      <Skeleton class="ml-3 mr-2.5 size-[0.875rem] shrink-0 rounded-full opacity-60" />
      <div class="flex min-w-0 flex-1 flex-col gap-1.5 pr-3">
        <Skeleton
          class="h-[0.6875rem] rounded-[0.25rem] opacity-85"
          style="width:{TITLE_WIDTHS[(i + 3) % TITLE_WIDTHS.length]}%"
        />
        <Skeleton
          class="h-[0.5625rem] rounded-[0.1875rem] opacity-55"
          style="width:{META_WIDTHS[(i + 3) % META_WIDTHS.length]}%"
        />
      </div>
    </div>
  {/each}
</div>
