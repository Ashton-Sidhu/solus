<script lang="ts" generics="TData extends RowData">
  import type { RowData, SvelteTable } from '@tanstack/svelte-table'
  import { ChevronLeft as CaretLeftIcon, ChevronRight as CaretRightIcon } from "@lucide/svelte";
  import { Button } from '../../ui/button'
  import * as Select from '../../ui/select'
  import type { InsightsTableFeatures } from './data-table-features'

  let { table }: { table: SvelteTable<InsightsTableFeatures, TData> } = $props()

  const pagination = $derived(table.atoms.pagination.get())
  const filteredRows = $derived(table.getFilteredRowModel().rows.length)
  const pageCount = $derived(Math.max(1, table.getPageCount()))
  const firstRow = $derived(filteredRows === 0 ? 0 : pagination.pageIndex * pagination.pageSize + 1)
  const lastRow = $derived(Math.min(filteredRows, firstRow + pagination.pageSize - 1))
</script>

<footer
  class="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-1.5 text-insights-chrome text-muted-foreground shadow-[inset_0_0.5px_0_var(--hairline)]"
  data-insights-table-pagination
>
  <span class="mr-auto tabular-nums">
    <span class="text-foreground">{firstRow}–{lastRow}</span> of {filteredRows}
  </span>

  <div class="flex items-center gap-1.5">
    <span class="hidden sm:inline">Rows per page</span>
    <Select.Root
      type="single"
      value={String(pagination.pageSize)}
      onValueChange={(value) => table.setPageSize(Number(value))}
    >
      <Select.Trigger
        size="sm"
        aria-label="Rows per page"
        class="h-8 w-16 gap-1 rounded-full border-0 bg-[var(--wash-1)] px-2.5 text-insights-chrome tabular-nums text-foreground shadow-[inset_0_0_0_0.5px_var(--hairline)] transition-[background-color,box-shadow] hover:bg-[var(--wash-2)] focus-visible:ring-0 focus-visible:shadow-[inset_0_0_0_1px_var(--ring),0_0_0_3px_color-mix(in_oklch,var(--ring)_12%,transparent)] pointer-coarse:h-10 [&_svg]:size-2.5 [&_svg]:opacity-60"
      >
        {pagination.pageSize}
      </Select.Trigger>
      <Select.Content align="end" class="min-w-16">
        {#each [10, 25, 50, 100] as pageSize (pageSize)}
          <Select.Item value={String(pageSize)} label={String(pageSize)} />
        {/each}
      </Select.Content>
    </Select.Root>
  </div>

  <div class="flex items-center gap-1">
    <Button
      variant="ghost"
      size="icon"
      class="size-8 rounded-full text-muted-foreground shadow-[inset_0_0_0_0.5px_var(--hairline)] transition-[color,background-color,scale] hover:bg-[var(--wash-2)] hover:text-foreground active:scale-[0.94] disabled:opacity-35 disabled:shadow-none pointer-coarse:size-10"
      disabled={!table.getCanPreviousPage()}
      aria-label="Previous page"
      onclick={() => table.previousPage()}
    >
      <CaretLeftIcon class="size-3.5" weight="bold" aria-hidden="true" />
    </Button>
    <span class="min-w-12 text-center tabular-nums">
      <span class="text-foreground">{pagination.pageIndex + 1}</span> / {pageCount}
    </span>
    <Button
      variant="ghost"
      size="icon"
      class="size-8 rounded-full text-muted-foreground shadow-[inset_0_0_0_0.5px_var(--hairline)] transition-[color,background-color,scale] hover:bg-[var(--wash-2)] hover:text-foreground active:scale-[0.94] disabled:opacity-35 disabled:shadow-none pointer-coarse:size-10"
      disabled={!table.getCanNextPage()}
      aria-label="Next page"
      onclick={() => table.nextPage()}
    >
      <CaretRightIcon class="size-3.5" weight="bold" aria-hidden="true" />
    </Button>
  </div>
</footer>
