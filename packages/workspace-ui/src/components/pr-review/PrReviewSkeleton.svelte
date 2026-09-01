<script lang="ts">
  import { Skeleton } from "../ui/skeleton";

  /**
   * The pull request review's silhouette: the chrome band, the masthead that
   * carries the branch refs and view tabs, and the activity column beneath it.
   *
   * The review is the heaviest lazy module in the workspace and it opens onto a
   * worktree it may still be fetching, so this stands in for a real wait rather
   * than a microtask. It mirrors the leading-pane layout — the page form — since
   * that is the shape the outlet mounts.
   */
  const activityRows = [86, 72, 91, 64];
</script>

<section
  class="@container flex h-full min-h-0 flex-col bg-background"
  role="status"
  aria-busy="true"
  aria-label="Loading pull request"
>
  <div
    class="workspace-titlebar h-(--solus-chrome-row-h,2.5rem) shrink-0 border-b border-[var(--hairline)]"
    aria-hidden="true"
  >
    <div
      class="flex h-full w-full items-center justify-between gap-2 pr-3.5 pl-[max(1rem,var(--solus-chrome-lead-inset,0px))]"
    >
      <div class="flex min-w-0 flex-1 items-center gap-[7px]">
        <Skeleton class="h-3 w-24 rounded-[0.1875rem] opacity-60" />
        <span class="opacity-25">/</span>
        <Skeleton class="h-3 w-12 rounded-[0.1875rem] opacity-50" />
      </div>
      <div class="flex shrink-0 items-center gap-0.5">
        <Skeleton class="mr-1.5 h-[26px] w-20 rounded-full opacity-45" />
        {#each [0, 1, 2, 3] as index (index)}
          <Skeleton
            class="size-[26px] rounded-full opacity-45"
            style="animation-delay:{110 + index * 55}ms"
          />
        {/each}
      </div>
    </div>
  </div>

  <div class="min-h-0 flex-1 overflow-hidden" aria-hidden="true">
    <div
      class="mx-auto w-full max-w-[92rem] pt-[clamp(20px,1.8cqi,32px)] pr-8 pl-14 2xl:max-w-[104rem]"
    >
      <div class="flex items-center justify-between gap-6 pb-5">
        <div class="flex min-w-0 items-center gap-2">
          <Skeleton class="h-3 w-32 rounded-[0.1875rem] opacity-55" />
          <span class="opacity-30">→</span>
          <Skeleton class="h-3 w-16 rounded-[0.1875rem] opacity-45" />
        </div>
        <Skeleton class="h-[30px] w-56 shrink-0 rounded-full opacity-55" />
      </div>

      <Skeleton class="h-7 w-[54%] max-w-[34rem] rounded-md opacity-70" />

      <div class="flex flex-col gap-5 pt-9">
        {#each activityRows as width, index (index)}
          <div class="flex gap-3">
            <Skeleton class="size-7 shrink-0 rounded-full opacity-50" />
            <div class="flex min-w-0 flex-1 flex-col gap-2 pt-1">
              <Skeleton class="h-2.5 w-28 rounded-[0.1875rem] opacity-50" />
              <Skeleton
                class="h-3 rounded-[0.1875rem] opacity-40"
                style="width:{width}%; animation-delay:{200 + index * 70}ms"
              />
            </div>
          </div>
        {/each}
      </div>
    </div>
  </div>
</section>
