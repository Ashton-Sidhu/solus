<script lang="ts">
  import { Skeleton } from "../ui/skeleton";
  import InsightsResultSkeleton from "./InsightsResultSkeleton.svelte";
</script>

<!-- Mirrors the Insights shell while its lazy module loads. The titlebar, the
     console band, and the answer geometry stay in place, so the pane does not
     settle twice after it opens. -->
<div
  class="@container relative flex h-full w-full flex-col overflow-hidden bg-background text-insights-chrome text-foreground"
  role="status"
  aria-busy="true"
  aria-label="Loading insights"
>
  <div class="mx-auto w-full max-w-[72rem] shrink-0 px-8 @min-[90rem]:max-w-[82rem] @min-[110rem]:max-w-[94rem] @max-[44rem]:px-5 @max-[34rem]:px-4">
  <header
    class="workspace-titlebar box-content flex h-[31px] shrink-0 items-center pt-[42px] pb-[13px] text-muted-foreground pointer-coarse:h-9 pointer-fine:[.is-laptop-display_&]:h-[27px] [.is-laptop-display_&]:pt-8 [.is-laptop-display_&]:pb-2.5 @max-[30rem]/pane:h-11! @max-[30rem]/pane:pb-2.5!"
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
  </div>

  <div class="mx-auto flex min-h-0 w-full max-w-[72rem] flex-1 flex-col gap-3 px-8 pb-4.5 @min-[90rem]:max-w-[82rem] @min-[110rem]:max-w-[94rem] @max-[44rem]:px-5 @max-[34rem]:px-4">
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
