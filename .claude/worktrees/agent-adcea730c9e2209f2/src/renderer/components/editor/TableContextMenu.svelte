<script lang="ts">
  import type { Editor } from '@tiptap/core'
  import * as ContextMenu from '../ui/context-menu'
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

</script>

<ContextMenu.Root onOpenChange={(open) => { if (!open) onClose() }}>
  <ContextMenu.PointTrigger x={coords.x} y={coords.y} />
  <ContextMenu.Content class="min-w-44">
    {#each actions as item}
      {#if item.dividerBefore}
        <ContextMenu.Separator />
      {/if}
      {@const Icon = item.icon}
      <ContextMenu.Item
        variant={item.danger ? 'destructive' : 'default'}
        onSelect={item.action}
      >
        <Icon />
        {item.label}
      </ContextMenu.Item>
    {/each}
  </ContextMenu.Content>
</ContextMenu.Root>
