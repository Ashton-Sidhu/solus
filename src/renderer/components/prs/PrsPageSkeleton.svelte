<script lang="ts">
  import { Skeleton } from "../ui/skeleton";
  import ListSkeleton from "../ui/list-page/ListSkeleton.svelte";
</script>

<!-- Mirrors the PR page shell while its lazy module loads. Keeping the final
     header, filter, and row geometry in place prevents the pane from settling
     twice after it opens. -->
<div
  class="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background"
  role="status"
  aria-busy="true"
  aria-label="Loading pull requests"
>
  <div
    class="mx-auto flex min-h-0 w-full max-w-[72rem] flex-1 flex-col px-8 @min-[90rem]:max-w-[82rem] @min-[110rem]:max-w-[94rem] @max-[44rem]:px-5 @max-[34rem]:px-4"
  >
    <div
      class="workspace-titlebar flex shrink-0 items-end justify-between gap-8 pb-[22px] pt-[42px]"
    >
      <div class="flex min-w-0 flex-col gap-[9px]">
        <Skeleton class="h-6 w-36 rounded opacity-70" />
        <div class="flex items-center gap-2">
          <Skeleton class="h-2.5 w-16 rounded-[0.1875rem] opacity-60" />
          <Skeleton class="h-2.5 w-24 rounded-[0.1875rem] opacity-45" />
        </div>
      </div>

      <div class="flex shrink-0 items-center gap-2">
        <Skeleton class="h-[26px] w-24 rounded-full opacity-50 @max-[44rem]:hidden" />
        <Skeleton class="h-[30px] w-48 rounded-full opacity-60" />
        <Skeleton class="size-[26px] rounded-full opacity-50" />
      </div>
    </div>

    <div class="flex shrink-0 items-center gap-2 pb-3.5">
      <Skeleton class="h-7 min-w-0 flex-1 rounded-lg opacity-55" />
      <Skeleton class="h-7 w-20 rounded-lg opacity-45 @max-[34rem]:hidden" />
      <Skeleton class="h-7 w-16 rounded-lg opacity-45 @max-[44rem]:hidden" />
    </div>

    <div class="min-h-0 flex-1 overflow-hidden">
      <ListSkeleton identWidth={44} />
    </div>
  </div>
</div>
