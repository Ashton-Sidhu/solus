<script lang="ts">
  import { LoaderCircle as CircleNotchIcon } from "@lucide/svelte";
  import type { PullRequest } from "@solus/contracts/providers";
  import type { IpcContext } from "@solus/contracts/types";
  import { Button } from "../ui/button";
  import MergeControl from "./MergeControl.svelte";
  import ResolveConflictsButton from "./ResolveConflictsButton.svelte";
  import type { PrActionsLayout } from "./lib/pr-actions-layout";
  import type { PullRequest as IndexedPullRequest } from "../../contexts/prs/pull-request.svelte";

  // The PR's action cluster, Linear-style: it lives inside the merge card in
  // the right rail, not in the page header. One full-width primary CTA and one
  // quiet full-width row under it. Review guide sits outside this cluster, as
  // its own rail row: it is something to read, not a step in landing the
  // change. The rarely-used actions are in the ⋯ beside the card's headline
  // (see PrOverflowMenu).
  //
  // Below the rail's fold the same cluster is the trailing half of a one-line
  // bar, so the column and its card margin become a row (see lib/pr-actions-layout).
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
    layout = "card",
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
    layout?: PrActionsLayout;
  } = $props();

  const bar = $derived(layout === "bar");

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
     either shouting.

     In the bar the same two tiers run left to right, centred on the bar's own
     line rather than carrying the card's top margin. -->
<div
  class={bar
    ? "flex min-w-0 items-center gap-1.5"
    : "mt-[13px] flex w-full flex-col gap-[7px]"}
>
  {#if showMerge && detail}
    {#if detail.mergeStateStatus === "dirty"}
      <ResolveConflictsButton
        pr={{ number: pr.number, title: pr.title, headSha: detail.headSha }}
        {getCtx}
        {layout}
      />
    {:else}
      <MergeControl
        {pullRequest}
        methods={mergeMethods}
        {onMerged}
        {layout}
      />
    {/if}
  {/if}

  {#if showAddressComments}
    <Button
      variant="ghost"
      disabled={!addressCommentsReady || addressingComments}
      class="flex h-8 min-w-0 cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-[10px] border-0 bg-transparent px-3 font-normal text-muted-foreground shadow-[shadow:var(--elev-ring)] transition-[background-color,color,scale] duration-150 hover:bg-[var(--wash-2)] hover:text-foreground active:scale-[0.985] disabled:opacity-60 {bar
        ? 'shrink pointer-fine:[.is-laptop-display_&]:h-7'
        : 'w-full'}"
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
      <!-- The bar has one line to hold the readiness sentence, Details, and
           the merge control, so the count drops to the title the row already
           carries rather than the label spending it twice. -->
      <span class="truncate tabular-nums">
        {#if bar}
          Send to agent
        {:else}
          Send {feedbackCount} {feedbackCount === 1 ? "comment" : "comments"} to agent
        {/if}
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
