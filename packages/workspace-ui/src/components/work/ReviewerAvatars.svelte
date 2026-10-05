<script lang="ts">
  import { parseUserKey } from "@solus/contracts/user";
  import type { WorkReviewerSummary } from "@solus/contracts/work-review";
  import * as TooltipUI from "../ui/tooltip";
  import UserAvatar from "../users/UserAvatar.svelte";
  import ReviewDecisionIcon from "./ReviewDecisionIcon.svelte";
  import { reviewerActivity } from "./lib/work-review";

  // The reviewers of a work as a small avatar stack. A current approval or
  // change request rings the avatar faintly in the pull request list's
  // verdict color (emerald, amber); hover lists
  // who decided what, and when.
  let { reviewers, size = 16, max = 3, nameOf = (reviewer) => reviewer.displayName, class: className = "" }: {
    reviewers: WorkReviewerSummary[];
    size?: 14 | 16;
    max?: number;
    /** The name to show; the host's stamped name unless the caller knows a newer one. */
    nameOf?: (reviewer: WorkReviewerSummary) => string;
    class?: string;
  } = $props();
</script>

{#if reviewers.length > 0}
  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props })}
        <span {...props} class="inline-flex shrink-0 items-center -space-x-1 {className}" data-testid="reviewer-avatars">
          {#each reviewers.slice(0, max) as reviewer (reviewer.reviewerId)}
            <UserAvatar
              user={{ id: parseUserKey(reviewer.reviewerId), displayName: nameOf(reviewer) }}
              {size}
              class="ring-1 {reviewer.isStale || !reviewer.decision || reviewer.decision === 'commented'
                ? 'ring-background'
                : reviewer.decision === 'approved'
                  ? 'ring-emerald-600/40 dark:ring-emerald-300/40'
                  : 'ring-amber-600/40 dark:ring-amber-400/40'}"
            />
          {/each}
          {#if reviewers.length > max}
            <span class="pl-1.5 text-(--solus-text-tertiary) tabular-nums">+{reviewers.length - max}</span>
          {/if}
        </span>
      {/snippet}
    </TooltipUI.Trigger>
    <TooltipUI.Content class="flex-col items-start gap-1 py-1">
      {#each reviewers as reviewer (reviewer.reviewerId)}
        <span class="flex items-center gap-1.5">
          <ReviewDecisionIcon decision={reviewer.decision} isStale={reviewer.isStale} size={12} />
          <span>{nameOf(reviewer)}</span>
          <span class="font-normal text-(--solus-text-secondary)">{reviewerActivity(reviewer)}</span>
        </span>
      {/each}
    </TooltipUI.Content>
  </TooltipUI.Root>
{/if}
