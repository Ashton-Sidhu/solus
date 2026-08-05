<script lang="ts">
  import { ArrowsClockwiseIcon } from "phosphor-svelte";
  import type { GitCheckout } from "../../../shared/types";
  import { getWorkspaceContext, getSettingsContext, getAgentContext } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import { formatDiffInlineComments } from "../../contexts/workspace/session.utils";
  import { resolveReviewAgent } from "../../lib/reviewAgent";
  import { PAGE_ICON_BTN } from "../../lib/page-chrome";
  import * as TooltipUI from "@renderer/components/ui/tooltip";
  import PaneChrome from "../ui/PaneChrome.svelte";
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
    sourceTabId,
    workingDirectory,
    gitContext,
    isLeading = true,
    onOpenInSplit,
    onClose,
  }: {
    guideKey: string;
    scope?: "branch" | "session";
    sourceTabId?: string;
    workingDirectory?: string;
    gitContext?: GitCheckout | null;
    isLeading?: boolean;
    onOpenInSplit?: () => void;
    onClose: () => void;
  } = $props();

  const session = getWorkspaceContext();
  const theme = getSettingsContext();
  const agentContext = getAgentContext();
  const isDemo = document.documentElement.classList.contains("solus-demo");

  const reviewTabId = $derived(sourceTabId ?? session.activeTabId);
  const reviewSession = $derived(session.sessionFor(reviewTabId));
  const reviewWorkingDirectory = $derived(
    workingDirectory ??
      gitContext?.worktreePath ??
      reviewSession?.workingDirectory ??
      session.globalDefaults.workingDirectory,
  );
  const reviewGitContext = $derived(
    gitContext === undefined ? (reviewSession?.gitContext ?? null) : gitContext,
  );
  const reviewCtx = $derived(
    session.ctxForEnvironment(reviewWorkingDirectory, reviewGitContext, reviewTabId),
  );

  const loader = new GuideLoader({
    getApi: () => session.apiFor(reviewTabId),
    getCtx: () => reviewCtx,
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
    getApi: () => session.apiFor(reviewTabId),
    getCtx: () => reviewCtx,
    getKey: () => guideKey,
  });
  $effect(() => {
    void guideKey;
    void reviewDrafts.load();
  });

  let composerNote = $state("");
  let composerRef: ReturnType<typeof PromptComposer> | null = $state(null);
  let composerCollapsed = $state(true);
  let submitting = $state(false);

  async function sendToAgent(payload: PromptComposerSubmit) {
    const hasDrafts = reviewDrafts.drafts.length > 0;
    if ((!hasDrafts && !payload.text) || submitting) return;

    const parts = [`Please address this review feedback on the current changes:`];
    if (payload.text) parts.push(payload.text);
    if (hasDrafts) {
      parts.push(`Inline comments:\n${formatDiffInlineComments(reviewDrafts.diffComments)}`);
    }
    submitting = true;
    try {
      const newTabId = await session.createTab(reviewWorkingDirectory, {
        activate: false,
        gitContext: reviewGitContext,
        worktreeRequested: false,
      });
      const newSession = session.sessionFor(newTabId);
      if (newSession) {
        newSession.provider = payload.provider;
        newSession.modelConfig.modelId = payload.modelId;
        newSession.modelConfig.reasoningEffort = payload.reasoningEffort;
      }
      const newTab = session.tabs[newTabId];
      if (newTab) {
        newTab.input.planRefs = [...payload.planRefs];
        newTab.input.workRefs = [...payload.workRefs];
      }
      session.sendMessage(parts.join("\n\n"), undefined, newTabId);
      composerRef?.clear();
      reviewDrafts.clear();
      toasts.success("Feedback sent to an agent", {
        action: {
          label: "Open session",
          onAction: () => session.selectTab(newTabId),
        },
      });
    } catch (error) {
      toasts.error(
        `Couldn't start a feedback session: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      submitting = false;
    }
  }
</script>

<section class="relative flex h-full min-h-0 flex-col bg-(--solus-container-bg)">
  <PaneChrome
    {onClose}
    {onOpenInSplit}
    {isLeading}
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

  {#if !loader.loading && loader.guide}
    <div
      class={composerCollapsed
        ? "absolute bottom-2.5 left-4 z-20"
        : "shrink-0 bg-(--solus-container-bg) px-4 pt-2.5 pb-2.5"}
    >
      <div class={composerCollapsed ? "" : "mx-auto w-full max-w-[92rem] 2xl:max-w-[104rem]"}>
        <PromptComposer
          bind:this={composerRef}
          bind:value={composerNote}
          bind:collapsed={composerCollapsed}
          tabId={reviewTabId}
          workingDirectory={reviewWorkingDirectory}
          canSubmitWhenEmpty={reviewDrafts.drafts.length > 0}
          onSubmit={sendToAgent}
          {submitting}
          placeholder="Add feedback for the agent…"
        />
      </div>
    </div>
  {/if}
</section>
