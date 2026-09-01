<script lang="ts">
  import { LoaderCircle as CircleNotchIcon } from "@lucide/svelte";
  import type { PullRequest } from "@solus/contracts/providers";
  import type { IpcContext } from "@solus/contracts/types";
  import { Button } from "../ui/button";
  import MergeControl from "./MergeControl.svelte";
  import ResolveConflictsButton from "./ResolveConflictsButton.svelte";
  import type { PullRequest as IndexedPullRequest } from "../../contexts/prs/pull-request.svelte";

  // The PR's action cluster, Linear-style: it lives inside the merge card in
  // the right rail, not in the page header. One full-width primary CTA and one
  // quiet full-width row under it. Review guide sits outside this cluster, as
  // its own rail row: it is something to read, not a step in landing the
  // change. The rarely-used actions are in the ⋯ beside the card's headline
  // (see PrOverflowMenu).
  let {
    pr,
    pullRequest,
    detail,
    feedbackCount = 0,
    addressCommentsReady = true,
    addressingComments = false,
    onAddressComments,
    getCtx,
    onMerged,
  }: {
    pr: { number: number; title: string };
    /** The indexed pull request, for the actions that change it. */
    pullRequest: IndexedPullRequest;
    detail: PullRequest | null;
    feedbackCount?: number;
    addressCommentsReady?: boolean;
    addressingComments?: boolean;
    onAddressComments?: () => void;
    getCtx: () => IpcContext;
    onMerged?: () => void;
  } = $props();

  // Every action here is gated on the PR still being open, so a draft, merged,
  // or closed PR renders nothing at all rather than an empty cluster.
  const showAddressComments = $derived(
    !!onAddressComments &&
      feedbackCount > 0 &&
      detail?.state === "open" &&
      !detail.draft &&
      !detail.headRepo.isFork,
  );
  const allowedActions = $derived(new Set(detail?.viewerPermissions.actions ?? []));
  const mergeMethods = $derived(detail?.capabilities.mergeMethods ?? []);
  const canMerge = $derived(
    !!detail &&
      detail.capabilities.actions.includes("merge") &&
      allowedActions.has("merge") &&
      mergeMethods.length > 0,
  );
  const showMerge = $derived(
    detail?.state === "open" && !detail.draft && canMerge,
  );
  // The cluster owns its own top margin: a draft has none of these actions, and
  // an empty wrapper still held a gap inside the card.
  const hasActions = $derived(showMerge || showAddressComments);
</script>

{#if hasActions}
<!-- One saturated button and one quiet one: the tiers are set by how much
     surface each carries, so the eye lands on the merge decision first without
     either shouting. -->
<div class="mt-[13px] flex w-full flex-col gap-[7px]">
  {#if showMerge && detail}
    {#if detail.mergeStateStatus === "dirty"}
      <ResolveConflictsButton
        pr={{ number: pr.number, title: pr.title, headSha: detail.headSha }}
        {getCtx}
      />
    {:else}
      <MergeControl
        {pullRequest}
        methods={mergeMethods}
        {onMerged}
      />
    {/if}
  {/if}

  {#if showAddressComments}
    <Button
      variant="ghost"
      disabled={!addressCommentsReady || addressingComments}
      class="flex h-8 w-full min-w-0 cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-[10px] border-0 bg-transparent px-3 font-normal text-muted-foreground shadow-[shadow:var(--elev-ring)] transition-[background-color,color,scale] duration-150 hover:bg-[var(--wash-2)] hover:text-foreground active:scale-[0.985] disabled:opacity-60"
      title={addressingComments
        ? "Opening fix agent…"
        : addressCommentsReady
          ? `Send ${feedbackCount} ${feedbackCount === 1 ? "comment" : "comments"} to an agent`
          : "Preparing the PR worktree…"}
      onclick={onAddressComments}
    >
      <!-- The stack is typographic: no leading glyph on a full-width labelled
           row, and the spinner only while the agent is actually opening. -->
      {#if addressingComments}
        <CircleNotchIcon
          size={14}
          class="shrink-0 animate-spin [animation-duration:0.9s]"
        />
      {/if}
      <span class="truncate tabular-nums">
        Send {feedbackCount} {feedbackCount === 1 ? "comment" : "comments"} to agent
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
