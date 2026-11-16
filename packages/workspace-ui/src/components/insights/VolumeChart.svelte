<script lang="ts">
  import { Button } from "../ui/button";
  import VolumeBars from "./VolumeBars.svelte";
  import {
    axisInstantFormat,
    formatClock,
    formatCost,
    formatCostTick,
    formatDayClock,
    formatDuration,
  } from "./lib/format";
  import {
    bucketCountForWidth,
    bucketPoints,
    bucketAxisTicks,
    costAxisMax,
    pointsWithinSelection,
    providerTotals,
    rebucketVolume,
    volumeStats,
    volumeViewport,
    type TimeSelection,
    type VolumeBucket,
    type VolumePoint,
    type VolumeStats,
  } from "./lib/volume";
  import type { MetricsTurnVolumeBucket } from "@solus/contracts/observability-types";

  /**
   * How many rows the answer holds, across the window it covers.
   *
   * The bars count whatever the answer lists — turns for a turn listing, spans
   * for an event listing — so narrowing the question narrows the picture with
   * it. Only when the answer places nothing in time does the chart fall back to
   * turn volume, as the context an empty answer is missing from.
   *
   * The bars stack the two agent providers. Provider is a stable dimension of
   * the work; completion status remains in the listing instead of turning a
   * small number of failed rows into the loudest mark on the volume plot.
   *
   * A spend line rides over the bars on its own right-hand axis. The bars say
   * how much work a window holds; the line answers the question that follows —
   * whether the busy window was also the expensive one — which a second stacked
   * series could not, spend and count having no common unit. The line combines
   * every provider's recorded cost and is absent entirely from an answer that
   * records no spend.
   *
   * Dragging across the plot brushes a time range, which narrows the list below
   * without re-running the query — the brush filters the answer, it is not the
   * question.
   */
  interface Props {
    /** Every counted row, before the brush — the bars must not collapse into
     *  the selection the user just made on them. */
    points: VolumePoint[];
    /** Full-dataset aggregates for a server-paged turn listing. */
    aggregateBuckets?: MetricsTurnVolumeBucket[];
    aggregateStats?: VolumeStats;
    /** Names what is counted and over what window, in words. */
    heading: string;
    /** What one bar counts, for the stat line: "Turns", "Tool calls", … */
    countLabel: string;
    from: number;
    to: number;
    selection: TimeSelection | null;
    onSelectionChange: (selection: TimeSelection | null) => void;
  }

  let {
    points,
    aggregateBuckets,
    aggregateStats,
    heading,
    countLabel,
    from,
    to,
    selection,
    onSelectionChange,
  }: Props = $props();

  /** The plot's own width, so the bucket count — and with it the bar width —
   *  follows the space the card was given rather than a constant. */
  let plotWidth = $state(0);
  const AXIS_GUTTER_PX = 46;

  /** Whether the answer records spend at all, read off the rows rather than the
   *  buckets: both gutters have to be reserved before the bucket count — and
   *  so the bucket widths — can be derived from the space that remains. */
  const hasCostSignal = $derived(
    aggregateBuckets
      ? aggregateBuckets.some((bucket) => bucket.costedCount > 0)
      : points.some((point) => point.costUsd != null),
  );
  const leftGutterPx = $derived(hasCostSignal ? 64 : AXIS_GUTTER_PX);
  const rightGutterPx = $derived(hasCostSignal ? AXIS_GUTTER_PX : 12);

  const viewport = $derived(volumeViewport(from, to, selection));
  const buckets = $derived.by(() => {
    const count = bucketCountForWidth(plotWidth - leftGutterPx - rightGutterPx);
    return aggregateBuckets
      ? rebucketVolume(aggregateBuckets, viewport.from, viewport.to, count)
      : bucketPoints(points, viewport.from, viewport.to, count);
  });
  const bucketWidthMs = $derived(
    buckets.length > 1
      ? buckets[1].at - buckets[0].at
      : viewport.to - viewport.from,
  );
  const selectedPoints = $derived(pointsWithinSelection(points, selection));
  const stats = $derived(aggregateStats ?? volumeStats(selectedPoints));
  // One label per ~190px. A wide plot with five labels leaves the reader
  // measuring by eye across a quarter of a week.
  const ticks = $derived(
    bucketAxisTicks(
      buckets,
      Math.min(9, Math.max(3, Math.round(plotWidth / 190))),
    ),
  );
  /** The spend axis's top value. Its rungs sit on the count axis's rungs, so one
   *  set of gridlines rules both. */
  const costMax = $derived(costAxisMax(buckets));
  const showCost = $derived(hasCostSignal && costMax > 0);

  /** The legend and tooltip use the provider colours; bars use softer fills. */
  const CLAUDE_FILL = "var(--insights-provider-claude)";
  const CODEX_FILL = "var(--insights-provider-codex)";
  const UNKNOWN_FILL =
    "color-mix(in oklch, var(--muted-foreground) 38%, var(--card))";
  /**
   * The spend line uses blue to distinguish cost from provider counts.
   * Its light and dark values are set in `workspace.css`.
   */
  const COST_STROKE = "var(--insights-cost-line)";

  const providers = $derived(providerTotals(buckets));

  /** The count leads as the headline; these read beside it as its context. */
  const summary = $derived([
    ...(stats.totalCostUsd == null
      ? []
      : [{ label: "Spend", value: formatCost(stats.totalCostUsd) }]),
    { label: "p50", value: formatDuration(stats.p50DurationMs) },
    { label: "p95", value: formatDuration(stats.p95DurationMs) },
  ]);

  /** Past a day, a bare clock repeats across the axis and names no instant. */
  const spansDays = $derived(to - from > 24 * 60 * 60 * 1000);
  const formatInstant = $derived(spansDays ? formatDayClock : formatClock);
  /** The axis has one label per bar-run and no room for a full timestamp; the
   *  tooltip and the zoom label name the exact instant. */
  const formatTick = $derived(axisInstantFormat(to - from));

  const selectionLabel = $derived(
    selection
      ? `${formatInstant(selection.from)}–${formatInstant(selection.to)}`
      : "",
  );

  /** The instants one bar covers, for its tooltip header. */
  function bucketLabel(bucket: VolumeBucket): string {
    return `${formatInstant(bucket.at)}–${formatInstant(bucket.at + bucketWidthMs)}`;
  }
