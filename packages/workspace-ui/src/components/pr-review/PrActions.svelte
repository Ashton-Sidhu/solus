<script lang="ts">
  import { LoaderCircle as CircleNotchIcon } from "@lucide/svelte";
  import type { PullRequest } from "@solus/contracts/providers";
  import { toasts } from "../../lib/toasts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Button } from "../ui/button";
  import MergeControl from "./MergeControl.svelte";
  import type { MergeAction } from "./lib/merge-readiness";
  import type { PrActionsLayout } from "./lib/pr-actions-layout";
  import type { PullRequest as IndexedPullRequest } from "../../contexts/prs/pull-request.svelte";

  // The PR's action cluster, Linear-style: it lives inside the status card in
  // the right rail, not in the page header. One full-width primary CTA — the
  // move the shared readiness model chose — and one quiet full-width row under
  // it. The rarely-used actions are in the ⋯ beside the card's headline (see
  // PrOverflowMenu).
  //
  // Once the rail folds into the reading column the same cluster is the
  // trailing half of the card's one line, so the column and its card margin
  // become a row (see lib/pr-actions-layout).
  let {
    pullRequest,
    detail,
    action,
    onAction,
    feedbackCount = 0,
    addressCommentsReady = true,
    addressingComments = false,
    onAddressComments,
    onMerged,
    layout = "card",
  }: {
    /** The indexed pull request, for the merge that changes it. */
    pullRequest: IndexedPullRequest;
    detail: PullRequest | null;
    /** The move the shared readiness model chose; null when the next step is
     *  someone else's. The merge has a control of its own here; every other
     *  move is one button that runs through `onAction`. */
    action: MergeAction | null;
    onAction: (action: MergeAction) => Promise<void>;
    feedbackCount?: number;
    addressCommentsReady?: boolean;
    addressingComments?: boolean;
    onAddressComments?: () => void;
    onMerged?: () => void;
    layout?: PrActionsLayout;
  } = $props();

  const row = $derived(layout === "row");

  // Every action here is gated on the PR still being open, so a merged or
  // closed PR renders nothing at all rather than an empty cluster.
  const showAddressComments = $derived(
    !!onAddressComments &&
      feedbackCount > 0 &&
      detail?.state === "open" &&
      !detail.draft &&
      !detail.headRepo.isFork,
  );
  // The cluster owns its own top margin: a PR with nothing to do has none of
  // these actions, and an empty wrapper still held a gap inside the card.
  const hasActions = $derived(!!action || showAddressComments);

  let running = $state(false);

  async function run(move: MergeAction) {
    if (running) return;
    running = true;
    try {
      await onAction(move);
    } catch (error) {
      toasts.error("Couldn't run the pull request action", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      running = false;
      requestInputFocus();
    }
  }
</script>

{#if hasActions}
<!-- One saturated button and one quiet one: the tiers are set by how much
     surface each carries, so the eye lands on the merge decision first without
     either shouting.

     In the row the same two tiers run left to right, centred on the card's
     own line rather than carrying the stacked top margin. -->
<div
  class={row
    ? "flex min-w-0 items-center gap-1.5"
    : "mt-[13px] flex w-full flex-col gap-[7px]"}
>
  {#if action?.kind === "merge" && detail}
    <MergeControl
      {pullRequest}
      methods={detail.capabilities.mergeMethods}
      method={action.method}
      {onMerged}
      {layout}
    />
  {:else if action}
    <!-- The same saturated tier as the merge button: this is the one move the
         card asks for, whether it runs on the host or opens a session. A
         conflict is the one move painted in the blocker's own colour. -->
    <Button
      type="button"
      disabled={running}
      class="flex min-w-0 cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-[10px] border-0 px-3.5 font-medium transition-[background-color,scale] duration-150 active:scale-[0.985] disabled:cursor-not-allowed disabled:opacity-60 {action.kind ===
      'resolve-conflicts'
        ? 'bg-(--solus-art-negative) text-white hover:bg-[color-mix(in_oklch,var(--solus-art-negative)_88%,var(--foreground))] focus-visible:ring-[color:color-mix(in_srgb,var(--solus-art-negative)_28%,transparent)]'
        : 'bg-primary text-primary-foreground shadow-[0_1px_2px_-1px_color-mix(in_oklch,var(--primary)_55%,transparent)] hover:bg-primary/90'} {row
        ? 'h-8 shrink-0 pointer-fine:[.is-laptop-display_&]:h-7'
        : 'h-[34px] w-full'}"
      title={action.kind === "mark-ready"
        ? "Mark the pull request ready for review"
        : action.kind === "resolve-conflicts"
          ? "Open an agent session to resolve the merge conflicts"
          : "Open a new session composer with the fix drafted"}
      onclick={() => run(action)}
    >
      {#if running}
        <CircleNotchIcon
          size={14}
          class="shrink-0 animate-spin [animation-duration:0.9s]"
        />
      {/if}
      <span class="truncate">{running ? "Working…" : action.label}</span>
    </Button>
  {/if}

  {#if showAddressComments}
    <Button
      variant="ghost"
      disabled={!addressCommentsReady || addressingComments}
      class="flex h-8 min-w-0 cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-[10px] border-0 bg-transparent px-3 font-normal text-muted-foreground shadow-[shadow:var(--elev-ring)] transition-[background-color,color,scale] duration-150 hover:bg-[var(--wash-2)] hover:text-foreground active:scale-[0.985] disabled:opacity-60 {row
        ? 'shrink pointer-fine:[.is-laptop-display_&]:h-7'
        : 'w-full'}"
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
      <!-- The row has one line to hold the readiness sentence and the merge
           control, so the count drops to the title the button already carries
           rather than the label spending it twice. -->
      <span class="truncate tabular-nums">
        {#if row}
          Draft fix
        {:else}
          Draft fix for {feedbackCount} {feedbackCount === 1 ? "comment" : "comments"}
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
