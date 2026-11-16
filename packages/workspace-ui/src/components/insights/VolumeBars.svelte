<script lang="ts" generics="Bucket extends { at: number; total: number }">
  import type { Snippet } from "svelte";
  import { scaleBand } from "d3-scale";
  import { curveMonotoneX } from "d3-shape";
  import { Axis, Bars, Chart, Highlight, Rule, Spline, Svg, Text, Tooltip, type TextProps } from "layerchart";
  import { TIME_AXIS_INSET_PX, TIME_AXIS_LABEL_GAP_PX } from "./lib/chart-axis";
  import { countAxisTicks, stackGapUnits, stackedSegment, type TimeSelection } from "./lib/volume";

  /**
   * Counts over time as stacked bars, and the drag that zooms them — the plot
   * of the Insights volume chart, and of an app's Activity chart.
   *
   * Each series is one segment of a bar, the first at the bottom. A line can
   * ride over the bars on its own right-hand axis (Insights spend); its rungs
   * sit on the count axis's rungs, so one set of gridlines rules both.
   *
   * The plot is as wide as its owner's box; an owner that cuts its buckets to
   * fit measures that box.
   *
   * Dragging across the plot brushes a time range. The owner decides what the
   * range narrows: Insights narrows the list below, Activity narrows its
   * query.
   */
  let {
    buckets,
    bucketWidthMs,
    series,
    ticks,
    formatTick,
    line,
    leftGutterPx,
    rightGutterPx,
    viewKey,
    emptyText = null,
    tooltip,
    onBrush,
    class: className = "",
  }: {
    buckets: Bucket[];
    /** Each bar's width in time: the brush's upper edge covers the last bar it touches. */
    bucketWidthMs: number;
    series: { key: string; fill: string; value: (bucket: Bucket) => number }[];
    /** Bucket starts the time axis names. */
    ticks: number[];
    formatTick: (at: number) => string;
    /** A line over the bars: its value in each bucket, its axis's top value, and how a rung reads. */
    line?: { value: (bucket: Bucket) => number; max: number; color: string; formatTick: (value: number) => string };
    leftGutterPx: number;
    rightGutterPx: number;
    /** A new key draws the chart again: the window it shows changed. */
    viewKey: string;
    /** Shown over an empty plot; null when the plot has something. */
    emptyText?: string | null;
    tooltip: Snippet<[Bucket]>;
    onBrush: (selection: TimeSelection | null) => void;
    class?: string;
  } = $props();

  let plotHeight = $state(0);
  const PLOT_TOP_PX = 4;

  const countTicks = $derived(countAxisTicks(Math.max(0, ...buckets.map((bucket) => bucket.total))));
  const countTop = $derived(countTicks[countTicks.length - 1]);
  const yMax = $derived(countTop * 1.08);
  /** A two-pixel sliver of card between a bar's segments, in rows: it is what
   *  lets the stack read as several quantities rather than one bar with a seam. */
  const stackGap = $derived(stackGapUnits(yMax, plotHeight - PLOT_TOP_PX - TIME_AXIS_INSET_PX));
  const showLine = $derived(line !== undefined && line.max > 0);
  /** The line's values are converted into bar heights on the way in and back on the way out. */
  const lineScale = $derived(line && line.max > 0 ? countTop / line.max : 0);

  /** The total of the series under series `index`, in one bucket. */
  function below(bucket: Bucket, index: number): number {
    let sum = 0;
    for (let at = 0; at < index; at++) sum += series[at].value(bucket);
    return sum;
  }

  /** The brush's own state, narrowed to the axis this chart reads. LayerChart
   *  keeps `BrushState` internal to its component module, so the shape is
   *  restated here rather than reaching into the package's private types. */
  type BrushSelectionState = {
    x: Array<number | Date | string | null>;
    reset: () => void;
  };

  // The brush reports the first and last selected category — bucket start times,
  // because that is the band domain. The upper edge extends to the end of the
  // last bucket so a one-bar selection still covers that bar's rows.
  function applyBrush(state: BrushSelectionState): void {
    const [first, last] = state.x;
    if (first == null || last == null || first instanceof Date || last instanceof Date) {
      onBrush(null);
      return;
    }
    const firstBucket = Number(first);
    const lastBucket = Number(last);
    if (!Number.isFinite(firstBucket) || !Number.isFinite(lastBucket)) {
      onBrush(null);
      return;
    }
    onBrush({ from: Math.min(firstBucket, lastBucket), to: Math.max(firstBucket, lastBucket) + bucketWidthMs });
    // The plot now renders the selected interval itself. Clear LayerChart's
    // transient overlay so it does not become a full-width rail after the zoom.
    state.reset();
  }
</script>

