<script lang="ts">
  import type { Editor } from '@tiptap/core'
  import * as ContextMenu from '../ui/context-menu'
  import {
    ArrowLeftToLine as ArrowLineLeft,
    ArrowRightToLine as ArrowLineRight,
    ArrowUpToLine as ArrowLineUp,
    ArrowDownToLine as ArrowLineDown,
    AlignLeft as TextAlignLeft,
    AlignCenter as TextAlignCenter,
    AlignRight as TextAlignRight,
    Trash,
    MinusSquare,
  } from "@lucide/svelte";
  import { alignColumn } from './lib/table-align'

  interface Props {
    editor: Editor
    coords: { x: number; y: number }
    /** Set when the menu was opened from a grip: the grip has already said
     *  which axis you mean, so the menu carries only that axis's verbs rather
     *  than making you find them among the other one's. */
    axis?: 'row' | 'column' | null
    onClose: () => void
  }

  let { editor, coords, axis = null, onClose }: Props = $props()

  type TableAction = {
    label: string
    icon: typeof ArrowLineLeft
    action: () => void
    danger?: boolean
  }

  const columnActions: TableAction[] = [
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
    // Alignment is a column property in markdown, so it belongs to the column
    // menu — the block bar's "Align" cycles the same three states.
    {
      label: 'Align left',
      icon: TextAlignLeft,
      action: () => alignColumn(editor, 'left'),
    },
    {
      label: 'Align center',
      icon: TextAlignCenter,
      action: () => alignColumn(editor, 'center'),
    },
    {
      label: 'Align right',
      icon: TextAlignRight,
      action: () => alignColumn(editor, 'right'),
    },
    {
      label: 'Delete column',
      icon: MinusSquare,
      action: () => editor.chain().focus().deleteColumn().run(),
      danger: true,
    },
  ]

  const rowActions: TableAction[] = [
    {
      label: 'Add row above',
      icon: ArrowLineUp,
      action: () => editor.chain().focus().addRowBefore().run(),
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
  ]

  const tableActions: TableAction[] = [
    {
      label: 'Delete table',
      icon: Trash,
      action: () => editor.chain().focus().deleteTable().run(),
      danger: true,
    },
  ]

  // Right-click has no axis to go on, so it keeps the whole verb list.
  const groups = $derived(
    axis === 'column'
      ? [columnActions]
      : axis === 'row'
        ? [rowActions]
        : [columnActions, rowActions, tableActions],
  )
</script>

<ContextMenu.Root onOpenChange={(open) => { if (!open) onClose() }}>
  <ContextMenu.PointTrigger x={coords.x} y={coords.y} />
  <ContextMenu.Content class="min-w-44">
    {#each groups as group, groupIndex}
      {#if groupIndex > 0}
        <ContextMenu.Separator />
      {/if}
      {#each group as item}
        {@const Icon = item.icon}
        <ContextMenu.Item
          variant={item.danger ? 'destructive' : 'default'}
          onSelect={item.action}
        >
          <Icon />
          {item.label}
        </ContextMenu.Item>
      {/each}
    {/each}
  </ContextMenu.Content>
</ContextMenu.Root>
