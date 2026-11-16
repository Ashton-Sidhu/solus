<script lang="ts">
  import type { AppCallStats, AppCallView } from "@solus/contracts/apps";
  import ResultTrendChart from "../../insights/ResultTrendChart.svelte";
  import VolumeBars from "../../insights/VolumeBars.svelte";
  import { formatDuration } from "../../insights/lib/format";
  import { bucketAxisTicks, type TimeSelection } from "../../insights/lib/volume";
  import { Button } from "../../ui/button";
  import * as Tabs from "../../ui/tabs";
  import { bucketRangeLabel, callAtPoint, callBarText, callBars, callTickFormat, callTrendPoints, callZoomText, type CallBar } from "./lib/activity";

  /**
   * The chart of the Activity section (docs/plans/apps.md §9.2), plain on the
   * page: every call that passes the query in numbers, then the Insights
   * volume bars over the range, the failed calls on top. Dragging across the
   * bars zooms the query to that time; Reset goes back to the range. Duration
   * shows each call in view as a point of its time; a point opens its call.
   */
  interface Props {
    title: string;
    stats: AppCallStats | undefined;
    error: string | null;
    /** The rows in view, for the duration points. */
    calls: readonly AppCallView[];
    /** The time the chart is zoomed to; null for the whole range. */
    zoom: TimeSelection | null;
    onZoom: (zoom: TimeSelection | null) => void;
    onRetry: () => void;
    onOpenCall: (callId: string) => void;
  }
  let { title, stats, error, calls, zoom, onZoom, onRetry, onOpenCall }: Props = $props();

  let view = $state<"count" | "duration">("count");
  let plotWidth = $state(0);
  const bars = $derived(stats ? callBars(stats) : []);
  // One label per ~190px, as the Insights chart does.
  const ticks = $derived(bucketAxisTicks(bars, Math.min(9, Math.max(3, Math.round(plotWidth / 190)))));
  const trendPoints = $derived(view === "duration" ? callTrendPoints(calls) : []);
</script>

