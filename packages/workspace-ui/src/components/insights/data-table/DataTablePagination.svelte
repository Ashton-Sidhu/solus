<script lang="ts" generics="TData extends RowData">
  import type { RowData, SvelteTable } from '@tanstack/svelte-table'
  import { ChevronLeft as CaretLeftIcon, ChevronRight as CaretRightIcon } from "@lucide/svelte";
  import { Button } from '../../ui/button'
  import * as Select from '../../ui/select'
  import type { InsightsTableFeatures } from './data-table-features'

  let {
    table,
    totalRows,
    pageIndex,
    pageSize,
    onPageChange,
    onPageSizeChange,
  }: {
    table: SvelteTable<InsightsTableFeatures, TData>
    totalRows?: number
    pageIndex?: number
    pageSize?: number
    onPageChange?: (pageIndex: number) => void
    onPageSizeChange?: (pageSize: number) => void
  } = $props()

  const pagination = $derived(table.atoms.pagination.get())
  const effectiveRows = $derived(totalRows ?? table.getFilteredRowModel().rows.length)
  const effectivePageIndex = $derived(pageIndex ?? pagination.pageIndex)
  const effectivePageSize = $derived(pageSize ?? pagination.pageSize)
  const pageCount = $derived(Math.max(1, Math.ceil(effectiveRows / effectivePageSize)))
  const firstRow = $derived(effectiveRows === 0 ? 0 : effectivePageIndex * effectivePageSize + 1)
  const lastRow = $derived(Math.min(effectiveRows, firstRow + effectivePageSize - 1))
  const canPrevious = $derived(effectivePageIndex > 0)
  const canNext = $derived(effectivePageIndex + 1 < pageCount)

  function setPageSize(next: number): void {
    if (onPageSizeChange) onPageSizeChange(next)
    else table.setPageSize(next)
  }

  function setPage(next: number): void {
    if (onPageChange) onPageChange(next)
    else table.setPageIndex(next)
  }
</script>

<footer
  class="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-1.5 text-insights-chrome text-muted-foreground shadow-[inset_0_0.5px_0_var(--hairline)]"
  data-insights-table-pagination
>
  <span class="mr-auto tabular-nums">
    <span class="text-foreground">{firstRow}–{lastRow}</span> of {effectiveRows}
  </span>

  <div class="flex items-center gap-1.5">
    <span class="hidden sm:inline">Rows per page</span>
    <Select.Root
      type="single"
      value={String(effectivePageSize)}
      onValueChange={(value) => setPageSize(Number(value))}
    >
      <Select.Trigger
        size="sm"
        aria-label="Rows per page"
        class="h-8 w-16 gap-1 rounded-full border-0 bg-[var(--wash-1)] px-2.5 text-insights-chrome tabular-nums text-foreground shadow-[inset_0_0_0_0.5px_var(--hairline)] transition-[background-color,box-shadow] hover:bg-[var(--wash-2)] focus-visible:ring-0 focus-visible:shadow-[inset_0_0_0_1px_var(--ring),0_0_0_3px_color-mix(in_oklch,var(--ring)_12%,transparent)] pointer-coarse:h-10 [&_svg]:size-2.5 [&_svg]:opacity-60"
      >
        {effectivePageSize}
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
      disabled={!canPrevious}
      aria-label="Previous page"
      onclick={() => setPage(effectivePageIndex - 1)}
    >
      <CaretLeftIcon class="size-3.5" weight="bold" aria-hidden="true" />
    </Button>
    <span class="min-w-12 text-center tabular-nums">
      <span class="text-foreground">{effectivePageIndex + 1}</span> / {pageCount}
    </span>
    <Button
      variant="ghost"
      size="icon"
      class="size-8 rounded-full text-muted-foreground shadow-[inset_0_0_0_0.5px_var(--hairline)] transition-[color,background-color,scale] hover:bg-[var(--wash-2)] hover:text-foreground active:scale-[0.94] disabled:opacity-35 disabled:shadow-none pointer-coarse:size-10"
      disabled={!canNext}
      aria-label="Next page"
      onclick={() => setPage(effectivePageIndex + 1)}
    >
      <CaretRightIcon class="size-3.5" weight="bold" aria-hidden="true" />
    </Button>
  </div>
</footer>
