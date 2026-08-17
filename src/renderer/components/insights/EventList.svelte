<script lang="ts">
  import type { MetricsValue } from "../../../shared/observability-types";
  import {
    formatClock,
    formatDayClock,
    formatDuration,
    formatPercent,
  } from "./lib/format";
  import { eventStats, type EventColumn, type EventRow, type EventTable } from "./lib/result-shape";
  import { colorForKind, labelForKind } from "./lib/span-palette";
  import ResultTrendChart from "./ResultTrendChart.svelte";

  /**
   * The event listing: one row per span from a single non-turn view.
   *
   * The scatter above the table is the "over time" answer — each event placed
   * at its instant, sized by nothing, coloured by its kind's fixed hue with
   * failures in the status colour. The table below is the exact answer, with
   * times and durations formatted rather than left as epoch numbers.
   *
   * Identity columns ride along in the result but are not rendered; they are
   * what lets a row open its turn's waterfall with this span selected.
   */
  interface Props {
    table: EventTable;
    view: string;
    kind: string;
    /** Rows after the histogram brush narrowed them. */
    rows: EventRow[];
    onOpenSpan: (traceId: string, spanId: string | null) => void;
    /** Shown under the empty state — why nothing matched, in the user's terms. */
    emptyHint: string;
  }

  let { table, view, kind, rows, onOpenSpan, emptyHint }: Props = $props();

  const title = $derived(kind ? labelForKind(kind) : view.replace(/_/g, " "));
  const seriesColor = $derived(colorForKind(kind));
  const stats = $derived(eventStats(rows));

  const summary = $derived([
    { label: "Events", value: String(stats.events), tone: "var(--foreground)" },
    { label: "p50", value: formatDuration(stats.p50DurationMs), tone: "var(--foreground)" },
    { label: "p95", value: formatDuration(stats.p95DurationMs), tone: "var(--foreground)" },
    {
      label: "Failed",
      value: formatPercent(stats.failureRate),
      tone: stats.failed > 0 ? "var(--failure)" : "var(--foreground)",
    },
  ]);

  const trendPoints = $derived(
    rows
      .filter((row) => row.durationMs != null)
      .map((row) => ({
        at: row.startedAt,
        value: row.durationMs ?? 0,
        failed: row.status === "error" || row.status === "interrupted",
      })),
  );

  const spansDays = $derived.by(() => {
    if (rows.length < 2) return false;
    let earliest = Infinity;
    let latest = -Infinity;
    for (const row of rows) {
      earliest = Math.min(earliest, row.startedAt);
      latest = Math.max(latest, row.startedAt);
    }
    return latest - earliest > 24 * 60 * 60 * 1000;
  });

  const template = $derived(
    table.columns
      .map((column) => (column.numeric || column.format !== "raw" ? "minmax(6rem,auto)" : "minmax(8rem,1fr)"))
      .join(" "),
  );

  function cellText(column: EventColumn, value: MetricsValue): string {
    if (value == null) return "—";
    if (column.format === "time" && typeof value === "number") {
      return spansDays ? formatDayClock(value) : formatClock(value);
    }
    if (column.format === "duration" && typeof value === "number") return formatDuration(value);
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(3);
    return value;
  }

  function cellColor(column: EventColumn, row: EventRow): string {
    if (column.format !== "status") return "var(--foreground)";
    if (row.status === "error") return "var(--failure)";
    if (row.status === "interrupted") return "var(--warning)";
    return "var(--muted-foreground)";
  }

  function open(row: EventRow): void {
    if (row.traceId) onOpenSpan(row.traceId, row.spanId);
  }
</script>

{#snippet eventCells(row: EventRow)}
  {#each row.cells as cell, cellIndex (cellIndex)}
    {@const column = table.columns[cellIndex]}
    <span
      class="truncate text-xs"
      class:tabular-nums={column.numeric || column.format !== "raw"}
      style="text-align:{column.numeric ? 'right' : 'left'};color:{cellColor(column, row)}"
      title={cellText(column, cell)}>{cellText(column, cell)}</span
    >
  {/each}
{/snippet}

<section
  class="flex min-h-35 flex-1 flex-col overflow-hidden rounded-xl bg-card shadow-[shadow:var(--elev-ring)]"
  aria-label="Events"
>
  <header
    class="flex h-10 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-4 shadow-[inset_0_-0.5px_0_var(--hairline)]"
  >
    <h2 class="flex items-center gap-1.5 text-xs font-medium">
      <span class="size-2 rounded-sm" style="background:{seriesColor}"></span>
      {title}
    </h2>
    <span class="text-[0.6875rem] tabular-nums text-muted-foreground"
      >{rows.length} of {table.rows.length}</span
    >
    <span class="flex-1"></span>
    {#each summary as stat (stat.label)}
      <span class="flex items-baseline gap-1.5">
        <span class="text-[0.5938rem] font-medium text-muted-foreground uppercase"
          >{stat.label}</span
        >
        <span class="text-xs font-medium tabular-nums" style="color:{stat.tone}">{stat.value}</span>
      </span>
    {/each}
  </header>

  {#if trendPoints.length >= 2}
    <div class="shrink-0 px-4 pt-2 pb-1 shadow-[inset_0_-0.5px_0_var(--hairline)]">
      <ResultTrendChart
        points={trendPoints}
        mark="points"
        valueFormat="duration"
        color={seriesColor}
      />
    </div>
  {/if}

  <div class="min-h-0 flex-1 overflow-auto" data-sb>
    <div class="min-w-full" style="width:max-content">
      <div
        class="sticky top-0 z-10 grid h-7.5 items-center gap-4 bg-card px-4 text-[0.5938rem] font-medium text-muted-foreground uppercase shadow-[inset_0_-0.5px_0_var(--hairline-strong)]"
        style="grid-template-columns:{template}"
      >
        {#each table.columns as column (column.name)}
          <span class="truncate" style="text-align:{column.numeric ? 'right' : 'left'}"
            >{column.name}</span
          >
        {/each}
      </div>

      {#if rows.length === 0}
        <div class="flex flex-col items-center gap-2 py-16 text-muted-foreground">
          <span class="text-xs">No events match this query</span>
          <span class="text-[0.625rem]">{emptyHint}</span>
        </div>
      {:else}
        {#each rows as row, rowIndex (rowIndex)}
          {#if row.traceId != null}
            <div
              class="grid h-8 cursor-pointer items-center gap-4 px-4 transition-colors hover:bg-muted"
              style="grid-template-columns:{template};box-shadow:inset 0 -0.5px 0 var(--hairline)"
              role="button"
              tabindex="0"
              title="Open this span in its turn's waterfall"
              onclick={() => open(row)}
              onkeydown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  open(row);
                }
              }}
            >
              {@render eventCells(row)}
            </div>
          {:else}
            <div
              class="grid h-8 items-center gap-4 px-4"
              style="grid-template-columns:{template};box-shadow:inset 0 -0.5px 0 var(--hairline)"
            >
              {@render eventCells(row)}
            </div>
          {/if}
        {/each}
      {/if}
      <div class="h-3"></div>
    </div>
  </div>
</section>