<section class="flex min-w-0 flex-col gap-4" aria-label={title} data-testid="app-call-stats">
  <div class="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
    <div class="flex min-h-6 min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <h3 class="m-0 text-[15px] font-semibold text-foreground">{title}</h3>
      {#if zoom}
        <span class="text-muted-foreground" aria-hidden="true">·</span>
        <span class="text-[13px] text-(--solus-text-secondary) tabular-nums" data-testid="app-call-zoom">{callZoomText(zoom)}</span>
        <Button size="xs" variant="ghost" class="text-(--solus-text-secondary)" aria-label="Reset the chart zoom" onclick={() => onZoom(null)}>Reset</Button>
      {:else if view === "count"}
        <span class="text-[13px] text-(--solus-text-tertiary)">Drag across the chart to zoom</span>
      {/if}
    </div>
    <Tabs.Root bind:value={() => view, (next) => (view = next === "duration" ? "duration" : "count")}>
      <Tabs.List variant="line" class="h-auto gap-3 p-0">
        <Tabs.Trigger value="count" class="h-auto px-0 pb-1 text-[13px]">Count</Tabs.Trigger>
        <Tabs.Trigger value="duration" class="h-auto px-0 pb-1 text-[13px]">Duration</Tabs.Trigger>
      </Tabs.List>
    </Tabs.Root>
  </div>

  {#if stats}
    <div class="flex min-w-0 flex-wrap items-end gap-x-9 gap-y-3">
      <dl class="m-0 flex flex-wrap items-end gap-x-9 gap-y-3">
        <div class="flex items-baseline gap-1.5">
          <dt class="sr-only">Calls</dt>
          <dd class="m-0 text-[2.125rem] leading-[2.625rem] font-medium tracking-[-0.02em] tabular-nums text-foreground">{stats.calls.toLocaleString()}</dd>
          <span class="text-[15px] text-(--solus-text-secondary)" aria-hidden="true">{stats.calls === 1 ? "call" : "calls"}</span>
        </div>
        <div class="flex flex-col gap-0.5">
          <dt class="text-[13px] text-(--solus-text-tertiary)">Failed</dt>
          <dd class="m-0 text-base font-medium tabular-nums {stats.failed > 0 ? 'text-(--failure)' : 'text-foreground'}">{stats.failed.toLocaleString()}</dd>
        </div>
        <div class="flex flex-col gap-0.5">
          <dt class="text-[13px] text-(--solus-text-tertiary)">p50</dt>
          <dd class="m-0 text-base font-medium tabular-nums text-foreground">{formatDuration(stats.p50Ms)}</dd>
        </div>
        <div class="flex flex-col gap-0.5">
          <dt class="text-[13px] text-(--solus-text-tertiary)">p95</dt>
          <dd class="m-0 text-base font-medium tabular-nums text-foreground">{formatDuration(stats.p95Ms)}</dd>
        </div>
      </dl>
      {#if view === "count"}
        <ul class="m-0 ml-auto flex list-none flex-wrap items-center gap-x-4 gap-y-1 p-0 text-xs text-muted-foreground" aria-label="Outcomes">
          <li class="flex items-center gap-1.5">
            <span class="h-2 w-2.5 rounded-[3px] bg-[color-mix(in_oklch,var(--solus-accent)_50%,transparent)]" aria-hidden="true"></span>
            OK <span class="text-foreground tabular-nums">{(stats.calls - stats.failed).toLocaleString()}</span>
          </li>
          <li class="flex items-center gap-1.5">
            <span class="h-2 w-2.5 rounded-[3px] bg-(--solus-art-negative)" aria-hidden="true"></span>
            Failed <span class="text-foreground tabular-nums">{stats.failed.toLocaleString()}</span>
          </li>
        </ul>
      {/if}
    </div>

    {#if view === "duration"}
      {#if trendPoints.length >= 2}
        <ResultTrendChart
          lines={[{ label: "", points: trendPoints, segments: [trendPoints] }]}
          mark="points"
          valueFormat="duration"
          valueLabel="duration"
          onSelect={(point) => {
            const call = callAtPoint(calls, point);
            if (call) onOpenCall(call.id);
          }}
        />
      {:else}
        <p class="m-0 text-[13px] text-(--solus-text-tertiary)">Too few calls in view ended to draw their times.</p>
      {/if}
    {:else}
      <div class="w-full" bind:clientWidth={plotWidth}>
        <VolumeBars
          class="h-36"
          buckets={bars}
          bucketWidthMs={stats.bucketMs}
          series={[
            { key: "ok", fill: "color-mix(in oklch, var(--solus-accent) 50%, transparent)", value: (bar) => bar.ok },
            { key: "failed", fill: "var(--solus-art-negative)", value: (bar) => bar.failed },
          ]}
          {ticks}
          formatTick={callTickFormat(stats)}
          leftGutterPx={34}
          rightGutterPx={12}
          viewKey={`${stats.since}:${stats.until}:${stats.bucketMs}`}
          emptyText={stats.calls === 0 ? "No call in this time" : null}
          onBrush={onZoom}
        >
          {#snippet tooltip(bar: CallBar)}
            <div class="flex flex-col gap-0.5 text-xs">
              <span class="whitespace-nowrap text-muted-foreground tabular-nums">{bucketRangeLabel(bar.at, stats.bucketMs)}</span>
              <span class="whitespace-nowrap text-foreground tabular-nums">{callBarText(bar)}</span>
            </div>
          {/snippet}
        </VolumeBars>
      </div>
    {/if}
  {:else if error}
    <div class="flex flex-wrap items-center gap-3" role="alert">
      <p class="m-0 text-sm text-(--solus-text-secondary)">{error}</p>
      <Button size="sm" variant="outline" onclick={onRetry}>Try again</Button>
    </div>
  {:else}
    <p class="m-0 text-sm text-(--solus-text-tertiary)" role="status" aria-busy="true">Reading…</p>
  {/if}
</section>
