<script lang="ts">
  import type { ReviewGuideReference } from "@solus/contracts/review";
  import { worktreeProjectRoot } from "@solus/contracts/types";
  import { getWorkspaceContext } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import ConversationRefCard from "../conversation/ConversationRefCard.svelte";
  import TranscriptChip from "../conversation/TranscriptChip.svelte";
  import { reviewGuideStore, type ReviewGuideIdentity } from "./review-guide.store.svelte";
  import { reviewGuideCardPresentation } from "./lib/review-guide-card";
  import { reviewGuideTargetLabel } from "./lib/review-guide-reference";

  interface Props {
    ref: ReviewGuideReference;
    tabId: string;
    skipMotion?: boolean;
  }

  let { ref, tabId, skipMotion = false }: Props = $props();
  const workspace = getWorkspaceContext();
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
  const status = $derived(reviewGuideStore.statusFor(serverId, identity));
  const targetLabel = $derived(reviewGuideTargetLabel(ref.target));
  const presentation = $derived(reviewGuideCardPresentation(status));

  $effect(() => {
    if (!conversation || !identity) return;
    const api = workspace.apiFor(tabId);
    void reviewGuideStore.load(api, serverId, workspace.ctxFor(tabId), identity, ref.target);
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
        { target: ref.target },
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

<ConversationRefCard
  kicker="Review guide"
  title={targetLabel}
  subtitle={presentation.subtitle}
  actionLabel={presentation.canRetry ? "Retry" : "Open"}
  ariaLabel={`${status?.status === "ready" ? "Open" : "Review"} ${targetLabel.toLowerCase()} guide`}
  onOpen={open}
  data-testid="review-guide-card"
  {skipMotion}
>
  {#snippet chip()}
    <TranscriptChip>{presentation.statusLabel}</TranscriptChip>
  {/snippet}
</ConversationRefCard>
