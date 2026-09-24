<script lang="ts">
  import type { ReviewGuideReference } from "@solus/contracts/review";
  import { worktreeProjectRoot } from "@solus/contracts/types";
  import { getAgentContext, getWorkspaceContext } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import { Check as CheckIcon, CircleAlert as WarningCircleIcon, Map as MapIcon } from "@lucide/svelte";
  import TranscriptCard from "../conversation/TranscriptCard.svelte";
  import { reviewGuideStore, type ReviewGuideIdentity } from "./review-guide.store.svelte";
  import { reviewGuideCardPresentation, reviewGuideCardSubtitle } from "./lib/review-guide-card";
  import { reviewGuideTargetLabel } from "./lib/review-guide-reference";

  interface Props {
    ref: ReviewGuideReference;
    tabId: string;
    skipMotion?: boolean;
  }

  let { ref, tabId, skipMotion = false }: Props = $props();
  const workspace = getWorkspaceContext();
  const agents = getAgentContext();
  const conversation = $derived(workspace.sessionFor(tabId));
  const serverId = $derived(workspace.serverIdFor(tabId));
  const identity = $derived.by((): ReviewGuideIdentity | null => {
    const root = conversation?.run.gitContext?.repoRoot ?? conversation?.run.workingDirectory;
    // Identified by target, not by `ref.key`: that key was computed when the
    // tool call was parsed, from whatever branch the renderer could see then —
    // nothing, for a session outside a worktree.
    return root
      ? { repoRoot: worktreeProjectRoot(root), key: ref.key, target: ref.target }
      : null;
  });
  // Read only: the workspace's `startDirectReview` tracked this guide when it
  // queued it, and the store keeps its status through host events and
  // reconnects. The card never asks the host itself.
  const status = $derived(reviewGuideStore.statusFor(serverId, identity));
  const targetLabel = $derived(reviewGuideTargetLabel(ref.target));
  const presentation = $derived(reviewGuideCardPresentation(status));
  const modelLabel = $derived(
    agents.metadata[ref.agent]?.models.find((model) => model.id === ref.model)?.label
      ?? ref.model
      ?? "Default model",
  );
  const subtitle = $derived(
    reviewGuideCardSubtitle(presentation.subtitle, modelLabel, ref.reasoningEffort),
  );
  const isWorking = $derived(status?.status === "queued" || status?.status === "generating");
  const isReady = $derived(status?.status === "ready");
  // A stopped guide says why in the type slot; a live one says what it does.
  const typeWord = $derived(
    isReady
      ? "review guide"
      : presentation.canRetry && status
        ? presentation.subtitle.toLowerCase()
        : presentation.statusLabel.toLowerCase(),
  );

  const isOpen = $derived.by(() => {
    const review = workspace.router.params("review");
    return review?.view === "guide" && review.sourceTabId === tabId;
  });

  function open() {
    if (!conversation || !identity) return;
    if (presentation.canRetry) {
      toasts.info("Started generating the review guide");
      void reviewGuideStore.generate(
        workspace.apiFor(tabId),
        serverId,
        workspace.ctxFor(tabId),
        identity,
        {
          target: ref.target,
          agent: ref.agent,
          model: ref.model,
          reasoningEffort: ref.reasoningEffort,
        },
      ).catch((error) => {
        toasts.error("Couldn't generate the review guide", {
          description: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }
    if (status) {
      // The status target is host-resolved and carries the exact PR base/head.
      // The durable tool input can contain only the portable repository + PR
      // number, which is not enough to load Map or Diff.
      workspace.openReviewGuide(status.target ?? ref.target, tabId, {
        repoRoot: status.repoRoot,
        key: status.key,
        serverId,
      });
    }
  }
</script>

<TranscriptCard
  title={targetLabel}
  type={typeWord}
  actionLabel={presentation.canRetry ? "Retry" : "Open"}
  ariaLabel={`${status?.status === "ready" ? "Open" : "Review"} ${targetLabel.toLowerCase()} guide`}
  onOpen={open}
  open={isOpen}
  failed={status?.status === "failed"}
  glyphClass={isReady ? "is-done" : status?.status === "failed" ? "is-failed" : ""}
  data-testid="review-guide-card"
  {skipMotion}
>
  {#snippet glyph()}
    {#if isWorking}<span class="activity-spinner"></span>
    {:else if isReady}<CheckIcon />
    {:else if presentation.canRetry && status}<WarningCircleIcon />
    {:else}<MapIcon />{/if}
  {/snippet}
  {#snippet menu()}
    <span class="px-2.5 py-1.5 text-transcript-meta text-muted-foreground">{subtitle}</span>
  {/snippet}
</TranscriptCard>
