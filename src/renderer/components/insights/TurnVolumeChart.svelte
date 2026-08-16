<script lang="ts">
  import { scaleBand } from "d3-scale";
  import { Bars, BrushContext, Chart, Svg } from "layerchart";
  import { XIcon } from "phosphor-svelte";
  import { formatClock, formatCost, formatDuration, formatPercent } from "./lib/format";
  import {
    bucketTurns,
    volumeAxisTicks,
    volumeStats,
    type TimeSelection,
    type VolumeBucket,
  } from "./lib/volume";
  import type { TurnRow } from "./lib/turn-rows";

  /**
   * Turn volume across the window — the shape every answer sits in.
   *
   * Two bar layers rather than a stack: the first is every turn, the second is
   * the failed ones drawn from the same baseline, so a bar's full height is the
   * volume and its red foot is the failures. Reading either quantity never
   * requires subtracting one from the other.
   *
   * Dragging across the plot brushes a time range, which narrows the list below
   * without re-running the query — the histogram is context, not the question.
   */
  interface Props {
    rows: TurnRow[];
    from: number;
    to: number;
    selection: TimeSelection | null;
    onSelectionChange: (selection: TimeSelection | null) => void;
    /** Rows after the selection is applied — what the stat line describes. */
    selectedRows: TurnRow[];
  }

  let { rows, from, to, selection, onSelectionChange, selectedRows }: Props = $props();

  const buckets = $derived(bucketTurns(rows, from, to));
  const bucketWidthMs = $derived(buckets.length > 1 ? buckets[1].at - buckets[0].at : to - from);
  const stats = $derived(volumeStats(selectedRows));
  const ticks = $derived(volumeAxisTicks(from, to));

  const summary = $derived([
    { label: "Turns", value: String(stats.turns), tone: "var(--foreground)" },
    {
      label: "Spend",
      value: formatCost(stats.totalCostUsd),
      tone: "var(--foreground)",
    },
    { label: "p95", value: formatDuration(stats.p95DurationMs), tone: "var(--foreground)" },
    {
      label: "Failed",
      value: formatPercent(stats.failureRate),
      tone: stats.failed > 0 ? "var(--failure)" : "var(--foreground)",
    },
  ]);

  const selectionLabel = $derived(
    selection ? `${formatClock(selection.from)}–${formatClock(selection.to)}` : "",
  );

  /** The brush's own state, narrowed to the axis this chart reads. LayerChart
   *  keeps `BrushState` internal to its component module, so the shape is
   *  restated here rather than reaching into the package's private types. */
  type BrushSelectionState = { x: Array<number | Date | string | null> };

  // The brush reports the first and last selected category — bucket start times,
  // because that is the band domain. The upper edge extends to the end of the
  // last bucket so a one-bar selection still covers that bar's turns.
  function applyBrush(state: BrushSelectionState): void {
    const [first, last] = state.x;
    if (typeof first !== "number" || typeof last !== "number") {
      onSelectionChange(null);
      return;
    }
    onSelectionChange({ from: Math.min(first, last), to: Math.max(first, last) + bucketWidthMs });
  }
</script>

<section
  class="flex shrink-0 flex-col gap-1.5 rounded-xl bg-card px-4 py-2.5 shadow-[shadow:var(--elev-ring)]"
  aria-label="Turn volume"
>
  <header class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
    <h2 class="text-xs font-medium">Turns over the last 24 hours</h2>
    {#if selection}
      <span
        class="flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[0.6875rem]"
        style="background:color-mix(in oklch, var(--primary) 12%, transparent);color:var(--primary)"
      >
        {selectionLabel} · {selectedRows.length} turns
        <button
          type="button"
          class="flex cursor-pointer opacity-70 transition-opacity hover:opacity-100"
          onclick={() => onSelectionChange(null)}
          aria-label="Clear the time selection"
        >
          <XIcon size={9} weight="bold" />
        </button>
      </span>
    {/if}
    <span class="flex-1"></span>
    {#each summary as stat (stat.label)}
      <span class="flex items-baseline gap-1.5">
        <span
          class="text-[0.5938rem] font-medium text-muted-foreground uppercase"
          >{stat.label}</span
        >
        <span class="text-xs font-medium tabular-nums" style="color:{stat.tone}">{stat.value}</span>
      </span>
    {/each}
  </header>

  <div class="h-[4.375rem] w-full">
    {#key buckets.length}
      <Chart
        data={buckets}
        x={(bucket: VolumeBucket) => bucket.at}
        xScale={scaleBand().padding(0.2)}
        y={(bucket: VolumeBucket) => bucket.total}
        yDomain={[0, null]}
        padding={{ bottom: 1 }}
      >
        <Svg>
          <Bars rounded="top" radius={2} class="fill-[var(--solus-art-5)]" />
          <Bars
            y={(bucket: VolumeBucket) => bucket.failed}
            rounded="none"
            class="fill-[var(--failure)]"
          />
        </Svg>
        <BrushContext
          axis="x"
          onBrushEnd={({ brush }) => applyBrush(brush)}
          classes={{
            range: "bg-[color-mix(in_oklch,var(--primary)_10%,transparent)]",
            handle: "bg-(--primary)",
          }}
        />
      </Chart>
    {/key}
  </div>

  <div
    class="flex shrink-0 justify-between text-[0.625rem] text-muted-foreground opacity-80"
    aria-hidden="true"
  >
    {#each ticks as tick (tick)}
      <span class="tabular-nums">{formatClock(tick)}</span>
    {/each}
  </div>
</section>
