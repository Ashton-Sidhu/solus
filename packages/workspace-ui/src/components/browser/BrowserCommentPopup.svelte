<script lang="ts">
  import { Code2 } from "@lucide/svelte";
  import { CommentComposer } from "../ui/comment-composer";

  /**
   * The comment composer that appears on a placed mark.
   *
   * One card from the start: the mark's number and the field on top, the
   * element it points at, the recorder, Skip, and Send on the line below. The
   * caret is already in the field.
   */

  interface Props {
    /** The stable number shared by the popup, attachment, and prompt. */
    markNumber: number;
    /** The element the mark points at, shown in the footer once typing starts. */
    context?: string | undefined;
    onCommit: (comment: string) => void;
    onSkip: () => void;
  }

  let { markNumber, context, onCommit, onSkip }: Props = $props();
</script>

<div
  class="comment-pop text-workspace-chrome flex w-96 max-w-[calc(100%-1rem)] flex-col rounded-[14px] bg-[var(--popover)] px-3 py-2 shadow-[shadow:0_0_0_0.5px_var(--hairline-strongest),0_0_0_3px_color-mix(in_oklch,var(--primary)_14%,transparent),0_0.25rem_0.5rem_-0.25rem_rgba(0,0,0,0.14),0_1.5rem_2.75rem_-1.125rem_rgba(0,0,0,0.32)]"
>
  <CommentComposer
    surface="compact"
    onSave={onCommit}
    onCancel={onSkip}
    cancelLabel="Skip"
    submitLabel="Send"
    placeholder="Add a note"
    ariaLabel="Comment on mark {markNumber}"
    maxHeight={160}
    editorClass="min-w-0 flex-1 [--plain-editor-padding:0.375rem_0_0.375rem_0.25rem]"
  >
    {#snippet leading()}
      <span
        class="flex size-4.5 shrink-0 items-center justify-center rounded-full bg-[var(--primary)] font-semibold text-[color:var(--primary-foreground)] tabular-nums"
      >
        {markNumber}
      </span>
    {/snippet}
    {#snippet footer()}
      {#if context}
        <span
          class="flex min-w-0 items-center gap-1 overflow-hidden rounded-md bg-[var(--card)] px-1.5 py-0.5 text-(--solus-text-tertiary) shadow-[shadow:0_0_0_0.5px_var(--hairline-strong)]"
          title={context}
        >
          <Code2 class="size-2.5 shrink-0 opacity-60" aria-hidden="true" />
          <span class="truncate">{context}</span>
        </span>
      {/if}
    {/snippet}
  </CommentComposer>
</div>

<style>
  /* A composited entrance — transform and opacity only — matching the spec's
     popIn. Nothing here reflows, so the composer never stutters as it appears. */
  .comment-pop {
    animation: comment-pop 160ms ease-out;
  }

  @keyframes comment-pop {
    from {
      opacity: 0;
      transform: translateY(6px) scale(0.985);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .comment-pop {
      animation: none;
    }

    .comment-pop {
      transition-duration: 0.01ms !important;
    }
  }
</style>
