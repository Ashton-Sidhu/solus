<script lang="ts">
  import { CircleAlert, CircleCheck, Clock, MessageSquareText } from "@lucide/svelte";
  import type { WorkReviewDecision } from "@solus/contracts/work-review";
  import { PR_VERDICT_TONE } from "../prs/lib/pr-row-styles";

  // A decision as an icon, in the verdict colors of the pull request list.
  // No decision reads as waiting; a stale decision keeps its shape but loses
  // its color, so it does not read as a verdict on the current body.
  let { decision, isStale = false, size = 14, class: className = "" }: {
    decision: WorkReviewDecision | null;
    isStale?: boolean;
    size?: number;
    class?: string;
  } = $props();

  const Icon = $derived(decision === "approved" ? CircleCheck : decision === "changes_requested" ? CircleAlert : decision === "commented" ? MessageSquareText : Clock);
</script>

<Icon
  {size}
  aria-hidden="true"
  class="shrink-0 {isStale || !decision || decision === 'commented' ? 'text-(--solus-text-tertiary)' : decision === 'approved' ? PR_VERDICT_TONE.approved : PR_VERDICT_TONE['changes-requested']} {className}"
/>
