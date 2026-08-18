<script lang="ts">
  import { scaleBand } from "d3-scale";
  import { Axis, Bars, Chart, Svg } from "layerchart";
  import { TIME_AXIS_INSET_PX, TIME_AXIS_LABEL_GAP_PX } from "./lib/chart-axis";
  import { axisInstantFormat } from "./lib/format";
  import { bucketAxisTicks, bucketCountForWidth } from "./lib/volume";
  import { sessionContextBuckets, type SessionContextBucket } from "./lib/session-context";
  import type { TurnRow } from "./lib/turn-rows";

  /**
   * Where one turn sits inside the whole window.
   *
   * Three bar layers over one band scale rather than a colour scale: each layer
   * reads a different count off the same bucket, so "everything else", "this
   * session", and "this turn" keep their own fixed colour instead of depending
   * on the order a categorical scale happened to assign.
   *
   * A picture, not a control. The session's own turns are opened from the rail
   * card beside it, which names them; a bar names a half hour and would open
   * whichever turn happened to fall in it.
   */
  interface Props {
    /** Every turn the window holds, across all sessions — the backdrop. */
    rows: TurnRow[];
    /** The session being read. */
    sessionId: string | null;
    currentTraceId: string;
    currentStartedAt: number;
    from: number;
    to: number;
    heading: string;
    note: string;
  }

  let { rows, sessionId, currentTraceId, currentStartedAt, from, to, heading, note }: Props =
    $props();

  /** The strip's own width, so a bar keeps one size whether this sits in a
   *  narrow rail or across a full page. */
  let plotWidth = $state(0);
  const PLOT_INSET = { top: 2, bottom: TIME_AXIS_INSET_PX, left: 8, right: 8 };

  const bucketCount = $derived(bucketCountForWidth(plotWidth - PLOT_INSET.left - PLOT_INSET.right));
  const buckets = $derived(
    sessionContextBuckets({
      rows,
      sessionId,
      currentTraceId,
      currentStartedAt,
      from,
      to,
      count: bucketCount,
    }),
  );
  const ticks = $derived(bucketAxisTicks(buckets, 3));
  const formatTick = $derived(axisInstantFormat(to - from));
</script>

<section
  class="flex flex-col gap-1.5 rounded-xl bg-card px-4 pt-2.5 pb-2 shadow-[shadow:var(--insights-card-shadow)]"
  aria-label="This session in the window"
>
  <div class="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
    <h2 class="m-0 text-xs font-medium">{heading}</h2>
    <span class="text-[0.6875rem] text-muted-foreground">{note}</span>
    <span class="flex-1"></span>
    <div class="flex items-center gap-2.5 text-[0.625rem] text-muted-foreground">
      {#each [{ label: "This turn", swatch: "var(--primary)" }, { label: "This session", swatch: "color-mix(in oklch, var(--primary) 42%, transparent)" }, { label: "Other sessions", swatch: "var(--wash-4)" }] as entry (entry.label)}
        <span class="flex items-center gap-1.5">
          <span class="size-1.5 rounded-full" style="background:{entry.swatch}"></span>
          {entry.label}
        </span>
      {/each}
    </div>
  </div>

  <div
    class="relative h-[5.5rem] w-full sm:h-[4.5rem] sm:[@media(min-height:1000px)]:h-[5.5rem]"
    bind:clientWidth={plotWidth}
  >
    {#key `${from}:${to}`}
      <Chart
        data={buckets}
        x={(bucket: SessionContextBucket) => bucket.at}
        xScale={scaleBand().padding(0.24)}
        y={(bucket: SessionContextBucket) => bucket.total}
        yDomain={[0, null]}
        padding={{
          top: PLOT_INSET.top,
          bottom: PLOT_INSET.bottom,
          left: PLOT_INSET.left,
          right: PLOT_INSET.right,
        }}
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
            tickLabelProps={{ dy: TIME_AXIS_LABEL_GAP_PX }}
            format={(value: unknown) => formatTick(Number(value))}
            classes={{ tickLabel: "text-[0.6875rem] tabular-nums fill-[var(--muted-foreground)]" }}
          />
          <Bars rounded="top" radius={3} class="fill-[var(--wash-4)]" />
          <Bars
            y={(bucket: SessionContextBucket) => bucket.sessionCount}
            rounded="top"
            radius={3}
            class="fill-[color-mix(in_oklch,var(--primary)_42%,transparent)]"
          />
          <!-- The turn being read, kept visible when its bar is one turn tall:
               the whole bucket is inked rather than the session's share of it. -->
          <Bars
            y={(bucket: SessionContextBucket) => (bucket.isCurrent ? bucket.total : 0)}
            rounded="top"
            radius={3}
            class="fill-(--primary)"
          />
        </Svg>
      </Chart>
    {/key}

    {#if buckets.every((bucket) => bucket.total === 0)}
      <span
        class="pointer-events-none absolute inset-0 flex items-center justify-center text-[0.6875rem] text-muted-foreground"
        >No turns in this window</span
      >
    {/if}
  </div>
</section>
