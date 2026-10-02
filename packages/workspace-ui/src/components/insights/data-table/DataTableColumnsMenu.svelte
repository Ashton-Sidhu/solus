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
        class="h-6.5 shrink-0 gap-2 rounded-full bg-background pr-2.5 pl-3 text-insights-chrome text-foreground shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_5%,transparent),0_2px_10px_color-mix(in_oklch,var(--foreground)_7%,transparent)] transition-[background-color,scale] hover:bg-[var(--wash-1)] active:scale-[0.96] aria-expanded:bg-[var(--wash-1)] pointer-coarse:h-10"
      >
        <SlidersHorizontalIcon class="size-4" strokeWidth={1.5} aria-hidden="true" />
        <span class="hidden sm:inline">Columns</span>
        <CaretDownIcon class="size-3.5 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
      </Button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align="end" class="min-w-44">
    <DropdownMenu.Label class="text-insights-chrome uppercase text-muted-foreground">
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
