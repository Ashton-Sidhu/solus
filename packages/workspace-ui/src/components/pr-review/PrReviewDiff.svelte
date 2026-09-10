<script lang="ts">
  import type { HostApi } from "@solus/client-core/host-api";
  import type { IpcContext } from "@solus/contracts/types";
  import type { PrReviewTarget } from "@solus/contracts/providers";
  import type { PaneId } from "../../contexts/workspace/routing/location";
  import type { PrReviewState } from "./lib/pr-review.store.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import DiffPanel from "../diff/DiffPanel.svelte";
  import DiffLoadingSkeleton from "../diff/DiffLoadingSkeleton.svelte";
  import StackDiffBanner from "./StackDiffBanner.svelte";
  import SinceReviewBar from "./SinceReviewBar.svelte";

  let { review, pr, reviewTabId, paneId, getCtx, getApi, projectPath, headless,
    onClose, toggleFullDiff, clearCommitScope, diffPanelRef = $bindable(null),
  }: {
    review: PrReviewState;
    pr: PrReviewTarget;
    reviewTabId: string;
    paneId?: PaneId;
    getCtx: () => IpcContext;
    getApi: () => HostApi;
    projectPath: string;
    headless: boolean;
    onClose: () => void;
    toggleFullDiff: () => void;
    clearCommitScope: () => void;
    diffPanelRef?: DiffPanel | null;
  } = $props();
  const diffViewLoading = $derived(review.commitScope
    ? review.commitDiffLoading && review.commitDiffPatch === null
    : review.diffLoading && review.diffPatch === null);
  const diffViewError = $derived(review.commitScope ? review.commitDiffError : review.diffError);
</script>

{#if !review.commitScope && review.ownDeltaBase}
  <StackDiffBanner
    parent={review.ownDeltaBase.parent}
    fileCount={review.ownDeltaFileCount}
    showingFull={review.showingFullDiff}
    onToggle={toggleFullDiff}
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
  {#if diffViewLoading}
    <DiffLoadingSkeleton variant="diff" />
  {:else if diffViewError}
    <div class="grid h-full place-items-center px-6 text-center text-xs text-destructive" role="alert">
      {diffViewError}
    </div>
  {:else}
  <DiffPanel
    bind:this={diffPanelRef}
    tabId={reviewTabId}
    {paneId}
    getCtx={getCtx}
    {getApi}
    projectPath={review.checkout?.worktreePath ?? projectPath}
    worktreePath={review.checkout?.worktreePath}
    worktreeBranch={pr.headRef}
    targetBranch={pr.baseRef}
    isWorktree={!!review.checkout}
    {onClose}
    embedded
    hasHostHeaderRow={!headless}
    initialScope={review.diffScope}
    commentingDisabled={!!review.commitScope}
    commitSha={review.commitScope?.sha ?? null}
    onClearCommitScope={clearCommitScope}
    patchOverride={review.commitScope
      ? (review.commitDiffPatch ?? "")
      : review.isSinceReviewMode
        ? (review.interdiff?.patch ?? "")
        : (review.diffPatch ?? "")}
    patchOverrideFileLoader={review.commitScope
      ? review.loadCommitDiffFiles
      : review.isSinceReviewMode
        ? undefined
        : review.loadDiffFiles}
    emptyState={review.commitScope
      ? {
          title: "No file changes in this commit",
          description:
            "This commit did not change any reviewable files.",
        }
      : review.isSinceReviewMode
        ? {
            title: "No patch changes since your review",
            description:
              "The PR head moved, but its effective patch stayed the same.",
          }
        : undefined}
    externalComments={review.commitScope ? [] : review.drafts.diffComments}
    onExternalCommentSave={(comment) => review.drafts.save(comment)}
    onExternalCommentDelete={(id) => review.drafts.remove(id)}
    reviewThreads={review.commitScope
      ? []
      : review.isSinceReviewMode
        ? review.sinceReviewThreads
        : review.threads}
    onThreadReply={(threadId, body) => review.replyToThread(threadId, body)}
    onThreadResolve={(threadId, resolved) => review.resolveThread(threadId, resolved)}
  />
  {/if}
</div>
