<script lang="ts">
  import { fly } from "svelte/transition";
  import { ArrowsSplitIcon, ChatCircleTextIcon } from "phosphor-svelte";
  import { PromptComposer, type PromptComposerSubmit } from "../ui/prompt-composer";
  import { getWorkspaceContext, getStatusBarContext } from "../../contexts";
  import { tooltip } from "../../lib/tooltip";
  import type { DiffComment } from "../../../shared/types";

  interface Props {
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
    /** Open the comments popover (chip click) so the queued comments are discoverable. */
    onShowComments?: () => void;
    /** Working-tree scope: changes aren't tied to the current agent turn, so the
     *  only send target is a fresh session. The current-session button is hidden. */
    workingTree?: boolean;
  }

  let {
    filePath = null,
    diffText = "",
    branchContext,
    onSubmitted,
    beforeSend,
    pendingInlineDraft = false,
    onShowComments,
    workingTree = false,
  }: Props = $props();

  const session = getWorkspaceContext();
  const statusBar = getStatusBarContext();
  const tab = $derived(session.tabs[session.activeTabId]);
  const sess = $derived(session.sessionFor(session.activeTabId));
  const diffComments = $derived<DiffComment[]>(tab?.diffComments ?? []);
  const generalComment = $derived(tab?.diffGeneralComment ?? "");

  let submitting = $state(false);
  let composerRef: ReturnType<typeof PromptComposer> | null = $state(null);
  let useWorktree = $state(false);

  // The "send to new session" path spins up a fresh session, so an isolated
  // worktree is meaningful — offer it whenever the source is a real repo that
  // isn't already inside a worktree.
  const showWorktree = $derived(
    !!sess?.gitContext && !sess.gitContext.worktreePath,
  );

  const inlineCount = $derived(
    diffComments.length + (pendingInlineDraft ? 1 : 0),
  );
  // A typed-but-unsaved inline comment (pendingInlineDraft) counts: beforeSend
  // commits it before the send fires, so the queued comments alone can submit
  // with nothing in the text input.
  const canSubmit = $derived(
    generalComment.trim().length > 0 || inlineCount > 0,
  );

  // When sending is enabled purely by queued comments (empty message), the
  // generic "Reply…" placeholder hides what the send button will actually do.
  const placeholder = $derived.by(() => {
    const n = diffComments.length;
    if (n > 0 && generalComment.trim().length === 0) {
      return `Send ${n} comment${n === 1 ? "" : "s"} — add an optional note…`;
    }
    return workingTree ? "Send to a new session…" : "Reply to the agent…";
  });

  /** Composer picks that differ from the session's effective config. */
  function changedConfig(payload: PromptComposerSubmit) {
    const current = statusBar.ctxFor(session.activeTabId);
    const providerChanged = payload.provider !== current.activeAgent;
    const modelChanged = payload.modelId !== (current.model || null);
    const effortChanged = payload.reasoningEffort !== current.reasoningEffort;
    return { providerChanged, changed: modelChanged || effortChanged };
  }

  function applyRefs(payload: PromptComposerSubmit) {
    if (!tab) return;
    tab.input.planRefs = [...payload.planRefs];
    tab.input.workRefs = [...payload.workRefs];
  }

  function handleSend(payload: PromptComposerSubmit) {
    if (submitting) return;
    beforeSend?.();
    submitting = true;
    if (changedConfig(payload).changed) {
      session.updateModelConfig({
        modelId: payload.modelId,
        reasoningEffort: payload.reasoningEffort,
      });
    }
    applyRefs(payload);
    const sent = session.submitDiffFeedback(payload.text);
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
        ? { modelId: payload.modelId, reasoningEffort: payload.reasoningEffort }
        : undefined,
      useWorktree: useWorktree || undefined,
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

<div class="px-3 pt-2 pb-3" style="background:var(--solus-container-bg)">
  <PromptComposer
    bind:this={composerRef}
    bind:value={() => generalComment, (v) => session.setDiffGeneralComment(v)}
    tabId={session.activeTabId}
    workingDirectory={sess?.workingDirectory}
    canSubmitWhenEmpty={inlineCount > 0}
    allowAgentSwitch={workingTree}
    showWorktree={showWorktree}
    bind:useWorktree
    onKeyDown={handleKeyDown}
    onSubmit={workingTree ? handleSendToNewSession : handleSend}
    {submitting}
    {placeholder}
  >
    {#snippet trailing()}
      {#if inlineCount > 0}
        <button
          type="button"
          onclick={() => onShowComments?.()}
          class="comments-chip"
          aria-label={`View ${inlineCount} queued comment${inlineCount === 1 ? "" : "s"}`}
          use:tooltip={"View queued comments"}
        >
          <ChatCircleTextIcon size={10} weight="fill" />
          <span class="tabular-nums">{inlineCount}</span>
        </button>
      {/if}
      {#if canSubmit && !workingTree}
        <button
          type="button"
          onclick={() => {
            const payload = composerRef?.payload();
            if (payload) void handleSendToNewSession(payload);
          }}
          disabled={submitting}
          aria-label="Send to new session"
          class="split-btn relative flex size-6 items-center justify-center rounded-full cursor-pointer"
          use:tooltip={"Send to new session · ⌘⇧↵"}
          transition:fly={{ x: 4, duration: 120 }}
        >
          <span class="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden" aria-hidden="true"></span>
          <ArrowsSplitIcon size={12} weight="bold" />
        </button>
      {/if}
    {/snippet}
  </PromptComposer>
</div>

<style>
  .split-btn {
    background: var(--solus-surface-hover);
    color: var(--solus-text-secondary);
    border: 0.0625rem solid var(--solus-container-border);
    transition:
      background-color 0.15s ease,
      color 0.15s ease,
      transform 0.1s ease,
      opacity 0.15s ease;
  }
  .split-btn:hover:not(:disabled) {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }
  .split-btn:active:not(:disabled) {
    transform: scale(0.96);
  }
  .comments-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.1875rem;
    height: 1.25rem;
    padding: 0 0.375rem;
    border-radius: 0.625rem;
    background: var(--solus-accent-light);
    color: var(--solus-accent);
    border: none;
    font-size: 0.625rem;
    font-weight: 600;
    line-height: 1;
    cursor: pointer;
    transition: background-color 0.12s ease, transform 0.1s ease;
  }
  .comments-chip:hover {
    background: var(--solus-surface-hover);
  }
  .comments-chip:active {
    transform: scale(0.96);
  }
  .comments-chip:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.125rem;
  }
  .tabular-nums {
    font-variant-numeric: tabular-nums;
  }
</style>
