<script lang="ts">
  import { ArrowRightIcon, ChatCircleIcon } from "phosphor-svelte";
  import type { ReviewThread } from "@solus/contracts/providers";
  import { reviewCommentPreview } from "./lib/since-review";

  let { thread }: { thread: ReviewThread } = $props();
</script>

<div
  class="mx-3 my-1.5 flex items-start gap-2 rounded-lg bg-(--solus-popover-bg) px-2.5 py-2 shadow-[0_0_0_0.0625rem_var(--solus-container-border)]"
>
  <ChatCircleIcon size={13} weight="fill" class="mt-0.5 shrink-0 text-(--solus-accent)" />
  <div class="min-w-0 flex-1">
    <div class="flex items-center gap-1 text-xs font-medium r text-primary uppercase">
      Your comment here <ArrowRightIcon size={10} weight="bold" /> this changed
    </div>
    <p class="mt-0.5 truncate text-xs text-muted-foreground">
      {reviewCommentPreview(thread)}
    </p>
  </div>
</div>
