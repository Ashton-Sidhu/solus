<script lang="ts">
  import { scaleBand } from "d3-scale";
  import { Bars, Chart, Svg } from "layerchart";
  import { formatClock } from "./lib/format";
  import { bucketTurns, volumeAxisTicks, type VolumeBucket } from "./lib/volume";
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

  const buckets = $derived(bucketTurns(allRows, from, to));
  const sessionBuckets = $derived(
    bucketTurns(sessionRows, from, to).filter((bucket) => bucket.total > 0),
  );
  const currentBuckets = $derived(
    buckets.filter((bucket) => currentStartedAt >= bucket.at && currentStartedAt < bucket.endAt),
  );
  const ticks = $derived(volumeAxisTicks(from, to));
</script>

<section
  class="flex flex-col gap-1.5 rounded-xl bg-card px-4 py-2.5 shadow-[shadow:var(--elev-ring)]"
  aria-label="This session in the window"
>
  <div class="flex flex-wrap items-baseline gap-3">
    <h2 class="text-xs font-medium">This session in the last 24 hours</h2>
    <span class="text-[0.6875rem] text-muted-foreground">{note}</span>
  </div>

  <div class="h-13 w-full">
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
          <Bars rounded="top" radius={2} class="fill-[var(--wash-4)]" />
          <Bars data={sessionBuckets} rounded="top" radius={2}
            class="fill-[color-mix(in_oklch,var(--primary)_50%,transparent)]" />
          <Bars data={currentBuckets} rounded="top" radius={2} class="fill-(--primary)" />
        </Svg>
      </Chart>
    {/key}
  </div>

  <div
    class="flex justify-between text-[0.625rem] text-muted-foreground opacity-80"
    aria-hidden="true"
  >
    {#each ticks as tick (tick)}
      <span class="tabular-nums">{formatClock(tick)}</span>
    {/each}
  </div>
</section>
