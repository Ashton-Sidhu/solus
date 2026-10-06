<script lang="ts">
  import { Skeleton } from "../ui/skeleton";
  import ConversationSkeleton from "./ConversationSkeleton.svelte";
  import { underStrip } from "../ui/lib/pane-strip";

  // The companion strip draws the seam for the pane it heads.
  const isUnderStrip = underStrip();
</script>

<!-- Holds the split chat's frame — chrome row, transcript, composer — while
     ConversationPane is still being fetched, so the pane opens at its final
     geometry instead of resettling once the module lands. -->
<div
  class="flex h-full min-h-0 min-w-0 flex-col bg-(--solus-container-bg) {isUnderStrip()
    ? ''
    : 'border-l border-(--solus-container-border)'}"
  role="status"
  aria-label="Loading conversation"
>
  <div
    class="workspace-titlebar flex h-(--solus-chrome-row-h,2.5rem) shrink-0 items-center justify-end gap-2 border-b border-[color-mix(in_srgb,var(--solus-container-border)_50%,transparent)] px-2.5"
  >
    <Skeleton class="mr-auto h-3.5 w-44 rounded opacity-45" />
    <Skeleton class="size-4 rounded-[0.25rem] opacity-55" />
    <Skeleton class="size-4 rounded-[0.25rem] opacity-55" />
  </div>

  <div class="min-h-0 flex-1 overflow-hidden">
    <ConversationSkeleton />
  </div>

  <div class="shrink-0 px-4 pt-2.5 pb-2.5">
    <Skeleton
      class="mx-auto h-20 w-full max-w-(--solus-reading-max) rounded-2xl opacity-60"
    />
  </div>
</div>
