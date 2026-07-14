<script lang="ts">
  import { fly } from 'svelte/transition'
  import { PencilSimpleIcon, TrashIcon } from 'phosphor-svelte'
  import type { PlanComment } from '../../../shared/types'
  import { portal } from '../portal'
  import { Button } from '../ui/button'

  interface Props {
    comment: PlanComment
    anchor: { x: number; y: number }
    /** Pinned popovers (opened by click) ignore mouse-leave auto-close. */
    pinned?: boolean
    onEdit: (comment: PlanComment) => void
    onDelete: (comment: PlanComment) => void
    onClose: () => void
    onHoverEnter?: () => void
  }

  let { comment, anchor, pinned = false, onEdit, onDelete, onClose, onHoverEnter }: Props = $props()

  let popoverEl: HTMLDivElement | null = $state(null)
  let leaveTimeout: ReturnType<typeof setTimeout> | null = null

  // A pinned popover takes focus so Escape closes it without a stray hover.
  $effect(() => {
    if (pinned) popoverEl?.focus()
  })

  function handleMouseEnter() {
    if (leaveTimeout) {
      clearTimeout(leaveTimeout)
      leaveTimeout = null
    }
    onHoverEnter?.()
  }

  function handleMouseLeave() {
    // A pinned popover (opened by click) stays put until dismissed explicitly.
    if (pinned) return
    // Generous grace period so a diagonal move toward Edit/Delete never drops it.
    leaveTimeout = setTimeout(() => {
      onClose()
    }, 400)
  }
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
  onkeydown={(e) => { if (e.key === 'Escape') onClose(); }}
  onmouseenter={handleMouseEnter}
  onmouseleave={handleMouseLeave}
>
  <span class="plan-comment-popover__arrow" aria-hidden="true"></span>
  <div class="px-3 py-2.5">
    <div
      class="plan-comment-popover__quote text-[0.6563rem] italic leading-snug mb-1.5 px-2 py-1 rounded text-(--solus-text-secondary)"
    >
      &ldquo;{comment.selectedText.length > 100
        ? comment.selectedText.slice(0, 100) + '…'
        : comment.selectedText}&rdquo;
    </div>
    <p class="text-[0.7188rem] text-(--solus-text-primary) leading-snug select-text">
      {comment.comment}
    </p>
    <div class="flex gap-1 mt-2 justify-end">
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
</div>

<style>
  .plan-comment-popover {
    transform: translateX(-50%);
    max-width: 17.5rem;
    border-radius: 0.625rem;
    border: 0.0625rem solid var(--solus-popover-border);
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
    border-left: 0.0625rem solid var(--solus-popover-border);
    border-top: 0.0625rem solid var(--solus-popover-border);
    transform: translateX(-50%) rotate(45deg);
  }
  .plan-comment-popover__quote {
    background: var(--solus-surface-hover);
    border-left: 0.125rem solid var(--solus-accent);
  }
</style>
