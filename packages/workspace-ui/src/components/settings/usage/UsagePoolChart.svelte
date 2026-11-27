<script lang="ts">
  import { scaleBand } from "d3-scale";
  import { Bar, Chart, Rule, Svg } from "layerchart";
  import { RotateCw as RotateCwIcon } from "@lucide/svelte";
  import {
    accountHue,
    buildPooledBarSegments,
    emailInitials,
    formatUsagePercent,
    type UsageDisplayMode,
    type UsagePoolMember,
    type UsagePoolWindow,
    type UsagePooledChartSegment,
  } from "@solus/client-core/usage-limits";
  import { formatShortResetClock, usageBarColor } from "./lib/usage-chart";
  import UsageResetTimer from "./UsageResetTimer.svelte";

  interface PoolBarDatum {
    readonly id: string;
    readonly lane: string;
    readonly extent: [number, number];
    readonly segment: UsagePooledChartSegment;
  }

  interface Props {
    window: UsagePoolWindow;
    providerLabel: string;
    displayMode: UsageDisplayMode;
    selectedAccountKey: string | null;
    onSelectAccount: (key: string) => void;
  }

  let {
    window,
    providerLabel,
    displayMode,
    selectedAccountKey,
    onSelectAccount,
  }: Props = $props();

  const LANE = "pool";
  const patternPrefix = $props.id();

  const segments = $derived(buildPooledBarSegments(window, displayMode));

  const trackBars = $derived<PoolBarDatum[]>(
    segments.map((segment) => ({
      id: `track:${segment.key}`,
      lane: LANE,
      extent: [segment.start, segment.end],
      segment,
    })),
  );

  const extentOf = (bar: PoolBarDatum): [number, number] => bar.extent;
  const laneOf = (bar: PoolBarDatum): string => bar.lane;

  function fillBarFor(segment: UsagePooledChartSegment): PoolBarDatum {
    return {
      id: `fill:${segment.key}`,
      lane: LANE,
      extent: [segment.start, segment.fillEnd],
      segment,
    };
  }

  function refillBarFor(segment: UsagePooledChartSegment): PoolBarDatum {
    return {
      id: `refill:${segment.key}`,
      lane: LANE,
      extent: [segment.refillStart, segment.refillEnd],
      segment,
    };
  }

  function segmentAriaLabel(member: UsagePoolMember, index: number): string {
    const pct = formatUsagePercent(
      member.window.remainingPercent,
      member.window.usedPercent,
      displayMode,
    );
    const parts = [
      `${providerLabel}, ${window.groupLabel ? `${window.groupLabel} ` : ""}${window.label}`,
      `account ${index + 1}, ${member.account.displayName}`,
      `${pct.formatted}${pct.suffix}`,
    ];
    if (member.window.resetCountdown) parts.push(member.window.resetCountdown);
    return parts.join(", ");
  }

  function segmentTooltip(segment: UsagePooledChartSegment): string {
    const member = segment.member;
    const pct = formatUsagePercent(
      member.window.remainingPercent,
      member.window.usedPercent,
      displayMode,
    );
    const shortReset = formatShortResetClock(member.window.resetsAt);
    const parts = [`${member.account.displayName} · ${pct.formatted}${pct.suffix}`];
    if (shortReset) parts.push(`Resets ${shortReset}`);
    if (segment.restoresPoolPercent > 0 && member.window.resetsAt) {
      parts.push(`Restores +${segment.restoresPoolPercent}% of pool`);
    }
    return parts.join(" · ");
  }

  function trackFillFor(segment: UsagePooledChartSegment): string {
    if (segment.member.window.tone === "spent") {
      return "color-mix(in oklch, var(--solus-art-negative) 14%, transparent)";
    }
    return "var(--wash-2)";
  }
</script>

<!-- LayerChart proportional multi-account pooled bar: each account occupies its
     plan-weighted slice of [0, 100], with hatched SVG refill preview, quota fill,
     even-pace rule, and keyboard-accessible segment controls. -->
