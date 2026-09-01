<script lang="ts">
  import {
    ChatCircleTextIcon,
    FolderMinusIcon,
    PencilSimpleIcon,
    SquaresFourIcon,
    StackSimpleIcon,
    TrashIcon,
  } from 'phosphor-svelte'
  import * as ContextMenu from '../ui/context-menu'

  interface Props {
    x: number
    y: number
    type: 'node' | 'edge'
    onDelete: () => void
    onEditDetails: () => void
    onClose: () => void
    showRemoveFromGroup?: boolean
    onRemoveFromGroup?: () => void
    showDetail?: boolean
    hasDetail?: boolean
    onOpenDetail?: () => void
    sentToBack?: boolean
    onSendToBack?: () => void
    onBringToFront?: () => void
    onAddComment?: () => void
  }

  let {
    x,
    y,
    type,
    onDelete,
    onEditDetails,
    onClose,
    showRemoveFromGroup = false,
    onRemoveFromGroup,
    showDetail = false,
    hasDetail = false,
    onOpenDetail,
    sentToBack = false,
    onSendToBack,
    onBringToFront,
    onAddComment,
  }: Props = $props()

  const isMac = navigator.platform.includes('Mac')
  const layerShortcut = $derived(
    sentToBack
      ? isMac ? '⌘⇧]' : 'Ctrl+Shift+]'
      : isMac ? '⌘⇧[' : 'Ctrl+Shift+[',
  )
</script>

<ContextMenu.Root onOpenChange={(open) => { if (!open) onClose() }}>
  <ContextMenu.PointTrigger {x} {y} />
  <ContextMenu.Content class="min-w-40">
    <ContextMenu.Item onSelect={onEditDetails}>
      <PencilSimpleIcon />
      {type === 'edge' ? 'Edit edge' : 'Edit details'}
    </ContextMenu.Item>

    {#if showDetail && onOpenDetail}
      <ContextMenu.Item onSelect={onOpenDetail}>
        <SquaresFourIcon />
        {hasDetail ? 'Open detail' : 'Add detail diagram'}
      </ContextMenu.Item>
    {/if}

    {#if type === 'node' && onAddComment}
      <ContextMenu.Item onSelect={onAddComment}>
        <ChatCircleTextIcon />
        Add comment
      </ContextMenu.Item>
    {/if}

    {#if showRemoveFromGroup && onRemoveFromGroup}
      <ContextMenu.Item onSelect={onRemoveFromGroup}>
        <FolderMinusIcon />
        Remove from group
      </ContextMenu.Item>
    {/if}

    {#if type === 'node' && (onSendToBack || onBringToFront)}
      <ContextMenu.Item onSelect={() => (sentToBack ? onBringToFront : onSendToBack)?.()}>
        <StackSimpleIcon />
        {sentToBack ? 'Bring to front' : 'Send to back'}
        <ContextMenu.Shortcut>{layerShortcut}</ContextMenu.Shortcut>
      </ContextMenu.Item>
    {/if}

    <ContextMenu.Separator />
    <ContextMenu.Item variant="destructive" onSelect={onDelete}>
      <TrashIcon />
      Delete
      <ContextMenu.Shortcut>{isMac ? '⌫' : 'Del'}</ContextMenu.Shortcut>
    </ContextMenu.Item>
  </ContextMenu.Content>
</ContextMenu.Root>
