<script lang="ts">
  import {
    XIcon,
    ArrowsClockwiseIcon,
    ArrowSquareOutIcon,
    ArrowsOutSimpleIcon,
  } from "phosphor-svelte";
  import type { PaneSlot } from "../../contexts/pane-view.store.svelte";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { getSettingsContext } from "../../contexts/settings.context.svelte";
  import { getAgentContext } from "../../contexts/agent.context.svelte";
  import { formatDiffInlineComments } from "../../contexts/session.utils";
  import { resolveReviewAgent } from "../../lib/reviewAgent";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { tooltip } from "../../lib/tooltip";
  import PendingReviewTray from "../pr-review/PendingReviewTray.svelte";
  import GuideSurface from "./GuideSurface.svelte";
  import { GuideLoader } from "./lib/guide-loader.svelte";
  import { ReviewDrafts } from "./lib/review-drafts.svelte";

  // The standalone guided-review surface (branch "Review changes" + session
  // walkthrough): own header + chrome over a GuideView whose draft comments
  // submit back to the agent as feedback. The PR-review host renders its own
  // chrome and uses GuideLoader/GuideSurface directly.
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

  const loader = new GuideLoader({
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
    getCtx: () => session.ctx,
    getKey: () => guideKey,
  });
  $effect(() => {
    void guideKey;
    void reviewDrafts.load();
  });

  function sendToAgent() {
    if (reviewDrafts.drafts.length === 0) return;
    session.sendMessage(
      `Please address this review feedback on the current changes:\n\n` +
        `Inline comments:\n${formatDiffInlineComments(reviewDrafts.diffComments)}`,
    );
    reviewDrafts.clear();
    requestInputFocus();
  }
</script>

<section class="flex h-full min-h-0 flex-col bg-(--solus-container-bg)">
  <header
    class="flex h-[var(--solus-chrome-row-h,2.5rem)] shrink-0 items-center justify-between border-b border-[color:var(--solus-chrome-row-border,color-mix(in_srgb,var(--solus-container-border)_50%,transparent))] pr-2 pl-[max(1rem,var(--solus-chrome-lead-inset,0px))]"
  >
    <span class="text-[0.8125rem] font-semibold text-(--solus-text-primary)"
      >{scope === "session" ? "Session walkthrough" : "Review guide"}</span
    >
    <div class="inline-flex gap-1">
      {#if onOpenInSplit}
        <button
          class="inline-flex size-7 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-(--solus-text-secondary) transition-[color,background-color] duration-150 ease-in-out hover:bg-(--solus-accent-soft) hover:text-(--solus-accent) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--solus-accent)"
          onclick={onOpenInSplit}
          use:tooltip={slot === "secondary" ? "Move to main pane" : "Open in split"}
          aria-label={slot === "secondary" ? "Move review guide to main pane" : "Open review guide in split"}
        >
          {#if slot === "secondary"}
            <ArrowsOutSimpleIcon size={15} weight="bold" />
          {:else}
            <ArrowSquareOutIcon size={15} weight="bold" />
          {/if}
        </button>
      {/if}
      <button
        class="inline-flex size-7 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-(--solus-text-secondary) transition-[color,background-color] duration-150 ease-in-out hover:bg-(--solus-accent-soft) hover:text-(--solus-accent) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--solus-accent)"
        onclick={() => loader.refresh()}
        use:tooltip={"Regenerate review"}
        aria-label="Regenerate review guide"
      >
        <ArrowsClockwiseIcon size={15} weight="bold" />
      </button>
      <button
        class="inline-flex size-7 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-(--solus-text-secondary) transition-[color,background-color] duration-150 ease-in-out hover:bg-(--solus-accent-soft) hover:text-(--solus-accent) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--solus-accent)"
        onclick={onClose}
        use:tooltip={"Close"}
        aria-label="Close review guide"
      >
        <XIcon size={15} weight="bold" />
      </button>
    </div>
  </header>

  <GuideSurface
    {loader}
    comments={reviewDrafts.diffComments}
    onCommentSave={(c) => reviewDrafts.save(c)}
    onCommentDelete={(id) => reviewDrafts.remove(id)}
  />

  {#if reviewDrafts.drafts.length > 0}
    <PendingReviewTray
      drafts={reviewDrafts.drafts}
      submitLabel="Send to agent"
      onSubmit={sendToAgent}
      onRemove={(id) => reviewDrafts.remove(id)}
    />
  {/if}
</section>