</script>

<section
  class="flex shrink-0 flex-col gap-4 rounded-xl bg-card px-5 pt-4 pb-3 shadow-[shadow:var(--insights-card-shadow)]"
  aria-label="Volume"
>
  <header class="flex flex-col gap-3">
    <div class="flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1">
      <h2 class="text-insights-summary font-medium">{heading}</h2>
      <!-- The zoom is named as plain text beside the heading, not a badge: the
           window it narrows to is the fact, and the headline below already
           counts what it holds. -->
      {#if selection}
        <span class="text-muted-foreground" aria-hidden="true">·</span>
        <span class="text-insights-summary text-muted-foreground tabular-nums"
          >{selectionLabel}</span
        >
        <Button
          variant="ghost"
          size="xs"
          class="text-muted-foreground hover:text-foreground"
          onclick={() => onSelectionChange(null)}
          aria-label="Reset the chart zoom">Reset</Button
        >
      {:else}
        <span class="text-xs text-muted-foreground"
          >Drag across the chart to zoom</span
        >
      {/if}
    </div>
    <div class="flex flex-wrap items-end gap-x-10 gap-y-3">
      <!-- The count is the headline: it is what the bars add up to. The other
           figures describe it, so they sit beside it at reading size. -->
      <div class="flex items-baseline gap-2">
        <span
          class="text-[1.75rem] leading-none font-semibold tracking-tight"
          >{stats.counted.toLocaleString()}</span
        >
        <span class="text-insights-summary text-muted-foreground"
          >{countLabel.toLowerCase()}</span
        >
      </div>
      <dl class="flex flex-wrap gap-x-8 gap-y-2">
        {#each summary as stat (stat.label)}
          <div class="flex flex-col">
            <dt class="text-xs text-muted-foreground">{stat.label}</dt>
            <dd class="text-insights-summary font-medium tabular-nums">
              {stat.value}
            </dd>
          </div>
        {/each}
      </dl>
      <span class="flex-1"></span>
      <!-- The legend carries each backend's share of the count, so it keys the
           bar colours and answers "who did the work" in one line. The swatch is
           the whole mark: a logo beside it would say the same thing twice. -->
      <ul
        class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground"
        aria-label="Providers"
      >
        <li class="flex items-center gap-1.5">
          <span
            class="h-2 w-2.5 rounded-[3px]"
            style="background:{CLAUDE_FILL}"
            aria-hidden="true"
          ></span>
          Claude Code
          <span class="text-foreground tabular-nums"
            >{providers.claudeCode.toLocaleString()}</span
          >
        </li>
        <li class="flex items-center gap-1.5">
          <span
            class="h-2 w-2.5 rounded-[3px]"
            style="background:{CODEX_FILL}"
            aria-hidden="true"
          ></span>
          Codex
          <span class="text-foreground tabular-nums"
            >{providers.codex.toLocaleString()}</span
          >
        </li>
        {#if providers.unknownProvider > 0}
          <li class="flex items-center gap-1.5">
            <span
              class="h-2 w-2.5 rounded-[3px]"
              style="background:{UNKNOWN_FILL}"
              aria-hidden="true"
            ></span>
            Unknown
            <span class="text-foreground tabular-nums"
              >{providers.unknownProvider.toLocaleString()}</span
            >
          </li>
        {/if}
        {#if showCost}
          <!-- A rule, not a dot: the swatch has to say this series is a line
               over the bars rather than another band inside them. -->
          <li class="flex items-center gap-1.5">
            <span
              class="h-0.5 w-3 rounded-full"
              style="background:{COST_STROKE}"
              aria-hidden="true"
            ></span>
            Spend
          </li>
        {/if}
      </ul>
    </div>
  </header>

  <!-- The plot's own width, so the bucket count follows the space the card was given. -->
  <div class="w-full" bind:clientWidth={plotWidth}>
    <VolumeBars
      class="h-52 sm:h-44 sm:[@media(min-height:1000px)]:h-52"
      {buckets}
      {bucketWidthMs}
      series={[
        { key: "claude", fill: "var(--insights-provider-claude-fill)", value: (bucket) => bucket.claudeCode },
        { key: "codex", fill: "var(--insights-provider-codex-fill)", value: (bucket) => bucket.codex },
        { key: "unknown", fill: UNKNOWN_FILL, value: (bucket) => bucket.unknownProvider },
      ]}
      {ticks}
      {formatTick}
      line={hasCostSignal ? { value: (bucket) => bucket.costUsd, max: costMax, color: COST_STROKE, formatTick: formatCostTick } : undefined}
      {leftGutterPx}
      {rightGutterPx}
      viewKey={`${viewport.from}:${viewport.to}`}
      emptyText={points.length === 0 ? "Nothing in this window" : null}
      onBrush={onSelectionChange}
    >
      {#snippet tooltip(data: VolumeBucket)}
        <div class="flex flex-col gap-0.5 text-insights-summary">
          <span class="tabular-nums whitespace-nowrap text-muted-foreground"
            >{bucketLabel(data)}</span
          >
          <span class="flex items-baseline gap-1.5">
            <span class="text-insights-summary font-medium tabular-nums"
              >{data.total}</span
            >
            <span class="text-muted-foreground"
              >{countLabel.toLowerCase()}</span
            >
          </span>
          {#if data.claudeCode > 0}
            <span class="flex items-center gap-1.5">
              <span
                class="h-1.5 w-2.5 rounded-sm"
                style="background:{CLAUDE_FILL}"
                aria-hidden="true"
              ></span>
              <span class="text-insights-summary font-medium tabular-nums"
                >{data.claudeCode}</span
              >
              <span class="text-muted-foreground">Claude Code</span>
            </span>
          {/if}
          {#if data.codex > 0}
            <span class="flex items-center gap-1.5">
              <span
                class="h-1.5 w-2.5 rounded-sm"
                style="background:{CODEX_FILL}"
                aria-hidden="true"
              ></span>
              <span class="text-insights-summary font-medium tabular-nums"
                >{data.codex}</span
              >
              <span class="text-muted-foreground">Codex</span>
            </span>
          {/if}
          {#if data.unknownProvider > 0}
            <span class="flex items-center gap-1.5">
              <span
                class="h-1.5 w-2.5 rounded-sm"
                style="background:{UNKNOWN_FILL}"
                aria-hidden="true"
              ></span>
              <span class="text-insights-summary font-medium tabular-nums"
                >{data.unknownProvider}</span
              >
              <span class="text-muted-foreground">Unknown</span>
            </span>
          {/if}
          {#if data.costedCount > 0}
            <span class="flex items-center gap-1.5">
              <span
                class="h-0.5 w-2.5 rounded-full"
                style="background:{COST_STROKE}"
                aria-hidden="true"
              ></span>
              <span class="text-insights-summary font-medium tabular-nums"
                >{formatCost(data.costUsd)}</span
              >
              <!-- Spend over part of a bucket is not the bucket's spend.
                   Naming the fraction is what keeps work with an unknown
                   model price from reading as cheap rather than uncosted. -->
              <span class="text-muted-foreground"
                >{data.costedCount < data.total
                  ? `spend, ${data.costedCount} of ${data.total}`
                  : "spend"}</span
              >
            </span>
          {/if}
        </div>
      
      {/snippet}
    </VolumeBars>
  </div>
</section>
