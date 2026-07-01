<script lang="ts">
  import { fly } from 'svelte/transition'
  import { getPopoverLayer, useClickOutside } from '../popoverLayer.svelte'
  import { portal } from '../portal'
  import type { Editor } from '@tiptap/core'
  import {
    ArrowLineLeft,
    ArrowLineRight,
    ArrowLineUp,
    ArrowLineDown,
    Trash,
    MinusSquare,
  } from 'phosphor-svelte'

  interface Props {
    editor: Editor
    coords: { x: number; y: number }
    onClose: () => void
  }

  let { editor, coords, onClose }: Props = $props()

  const layer = getPopoverLayer()
  let menuEl: HTMLDivElement | null = $state(null)

  useClickOutside(
    () => true,
    () => [menuEl],
    () => onClose(),
  )

  const posStyle = $derived.by(() => {
    const spaceBelow = window.innerHeight - coords.y
    const spaceRight = window.innerWidth - coords.x
    const top = spaceBelow >= 260 ? coords.y : coords.y - 260
    const left = spaceRight >= 180 ? coords.x : coords.x - 180
    return `position:fixed;top:${top}px;left:${left}px`
  })

  type TableAction = {
    label: string
    icon: typeof ArrowLineLeft
    action: () => void
    danger?: boolean
    dividerBefore?: boolean
  }

  const actions: TableAction[] = [
    {
      label: 'Add column before',
      icon: ArrowLineLeft,
      action: () => editor.chain().focus().addColumnBefore().run(),
    },
    {
      label: 'Add column after',
      icon: ArrowLineRight,
      action: () => editor.chain().focus().addColumnAfter().run(),
    },
    {
      label: 'Delete column',
      icon: MinusSquare,
      action: () => editor.chain().focus().deleteColumn().run(),
      danger: true,
    },
    {
      label: 'Add row above',
      icon: ArrowLineUp,
      action: () => editor.chain().focus().addRowBefore().run(),
      dividerBefore: true,
    },
    {
      label: 'Add row below',
      icon: ArrowLineDown,
      action: () => editor.chain().focus().addRowAfter().run(),
    },
    {
      label: 'Delete row',
      icon: MinusSquare,
      action: () => editor.chain().focus().deleteRow().run(),
      danger: true,
    },
    {
      label: 'Delete table',
      icon: Trash,
      action: () => editor.chain().focus().deleteTable().run(),
      danger: true,
      dividerBefore: true,
    },
  ]

  function handleAction(fn: () => void) {
    fn()
    onClose()
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if layer.el}
  <div use:portal={layer.el} transition:fly={{ y: 4, duration: 140, opacity: 0 }} style={posStyle}>
    <div
      bind:this={menuEl}
      class="table-ctx-menu overflow-y-auto rounded-xl py-1.5 px-1 bg-(--solus-popover-bg) border border-(--solus-popover-border)"
      style="min-width:11.25rem;backdrop-filter:blur(1.25rem) saturate(1.1);-webkit-backdrop-filter:blur(1.25rem) saturate(1.1);box-shadow:var(--solus-popover-shadow)"
      role="menu"
    >
      {#each actions as item}
        {#if item.dividerBefore}
          <div class="mx-1.5 my-1 h-px bg-(--solus-container-border)"></div>
        {/if}
        {@const Icon = item.icon}
        <button
          onclick={() => handleAction(item.action)}
          class="flex w-full cursor-pointer items-center gap-[0.5625rem] rounded-md border-0 bg-transparent px-[0.5625rem] py-1.5 text-left transition-[background,color] duration-(--duration-quick,120ms) ease-(--ease-premium,cubic-bezier(0.16,1,0.3,1)) hover:bg-(--solus-surface-hover) motion-reduce:transition-none {item.danger ? 'hover:bg-[color-mix(in_srgb,var(--solus-error,#e05252)_10%,transparent)]' : ''}"
          role="menuitem"
        >
          <span class="inline-flex shrink-0 items-center text-(--solus-text-tertiary) transition-colors duration-(--duration-quick,120ms) ease-(--ease-premium,cubic-bezier(0.16,1,0.3,1)) motion-reduce:transition-none {item.danger ? 'text-(--solus-error,#e05252)' : ''}">
            <Icon size={13} />
          </span>
          <span class="text-[0.75rem] leading-tight font-medium text-(--solus-text-primary) transition-colors duration-(--duration-quick,120ms) ease-(--ease-premium,cubic-bezier(0.16,1,0.3,1)) motion-reduce:transition-none {item.danger ? 'text-(--solus-error,#e05252)' : ''}">{item.label}</span>
        </button>
      {/each}
    </div>
  </div>
{/if}
