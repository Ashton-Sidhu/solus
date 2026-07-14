<script lang="ts">
  import { fly } from "svelte/transition";
  import { quintOut } from "svelte/easing";
  import { PaperPlaneTiltIcon, XIcon } from "phosphor-svelte";
  import type { PlanComment } from "../../../shared/types";
  import PlanCommentsRail from "../plan/PlanCommentsRail.svelte";
  import { Textarea } from "../ui/textarea";

  interface Props {
    comments: PlanComment[];
    /** Label of the node the composer is anchored to; null = whole diagram. */
    draftAnchorLabel: string | null;
    onClearAnchor: () => void;
    onAdd: (text: string) => void;
    onEdit: (id: string, text: string) => void;
    onDelete: (id: string) => void;
    /** Center the canvas on the comment's node. */
    onScrollTo: (id: string) => void;
    onSendToAgent: () => void;
    onClose: () => void;
    /** Focus the composer on mount — set when opened via an explicit
        "Add comment" intent, mirroring the details drawer's autoFocus. */
    autoFocus?: boolean;
  }

  let {
    comments,
    draftAnchorLabel,
    onClearAnchor,
    onAdd,
    onEdit,
    onDelete,
    onScrollTo,
    onSendToAgent,
    onClose,
    autoFocus = false,
  }: Props = $props();

  let draft = $state("");
  let activeCommentId = $state<string | null>(null);
  let editingCommentId = $state<string | null>(null);
  let textareaEl = $state<HTMLTextAreaElement | null>(null);

  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  $effect(() => {
    if (autoFocus) textareaEl?.focus();
  });

  function submit() {
    const text = draft.trim();
    if (!text) return;
    onAdd(text);
    draft = "";
    textareaEl?.focus();
  }

  function onComposerKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
  }
</script>

<!-- Same overlay geometry + enter/exit as the node/edge drawers so the three
     right-side panels read as one family. -->
<div
  class="diagram-comments"
  role="complementary"
  aria-label="Diagram comments"
  in:fly|global={{ x: 24, duration: reduceMotion ? 0 : 200, easing: quintOut }}
  out:fly|global={{ x: 12, duration: reduceMotion ? 0 : 140, easing: quintOut }}
>
  <PlanCommentsRail
    {comments}
    {activeCommentId}
    {editingCommentId}
    emptyHint="Right-click a node and choose “Add comment”, or write one below."
    onScrollTo={(id) => {
      activeCommentId = id;
      onScrollTo(id);
    }}
    onHover={(id) => (activeCommentId = id)}
    onStartEdit={(id) => (editingCommentId = id)}
    onSaveEdit={(id, text) => {
      onEdit(id, text);
      editingCommentId = null;
    }}
    onCancelEdit={() => (editingCommentId = null)}
    {onDelete}
    {onClose}
  >
    {#snippet footer()}
      <div class="diagram-comments__composer">
        {#if draftAnchorLabel}
          <span class="diagram-comments__anchor" title="The comment will be anchored to this node">
            {draftAnchorLabel}
            <button
              type="button"
              class="diagram-comments__anchor-clear"
              onclick={onClearAnchor}
              title="Comment on the whole diagram instead"
              aria-label="Comment on the whole diagram instead"
            >
              <XIcon size={9} />
            </button>
          </span>
        {:else}
          <span class="diagram-comments__anchor diagram-comments__anchor--whole">Whole diagram</span>
        {/if}
        <Textarea
          bind:ref={textareaEl}
          bind:value={draft}
          class="diagram-comments__input"
          rows="2"
          placeholder="Add a comment…"
          onkeydown={onComposerKeydown}
        />
        <div class="diagram-comments__actions">
          <button
            type="button"
            class="diagram-btn"
            onclick={submit}
            disabled={!draft.trim()}
          >
            Comment
          </button>
          {#if comments.length > 0}
            <button
              type="button"
              class="diagram-btn diagram-btn--ghost diagram-comments__send"
              onclick={onSendToAgent}
              title="Send all comments to the agent and clear them"
            >
              <PaperPlaneTiltIcon size={11} />
              Send to agent
            </button>
          {/if}
        </div>
      </div>
    {/snippet}
  </PlanCommentsRail>
</div>

<style>
  .diagram-comments {
    position: absolute;
    right: 0.5rem;
    top: 0.5rem;
    bottom: 0.5rem;
    width: clamp(18rem, 34vw, 21rem);
    max-width: calc(100% - 1rem);
    z-index: 10;
  }

  /* The rail carries its own gutter for the plan sleeve; the drawer geometry
     above already provides the inset, so strip it here. */
  .diagram-comments :global(.plan-comments-rail) {
    padding: 0;
  }

  .diagram-comments__composer {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.625rem 0.75rem 0.75rem;
  }

  .diagram-comments__anchor {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    align-self: flex-start;
    max-width: 100%;
    padding: 0.0625rem 0.375rem;
    border-radius: 0.375rem;
    background: var(--solus-accent-light);
    border: 0.0625rem solid var(--solus-accent-border);
    color: var(--solus-accent);
    font-size: 0.625rem;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .diagram-comments__anchor--whole {
    background: transparent;
    border-color: var(--solus-tool-border);
    color: var(--solus-text-tertiary);
  }

  .diagram-comments__anchor-clear {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 0.875rem;
    height: 0.875rem;
    border: none;
    border-radius: 0.25rem;
    padding: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    opacity: 0.7;
    transition: opacity var(--duration-quick) var(--ease-premium);
  }

  .diagram-comments__anchor-clear:hover {
    opacity: 1;
  }

  :global(.diagram-comments__input) {
    width: 100%;
    padding: 0.4375rem 0.5rem;
    border-radius: 0.5rem;
    border: 0.0625rem solid var(--solus-tool-border);
    background: var(--solus-surface-primary);
    color: var(--solus-text-primary);
    font-size: 0.75rem;
    font-family: inherit;
    line-height: 1.45;
    resize: none;
    outline: none;
    transition:
      border-color var(--duration-base) var(--ease-premium),
      box-shadow var(--duration-base) var(--ease-premium);
  }

  :global(.diagram-comments__input:focus) {
    border-color: var(--solus-accent-border);
    box-shadow: 0 0 0 0.125rem var(--solus-accent-soft);
  }

  .diagram-comments__actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.375rem;
  }

  .diagram-comments__actions .diagram-btn:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .diagram-comments__send {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
  }
</style>
