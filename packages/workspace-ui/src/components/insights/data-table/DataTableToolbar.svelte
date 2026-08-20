<script lang="ts" generics="TData extends RowData">
  import type { RowData, SvelteTable } from '@tanstack/svelte-table'
  import { Search as MagnifyingGlassIcon, X as XIcon } from "@lucide/svelte";
  import { Input } from '../../ui/input'
  import type { InsightsTableFeatures } from './data-table-features'

  // The search field, and how much of the answer it is currently hiding. It
  // sits at the header band's leading edge and takes only the width it needs,
  // so each grain decides which of its own controls follow it and which are
  // pushed to the trailing edge.

  let {
    table,
    filterPlaceholder = 'Filter rows…',
  }: {
    table: SvelteTable<InsightsTableFeatures, TData>
    filterPlaceholder?: string
  } = $props()

  // SAFETY: Insights registers the global-filter feature with a string value, and this toolbar is its only writer.
  const filter = $derived((table.atoms.globalFilter.get() as string | undefined) ?? '')
  const filteredRows = $derived(table.getFilteredRowModel().rows.length)
  const allRows = $derived(table.getPreFilteredRowModel().rows.length)
</script>

<div class="flex min-w-0 items-center gap-2" data-insights-table-toolbar>
  <div
    class="group relative w-44 min-w-0 transition-[width] duration-200 ease-out focus-within:w-60 motion-reduce:transition-none"
  >
    <MagnifyingGlassIcon
      class="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-muted-foreground transition-colors group-focus-within:text-foreground"
      aria-hidden="true"
    />
    <Input
      aria-label="Filter table rows"
      class="h-8 rounded-full border-0 bg-[var(--wash-1)] pr-7 pl-8 text-insights-chrome shadow-[inset_0_0_0_0.5px_var(--hairline)] transition-[background-color,box-shadow] placeholder:text-muted-foreground/70 hover:bg-[var(--wash-2)] focus-visible:ring-0 focus-visible:shadow-[inset_0_0_0_1px_var(--ring),0_0_0_3px_color-mix(in_oklch,var(--ring)_12%,transparent)] pointer-coarse:h-10"
      placeholder={filterPlaceholder}
      value={filter}
      oninput={(event) => table.setGlobalFilter(event.currentTarget.value)}
    />
    {#if filter}
      <button
        type="button"
        class="absolute top-1/2 right-0.5 z-10 flex size-7 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full text-muted-foreground outline-none transition-[color,background-color,scale] hover:bg-[var(--wash-3)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.94]"
        aria-label="Clear table filter"
        onclick={() => table.setGlobalFilter('')}
      >
        <XIcon class="size-3" weight="bold" aria-hidden="true" />
      </button>
    {/if}
  </div>

  {#if filter && filteredRows !== allRows}
    <span class="hidden shrink-0 text-insights-chrome tabular-nums text-muted-foreground sm:inline">
      {filteredRows} of {allRows}
    </span>
  {/if}
</div>
