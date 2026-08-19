<script lang="ts">
  import {
    ArrowsOutSimpleIcon,
    ClipboardIcon,
    PlusCircleIcon,
    SelectionAllIcon,
    SelectionPlusIcon,
    TreeStructureIcon,
  } from 'phosphor-svelte'
  import * as ContextMenu from '../ui/context-menu'

  interface Props {
    x: number
    y: number
    canPaste: boolean
    onAddNode: () => void
    onAddGroup: () => void
    onPaste: () => void
    onSelectAll: () => void
    onFitView: () => void
    onAutoLayout: () => void
    onClose: () => void
  }

  let {
    x,
    y,
    canPaste,
    onAddNode,
    onAddGroup,
    onPaste,
    onSelectAll,
    onFitView,
    onAutoLayout,
    onClose,
  }: Props = $props()

  const isMac = navigator.platform.includes('Mac')
  const mod = isMac ? '⌘' : 'Ctrl+'
</script>

<ContextMenu.Root onOpenChange={(open) => { if (!open) onClose() }}>
  <ContextMenu.PointTrigger {x} {y} />
  <ContextMenu.Content class="min-w-44">
    <ContextMenu.Item onSelect={onAddNode}>
      <PlusCircleIcon />
      Add node here
    </ContextMenu.Item>
    <ContextMenu.Item onSelect={onAddGroup}>
      <SelectionPlusIcon />
      Add group here
    </ContextMenu.Item>

    <ContextMenu.Separator />
    <ContextMenu.Item disabled={!canPaste} onSelect={onPaste}>
      <ClipboardIcon />
      Paste
      <ContextMenu.Shortcut>{mod}V</ContextMenu.Shortcut>
    </ContextMenu.Item>
    <ContextMenu.Item onSelect={onSelectAll}>
      <SelectionAllIcon />
      Select all
      <ContextMenu.Shortcut>{mod}A</ContextMenu.Shortcut>
    </ContextMenu.Item>

    <ContextMenu.Separator />
    <ContextMenu.Item onSelect={onFitView}>
      <ArrowsOutSimpleIcon />
      Fit view
    </ContextMenu.Item>
    <ContextMenu.Item onSelect={onAutoLayout}>
      <TreeStructureIcon />
      Auto-layout
    </ContextMenu.Item>
  </ContextMenu.Content>
</ContextMenu.Root>
