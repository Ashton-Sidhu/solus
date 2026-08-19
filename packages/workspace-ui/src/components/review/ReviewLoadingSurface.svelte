<script lang="ts">
  import type { ReviewView } from "../../contexts/workspace/routing/route-registry";
  import DiffLoadingSkeleton from "../diff/DiffLoadingSkeleton.svelte";
  import { Skeleton } from "../ui/skeleton";

  let { view }: { view: ReviewView } = $props();
</script>

<!-- This is the review route's complete loading geometry. It deliberately
     matches DiffPanel: one toolbar-height chrome row over one container-colour
     body. Keeping this in one component prevents each async boundary from
     inventing a slightly different background or vertical offset. -->
<div
  class="flex h-full min-h-0 w-full flex-col bg-(--solus-container-bg)"
  role="status"
  aria-label="Loading changes"
>
  <div
    class="workspace-titlebar flex h-(--solus-chrome-row-h,2.5rem) shrink-0 items-center gap-2 border-b border-[color-mix(in_srgb,var(--solus-container-border)_50%,transparent)] pr-[max(0.75rem,var(--solus-pane-chrome-inset,0px))] pl-[max(0.75rem,var(--solus-chrome-lead-inset,0px))]"
    aria-hidden="true"
  >
    <div class="flex min-w-0 flex-1 items-center gap-2">
      <Skeleton class="size-3.5 shrink-0 rounded-[0.1875rem]" />
      <Skeleton class="h-2.5 w-28 rounded-[0.1875rem]" />
    </div>
    <div class="flex shrink-0 items-center gap-1.5">
      <Skeleton class="h-7 w-32 rounded-lg" />
      {#if view === "diff"}
        <Skeleton class="h-7 w-28 rounded-lg" />
      {/if}
      <Skeleton class="size-7 rounded-lg" />
      <Skeleton class="size-7 rounded-lg" />
    </div>
  </div>

  <div class="flex min-h-0 flex-1 flex-col">
    {#if view !== "guide"}
      <DiffLoadingSkeleton variant={view === "map" ? "map" : "diff"} />
    {/if}
  </div>
</div>
