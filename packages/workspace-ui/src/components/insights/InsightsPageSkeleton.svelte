<script lang="ts">
  import { Skeleton } from "../ui/skeleton";
  import InsightsResultSkeleton from "./InsightsResultSkeleton.svelte";
</script>

<!-- Mirrors the Insights shell while its lazy module loads. The titlebar, the
     console band, and the answer geometry stay in place, so the pane does not
     settle twice after it opens. -->
<div
  class="relative flex h-full w-full flex-col overflow-hidden bg-background text-insights-chrome text-foreground"
  role="status"
  aria-busy="true"
  aria-label="Loading insights"
>
  <header
    class="workspace-titlebar flex h-[calc(var(--solus-chrome-row-h,2.75rem)-0.25rem)] shrink-0 items-center gap-1 pr-6 pl-[max(1.625rem,var(--solus-chrome-lead-inset,0px))] shadow-[inset_0_-0.5px_0_var(--hairline)] pointer-coarse:h-(--solus-chrome-row-h,2.75rem)"
  >
    <span class="flex h-7 shrink-0 items-center px-[7px] text-workspace-chrome font-semibold"
      >Insights</span
    >
    <span class="px-[3px] text-workspace-chrome opacity-25" aria-hidden="true">/</span>
    <Skeleton class="h-3.5 w-12 rounded opacity-55" />
    <span class="flex-1"></span>
    <Skeleton class="h-6 w-14 rounded-md opacity-45" />
    <!-- The move-across control the real header ends with. -->
    <Skeleton class="size-[1.625rem] rounded-[0.4375rem] opacity-40" />
  </header>

  <div class="flex min-h-0 flex-1 flex-col gap-3 px-4 pt-3.5 pb-4.5 sm:px-6.5">
    <section class="shrink-0 overflow-hidden rounded-xl bg-card" aria-hidden="true">
      <div class="flex h-11 items-center gap-2.5 pr-2 pl-2.5">
        <Skeleton class="h-6.5 w-24 shrink-0 rounded-lg opacity-55" />
        <Skeleton class="h-3 min-w-0 flex-1 rounded opacity-40" />
        <Skeleton class="h-6.5 w-28 shrink-0 rounded-lg opacity-45" />
        <Skeleton class="size-6.5 shrink-0 rounded-lg opacity-55" />
      </div>
      <div
        class="flex h-7.5 items-center gap-1 px-2 shadow-[inset_0_0.5px_0_var(--hairline)]"
      >
        <Skeleton class="h-6 w-20 rounded-md opacity-40" />
        <Skeleton class="h-6 w-24 rounded-md opacity-35" />
        <Skeleton class="h-6 w-16 rounded-md opacity-30" />
        <span class="flex-1"></span>
        <Skeleton class="size-6 rounded-md opacity-35" />
        <Skeleton class="size-6 rounded-md opacity-35" />
      </div>
    </section>

    <InsightsResultSkeleton />
  </div>
</div>
