<script lang="ts">
  import { scaleBand } from "d3-scale";
  import { Axis, Bars, Chart, Svg } from "layerchart";
  import { formatClock } from "./lib/format";
  import {
    bucketAxisTicks,
    bucketCountForWidth,
    bucketPoints,
    turnPoints,
    type VolumeBucket,
  } from "./lib/volume";
  import type { TurnRow } from "./lib/turn-rows";

  /**
   * Where one session's turns sit inside the whole window.
   *
   * Three bar layers over one band scale rather than a colour scale: each layer
   * is a filtered view of the same buckets, so "everything else", "this
   * session", and "this turn" keep their own fixed colour instead of depending
   * on the order a categorical scale happened to assign.
   */
  interface Props {
    /** Every turn in the window — the backdrop. */
    allRows: TurnRow[];
    /** The turns belonging to the session being read. */
    sessionRows: TurnRow[];
    currentStartedAt: number;
    from: number;
    to: number;
    note: string;
  }

  let { allRows, sessionRows, currentStartedAt, from, to, note }: Props = $props();

  /** The strip's own width, so a bar keeps one size whether this sits in a
   *  drawer or a full page. */
  let plotWidth = $state(0);
  const bucketCount = $derived(bucketCountForWidth(plotWidth - 16));

  const buckets = $derived(bucketPoints(turnPoints(allRows), from, to, bucketCount));
  const sessionBuckets = $derived(
    bucketPoints(turnPoints(sessionRows), from, to, bucketCount).filter(
      (bucket) => bucket.total > 0,
    ),
  );
  const currentBuckets = $derived(
    buckets.filter((bucket) => currentStartedAt >= bucket.at && currentStartedAt < bucket.endAt),
  );
  const ticks = $derived(bucketAxisTicks(buckets));
</script>

<section
  class="flex flex-col gap-1.5 rounded-xl bg-card px-4 py-2.5 shadow-[shadow:var(--insights-card-shadow)]"
  aria-label="This session in the window"
>
  <div class="flex flex-wrap items-baseline gap-3">
    <h2 class="text-xs font-medium">This session in the last 24 hours</h2>
    <span class="text-[0.6875rem] text-muted-foreground">{note}</span>
  </div>

  <div class="h-20 w-full" bind:clientWidth={plotWidth}>
    {#key `${from}:${to}`}
      <Chart
        data={buckets}
        x={(bucket: VolumeBucket) => bucket.at}
        xScale={scaleBand().padding(0.18)}
        y={(bucket: VolumeBucket) => bucket.total}
        yDomain={[0, null]}
        padding={{ bottom: 20, right: 8, left: 8, top: 2 }}
      >
        <Svg>
          <!-- Bucket starts, not evenly-spaced instants: a band scale only
               places a tick that is one of its own categories, so a computed
               instant lands between bands and names the wrong bar. -->
          <Axis
            placement="bottom"
            {ticks}
            tickMarks={false}
            tickLength={0}
            format={(value: unknown) => formatClock(Number(value))}
            classes={{ tickLabel: "text-[0.6875rem] tabular-nums fill-[var(--muted-foreground)]" }}
          />
          <Bars rounded="top" radius={3} class="fill-[var(--wash-4)]" />
          <Bars data={sessionBuckets} rounded="top" radius={3}
            class="fill-[color-mix(in_oklch,var(--primary)_50%,transparent)]" />
          <Bars data={currentBuckets} rounded="top" radius={3} class="fill-(--primary)" />
        </Svg>
      </Chart>
    {/key}
  </div>
</section>
