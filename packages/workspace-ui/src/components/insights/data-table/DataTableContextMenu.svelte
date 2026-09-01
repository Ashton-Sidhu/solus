<script lang="ts">
  import {
    MoveHorizontal as ArrowsHorizontalIcon,
    ExternalLink as ArrowSquareOutIcon,
    Copy as CopyIcon,
    EyeOff as EyeSlashIcon,
  } from "@lucide/svelte";
  import { requestInputFocus } from '../../../lib/inputFocus'
  import { copyText, toasts } from '../../../lib/toasts'
  import * as ContextMenu from '../../ui/context-menu'
  import type { CellContext } from './table-pointer'

  // One menu for all three grains. What it copies is what the row shows, so a
  // duration copies as `26m54` rather than as the epoch difference behind it.

  export interface DataTableMenuAction {
    label: string
    run: () => void
  }

  let {
    x,
    y,
    cell,
    insightsId,
    actions = [],
    onHideColumn,
    onResetWidths,
    onClose,
  }: {
    x: number
    y: number
    cell?: CellContext
    /** The trace identifier that owns this row, independent of which cell was clicked. */
    insightsId?: string | null
    /** Where this row leads — a turn, a session, a span. */
    actions?: DataTableMenuAction[]
    onHideColumn?: () => void
    onResetWidths?: () => void
    onClose: () => void
  } = $props()

  function select(action: () => void): void {
    action()
    onClose()
  }

  async function copy(text: string, label: string): Promise<void> {
    onClose()
    await copyText(text)
    toasts.success(`${label} copied`)
    requestInputFocus()
  }
</script>

<ContextMenu.Root
  onOpenChange={(open) => {
    if (!open) onClose()
  }}
>
  <ContextMenu.PointTrigger {x} {y} />
  <ContextMenu.Content class="min-w-52">
    {#each actions as action (action.label)}
      <ContextMenu.Item onSelect={() => select(action.run)}>
        <ArrowSquareOutIcon />
        {action.label}
      </ContextMenu.Item>
    {/each}
    {#if actions.length > 0}
      <ContextMenu.Separator />
    {/if}

    {#if insightsId !== undefined}
      <ContextMenu.Item disabled={!insightsId} onSelect={() => insightsId && void copy(insightsId, 'Insights ID')}>
        <CopyIcon />
        Copy Insights ID
      </ContextMenu.Item>
    {/if}
    {#if cell}
      <ContextMenu.Item disabled={!cell.cellText} onSelect={() => void copy(cell.cellText, 'Cell')}>
        <CopyIcon />
        {cell.columnLabel ? `Copy ${cell.columnLabel.toLowerCase()}` : 'Copy cell'}
      </ContextMenu.Item>
      <ContextMenu.Item disabled={!cell.rowText} onSelect={() => void copy(cell.rowText, 'Row')}>
        <CopyIcon />
        Copy row
      </ContextMenu.Item>
    {/if}

    {#if onHideColumn || onResetWidths}
      <ContextMenu.Separator />
      {#if onHideColumn}
        <ContextMenu.Item onSelect={() => select(onHideColumn)}>
          <EyeSlashIcon />
          Hide this column
        </ContextMenu.Item>
      {/if}
      {#if onResetWidths}
        <ContextMenu.Item onSelect={() => select(onResetWidths)}>
          <ArrowsHorizontalIcon />
          Reset column widths
        </ContextMenu.Item>
      {/if}
    {/if}
  </ContextMenu.Content>
</ContextMenu.Root>
