<script lang="ts">
  import type { AppMetrics, AppSummary } from "@solus/contracts/apps";
  import { appsStore } from "../../../../contexts/apps/apps.store.svelte";
  import { formatDuration } from "../../../insights/lib/format";
  import { Button } from "../../../ui/button";
  import { appTime } from "../../lib/app-view";
  import { failureRateText, hourBarLabel, hourBars, hourSpanStartLabel } from "../lib/overview";

  /**
   * The last 24 hours, plain on the page: the calls, the failed calls (a press
   * opens them in Activity), the median and the 95th percentile of the time,
   * the last call, and a bar for each hour. The failed part of a bar is on its
   * top in the error colour; the hour in progress is the full accent.
   */
  interface Props {
    serverId: string;
    app: AppSummary;
    /** Undefined until the host answers. */
    metrics: AppMetrics | undefined;
    onShowFailures: () => void;
  }
  let { serverId, app, metrics, onShowFailures }: Props = $props();

  const metricsError = $derived(appsStore.metrics.errorFor(serverId, app.id));
  const bars = $derived(metrics ? hourBars(metrics.hours) : []);
</script>

<section class="flex flex-col gap-3.5" aria-label="The last 24 hours" data-testid="app-overview-metrics">
  <div class="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
    <h3 class="m-0 text-[15px] font-semibold text-foreground">The last 24 hours</h3>
    {#if metrics && metrics.calls > 0}
      <span class="text-[13px] text-(--solus-text-tertiary)">One bar for each hour. The failed calls are on top.</span>
    {/if}
  </div>

  {#if metrics}
    <dl class="m-0 flex flex-wrap items-end gap-x-9 gap-y-4">
      <div class="flex items-baseline gap-1.5">
        <dt class="sr-only">Calls</dt>
        <dd class="m-0 text-[2.125rem] leading-[2.625rem] font-medium tracking-[-0.02em] tabular-nums text-foreground">{metrics.calls.toLocaleString()}</dd>
        <span class="text-[15px] text-(--solus-text-secondary)" aria-hidden="true">{metrics.calls === 1 ? "call" : "calls"}</span>
      </div>
      <div class="flex flex-col gap-0.5">
        <dt class="text-[13px] text-(--solus-text-tertiary)">Failed</dt>
        <dd class="m-0 text-base font-medium tabular-nums">
          {#if metrics.failed > 0}
            <button
              type="button"
              class="cursor-pointer rounded border-0 bg-transparent p-0 text-base font-medium text-(--failure) underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]"
              title="{failureRateText(metrics.calls, metrics.failed)} of the calls. Open them in Activity."
              onclick={onShowFailures}
              data-testid="app-overview-failed">{metrics.failed.toLocaleString()}</button
            >
          {:else}
            <span class="text-foreground">0</span>
          {/if}
        </dd>
      </div>
      <div class="flex flex-col gap-0.5">
        <dt class="text-[13px] text-(--solus-text-tertiary)">p50</dt>
        <dd class="m-0 text-base font-medium tabular-nums text-foreground">{formatDuration(metrics.p50Ms)}</dd>
      </div>
      <div class="flex flex-col gap-0.5">
        <dt class="text-[13px] text-(--solus-text-tertiary)">p95</dt>
        <dd class="m-0 text-base font-medium tabular-nums text-foreground">{formatDuration(metrics.p95Ms)}</dd>
      </div>
      <div class="flex flex-col gap-0.5">
        <dt class="text-[13px] text-(--solus-text-tertiary)">Last call</dt>
        <dd class="m-0 text-base font-medium tabular-nums text-foreground">{app.lastCallAt === null ? "None yet" : appTime(app.lastCallAt)}</dd>
      </div>
    </dl>

    {#if metrics.calls > 0 && bars.length > 0}
      <div class="flex flex-col gap-1.5">
        <div class="flex h-16 items-end gap-1 border-b border-[var(--hairline-strong)]" role="img" aria-label="Calls in each of the last 24 hours" data-testid="app-overview-hours">
          {#each bars as bar, index (bar.start)}
            {@const isNow = index === bars.length - 1}
            <div class="flex min-w-0 flex-1 flex-col gap-px {bar.calls > 0 ? 'min-h-0.5' : ''}" style:height="{bar.height * 100}%" title={hourBarLabel(bar)}>
              {#if bar.failed > 0}
                <div class="min-h-0.5 shrink-0 rounded-t-[3px] bg-(--failure)" style:height="{bar.failedPart * 100}%"></div>
              {/if}
              {#if bar.failed < bar.calls}
                <div class="min-h-0 flex-1 {bar.failed > 0 ? '' : 'rounded-t-[3px]'} {isNow ? 'bg-(--solus-accent)' : 'bg-[color-mix(in_oklch,var(--solus-accent)_50%,transparent)]'}"></div>
              {/if}
            </div>
          {/each}
        </div>
        <div class="flex justify-between text-xs text-(--solus-text-tertiary)">
          <span>{hourSpanStartLabel(bars[0].start)}</span>
          <span>Now</span>
        </div>
      </div>
    {/if}
  {:else if metricsError}
    <div class="flex flex-wrap items-center gap-3">
      <p class="m-0 text-sm text-(--solus-text-secondary)">{metricsError}</p>
      <Button size="sm" variant="outline" class="text-workspace-chrome" onclick={() => void appsStore.metrics.load(serverId, app.id)}>Try again</Button>
    </div>
  {:else}
    <p class="m-0 text-sm text-(--solus-text-tertiary)">Reading…</p>
  {/if}
</section>
