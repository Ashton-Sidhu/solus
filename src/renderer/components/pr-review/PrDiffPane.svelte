<script lang="ts">
  import { tick } from "svelte";
  import type { PrReviewTarget } from "../../../shared/providers";
  import { getWorkspaceContext } from "../../contexts";
  import type { RouteSurfaceProps } from "../ui/lib/pane-surface";
  import { paneActions } from "../ui/lib/pane-actions.svelte";
  import PaneChrome from "../ui/PaneChrome.svelte";
  import DiffPanel from "../diff/DiffPanel.svelte";
  import SinceReviewBar from "./SinceReviewBar.svelte";
  import StackDiffBanner from "./StackDiffBanner.svelte";
  import { existingPrReviewState } from "./lib/pr-review.store.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { serverConnections } from "@client-core/server-connections";

  // The review's change, popped out beside it. Reading a diff is a two-handed
  // job — the conversation on one side, the code on the other — so this is a
  // pane rather than a tab that would replace what you were reading.
  //
  // It owns no review data of its own: threads, draft comments, the interdiff
  // and the diff base all come from the shared `PrReviewState` the review pane
  // filled. Two `ReviewDrafts` over one review-state file would silently
  // diverge, and a comment written here has to be one the review submits.
  let { params, paneId }: RouteSurfaceProps<"prDiff"> = $props();

  const session = getWorkspaceContext();
  const pane = paneActions(paneId);

  // Never created here: this pane exists only alongside a review that already
  // opened, and state it invented would have no worktree to read.
  const reviewServerId = $derived(
    session.router.params("prReview")?.serverId ??
      serverConnections.serverIdForApi(serverConnections.primaryApi()),
  );
  const review = $derived(existingPrReviewState(reviewServerId, params.cwd ?? "", params.number));
  const pr = $derived<PrReviewTarget | null>(review?.pr ?? null);
  const checkout = $derived(review?.checkout ?? null);

  const reviewTabId = `pr-diff-${params.number}`;

  let diffPanelRef: DiffPanel | null = $state(null);

  // A jump asked for while this pane was still opening. `epoch` is what makes
  // asking for the same file twice move the panel again.
  let consumedJump = $state(0);
  $effect(() => {
    const jump = review?.pendingJump;
    if (!jump || !pr || jump.epoch === consumedJump) return;
    consumedJump = jump.epoch;
    void tick().then(() => diffPanelRef?.navigateTo(jump.path, jump.line, jump.side));
  });

  function close() {
    session.closePrDiff();
    requestInputFocus();
  }
</script>

<PaneChrome
  onClose={close}
  onToggleMaximize={pane.toggleMaximize}
  maximized={pane.maximized}
  isLeading={pane.isLeading}
  closeLabel="Close diff"
/>

{#if review && pr}
  <div class="flex h-full min-h-0 flex-col">
    {#if review.ownDeltaBase}
      <StackDiffBanner
        parent={review.ownDeltaBase.parent}
        fileCount={review.ownDeltaFileCount}
        showingFull={review.showingFullDiff}
        onToggle={() => (review.showingFullDiff = !review.showingFullDiff)}
      />
    {:else if review.hasReviewCheckpointNotice && review.interdiff}
      <SinceReviewBar
        result={review.interdiff}
        showingSince={review.isSinceReviewMode}
        onModeChange={(sinceReview) => {
          review.showingSinceReview = sinceReview;
          requestInputFocus();
        }}
      />
    {/if}
    <div class="min-h-0 flex-1">
      {#if review.diffLoading && review.diffPatch === null}
        <div class="grid h-full place-items-center text-xs text-muted-foreground" role="status">Loading pull request diff…</div>
      {:else if review.diffError}
        <div class="grid h-full place-items-center px-6 text-center text-xs text-destructive" role="alert">{review.diffError}</div>
      {:else}
      <DiffPanel
        bind:this={diffPanelRef}
        tabId={reviewTabId}
        getCtx={() => review.ctx}
        getApi={() => review.api}
        projectPath={checkout?.worktreePath ?? params.cwd ?? review.ctx.session.projectPath ?? review.ctx.session.workingDirectory}
        worktreePath={checkout?.worktreePath}
        worktreeBranch={pr.headRef}
        targetBranch={pr.baseRef}
        isWorktree={!!checkout}
        onClose={close}
        embedded
        onToggleMaximize={pane.toggleMaximize}
        initialScope={review.diffScope}
        patchOverride={review.isSinceReviewMode ? (review.interdiff?.patch ?? "") : (review.diffPatch ?? "")}
        patchOverrideFileLoader={review.isSinceReviewMode ? undefined : review.loadDiffFiles}
        emptyState={review.isSinceReviewMode
          ? {
              title: "No patch changes since your review",
              description: "The PR head moved, but its effective patch stayed the same.",
            }
          : undefined}
        externalComments={review.drafts.diffComments}
        onExternalCommentSave={(comment) => review.drafts.save(comment)}
        onExternalCommentDelete={(id) => review.drafts.remove(id)}
        reviewThreads={review.isSinceReviewMode ? review.sinceReviewThreads : review.threads}
        onThreadReply={(threadId, body) => review.replyToThread(threadId, body)}
        onThreadResolve={(threadId, resolved) => review.resolveThread(threadId, resolved)}
      />
      {/if}
    </div>
  </div>
{:else}
  <!-- The waiting state still draws the chrome row. DiffPanel's toolbar supplies
       it once the checkout lands, and without a stand-in here the seam between
       this pane and the review's band simply stops at the divider — the header
       line breaks in half while the diff is on its way. -->
  <div class="flex h-full min-h-0 flex-col">
    <div
      class="h-(--solus-chrome-row-h,2.5rem) shrink-0 border-b border-[var(--solus-container-border)]"
      aria-hidden="true"
    ></div>
    <div class="grid min-h-0 flex-1 place-items-center text-xs text-muted-foreground" role="status">
      Loading this pull request…
    </div>
  </div>
{/if}
