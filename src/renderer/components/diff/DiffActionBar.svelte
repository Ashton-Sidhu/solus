<script lang="ts">
  import { fly } from "svelte/transition";
  import { ArrowUpIcon, ArrowsSplitIcon, ChatCircleTextIcon } from "phosphor-svelte";
  import Kbd from "../ui/Kbd.svelte";
  import { MarkdownTextarea } from "../ui/markdown-field";
  import { getWorkspaceContext } from "../../contexts";
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
  const tab = $derived(session.tabs[session.activeTabId]);
  const diffComments = $derived<DiffComment[]>(tab?.diffComments ?? []);
  const generalComment = $derived(tab?.diffGeneralComment ?? "");

  let submitting = $state(false);
  let textareaEl: HTMLTextAreaElement | null = $state(null);
  let focused = $state(false);

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

  function setGeneral(value: string) {
    session.setDiffGeneralComment(value);
  }

  function handleSend() {
    if (!canSubmit || submitting) return;
    beforeSend?.();
    submitting = true;
    const sent = session.submitDiffFeedback(
      tab?.diffGeneralComment?.trim() ?? "",
    );
    submitting = false;
    if (sent) onSubmitted?.();
  }

  async function handleSendToNewSession() {
    if (!canSubmit || submitting) return;
    beforeSend?.();
    submitting = true;
    const sent = await session.submitDiffFeedbackToNewSession({
      generalComment: tab?.diffGeneralComment?.trim() ?? "",
      filePath,
      diffText,
      branchContext,
    });
    submitting = false;
    if (sent) onSubmitted?.();
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.shiftKey) {
      e.preventDefault();
      void handleSendToNewSession();
    }
  }
</script>

<div
  class="flex flex-col gap-1.5 px-3 py-1.5 border-t border-(--solus-container-border)"
  style="background:var(--solus-container-bg)"
>
  <div
    class="action-pill flex items-center gap-1.5 px-2 py-1.5"
    class:is-focused={focused}
  >
    <MarkdownTextarea
      bind:ref={textareaEl}
      bare
      value={generalComment}
      oninput={(e) => setGeneral((e.target as HTMLTextAreaElement).value)}
      onkeydown={handleKeyDown}
      onSubmit={workingTree ? handleSendToNewSession : handleSend}
      onfocus={() => (focused = true)}
      onblur={() => (focused = false)}
      {placeholder}
      rows={1}
      class="flex-1 min-w-0 placeholder:text-(--solus-text-muted) leading-[1.55] py-0.5 px-0.5 max-h-40"
    />

    <div class="flex items-center gap-1 shrink-0">
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
      {#if focused && !canSubmit}
        <Kbd variant="inline" class="text-[0.5938rem] text-(--solus-text-tertiary) tracking-wide px-1">⌘↵</Kbd>
      {/if}
      <div class="send-group flex items-center gap-1">
        {#if canSubmit && !workingTree}
          <button
            type="button"
            onclick={() => void handleSendToNewSession()}
            disabled={submitting}
            aria-label="Send to new session"
            class="split-btn relative flex items-center justify-center rounded-full cursor-pointer"
            style="width:1.5rem;height:1.5rem;"
            use:tooltip={"Send to new session · ⌘⇧↵"}
            transition:fly={{ x: 4, duration: 120 }}
          >
            <span class="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden" aria-hidden="true"></span>
            <ArrowsSplitIcon size={12} weight="bold" />
          </button>
        {/if}
        <button
          type="button"
          onclick={workingTree ? () => void handleSendToNewSession() : handleSend}
          disabled={!canSubmit || submitting}
          aria-label={workingTree ? "Send to new session" : "Send to session"}
          class="send-btn relative flex items-center justify-center rounded-full text-(--solus-text-on-accent) cursor-pointer"
          style="opacity:{canSubmit ? 1 : 0.4};width:1.5rem;height:1.5rem;"
          use:tooltip={workingTree ? "Send to new session · ⌘↵" : "Send to session · ⌘↵"}
        >
          <span class="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden" aria-hidden="true"></span>
          <ArrowUpIcon size={12} weight="bold" />
        </button>
      </div>
    </div>
  </div>
</div>

<style>
  .action-pill {
    border-radius: 0.875rem;
    border: 0.0625rem solid var(--solus-container-border);
    background: var(--solus-input-pill-bg);
    box-shadow: 0 0.0625rem 0.1875rem rgba(0, 0, 0, 0.04);
    transition:
      box-shadow 0.18s ease,
      border-color 0.18s ease;
  }
  .action-pill.is-focused {
    border-color: var(--solus-input-focus-border);
    box-shadow:
      0 0 0 0.1875rem var(--solus-input-focus-ring),
      0 0.0625rem 0.1875rem rgba(0, 0, 0, 0.04);
  }
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
  .send-btn {
    background: linear-gradient(145deg, #e08868 0%, #d97757 40%, #c96442 100%);
    box-shadow: 0 0.0625rem 0.1875rem var(--solus-send-glow);
    transition:
      box-shadow 0.15s ease,
      transform 0.1s ease,
      opacity 0.15s ease;
    position: relative;
  }
  .send-btn:hover:not(:disabled) {
    box-shadow: 0 0.125rem 0.375rem var(--solus-send-glow);
  }
  .send-btn:active:not(:disabled) {
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
