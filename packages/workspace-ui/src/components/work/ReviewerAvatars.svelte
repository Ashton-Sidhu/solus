<script lang="ts">
  import { parseUserKey } from "@solus/contracts/user";
  import type { WorkReviewerSummary } from "@solus/contracts/work-review";
  import { AvatarBadge } from "../ui/avatar-badge";
  import * as TooltipUI from "../ui/tooltip";
  import UserAvatar from "../users/UserAvatar.svelte";
  import ReviewDecisionIcon from "./ReviewDecisionIcon.svelte";
  import { isVerdict, reviewerActivity } from "./lib/work-review";

  // The reviewers of a work as a small avatar row. A current approval or
  // change request sits on that reviewer's avatar as a badge in the pull
  // request list's verdict color, so the mark names who gave it; hover lists
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
        <!-- Spaced rather than overlapped: a badge hangs past its avatar's rim
             and must not slide under the next face. -->
        <span {...props} class="inline-flex shrink-0 items-center gap-1.5 {className}" data-testid="reviewer-avatars">
          {#each reviewers.slice(0, max) as reviewer (reviewer.reviewerId)}
            {#snippet verdict()}
              <ReviewDecisionIcon decision={reviewer.decision} size={10} />
            {/snippet}
            <AvatarBadge badge={isVerdict(reviewer) ? verdict : undefined}>
              <UserAvatar user={{ id: parseUserKey(reviewer.reviewerId), displayName: nameOf(reviewer) }} {size} />
            </AvatarBadge>
          {/each}
          {#if reviewers.length > max}
            <span class="text-(--solus-text-tertiary) tabular-nums">+{reviewers.length - max}</span>
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
