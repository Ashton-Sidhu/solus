<script lang="ts">
  import { GitFork as GitForkIcon, MessagesSquare as ChatsIcon } from "@lucide/svelte";
  import { PromptComposer, type PromptComposerSubmit } from "../ui/prompt-composer";
  import { getWorkspaceContext, getStatusBarContext } from "../../contexts";
  import * as TooltipUI from "@solus/workspace-ui/components/ui/tooltip";
  import type { DiffComment, GitCheckout } from "@solus/contracts/types";

  interface Props {
    /** Tab that owns the queued comments and receives current-session feedback. */
    tabId?: string;
    /** Currently-viewed file — used for "Send to new session" context. */
    filePath?: string | null;
    /** Raw diff for the current scope. */
    diffText?: string;
    /** "feature/x vs main" — optional branch context for the fresh-session prompt. */
    branchContext?: string;
    /** Called after a successful submit so the parent can close the diff panel. */
    onSubmitted?: () => void;
    /** Called before sending — lets the parent auto-save any pending inline comment. */
    beforeSend?: () => void;
    /** If the parent has an in-progress (typed but unsaved) inline comment, bump the count. */
    pendingInlineDraft?: boolean;
    /** Feedback for a detached review target must start a fresh session. The
     *  current-session button is hidden because that conversation does not own
     *  the reviewed change. */
    feedbackToNewSession?: boolean;
    /** Checkout and host for a detached review's fresh feedback session. */
    feedbackSessionTarget?: {
      workingDirectory: string;
      gitContext: GitCheckout | null;
      serverId?: string;
    };
  }

  let {
    tabId,
    filePath = null,
    diffText = "",
    branchContext,
    onSubmitted,
    beforeSend,
    pendingInlineDraft = false,
    feedbackToNewSession = false,
    feedbackSessionTarget,
  }: Props = $props();

  const session = getWorkspaceContext();
  const statusBar = getStatusBarContext();
  const targetTabId = $derived(tabId ?? session.activeTabId);
  const tab = $derived(session.tabs[targetTabId]);
  const sess = $derived(session.sessionFor(targetTabId));
  const diffComments = $derived<DiffComment[]>(sess?.diffComments ?? []);
  const generalComment = $derived(sess?.diffGeneralComment ?? "");

  let submitting = $state(false);
  let composerRef: ReturnType<typeof PromptComposer> | null = $state(null);
  let useWorktree = $state(false);
  let collapsed = $state(true);
  // The bar used to carry two send buttons — an arrow that replied here and a
  // split arrow that opened a fresh session — so the destination was a property
  // of *which button you hit*. One send, and the destination is a state you can
  // see and change before you press it. ⌘⇧↵ still forces a new session, so the
  // one-keystroke path did not get longer.
  let startNewSession = $state(false);
  const toNewSession = $derived(feedbackToNewSession || startNewSession);

  // A fresh session can be given its own checkout, so the worktree choice only
  // means something on that path — offer it whenever the source is a real repo
  // that isn't already inside a worktree.
  const showWorktree = $derived(
    toNewSession && !!sess?.run.gitContext && !sess.run.gitContext.worktreePath,
  );

  const inlineCount = $derived(
    diffComments.length + (pendingInlineDraft ? 1 : 0),
  );
  let previousInlineCount = 0;
  $effect(() => {
    const count = inlineCount;
    if (count > previousInlineCount) collapsed = false;
    previousInlineCount = count;
  });
  // When sending is enabled purely by queued comments (empty message), the
  // generic "Reply…" placeholder hides what the send button will actually do.
  const placeholder = $derived.by(() => {
    const n = diffComments.length;
    if (n > 0 && generalComment.trim().length === 0) {
      return `Send ${n} comment${n === 1 ? "" : "s"} — add an optional note…`;
    }
    return toNewSession ? "Send to a new session…" : "Reply to the agent…";
  });

  /** Composer picks that differ from the session's effective config. */
  function changedConfig(payload: PromptComposerSubmit) {
    const current = statusBar.ctxFor(targetTabId);
    const providerChanged = payload.provider !== current.activeAgent;
    const modelChanged = payload.modelId !== (current.model || null);
    const effortChanged = payload.reasoningEffort !== current.reasoningEffort;
    const fastModeChanged = payload.fastMode !== current.fastMode;
    return { providerChanged, changed: modelChanged || effortChanged || fastModeChanged };
  }

  function applyRefs(payload: PromptComposerSubmit) {
    if (!tab) return;
    const prompt = session.inputFor(tab.id);
    prompt.planRefs = [...payload.planRefs];
    prompt.workRefs = [...payload.workRefs];
  }

  function handleSend(payload: PromptComposerSubmit) {
    if (submitting) return;
    beforeSend?.();
    submitting = true;
    if (changedConfig(payload).changed) {
      session.updateModelConfig(
        {
          modelId: payload.modelId,
          reasoningEffort: payload.reasoningEffort,
          fastMode: payload.fastMode,
        },
        targetTabId,
      );
    }
    applyRefs(payload);
    const sent = session.submitDiffFeedback(payload.text, targetTabId);
    submitting = false;
    if (sent) {
      composerRef?.clear();
      onSubmitted?.();
    }
  }

  async function handleSendToNewSession(payload: PromptComposerSubmit) {
    if (submitting) return;
    beforeSend?.();
    submitting = true;
    const { providerChanged, changed } = changedConfig(payload);
    applyRefs(payload);
    const sent = await session.submitDiffFeedbackToNewSession({
      generalComment: payload.text,
      filePath,
      diffText,
      branchContext,
      provider: providerChanged ? payload.provider : undefined,
      modelConfig: changed || providerChanged
        ? { modelId: payload.modelId, reasoningEffort: payload.reasoningEffort, fastMode: payload.fastMode }
        : undefined,
      useWorktree: useWorktree || undefined,
      sourceTabId: targetTabId,
      sessionTarget: feedbackSessionTarget,
    });
    submitting = false;
    if (sent) {
      composerRef?.clear();
      onSubmitted?.();
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.shiftKey) {
      e.preventDefault();
      const payload = composerRef?.payload();
      if (payload) void handleSendToNewSession(payload);
    }
  }
