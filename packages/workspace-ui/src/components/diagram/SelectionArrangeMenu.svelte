<script lang="ts">
  import { AlignHorizontalJustifyStart } from '@lucide/svelte'
  import PopoverMenu from './PopoverMenu.svelte'
  import * as DropdownMenu from '../ui/dropdown-menu'
  import type { Arrangement } from './lib/selection-arrangement'
  let { count, onArrange, onSelectAll }: { count: number; onArrange: (action: Arrangement) => void; onSelectAll: () => void } = $props()
  const actions: { action: Arrangement; label: string; minimum: number }[] = [
    { action: 'left', label: 'Align left', minimum: 2 }, { action: 'center', label: 'Align centers', minimum: 2 },
    { action: 'right', label: 'Align right', minimum: 2 }, { action: 'top', label: 'Align top', minimum: 2 },
    { action: 'middle', label: 'Align middles', minimum: 2 }, { action: 'bottom', label: 'Align bottom', minimum: 2 },
    { action: 'horizontal', label: 'Space evenly horizontally', minimum: 3 }, { action: 'vertical', label: 'Space evenly vertically', minimum: 3 },
    { action: 'width', label: 'Match widths', minimum: 2 }, { action: 'height', label: 'Match heights', minimum: 2 },
  ]
</script>
<PopoverMenu title="Align and space selected nodes" ariaLabel="Align and space selected nodes" maxHeight={320}>
  {#snippet icon()}<AlignHorizontalJustifyStart size={16} />{/snippet}
  {#snippet children()}
    <DropdownMenu.Label>{count} nodes selected</DropdownMenu.Label>
    <DropdownMenu.Item onSelect={onSelectAll}>Select all nodes</DropdownMenu.Item>
    <DropdownMenu.Separator />
    {#each actions as { action, label, minimum }}
      <DropdownMenu.Item disabled={count < minimum} onSelect={() => onArrange(action)}>{label}</DropdownMenu.Item>
    {/each}
  {/snippet}
</PopoverMenu>
