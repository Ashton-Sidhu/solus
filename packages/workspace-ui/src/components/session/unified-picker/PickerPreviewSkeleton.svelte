<script lang="ts">
  import { Skeleton } from "../../ui/skeleton";

  /** The preview pane while the list has no row to show yet: a line of facts,
   *  a title, and two paragraphs, in the measures of a record preview. */
</script>

<div class="flex h-full flex-col px-6 pt-[22px]" aria-hidden="true" data-testid="picker-preview-skeleton">
  <Skeleton class="mb-4 h-2 w-44 rounded-[0.25rem]" />
  <Skeleton class="mb-5 h-4 w-[56%] rounded-[0.375rem]" />
  <div class="flex flex-col gap-2.5">
    <Skeleton class="h-2.5 w-[92%] rounded-[0.25rem]" />
    <Skeleton class="h-2.5 w-[84%] rounded-[0.25rem]" />
    <Skeleton class="h-2.5 w-[61%] rounded-[0.25rem]" />
  </div>
  <div class="mt-6 flex flex-col gap-2.5 opacity-70">
    <Skeleton class="h-2.5 w-[88%] rounded-[0.25rem]" />
    <Skeleton class="h-2.5 w-[72%] rounded-[0.25rem]" />
  </div>
</div>