<div class="relative w-full cursor-crosshair {className}" bind:clientHeight={plotHeight}>
  {#key viewKey}
    <Chart
      data={buckets}
      x={(bucket: Bucket) => bucket.at}
      xScale={scaleBand().padding(0.3)}
      y={(bucket: Bucket) => bucket.total}
      yDomain={[0, yMax]}
      padding={{ left: leftGutterPx, bottom: TIME_AXIS_INSET_PX, right: rightGutterPx, top: PLOT_TOP_PX }}
      tooltipContext={{ mode: "band" }}
      brush={{
        axis: "x",
        // The selection is committed on release and immediately becomes the
        // viewport, so persistent resize rails add weight without utility.
        handleSize: 1,
        onBrushEnd: ({ brush }) => applyBrush(brush),
        // The range keeps the brush's own geometry: it sits in a panel with
        // no height, so a percentage height resolves to nothing and the drag
        // shows no range at all.
        classes: {
          range:
            "cursor-crosshair border-x border-[color-mix(in_oklch,var(--solus-art-1)_55%,transparent)] bg-[color-mix(in_oklch,var(--solus-art-1)_12%,transparent)]",
          handle: "opacity-0",
        },
      }}
    >
      <Svg>
        <!-- Bars with no scale beside them are a shape, not a quantity: three
             whole-row ticks are the fewest that say how tall the tall one is
             without turning the plot into a grid, and the zero gridline
             doubles as the baseline the bars stand on. -->
        <Axis
          placement={showLine ? "right" : "left"}
          grid={showLine ? false : { class: "stroke-[var(--hairline)]" }}
          ticks={countTicks}
          tickMarks={false}
          format={(value: unknown) => String(Math.round(Number(value)))}
          classes={{ tickLabel: "text-xs tabular-nums fill-[var(--muted-foreground)]" }}
        />
        {#if line && showLine}
          <!-- The line leads on the left and supplies the shared gridlines. -->
          <Axis
            placement="left"
            grid={{ class: "stroke-[var(--hairline)]" }}
            ticks={countTicks}
            tickMarks={false}
            format={(value: unknown) => line.formatTick(Number(value) / lineScale)}
            classes={{ tickLabel: "text-xs tabular-nums fill-[var(--muted-foreground)]" }}
          />
        {/if}
        <!-- Bucket starts, not evenly-spaced instants: a band scale only
             places a tick that is one of its own categories. -->
        <Axis
          placement="bottom"
          {ticks}
          tickMarks={false}
          tickLength={0}
          tickLabelProps={{ dy: TIME_AXIS_LABEL_GAP_PX }}
          format={(value: unknown) => formatTick(Number(value))}
          classes={{ tickLabel: "text-xs tabular-nums fill-[var(--muted-foreground)]" }}
        >
          <!-- The end labels are centred on their bar, which for the first and
               last bar hangs half a timestamp off the plot and gets cut by the
               card. Anchoring them inward keeps the window's own bounds
               readable, which is the pair the reader most needs. -->
          {#snippet tickLabel({ props, index }: { props: TextProps; index: number })}
            <Text {...props} textAnchor={index === 0 ? "start" : index === ticks.length - 1 ? "end" : "middle"} />
          {/snippet}
        </Axis>
        <Highlight area={{ class: "fill-[var(--wash-2)]" }} />
        <!-- The bars stand on a baseline a shade firmer than the rungs
             above it, so zero reads as the floor and not as one more
             gridline. -->
        <Rule y={0} class="stroke-[var(--hairline-strongest)]" />
        <!-- Each upper segment is lifted off the one below by a sliver of
             card, so the stack reads as separate quantities, not one bar with
             a seam drawn across it. -->
        {#each series as part, index (part.key)}
          <Bars
            y={(bucket: Bucket) =>
              index === 0 ? [0, part.value(bucket)] : stackedSegment(below(bucket, index), below(bucket, index) + part.value(bucket), stackGap)}
            rounded="top"
            radius={3}
            fill={part.fill}
          />
        {/each}
        {#if line && showLine}
          <!-- Drawn last so it reads over the bars, and deaf to the pointer so
               a drag that starts on the line still brushes the plot.

               Monotone, not a general spline: it smooths the corners a
               bucketed series puts in the path without inventing a peak
               between two buckets or dipping below a run of equal ones.

               A ring of card under the line keeps it legible where it
               crosses a bar: the two colours never touch, so the line
               stays a line and the bar's edge stays an edge. -->
          <Spline
            y={(bucket: Bucket) => line.value(bucket) * lineScale}
            curve={curveMonotoneX}
            stroke="var(--card)"
            class="pointer-events-none fill-none stroke-[5]"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <Spline
            y={(bucket: Bucket) => line.value(bucket) * lineScale}
            curve={curveMonotoneX}
            stroke={line.color}
            class="pointer-events-none fill-none stroke-[2]"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        {/if}
      </Svg>
      <Tooltip.Root variant="none" classes={{ root: "rounded-lg bg-card px-2.5 py-1.5 shadow-[shadow:var(--solus-menu-shadow)]" }}>
        {#snippet children({ data }: { data: Bucket })}
          {@render tooltip(data)}
        {/snippet}
      </Tooltip.Root>
    </Chart>
  {/key}
  {#if emptyText}
    <span class="pointer-events-none absolute inset-0 flex items-center justify-center text-insights-summary text-muted-foreground">{emptyText}</span>
  {/if}
</div>
