<script lang="ts">
  import type { Snippet } from 'svelte'
  import { fly } from 'svelte/transition'
  import { getPopoverLayer, useClickOutside } from '../popoverLayer.svelte'
  import { portal } from '../portal'

  interface Props {
    open: boolean
    triggerEl: HTMLElement | null
    width?: number
    align?: 'bottom' | 'top' | 'left'
    anchor?: 'left' | 'right'
    offset?: number
    /** When align="left", pop out to the left of this element's edge instead of
        the trigger's — e.g. clear an entire side panel rather than just the button. */
    boundaryEl?: HTMLElement | null
    class?: string
    children: Snippet
  }

  let {
    open = $bindable(),
    triggerEl,
    width = 224,
    align = 'bottom',
    anchor = 'left',
    offset = 6,
    boundaryEl = null,
    class: extraClass = '',
    children,
  }: Props = $props()

  const layer = getPopoverLayer()

  let popoverEl: HTMLDivElement | null = $state(null)
  let pos = $state({ top: 0, bottom: 0, left: 0, width: 0, maxHeight: 0 })

  function updatePosition() {
    if (!triggerEl) return

    const margin = 8
    const rect = triggerEl.getBoundingClientRect()
    const safeWidth = Math.min(width, Math.max(0, window.innerWidth - margin * 2))
    const leftEdge = boundaryEl?.getBoundingClientRect().left ?? rect.left
    const requestedLeft =
      align === 'left'
        ? leftEdge - safeWidth - offset
        : anchor === 'right'
          ? rect.right - safeWidth
          : rect.left
    const maxLeft = Math.max(margin, window.innerWidth - safeWidth - margin)
    const top = Math.min(
      Math.max(rect.top, margin),
      Math.max(margin, window.innerHeight - margin),
    )

    pos = {
      top: align === 'left' ? top : rect.bottom + offset,
      bottom: window.innerHeight - rect.top + offset,
      left: Math.min(Math.max(requestedLeft, margin), maxLeft),
      width: safeWidth,
      maxHeight: Math.max(
        0,
        align === 'left'
          ? window.innerHeight - top - margin
          : align === 'top'
          ? window.innerHeight - rect.bottom - offset - margin
          : rect.top - offset - margin,
      ),
    }
  }

  $effect(() => {
    if (open && triggerEl) updatePosition()
  })

  useClickOutside(
    () => open,
    () => [triggerEl, popoverEl],
    () => { open = false },
  )

  $effect(() => {
    if (!open) return
    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        open = false
        e.preventDefault()
        e.stopPropagation()
      }
    }
    document.addEventListener('keydown', handleKeydown, true)
    return () => document.removeEventListener('keydown', handleKeydown, true)
  })

  $effect(() => {
    if (!open || !triggerEl) return

    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)

    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  })
</script>

{#if open && layer.el}
  <div
    bind:this={popoverEl}
    use:portal={layer.el}
    transition:fly={{
      x: align === 'left' ? 4 : 0,
      y: align === 'top' ? 4 : align === 'left' ? 0 : -4,
      duration: 120,
    }}
    class="z-[10002] overflow-hidden rounded-[14px] border border-(--solus-popover-border) bg-(--solus-popover-bg) shadow-(--solus-popover-shadow) backdrop-blur-xl {extraClass}"
    style="
      position:fixed;
      {align === 'top' || align === 'left' ? `top:${pos.top}px` : `bottom:${pos.bottom}px`};
      left:{pos.left}px;
      width:{pos.width}px;
      max-height:{pos.maxHeight}px;
    "
  >
    {@render children()}
  </div>
{/if}
