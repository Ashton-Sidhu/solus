<script lang="ts">
  import { ArrowsClockwiseIcon } from "phosphor-svelte";
  import type { PaneSlot } from "../../contexts/workspace/pane-view.store.svelte";
  import { getWorkspaceContext, getSettingsContext, getAgentContext, getStatusBarContext } from "../../contexts";
  import { formatDiffInlineComments } from "../../contexts/workspace/session.utils";
  import { resolveReviewAgent } from "../../lib/reviewAgent";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { PAGE_ICON_BTN } from "../../lib/page-chrome";
  import * as TooltipUI from "@renderer/components/ui/tooltip";
  import PaneChrome from "../ui/PaneChrome.svelte";
  import PendingReviewTray from "../pr-review/PendingReviewTray.svelte";
  import { PromptComposer, type PromptComposerSubmit } from "../ui/prompt-composer";
  import GuideSurface from "./GuideSurface.svelte";
  import { GuideLoader } from "./lib/guide-loader.svelte";
  import { ReviewDrafts } from "./lib/review-drafts.svelte";

  // The standalone guided-review surface (branch "Review changes" + session
  // walkthrough): a GuideView whose draft comments submit back to the agent as
  // feedback. Its heading is the guide's own content — the only chrome is the
  // pane cluster, which carries Regenerate as its trailing action. The PR-review
  // host uses GuideLoader/GuideSurface directly.
  let {
    guideKey,
    scope = "branch",
    slot = "primary",
    onOpenInSplit,
    onClose,
  }: {
    guideKey: string;
    scope?: "branch" | "session";
    slot?: PaneSlot;
    onOpenInSplit?: () => void;
    onClose: () => void;
  } = $props();

  const session = getWorkspaceContext();
  const theme = getSettingsContext();
  const agentContext = getAgentContext();
  const statusBar = getStatusBarContext();
  const isDemo = document.documentElement.classList.contains("solus-demo");

  const loader = new GuideLoader({
    getApi: () => session.apiFor(session.activeTabId),
    getCtx: () => session.ctx,
    getKey: () => guideKey,
    getScope: () => scope,
    getAgent: () => resolveReviewAgent(theme, agentContext),
  });

  // Refetch whenever the key changes (the pane is reused across branches).
  $effect(() => {
    void guideKey;
    void loader.load(false);
  });

  // Inline draft comments on the guide's diff cards. Unlike the PR review
  // surface (drafts → GitHub review), these submit back to the agent as
  // feedback on the change, closing the review → fix loop.
  const reviewDrafts = new ReviewDrafts({
    getApi: () => session.apiFor(session.activeTabId),
    getCtx: () => session.ctx,
    getKey: () => guideKey,
  });
  $effect(() => {
    void guideKey;
    void reviewDrafts.load();
  });

  let composerNote = $state("");
  let composerRef: ReturnType<typeof PromptComposer> | null = $state(null);
  let composerCollapsed = $state(true);
  const sess = $derived(session.sessionFor(session.activeTabId));
  const tab = $derived(session.tabs[session.activeTabId]);

  function sendToAgent(payload: PromptComposerSubmit) {
    const hasDrafts = reviewDrafts.drafts.length > 0;
    if (!hasDrafts && !payload.text) return;

    const current = statusBar.ctxFor(session.activeTabId);
    if (
      payload.modelId !== (current.model || null) ||
      payload.reasoningEffort !== current.reasoningEffort
    ) {
      session.updateModelConfig({
        modelId: payload.modelId,
        reasoningEffort: payload.reasoningEffort,
      });
    }

    const parts = [`Please address this review feedback on the current changes:`];
    if (payload.text) parts.push(payload.text);
    if (hasDrafts) {
      parts.push(`Inline comments:\n${formatDiffInlineComments(reviewDrafts.diffComments)}`);
    }
    if (tab) {
      tab.input.planRefs = [...payload.planRefs];
      tab.input.workRefs = [...payload.workRefs];
    }
    session.sendMessage(parts.join("\n\n"));
    composerRef?.clear();
    reviewDrafts.clear();
    onClose();
    requestInputFocus();
  }
</script>

<section class="relative flex h-full min-h-0 flex-col bg-(--solus-container-bg)">
  <PaneChrome
    {onClose}
    {onOpenInSplit}
    {slot}
    closeLabel="Close review guide"
  >
    {#snippet trailing()}
      {#if !isDemo}
        <TooltipUI.Root>
          <TooltipUI.Trigger>
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                class={PAGE_ICON_BTN}
                onclick={() => loader.refresh()}
                aria-label="Regenerate review guide"
              >
                <ArrowsClockwiseIcon size={15} />
              </button>
            {/snippet}
          </TooltipUI.Trigger>
          <TooltipUI.Content value={"Regenerate review"} />
        </TooltipUI.Root>
      {/if}
    {/snippet}
  </PaneChrome>

  <GuideSurface
    {loader}
    comments={reviewDrafts.diffComments}
    onCommentSave={(c) => reviewDrafts.save(c)}
    onCommentDelete={(id) => reviewDrafts.remove(id)}
  />

  {#if reviewDrafts.drafts.length > 0}
    <PendingReviewTray
      drafts={reviewDrafts.drafts}
      onRemove={(id) => reviewDrafts.remove(id)}
    />
  {/if}

  {#if !loader.loading && loader.guide}
    <div
      class={composerCollapsed
        ? "absolute bottom-3 left-3 z-20"
        : "shrink-0 bg-(--solus-container-bg) px-3 pt-2 pb-3"}
    >
      <PromptComposer
        bind:this={composerRef}
        bind:value={composerNote}
        bind:collapsed={composerCollapsed}
        tabId={session.activeTabId}
        workingDirectory={sess?.workingDirectory}
        canSubmitWhenEmpty={reviewDrafts.drafts.length > 0}
        onSubmit={sendToAgent}
        placeholder="Add feedback for the agent…"
      />
    </div>
  {/if}
</section>