<div class="relative h-10.5 w-full min-w-0">
  <Chart
    data={trackBars}
    x={extentOf}
    xDomain={[0, 100]}
    y={laneOf}
    yScale={scaleBand()}
    yDomain={[LANE]}
  >
    <Svg>
      <defs>
        {#each segments as segment (segment.key)}
          {@const color = usageBarColor(segment.member.window.tone, segment.member.account.provider)}
          <pattern
            id="{patternPrefix}-hatch-{segment.index}"
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M-1 1L1 -1M0 6L6 0M5 7L7 5"
              stroke={color}
              stroke-width="1.2"
              opacity="0.22"
            />
          </pattern>
        {/each}
      </defs>

      {#each trackBars as bar (bar.id)}
        {@const segment = bar.segment}
        {@const color = usageBarColor(segment.member.window.tone, segment.member.account.provider)}
        {@const isSelected = selectedAccountKey === segment.key}
        {@const isSpent = segment.member.window.tone === "spent"}
        <Bar
          data={bar}
          insets={{ y: 1 }}
          rounded="all"
          radius={8}
          fill={trackFillFor(segment)}
          stroke={isSelected
            ? isSpent
              ? "var(--solus-art-negative)"
              : "var(--foreground)"
            : "transparent"}
          stroke-width={isSelected ? 1.25 : 0}
        />

        {#if segment.refillEnd - segment.refillStart > 0.25}
          <Bar
            data={refillBarFor(segment)}
            insets={{ y: 1 }}
            rounded="right"
            radius={8}
            fill="url(#{patternPrefix}-hatch-{segment.index})"
          />
        {/if}

        {#if segment.fillEnd - segment.start > 0.25}
          <Bar
            data={fillBarFor(segment)}
            insets={{ y: 1 }}
            rounded={segment.fillEnd >= segment.end - 0.5 ? "all" : "left"}
            radius={8}
            fill={color}
            fillOpacity={0.28}
          />
        {/if}

        {#if segment.paceX !== null}
          <Rule
            x={segment.paceX}
            y={false}
            class="pointer-events-none stroke-foreground/85"
            stroke-width={2}
            stroke-linecap="round"
          />
        {/if}
      {/each}
    </Svg>
  </Chart>

  <!-- Keyboard-accessible segment triggers aligned to each LayerChart extent. -->
  <div
    role="group"
    aria-label="{providerLabel} {window.label} accounts"
    class="pointer-events-none absolute inset-0"
  >
    {#each segments as segment (segment.key)}
      {@const member = segment.member}
      {@const display = formatUsagePercent(
        member.window.remainingPercent,
        member.window.usedPercent,
        displayMode,
      )}
      {@const isSelected = selectedAccountKey === segment.key}
      {@const isSpent = member.window.tone === "spent"}
      {@const isNarrow = segment.width < 26}
      <button
        type="button"
        onclick={() => onSelectAccount(segment.key)}
        aria-expanded={isSelected}
        aria-label={segmentAriaLabel(member, segment.index)}
        title={segmentTooltip(segment)}
        style="left: {segment.start}%; width: {segment.width}%;"
        class="pointer-events-auto absolute top-0 bottom-0 flex cursor-pointer items-center justify-between gap-1.5 overflow-hidden rounded-lg px-2.5 text-left transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
      >
        <span class="flex min-w-0 items-center gap-1.5">
          {#if member.account.email}
            {@const hue = accountHue(member.account.email)}
            <span
              class="flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold"
              style="background-color: hsl({hue}, 45%, 84%); color: hsl({hue}, 45%, 24%);"
            >
              {emailInitials(member.account.email)}
            </span>
          {:else}
            <span class="flex size-5 shrink-0 items-center justify-center rounded-full bg-background/80 text-[10px] font-semibold tabular-nums text-foreground">
              {segment.index + 1}
            </span>
          {/if}
          {#if !isNarrow}
            <span class="truncate text-[13px] font-medium text-foreground">
              {member.account.displayName}
            </span>
          {/if}
          <span
            class="shrink-0 text-[13px] font-semibold tabular-nums {isSpent ? 'text-(--solus-art-negative)' : 'text-foreground'}"
          >
            {display.formatted}%
          </span>
        </span>
        {#if member.window.resetsAt !== null || member.window.resetsLabel}
          <span class="hidden shrink-0 items-center gap-1 rounded bg-background/85 px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground @min-[42rem]/pane:inline-flex">
            <RotateCwIcon size={10} />
            <UsageResetTimer
              resetsAt={member.window.resetsAt}
              resetsLabel={member.window.resetsLabel}
              compact
            />
          </span>
        {/if}
      </button>
    {/each}
  </div>
</div>
