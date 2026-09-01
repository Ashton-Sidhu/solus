<script lang="ts">
  import {
    Area,
    Axis,
    Chart,
    Highlight,
    Points,
    Spline,
    Svg,
    Text,
    Tooltip,
    type TextProps,
  } from "layerchart";
  import type { TrendLine, TrendPoint } from "./lib/chart-shape";
  import { TIME_AXIS_INSET_PX, TIME_AXIS_LABEL_GAP_PX } from "./lib/chart-axis";
  import { axisInstantFormat, formatClock, formatDayClock, formatMeasure } from "./lib/format";
  import { colorForSeries } from "./lib/span-palette";

  /**
   * One measure over time, as one line per series — the "over time" half of a
   * span-grained or grouped answer.
   *
   * Raw instants draw as a scatter (they are observations, not a continuous
   * quantity); bucketed aggregates connect as a line through their points. One
   * measure, one axis — a second measure belongs in the table below, never on a
   * second y scale. A result that grouped by a dimension draws one line per
   * value of it: a single line through rows that differ in that dimension
   * states a change nobody measured. Everything else wears its series hue, in
   * the ramp's fixed order.
   *
   * Two or more series always carry a legend, so identity is never colour
   * alone. Hit detection is `quadtree` — the nearest point to the cursor rather
   * than the nearest x — because a scatter's answer to "what is that outlier"
   * has to survive two observations sharing a minute, and because with several
   * lines the nearest x is ambiguous by construction.
   *
   * Failed points wear the art ramp's own negative rather than `--failure`; see
   * VolumeChart. Where a point stands for one row, it also carries that row's
   * drill path, so the outlier the eye found is one click from its detail.
   */
  interface Props {
    lines: TrendLine[];
    mark: "points" | "line";
    valueFormat: "duration" | "number";
    /** Series the palette had no hue for; stated rather than dropped in silence. */
    hiddenSeries?: number;
    /** Hue for a result with one series — the span kind's fixed colour where the
     *  grain names one. Ignored once the answer breaks into several. */
    color?: string;
    /** Names the quantity in the tooltip: "duration", "turns", … */
    valueLabel?: string;
    /** Opens the row behind a point. Absent for bucketed aggregates, which
     *  stand for many rows and so have nothing single to open. */
    onSelect?: (point: TrendPoint) => void;
  }

  let {
    lines,
    mark,
    valueFormat,
    hiddenSeries = 0,
    color = "var(--solus-art-5)",
    valueLabel = "",
    onSelect,
  }: Props = $props();

  const split = $derived(lines.length > 1);
  const series = $derived(
    lines.map((line, index) => ({
      ...line,
      color: split ? colorForSeries(index) : color,
      ok: line.points.filter((point) => !point.failed),
      failed: line.points.filter((point) => point.failed),
    })),
  );
  const points = $derived(series.flatMap((line) => line.points));
  const colorByLabel = $derived(new Map(series.map((line) => [line.label, line.color])));

  // Query order is whatever the SQL said, so the extent is computed, not read
  // off the ends.
  const from = $derived(points.reduce((min, point) => Math.min(min, point.at), Infinity));
  const to = $derived(points.reduce((max, point) => Math.max(max, point.at), -Infinity));
  const spansDays = $derived(to - from > 24 * 60 * 60 * 1000);

  /** The chart family's own negative, not the cold `--failure` red the buttons
   *  and status pills use. See VolumeChart for why. */
  const FAILED_COLOR = "var(--solus-art-negative)";

  /** Explicit tick values rather than a count: d3 rounds a linear domain to
   *  neat numbers, and a neat number of epoch milliseconds is an arbitrary
   *  instant. Four evenly spaced instants across the extent name the window the
   *  chart actually draws. */
  const timeTicks = $derived(
    [0, 1, 2, 3].map((step) => Math.round(from + ((to - from) / 3) * step)),
  );

  function formatValue(value: number): string {
    return formatMeasure(value, valueFormat);
  }

  function formatInstant(at: number): string {
    return spansDays ? formatDayClock(at) : formatClock(at);
  }

  /** The axis has no room for a full timestamp on a multi-day extent; the
   *  tooltip names the exact instant. */
  const formatTick = $derived(axisInstantFormat(to - from));
</script>

