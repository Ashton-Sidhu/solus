<script lang="ts">
  import { Axis, Chart, Points, Spline, Svg } from "layerchart";
  import { formatClock, formatDayClock, formatDuration, formatTokens } from "./lib/format";
  import type { TrendPoint } from "./lib/result-shape";

  /**
   * One numeric series over time — the "over time" half of a span-grained or
   * bucketed answer.
   *
   * Raw instants draw as a scatter (they are observations, not a continuous
   * quantity); bucketed aggregates connect as a line through their points. One
   * series, one axis — a second measure belongs in the table below, never on a
   * second y scale. Failed events keep the reserved status colour; everything
   * else wears the one series hue the caller passes.
   */
  interface Props {
    points: TrendPoint[];
    mark: "points" | "line";
    valueFormat: "duration" | "number";
    /** Series hue — the span kind's fixed colour where the grain names one. */
    color?: string;
  }

  let { points, mark, valueFormat, color = "var(--solus-art-5)" }: Props = $props();

  const okPoints = $derived(points.filter((point) => !point.failed));
  const failedPoints = $derived(points.filter((point) => point.failed));
  // Query order is whatever the SQL said, so the extent is computed, not read
  // off the ends.
  const from = $derived(points.reduce((min, point) => Math.min(min, point.at), Infinity));
  const to = $derived(points.reduce((max, point) => Math.max(max, point.at), -Infinity));
  const spansDays = $derived(to - from > 24 * 60 * 60 * 1000);

  const timeTicks = $derived(
    [0, 1, 2, 3].map((step) => Math.round(from + ((to - from) / 3) * step)),
  );

  function formatValue(value: number): string {
    if (valueFormat === "duration") return formatDuration(value);
    if (Math.abs(value) >= 1000) return formatTokens(value);
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
</script>

<div class="h-36 w-full">
  {#key points}
    <Chart
      data={points}
      x={(point: TrendPoint) => point.at}
      xDomain={[from, to]}
      y={(point: TrendPoint) => point.value}
      yDomain={[0, null]}
      padding={{ left: 44, top: 6, bottom: 4, right: 6 }}
    >
      <Svg>
        <Axis
          placement="left"
          grid={{ class: "stroke-[var(--hairline)]" }}
          ticks={3}
          tickMarks={false}
          format={(value: unknown) => formatValue(Number(value))}
          classes={{ tickLabel: "text-[0.625rem] fill-[var(--muted-foreground)]" }}
        />
        {#if mark === "line"}
          <Spline stroke={color} class="fill-none stroke-2" />
        {/if}
        <Points data={okPoints} r={mark === "line" ? 2.5 : 3} fill={color} />
        {#if failedPoints.length > 0}
          <Points data={failedPoints} r={3} fill="var(--failure)" />
        {/if}
      </Svg>
    </Chart>
  {/key}
</div>
<div
  class="flex shrink-0 justify-between pl-11 text-[0.625rem] text-muted-foreground opacity-80"
  aria-hidden="true"
>
  {#each timeTicks as tick (tick)}
    <span class="tabular-nums">{spansDays ? formatDayClock(tick) : formatClock(tick)}</span>
  {/each}
</div>
