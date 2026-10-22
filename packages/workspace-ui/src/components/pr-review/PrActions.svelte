<script lang="ts">
  import { LoaderCircle as CircleNotchIcon } from "@lucide/svelte";
  import type { PullRequest } from "@solus/contracts/providers";
  import { Button } from "../ui/button";
  import PrPrimaryAction from "./PrPrimaryAction.svelte";
  import type { MergeAction, MergeReadiness } from "./lib/merge-readiness";
  import type { PullRequest as IndexedPullRequest } from "../../contexts/prs/pull-request.svelte";

  // The PR's action cluster, Linear-style: it lives inside the status card in
  // the right rail. The pull request's one move (PrPrimaryAction) leads it, so
  // the card says what it will do right under the state it changes. Under it,
  // one quiet full-width row. The
  // rarely-used actions are in the pull request's ⋯ in the chrome band (see
  // PrOverflowMenu).
  //
  // Once the rail folds into the reading column the card is not drawn: the
  // pull request's move rides in the chrome band instead (PrReviewPane).
  let {
    pullRequest,
    detail,
    readiness,
    onAgentAction,
    feedbackCount = 0,
    addressCommentsReady = true,
    addressingComments = false,
    onAddressComments,
  }: {
    /** The indexed pull request, which the host moves write through. */
    pullRequest: IndexedPullRequest;
    detail: PullRequest | null;
    readiness: MergeReadiness;
    onAgentAction: (action: MergeAction) => Promise<void>;
    feedbackCount?: number;
    addressCommentsReady?: boolean;
    addressingComments?: boolean;
    onAddressComments?: () => void;
  } = $props();

  // Every action here is gated on the PR still being open, so a merged or
  // closed PR renders nothing at all rather than an empty cluster.
  const showAddressComments = $derived(
    !!onAddressComments &&
      feedbackCount > 0 &&
      detail?.state === "open" &&
      !detail.draft &&
      !detail.headRepo.isFork,
  );
  // A merged or closed pull request has no move; the card's headline already
  // says so, and an empty wrapper would still hold a gap inside the card.
  const hasActions = $derived(
    readiness.key !== "merged" && readiness.key !== "closed",
  );
</script>

{#if hasActions}
<!-- One saturated button and one quiet one: the tiers are set by how much
     surface each carries, so the eye lands on the merge decision first without
     either shouting. -->
<div class="mt-[13px] flex w-full flex-col gap-[7px]">
  <PrPrimaryAction
    number={pullRequest.number}
    {pullRequest}
    {readiness}
    {onAgentAction}
  />

  {#if showAddressComments}
    <Button
      variant="ghost"
      disabled={!addressCommentsReady || addressingComments}
      class="flex h-8 min-w-0 cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-[10px] border-0 bg-transparent px-3 font-normal text-muted-foreground shadow-[shadow:var(--elev-ring)] transition-[background-color,color,scale] duration-150 hover:bg-[var(--wash-2)] hover:text-foreground active:scale-[0.985] disabled:opacity-60 w-full"
      title={addressingComments
        ? "Preparing fix draft…"
        : addressCommentsReady
          ? `Draft a fix for ${feedbackCount} ${feedbackCount === 1 ? "comment" : "comments"}`
          : "Preparing the PR worktree…"}
      onclick={onAddressComments}
    >
      {#if addressingComments}
        <CircleNotchIcon
          size={14}
          class="shrink-0 animate-spin [animation-duration:0.9s]"
        />
      {/if}
      <span class="truncate tabular-nums">
        Draft fix for {feedbackCount} {feedbackCount === 1 ? "comment" : "comments"}
      </span>
    </Button>
  {/if}

  <!-- No footnote naming the merge method. The button itself reads "Merge pull
       request" / "Squash and merge" / "Rebase and merge" and changes with the
       method you pick in its own menu, so "Merges as a merge commit" restated
       the control directly above it; the base branch it named is already the
       right-hand ref in the meta band under the title. -->
</div>
{/if}
