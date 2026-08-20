<script lang="ts">
  import { scaleBand } from "d3-scale";
  import {
    Axis,
    Bars,
    Chart,
    Highlight,
    Svg,
    Text,
    Tooltip,
    type TextProps,
  } from "layerchart";
  import { X as XIcon } from "@lucide/svelte";
  import { TIME_AXIS_INSET_PX, TIME_AXIS_LABEL_GAP_PX } from "./lib/chart-axis";
  import {
    axisInstantFormat,
    formatClock,
    formatCost,
    formatDayClock,
    formatDuration,
  } from "./lib/format";
  import {
    bucketCountForWidth,
    bucketPoints,
    bucketAxisTicks,
    pointsWithinSelection,
    volumeStats,
    volumeViewport,
    type TimeSelection,
    type VolumeBucket,
    type VolumePoint,
  } from "./lib/volume";
  import { providerMark } from "./lib/provider";

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
   * Dragging across the plot brushes a time range, which narrows the list below
   * without re-running the query — the brush filters the answer, it is not the
   * question.
   */
  interface Props {
    /** Every counted row, before the brush — the bars must not collapse into
     *  the selection the user just made on them. */
    points: VolumePoint[];
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

  const viewport = $derived(volumeViewport(from, to, selection));
  const buckets = $derived(
    bucketPoints(
      points,
      viewport.from,
      viewport.to,
      bucketCountForWidth(plotWidth - AXIS_GUTTER_PX),
    ),
  );
  const bucketWidthMs = $derived(
    buckets.length > 1
      ? buckets[1].at - buckets[0].at
      : viewport.to - viewport.from,
  );
  const selectedPoints = $derived(pointsWithinSelection(points, selection));
  const stats = $derived(volumeStats(selectedPoints));
  // One label per ~190px. A wide plot with five labels leaves the reader
  // measuring by eye across a quarter of a week.
  const ticks = $derived(
    bucketAxisTicks(
      buckets,
      Math.min(9, Math.max(3, Math.round(plotWidth / 190))),
    ),
  );
  const yMax = $derived(
    Math.max(1, ...buckets.map((bucket) => bucket.total)) * 1.12,
  );

  /** Each backend's bar carries that backend's own colour — the ramp's terracotta
   * is Claude's accent already, and Codex takes the violet-blue of its own app
   * icon — so the same two hues name the backends here and in `ProviderMark`.
   * The ramp's dusty blue named neither of them. Mixing toward the card keeps
   * both themes soft. */
  const CLAUDE_FILL =
    "color-mix(in oklch, var(--solus-art-1) 72%, var(--card))";
  const CODEX_FILL = "color-mix(in oklch, var(--brand-codex) 72%, var(--card))";
  const UNKNOWN_FILL =
    "color-mix(in oklch, var(--muted-foreground) 38%, var(--card))";

  const summary = $derived([
    {
      label: countLabel,
      value: String(stats.counted),
      tone: "var(--foreground)",
    },
    ...(stats.totalCostUsd == null
      ? []
      : [
          {
            label: "Spend",
            value: formatCost(stats.totalCostUsd),
            tone: "var(--foreground)",
          },
        ]),
    {
      label: "p50",
      value: formatDuration(stats.p50DurationMs),
      tone: "var(--foreground)",
    },
    {
      label: "p95",
      value: formatDuration(stats.p95DurationMs),
      tone: "var(--foreground)",
    },
  ]);

  const hasUnknownProvider = $derived(
    selectedPoints.some((point) => providerMark(point.provider) === null),
  );

  /** Past a day, a bare clock repeats across the axis and names no instant. */
  const spansDays = $derived(to - from > 24 * 60 * 60 * 1000);
  const formatInstant = $derived(spansDays ? formatDayClock : formatClock);
  /** The axis has one label per bar-run and no room for a full timestamp; the
   *  tooltip and the zoom pill name the exact instant. */
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

  /** The brush's own state, narrowed to the axis this chart reads. LayerChart
   *  keeps `BrushState` internal to its component module, so the shape is
   *  restated here rather than reaching into the package's private types. */
  type BrushSelectionState = {
    x: Array<number | Date | string | null>;
    reset: () => void;
  };

  // The brush reports the first and last selected category — bucket start times,
  // because that is the band domain. The upper edge extends to the end of the
  // last bucket so a one-bar selection still covers that bar's turns.
  function applyBrush(state: BrushSelectionState): void {
    const [first, last] = state.x;
    if (
      first == null ||
      last == null ||
      first instanceof Date ||
      last instanceof Date
    ) {
      onSelectionChange(null);
      return;
    }
    const firstBucket = Number(first);
    const lastBucket = Number(last);
    if (!Number.isFinite(firstBucket) || !Number.isFinite(lastBucket)) {
      onSelectionChange(null);
      return;
    }
    onSelectionChange({
      from: Math.min(firstBucket, lastBucket),
      to: Math.max(firstBucket, lastBucket) + bucketWidthMs,
    });
    // The plot now renders the selected interval itself. Clear LayerChart's
    // transient overlay so it does not become a full-width rail after the zoom.
    state.reset();
  }
</script>

<section
  class="flex shrink-0 flex-col gap-2 rounded-xl bg-card px-4 py-3 shadow-[shadow:var(--insights-card-shadow)]"
  aria-label="Volume"
>
  <header class="flex flex-wrap items-center gap-x-3 gap-y-1">
    <h2 class="text-[0.8125rem] font-semibold">{heading}</h2>
    {#if selection}
      <span
        class="flex items-center gap-1.5 rounded-full px-2 py-1 text-[0.6875rem] shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--primary)_24%,transparent)]"
        style="background:color-mix(in oklch, var(--primary) 9%, transparent)"
      >
        <span class="font-semibold text-[var(--primary)]">Zoomed</span>
        <span class="text-muted-foreground tabular-nums">{selectionLabel}</span>
        <span class="text-muted-foreground">·</span>
        <span class="font-medium tabular-nums"
          >{selectedPoints.length} {countLabel.toLowerCase()}</span
        >
        <button
          type="button"
          class="-mr-1 flex size-5 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-[color,background-color,scale] hover:bg-[var(--wash-2)] hover:text-foreground active:scale-[0.96]"
          onclick={() => onSelectionChange(null)}
          aria-label="Reset the chart zoom"
        >
          <XIcon class="size-2.5" weight="bold" />
        </button>
      </span>
    {:else}
      <span class="text-[0.6875rem] text-muted-foreground"
        >Drag across the chart to zoom</span
      >
    {/if}
    <span class="flex-1"></span>
    <div
      class="flex items-center gap-3 text-[0.6875rem] text-muted-foreground"
      aria-label="Providers"
    >
      <!-- The swatch is the whole mark here: it keys the name to a bar, and now
           carries that backend's own colour, so a logo beside it would say the
           same thing twice. -->
      <span class="flex items-center gap-1.5">
        <span
          class="h-1.5 w-3 rounded-sm"
          style="background:{CLAUDE_FILL}"
          aria-hidden="true"
        ></span>
        Claude Code
      </span>
      <span class="flex items-center gap-1.5">
        <span
          class="h-1.5 w-3 rounded-sm"
          style="background:{CODEX_FILL}"
          aria-hidden="true"
        ></span>
        Codex
      </span>
      {#if hasUnknownProvider}
        <span class="flex items-center gap-1.5">
          <span
            class="h-1.5 w-3 rounded-sm"
            style="background:{UNKNOWN_FILL}"
            aria-hidden="true"
          ></span>
          Unknown
        </span>
      {/if}
    </div>
    <span class="h-3.5 w-px shrink-0 bg-[var(--hairline)]" aria-hidden="true"
    ></span>
    <!-- Value first, label after: a stat strip is read for its numbers, and a
         row of same-weight label/value pairs makes the eye read the words. -->
    <div class="flex items-center gap-3.5">
      {#each summary as stat, index (stat.label)}
        {#if index > 0}
          <span
            class="h-3.5 w-px shrink-0 bg-[var(--hairline)]"
            aria-hidden="true"
          ></span>
        {/if}
        <span class="flex items-baseline gap-1.5">
          <span class="text-[0.8125rem] tabular-nums" style="color:{stat.tone}"
            >{stat.value}</span
          >
          <span class="text-[0.6875rem] text-muted-foreground"
            >{stat.label}</span
          >
        </span>
      {/each}
    </div>
  </header>

  <div
    class="relative h-52 w-full cursor-crosshair sm:h-44 sm:[@media(min-height:1000px)]:h-52"
    bind:clientWidth={plotWidth}
  >
    {#key `${viewport.from}:${viewport.to}`}
      <Chart
        data={buckets}
        x={(bucket: VolumeBucket) => bucket.at}
        xScale={scaleBand().padding(0.18)}
        y={(bucket: VolumeBucket) => bucket.total}
        yDomain={[0, yMax]}
        padding={{
          left: AXIS_GUTTER_PX,
          bottom: TIME_AXIS_INSET_PX,
          right: 12,
          top: 4,
        }}
        tooltipContext={{ mode: "band" }}
        brush={{
          axis: "x",
          // The selection is committed on release and immediately becomes the
          // viewport, so persistent resize rails add weight without utility.
          handleSize: 1,
          onBrushEnd: ({ brush }) => applyBrush(brush),
          classes: {
            range:
              "!top-1.5 !h-[calc(100%-0.75rem)] rounded-md bg-[color-mix(in_oklch,var(--solus-art-1)_8%,transparent)] shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--solus-art-1)_24%,transparent),0_2px_10px_color-mix(in_oklch,var(--solus-art-1)_7%,transparent)]",
            handle: "opacity-0",
          },
        }}
      >
        <Svg>
          <!-- Bars with no scale beside them are a shape, not a quantity: three
               ticks are the fewest that say how tall the tall one is without
               turning the plot into a grid, and the zero gridline doubles as the
               baseline the bars stand on. -->
          <Axis
            placement="left"
            grid={{ class: "stroke-[var(--hairline)]" }}
            ticks={3}
            tickMarks={false}
            format={(value: unknown) => String(Math.round(Number(value)))}
            classes={{
              tickLabel:
                "text-[0.6875rem] tabular-nums fill-[var(--muted-foreground)]",
            }}
          />
          <!-- Bucket starts, not evenly-spaced instants: a band scale only
               places a tick that is one of its own categories. -->
          <Axis
            placement="bottom"
            {ticks}
            tickMarks={false}
            tickLength={0}
            tickLabelProps={{ dy: TIME_AXIS_LABEL_GAP_PX }}
            format={(value: unknown) => formatTick(Number(value))}
            classes={{
              tickLabel:
                "text-[0.6875rem] tabular-nums fill-[var(--muted-foreground)]",
            }}
          >
            <!-- The end labels are centred on their bar, which for the first and
                 last bar hangs half a timestamp off the plot and gets cut by the
                 card. Anchoring them inward keeps the window's own bounds
                 readable, which is the pair the reader most needs. -->
            {#snippet tickLabel({
              props,
              index,
            }: {
              props: TextProps;
              index: number;
            })}
              <Text
                {...props}
                textAnchor={index === 0
                  ? "start"
                  : index === ticks.length - 1
                    ? "end"
                    : "middle"}
              />
            {/snippet}
          </Axis>
          <Highlight area={{ class: "fill-[var(--wash-2)]" }} />
          <Bars
            y={(bucket: VolumeBucket) => [0, bucket.claudeCode]}
            rounded="top"
            radius={2}
            fill={CLAUDE_FILL}
          />
          <Bars
            y={(bucket: VolumeBucket) => [
              bucket.claudeCode,
              bucket.claudeCode + bucket.codex,
            ]}
            rounded="top"
            radius={2}
            fill={CODEX_FILL}
          />
          <Bars
            y={(bucket: VolumeBucket) => [
              bucket.claudeCode + bucket.codex,
              bucket.total,
            ]}
            rounded="top"
            radius={2}
            fill={UNKNOWN_FILL}
          />
        </Svg>
        <Tooltip.Root
          variant="none"
          classes={{
            root: "rounded-lg bg-card px-2.5 py-1.5 shadow-[shadow:var(--solus-menu-shadow)]",
          }}
        >
          {#snippet children({ data }: { data: VolumeBucket })}
            <div class="flex flex-col gap-0.5 text-[0.6875rem]">
              <span class="tabular-nums whitespace-nowrap text-muted-foreground"
                >{bucketLabel(data)}</span
              >
              <span class="flex items-baseline gap-1.5">
                <span class="text-xs font-medium tabular-nums"
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
                  <span class="text-xs font-medium tabular-nums"
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
                  <span class="text-xs font-medium tabular-nums"
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
                  <span class="text-xs font-medium tabular-nums"
                    >{data.unknownProvider}</span
                  >
                  <span class="text-muted-foreground">Unknown</span>
                </span>
              {/if}
            </div>
          {/snippet}
        </Tooltip.Root>
      </Chart>
    {/key}
    {#if points.length === 0}
      <span
        class="pointer-events-none absolute inset-0 flex items-center justify-center text-[0.6875rem] text-muted-foreground"
        >Nothing in this window</span
      >
    {/if}
  </div>
</section>
