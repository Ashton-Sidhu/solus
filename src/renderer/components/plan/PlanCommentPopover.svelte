<script lang="ts">
  import { fly } from 'svelte/transition'
  import { PencilSimpleIcon, TrashIcon } from 'phosphor-svelte'
  import type { PlanComment } from '../../../shared/types'
  import { portal } from '../portal'
  import { Button } from '../ui/button'

  interface Props {
    comment: PlanComment
    anchor: { x: number; y: number }
    onEdit: (comment: PlanComment) => void
    onDelete: (comment: PlanComment) => void
    onClose: () => void
  }

  let { comment, anchor, onEdit, onDelete, onClose }: Props = $props()

  let popoverEl: HTMLDivElement | null = $state(null)

  // Opened by a click on the highlight, so it takes focus and stays until it is
  // dismissed — by Escape here, or by a click landing anywhere else in the text.
  $effect(() => {
    popoverEl?.focus()
  })
</script>

<div
  bind:this={popoverEl}
  use:portal={document.body}
  role="dialog"
  tabindex="-1"
  transition:fly={{ y: -4, duration: 140, opacity: 0 }}
  data-solus-ui
  class="plan-comment-popover fixed flex flex-col"
  style="left:{anchor.x}px;top:{anchor.y}px"
  onmousedown={(e) => e.stopPropagation()}
  onclick={(e) => e.stopPropagation()}
  onkeydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
>
  <span class="plan-comment-popover__arrow" aria-hidden="true"></span>
  <!-- Same parts, same order as a margin thread: what was said, then the anchor
       as a caption. A popover and a rail thread are one design. -->
  <div class="flex flex-col gap-2 px-3 py-2.5">
    <div class="flex items-center gap-[0.4375rem]">
      <div class="ml-auto flex gap-1">
        <Button
          variant="ghost"
          size="icon-xs"
          onclick={() => onEdit(comment)}
          class="text-(--solus-text-tertiary) hover:text-(--solus-text-primary)"
          title="Edit comment"
        >
          <PencilSimpleIcon size={12} />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onclick={() => onDelete(comment)}
          class="text-(--solus-text-tertiary) hover:text-(--solus-text-primary)"
          title="Delete comment"
        >
          <TrashIcon size={12} />
        </Button>
      </div>
    </div>
    <p class="plan-comment-popover__body select-text">
      {comment.comment}
    </p>
    <div class="plan-comment-popover__anchor">
      {comment.selectedText.length > 90
        ? comment.selectedText.slice(0, 90) + '…'
        : comment.selectedText}
    </div>
  </div>
</div>

<style>
  /* The same surface as the margin thread it stands in for, which is the same
     surface as the diff inline comment: popover fill, accent-tinted edge. */
  .plan-comment-popover {
    --pc-edge: color-mix(in oklab, var(--solus-accent) 22%, var(--solus-container-border));
    transform: translateX(-50%);
    /* The folded layout's stand-in for a margin thread, so it is the width of
       one: 268px, anchored to the run rather than parked at the pane edge. */
    width: 16.75rem;
    border-radius: 1rem;
    border: 0.0625rem solid var(--pc-edge);
    background: var(--solus-popover-bg);
    box-shadow: var(--solus-popover-shadow);
    backdrop-filter: blur(1.5rem) saturate(1.1);
    -webkit-backdrop-filter: blur(1.5rem) saturate(1.1);
    z-index: 10001;
  }
  .plan-comment-popover__arrow {
    position: absolute;
    top: -0.3125rem;
    left: 50%;
    width: 0.5rem;
    height: 0.5rem;
    background: var(--solus-popover-bg);
    border-left: 0.0625rem solid var(--pc-edge);
    border-top: 0.0625rem solid var(--pc-edge);
    transform: translateX(-50%) rotate(45deg);
  }
  .plan-comment-popover__body {
    font-size: var(--text-sm);
    line-height: 1.6;
    color: color-mix(in srgb, var(--solus-text-primary) 90%, var(--solus-text-tertiary));
  }
  /* The anchor is a caption, not a quote block: the highlight in the text is
     the real anchor, so this never needs a fill or a bar of its own. */
  .plan-comment-popover__anchor {
    padding-top: 0.4375rem;
    border-top: 0.0625rem solid color-mix(in srgb, var(--solus-art-border) 55%, transparent);
    font-size: var(--text-xs);
    line-height: 1.5;
    color: var(--solus-text-tertiary);
    word-break: break-word;
  }
</style>