{#if split}
  <!-- Always present at two or more series: the hue alone does not say which
       model, and the reader should not have to hover to find out. -->
  <ul class="flex flex-wrap items-center gap-x-3 gap-y-1 pb-1 pl-11.5" aria-label="Series">
    {#each series as line (line.label)}
      <li class="flex items-center gap-1.5 text-insights-summary text-muted-foreground">
        <span class="size-2 shrink-0 rounded-sm" style="background:{line.color}"></span>
        <span class="max-w-40 truncate" title={line.label}>{line.label}</span>
      </li>
    {/each}
    {#if hiddenSeries > 0}
      <li class="text-insights-summary text-muted-foreground opacity-70">
        +{hiddenSeries} more, in the table below
      </li>
    {/if}
  </ul>
{/if}

<div
  class="h-56 w-full sm:h-48 sm:[@media(min-height:1000px)]:h-64 pointer-fine:[.is-laptop-display_&]:h-48 {onSelect
    ? 'cursor-pointer'
    : 'cursor-crosshair'}"
>
  {#key points}
    <Chart
      data={points}
      x={(point: TrendPoint) => point.at}
      xDomain={[from, to]}
      y={(point: TrendPoint) => point.value}
      yDomain={[0, null]}
      padding={{ left: 46, top: 8, bottom: TIME_AXIS_INSET_PX, right: 24 }}
      tooltipContext={{
        mode: "quadtree",
        onclick: (_event: MouseEvent, detail: { data: TrendPoint | null }) => {
          if (detail.data) onSelect?.(detail.data);
        },
      }}
    >
      <Svg>
        <Axis
          placement="left"
          grid={{ class: "stroke-[var(--hairline)]" }}
          ticks={3}
          tickMarks={false}
          format={(value: unknown) => formatValue(Number(value))}
          classes={{ tickLabel: "text-insights-summary tabular-nums fill-[var(--muted-foreground)]" }}
        />
        <Axis
          placement="bottom"
          ticks={timeTicks}
          tickMarks={false}
          tickLength={0}
          tickLabelProps={{ dy: TIME_AXIS_LABEL_GAP_PX }}
          format={(value: unknown) => formatTick(Number(value))}
          classes={{ tickLabel: "text-insights-summary tabular-nums fill-[var(--muted-foreground)]" }}
        >
          <!-- The end labels sit on the extent itself, so centred they hang half
               a timestamp off the plot and get cut by the card. -->
          {#snippet tickLabel({ props, index }: { props: TextProps; index: number })}
            <Text
              {...props}
              textAnchor={index === 0
                ? "start"
                : index === timeTicks.length - 1
                  ? "end"
                  : "middle"}
            />
          {/snippet}
        </Axis>
        {#each series as line (line.label)}
          {#if mark === "line"}
            <!-- One stroke per run of consecutive buckets. A bucket nothing
                 happened in returns no row, and a stroke across the hole would
                 draw a continuity nobody measured; the dot for each end of the
                 run stays, so an isolated bucket still shows. -->
            {#each line.segments as segment, index (index)}
              {#if segment.length > 1}
                <!-- A flat 10% wash, not a gradient fading to nothing: the fade
                     reads as a rendering effect rather than a quantity, and it
                     is the first thing that makes a chart look generic. Left off
                     once the answer splits — overlapping washes read as a
                     stacked quantity nobody computed. -->
                {#if !split}
                  <Area data={segment} fill={color} fill-opacity={0.1} />
                {/if}
                <Spline
                  data={segment}
                  stroke={line.color}
                  class="fill-none stroke-2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              {/if}
            {/each}
          {/if}
          <!-- A ring in the surface colour, not a stroke around the mark: it is
               what keeps a dot legible where it crosses its own line or another
               series, and it enlarges the hover target with it. -->
          <Points
            data={line.ok}
            r={mark === "line" ? 3 : 3.5}
            fill={line.color}
            class="stroke-2 stroke-(--card)"
          />
          {#if line.failed.length > 0}
            <Points data={line.failed} r={3.5} fill={FAILED_COLOR} class="stroke-2 stroke-(--card)" />
          {/if}
        {/each}
        <!-- The hovered observation, restated: a ring the cursor cannot cover,
             and the lines to the axes that say which instant and value it is. -->
        <Highlight
          axis="both"
          lines={{ class: "stroke-[var(--hairline-strongest)]" }}
          points={{
            r: 4.5,
            class: "stroke-2 fill-(--card)",
            // One series has a hue to echo; several do not, so the ring stays
            // neutral rather than claiming the wrong line's identity.
            style: `stroke:${split ? "var(--foreground)" : color}`,
          }}
        />
      </Svg>
      <Tooltip.Root
        variant="none"
        classes={{
          root: "rounded-lg bg-card px-2.5 py-1.5 shadow-[shadow:var(--solus-menu-shadow)]",
        }}
      >
        {#snippet children({ data }: { data: TrendPoint })}
          <div class="flex flex-col gap-0.5 text-insights-summary">
            <span class="tabular-nums whitespace-nowrap text-muted-foreground"
              >{formatInstant(data.at)}</span
            >
            {#if data.series}
              <span class="flex items-center gap-1.5">
                <span
                  class="size-2 shrink-0 rounded-sm"
                  style="background:{colorByLabel.get(data.series) ?? color}"
                ></span>
                <span class="whitespace-nowrap">{data.series}</span>
              </span>
            {/if}
            <span class="flex items-baseline gap-1.5">
              <span
                class="text-insights-summary font-medium tabular-nums"
                style="color:{data.failed ? FAILED_COLOR : 'var(--foreground)'}"
                >{formatValue(data.value)}</span
              >
              {#if valueLabel}
                <span class="text-muted-foreground">{valueLabel}</span>
              {/if}
            </span>
            {#if data.failed}
              <span style="color:{FAILED_COLOR}">failed</span>
            {/if}
            {#if onSelect}
              <span class="text-muted-foreground">Click to open</span>
            {/if}
          </div>
        {/snippet}
      </Tooltip.Root>
    </Chart>
  {/key}
</div>
