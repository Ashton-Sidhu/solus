<script lang="ts">
  /** The list of the directory picker while its first folder is read: rows
   *  in the shape of `DirectoryRow` (mark, name, branch, kind), so nothing
   *  moves when the folder arrives. They fade in only after 300ms: a folder
   *  that answers sooner shows no placeholder at all. A move to another folder
   *  keeps the last listing instead (`DirectoryPicker` `hasListing`). */
  import { Skeleton } from "../ui/skeleton";

  let { label = "Loading folders" }: { label?: string } = $props();

  // Names of different lengths read as a listing; the lower rows fade, as a list that goes on.
  const NAME_WIDTHS = ["42%", "58%", "34%", "66%", "48%", "38%", "54%", "44%"];
</script>

<div class="rows flex w-full flex-col" role="status" aria-busy="true" aria-label={label}>
  {#each NAME_WIDTHS as width, index (index)}
    <!-- The paddings and the column widths mirror DirectoryRow. -->
    <div
      class="ml-1.5 mr-2.5 flex h-9 w-[calc(100%-1rem)] shrink-0 items-center gap-4 px-2.5"
      style:opacity={1 - index * 0.11}
      aria-hidden="true"
    >
      <span class="flex min-w-0 flex-1 items-center gap-3">
        <Skeleton class="size-4 shrink-0 rounded-[0.3rem]" />
        <Skeleton class="h-2.5" style="width: {width}" />
      </span>
      <span class="flex w-36 shrink-0 @max-[18rem]/picker:hidden">
        {#if index % 3 === 0}
          <Skeleton class="h-2.5 w-20" />
        {/if}
      </span>
      <span class="flex w-28 shrink-0 @max-[26rem]/picker:hidden">
        <Skeleton class="h-2.5 w-12" />
      </span>
    </div>
  {/each}
</div>

<style>
  .rows {
    animation: rows-in 0.2s var(--ease-premium, ease-out) 0.3s both;
  }
  @keyframes rows-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .rows {
      animation: none;
    }
  }
</style>
