<script lang="ts" generics="TData extends RowData">
  import type { RowData, SvelteTable } from '@tanstack/svelte-table'
  import { ChevronDown as CaretDownIcon, SlidersHorizontal as SlidersHorizontalIcon } from "@lucide/svelte";
  import { Button } from '../../ui/button'
  import * as DropdownMenu from '../../ui/dropdown-menu'
  import type { InsightsTableFeatures } from './data-table-features'

  // Which columns a table shows. It is its own control rather than part of the
  // toolbar because it belongs at the trailing edge of the header band, and a
  // grain's own controls — a status filter, a grouping toggle — sit between it
  // and the search field.

  let { table }: { table: SvelteTable<InsightsTableFeatures, TData> } = $props()
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <Button
        {...props}
        variant="ghost"
        size="sm"
        class="h-8 shrink-0 gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground shadow-[inset_0_0_0_0.5px_var(--hairline)] transition-[color,background-color,scale] hover:bg-[var(--wash-2)] hover:text-foreground active:scale-[0.96] aria-expanded:bg-[var(--wash-3)] aria-expanded:text-foreground pointer-coarse:h-10"
      >
        <SlidersHorizontalIcon class="size-3.5" aria-hidden="true" />
        <span class="hidden sm:inline">Columns</span>
        <CaretDownIcon class="size-2.5 opacity-60" weight="bold" aria-hidden="true" />
      </Button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align="end" class="min-w-44">
    <DropdownMenu.Label class="text-xs uppercase text-muted-foreground">
      Visible columns
    </DropdownMenu.Label>
    <DropdownMenu.Separator />
    {#each table.getAllColumns().filter((column) => column.getCanHide()) as column (column.id)}
      <DropdownMenu.CheckboxItem
        bind:checked={() => column.getIsVisible(), (value) => column.toggleVisibility(Boolean(value))}
      >
        {typeof column.columnDef.header === 'string' ? column.columnDef.header : column.id}
      </DropdownMenu.CheckboxItem>
    {/each}
  </DropdownMenu.Content>
</DropdownMenu.Root>
