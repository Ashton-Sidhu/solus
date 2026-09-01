<script lang="ts">
  import { fly } from "svelte/transition";
  import { quintOut } from "svelte/easing";
  import { Send as PaperPlaneTiltIcon, X as XIcon } from "@lucide/svelte";
  import type { PlanComment } from "@solus/contracts/types";
  import PlanCommentsRail from "../plan/PlanCommentsRail.svelte";
  import { Button } from "../ui/button";
  import { CommentComposer } from "../ui/comment-composer";

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
  let composerEl: ReturnType<typeof CommentComposer> | null = $state(null);

  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  $effect(() => {
    if (autoFocus) composerEl?.focusInput();
  });

  function submit(text: string) {
    onAdd(text);
    draft = "";
    composerEl?.focusInput();
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
  >
    {#snippet footer()}
      <CommentComposer
        bind:this={composerEl}
        surface="embedded"
        {autoFocus}
        class="flex flex-col gap-1.5 px-3 pt-2.5 pb-3"
        editorClass="rounded-lg border border-(--solus-tool-border) bg-(--solus-surface-primary) px-2 text-xs focus-within:border-(--solus-accent-border) focus-within:ring-2 focus-within:ring-(--solus-accent-soft)"
        initialValue={draft}
        onFormValueChange={(value) => (draft = value)}
        onSave={submit}
        onCancel={onClose}
        submitOn="enter"
        placeholder="Add a comment…"
      >
        {#snippet leading()}
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
        {/snippet}
        {#snippet secondaryActions()}
          {#if comments.length > 0}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              class="inline-flex items-center gap-1.5 text-(--solus-text-tertiary)"
              onclick={onSendToAgent}
              title="Send all comments to the agent and clear them"
            >
              <PaperPlaneTiltIcon size={11} />
              Send to agent
            </Button>
          {/if}
        {/snippet}
      </CommentComposer>
    {/snippet}
  </PlanCommentsRail>
</div>

<style>
  .diagram-comments {
    position: absolute;
    right: 0.5rem;
    top: 0.5rem;
    bottom: 0.5rem;
    width: clamp(18rem, 34cqi, 21rem);
    max-width: calc(100% - 1rem);
    z-index: 10;
    /* The rail draws margin threads on the page it belongs to — a document
       gutter. Over a canvas there is no page, so the frame the other right-side
       drawers use is supplied here rather than by the rail. */
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--solus-sidebar-bg-right, var(--solus-sidebar-bg));
    border: 0.0625rem solid var(--solus-container-border);
    border-radius: 1rem;
  }

  .diagram-comments :global(.plan-comments-rail) {
    padding: 0.75rem 0.75rem 0;
  }
  .diagram-comments :global(.plan-comments-rail__footer) {
    margin-top: 0.5rem;
    margin-inline: -0.75rem;
    border-top: 0.0625rem solid var(--solus-container-border);
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
    font-size: var(--text-xs);
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

</style>