</script>

<div
  class={collapsed
    ? "absolute bottom-2.5 left-4 z-20"
    : "shrink-0 px-4 pt-2.5 pb-2.5"}
  style:background={collapsed ? "transparent" : "var(--solus-container-bg)"}
>
  <PromptComposer
    bind:this={composerRef}
    bind:value={() => generalComment, (v) => session.setDiffGeneralComment(v, targetTabId)}
    bind:collapsed
    tabId={targetTabId}
    workingDirectory={sess?.run.workingDirectory}
    canSubmitWhenEmpty={inlineCount > 0}
    onKeyDown={handleKeyDown}
    onSubmit={toNewSession ? handleSendToNewSession : handleSend}
    {submitting}
    {placeholder}
  >
    {#snippet afterPicker()}
      <!-- Icon toggles rather than a labelled switch, matching the plan review
           bar: the destination and its checkout read as two states of the send,
           and the row keeps the width for the model chip's label. -->
      {#if !feedbackToNewSession}
        <TooltipUI.Root>
          <TooltipUI.Trigger>
            {#snippet child({ props: tooltipProps })}
              <button {...tooltipProps}
                type="button"
                onclick={() => {
                  startNewSession = !startNewSession;
                  composerRef?.focus();
                }}
                class="flex size-[1.875rem] shrink-0 cursor-pointer items-center justify-center rounded-lg transition-[background-color,color,scale] duration-150 active:scale-[0.96] {startNewSession
                  ? 'bg-(--solus-surface-hover) text-(--solus-text-primary)'
                  : 'text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-secondary)'}"
                data-testid="diff-action-new-session"
                aria-label="Send this feedback to a new session"
                aria-pressed={startNewSession}
              >
                <ChatsIcon size={14} />
              </button>
            {/snippet}
          </TooltipUI.Trigger>
          <TooltipUI.Content
            value={startNewSession
              ? "New session on — click to reply in this session"
              : "New session off — click to send to a new session (⌘⇧↵)"}
          />
        </TooltipUI.Root>
      {/if}
      {#if showWorktree}
        <TooltipUI.Root>
          <TooltipUI.Trigger>
            {#snippet child({ props: tooltipProps })}
              <button {...tooltipProps}
                type="button"
                onclick={() => {
                  useWorktree = !useWorktree;
                  composerRef?.focus();
                }}
                class="flex size-[1.875rem] shrink-0 cursor-pointer items-center justify-center rounded-lg transition-[background-color,color,scale] duration-150 active:scale-[0.96] {useWorktree
                  ? 'bg-(--solus-surface-hover) text-(--solus-text-primary)'
                  : 'text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-secondary)'}"
                data-testid="composer-worktree"
                aria-label="Run the new session in an isolated worktree"
                aria-pressed={useWorktree}
              >
                <GitForkIcon size={14} />
              </button>
            {/snippet}
          </TooltipUI.Trigger>
          <TooltipUI.Content
            value={useWorktree
              ? "Worktree on — click to run in the current checkout"
              : "Worktree off — click to run in an isolated worktree"}
          />
        </TooltipUI.Root>
      {/if}
    {/snippet}
  </PromptComposer>
</div>
