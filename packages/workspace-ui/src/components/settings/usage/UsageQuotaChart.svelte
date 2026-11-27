<script lang="ts">
  import { scaleBand } from "d3-scale";
  import { Bar, Chart, Rule, Svg, Tooltip } from "layerchart";
  import type { UsageDisplayMode } from "@solus/client-core/usage-limits";

  interface GaugeBarDatum {
    readonly id: string;
    readonly lane: string;
    readonly extent: [number, number];
  }

  interface Props {
    barPercent: number;
    pacePercent: number | null;
    fillColor: string;
    spent?: boolean;
    compact?: boolean;
    displayMode: UsageDisplayMode;
    valueLabel: string;
    ariaLabel: string;
    ariaValueNow: number;
    resetSummary?: string | null;
  }

  let {
    barPercent,
    pacePercent,
    fillColor,
    spent = false,
    compact = false,
    displayMode,
    valueLabel,
    ariaLabel,
    ariaValueNow,
    resetSummary = null,
  }: Props = $props();

  const LANE = "quota";
  const clampedFill = $derived(Math.max(0, Math.min(100, barPercent)));
  const clampedPace = $derived(
    pacePercent === null ? null : Math.max(2, Math.min(98, pacePercent)),
  );
  const trackFill = $derived(
    spent
      ? "color-mix(in oklch, var(--solus-art-negative) 14%, transparent)"
      : "var(--wash-2)",
  );

  const trackBar = $derived<GaugeBarDatum>({ id: "track", lane: LANE, extent: [0, 100] });
  const fillBar = $derived<GaugeBarDatum>({ id: "fill", lane: LANE, extent: [0, clampedFill] });
  const bars = $derived(clampedFill > 0 ? [trackBar, fillBar] : [trackBar]);

  const extentOf = (bar: GaugeBarDatum): [number, number] => bar.extent;
  const laneOf = (bar: GaugeBarDatum): string => bar.lane;
  const barInset = $derived(compact ? 3 : 4);
  const barRadius = $derived(compact ? 4 : 5);
</script>

<!-- LayerChart horizontal quota gauge: rounded track, proportional value fill
     (omitted at 0% so empty tracks stay clean), halo-cutout even-pace rule,
     and portalled hover tooltip. -->
<div
  role="progressbar"
  aria-label={ariaLabel}
  aria-valuemin={0}
  aria-valuemax={100}
  aria-valuenow={ariaValueNow}
  class="w-full min-w-0 {compact ? 'h-3.5' : 'h-4.5'}"
>
  <Chart
    data={bars}
    x={extentOf}
    xDomain={[0, 100]}
    y={laneOf}
    yScale={scaleBand()}
    yDomain={[LANE]}
    tooltipContext={{ mode: "band" }}
  >
    <Svg>
      <Bar
        data={trackBar}
        insets={{ y: barInset }}
        rounded="all"
        radius={barRadius}
        fill={trackFill}
      />
      {#if clampedFill > 0}
        <Bar
          data={fillBar}
          insets={{ y: barInset }}
          rounded="all"
          radius={barRadius}
          fill={fillColor}
        />
      {/if}
      {#if clampedPace !== null}
        <Rule
          x={clampedPace}
          y={false}
          class="pointer-events-none stroke-background"
          stroke-width={5}
        />
        <Rule
          x={clampedPace}
          y={false}
          class="pointer-events-none stroke-foreground"
          stroke-width={2}
          stroke-linecap="round"
        />
      {/if}
    </Svg>

    <Tooltip.Root
      variant="none"
      portal
      contained="window"
      classes={{
        root: "pointer-events-none z-50 rounded-lg bg-popover px-2.5 py-1.5 text-popover-foreground shadow-[shadow:var(--solus-menu-shadow)]",
      }}
    >
      {#snippet children()}
        <div class="flex flex-col gap-0.5 text-xs">
          <span class="font-medium tabular-nums text-foreground">{valueLabel}</span>
          {#if pacePercent !== null}
            <span class="tabular-nums text-muted-foreground">
              Even pace target: {pacePercent}% {displayMode === "used" ? "used" : "left"}
            </span>
          {/if}
          {#if resetSummary}
            <span class="text-[11px] tabular-nums text-muted-foreground">{resetSummary}</span>
          {/if}
        </div>
      {/snippet}
    </Tooltip.Root>
  </Chart>
</div>
