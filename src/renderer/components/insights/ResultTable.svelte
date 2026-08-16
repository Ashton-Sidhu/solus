<script lang="ts">
  import type { MetricsQueryResult, MetricsValue } from "../../../shared/observability-types";

  /**
   * Any result that is not a turn listing: a rollup, a tool-call table, a
   * grouped count. Rendered as a plain grid rather than forced into the turn
   * shape — a grouped answer is a legitimate answer, and pretending it has a
   * waterfall behind it would be a lie.
   *
   * Numbers are right-aligned and tabular, so a column of durations or costs
   * still scans as a column.
   */
  interface Props {
    result: MetricsQueryResult;
  }

  let { result }: Props = $props();

  /** A column is numeric when every non-null cell in it is. Alignment follows
   *  the data, not the column name, because SQL can alias anything. */
  const numericColumns = $derived(
    result.columns.map((_, index) =>
      result.rows.some((row) => row[index] != null) &&
      result.rows.every((row) => row[index] == null || typeof row[index] === "number"),
    ),
  );

  const template = $derived(
    result.columns.map((_, index) => (numericColumns[index] ? "minmax(6rem,auto)" : "minmax(8rem,1fr)")).join(" "),
  );

  function display(value: MetricsValue): string {
    if (value == null) return "—";
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(3);
    return value;
  }
</script>

<section
  class="flex min-h-35 flex-1 flex-col overflow-hidden rounded-xl bg-card shadow-[shadow:var(--elev-ring)]"
  aria-label="Query result"
>
  <header
    class="flex h-10 shrink-0 items-center gap-3 px-4 shadow-[inset_0_-0.5px_0_var(--hairline)]"
  >
    <h2 class="text-xs font-medium">Result</h2>
    <span class="text-[0.6875rem] tabular-nums text-muted-foreground"
      >{result.rows.length} {result.rows.length === 1 ? "row" : "rows"} · {result.columns.length} columns</span
    >
  </header>

  <div class="min-h-0 flex-1 overflow-auto" data-sb>
    <div class="min-w-full" style="width:max-content">
      <div
        class="sticky top-0 z-10 grid h-7.5 items-center gap-4 bg-card px-4 text-[0.5938rem] font-medium text-muted-foreground uppercase shadow-[inset_0_-0.5px_0_var(--hairline-strong)]"
        style="grid-template-columns:{template}"
      >
        {#each result.columns as column, index (column)}
          <span class="truncate" style="text-align:{numericColumns[index] ? 'right' : 'left'}"
            >{column}</span
          >
        {/each}
      </div>

      {#if result.rows.length === 0}
        <p class="px-4 py-16 text-center text-xs text-muted-foreground">
          The query ran and returned no rows.
        </p>
      {:else}
        {#each result.rows as row, rowIndex (rowIndex)}
          <div
            class="grid h-8 items-center gap-4 px-4 shadow-[inset_0_-0.5px_0_var(--hairline)] transition-colors hover:bg-muted"
            style="grid-template-columns:{template}"
          >
            {#each row as cell, cellIndex (cellIndex)}
              <span
                class="truncate text-xs"
                class:tabular-nums={numericColumns[cellIndex]}
                style="text-align:{numericColumns[cellIndex] ? 'right' : 'left'}"
                title={display(cell)}>{display(cell)}</span
              >
            {/each}
          </div>
        {/each}
      {/if}
      <div class="h-3"></div>
    </div>
  </div>
</section>
