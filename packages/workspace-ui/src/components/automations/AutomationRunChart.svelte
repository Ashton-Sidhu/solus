<script lang="ts">
  import { scaleBand } from "d3-scale";
  import { Bar, Chart, Highlight, Svg, Tooltip } from "layerchart";
  import type { AutomationRunPoint } from "@solus/contracts/types";
  import { runHealth, type HealthBar } from "./lib/automation-format";

  /**
   * An automation's recent runs, oldest to newest: one bar per run, its height
   * the run's duration against the longest in the window, its colour how the
   * run ended. Hovering a bar names when it ran, for how long, and the outcome.
   *
   * `full` is the detail page's graph with the success rate beside it;
   * `compact` is the list row's glance, bars only.
   */
  interface Props {
    /** Newest first, the order the store keeps them in. */
    runs: readonly AutomationRunPoint[];
    variant?: "full" | "compact";
  }

  let { runs, variant = "full" }: Props = $props();

  const health = $derived(runHealth(runs));

  /** The status palette the rest of Solus uses, themed for light and dark. */
  const TONE_FILL = {
    success: "var(--solus-status-complete)",
    error: "var(--solus-status-error)",
    running: "var(--solus-status-running)",
    cancelled: "var(--solus-status-idle)",
  } satisfies Record<HealthBar["tone"], string>;
</script>

{#if health.total === 0}
  {#if variant === "full"}
    <span class="text-workspace-chrome text-muted-foreground">No runs yet</span>
  {/if}
{:else}
  <div class="flex min-w-0 items-end gap-3.5 {variant === 'compact' ? 'w-full' : ''}">
    <div
      class={variant === "full"
        ? "h-10 w-[17rem] min-w-0 @max-[43.75rem]:w-full"
        : "h-5 w-full min-w-0"}
      role="img"
      aria-label="Last {health.total} runs: {health.clean} clean"
    >
      <Chart
        data={health.bars}
        x={(bar: HealthBar) => bar.id}
        xScale={scaleBand().padding(variant === "full" ? 0.22 : 0.28)}
        y={(bar: HealthBar) => bar.heightPct}
        yDomain={[0, 100]}
        tooltipContext={{ mode: "band" }}
      >
        <Svg>
          <Highlight area={{ class: "fill-[var(--wash-2)]" }} />
          {#each health.bars as bar (bar.id)}
            <Bar
              data={bar}
              rounded="top"
              radius={variant === "full" ? 2 : 1}
              fill={TONE_FILL[bar.tone]}
              fillOpacity={bar.latest ? 1 : 0.6}
            />
          {/each}
        </Svg>
        <!-- Portalled and kept on screen: a list row clips its own overflow. -->
        <Tooltip.Root
          variant="none"
          portal
          contained="window"
          classes={{
            root: "pointer-events-none z-50 rounded-lg bg-popover px-2.5 py-1.5 text-popover-foreground shadow-[shadow:var(--solus-menu-shadow)]",
          }}
        >
          {#snippet children({ data }: { data: HealthBar })}
            <div class="flex flex-col gap-0.5 text-xs">
              <span class="flex items-center gap-1.5 font-medium">
                <span
                  class="size-2 shrink-0 rounded-full"
                  style="background:{TONE_FILL[data.tone]}"
                  aria-hidden="true"
                ></span>
                {data.statusLabel}
                {#if data.latest}
                  <span class="font-normal text-muted-foreground">· latest</span>
                {/if}
              </span>
              <span class="whitespace-nowrap text-muted-foreground">{data.startedLabel}</span>
              <span class="tabular-nums text-muted-foreground">{data.durationLabel}</span>
            </div>
          {/snippet}
        </Tooltip.Root>
      </Chart>
    </div>
    {#if variant === "full"}
      <div class="flex shrink-0 flex-col items-end leading-tight">
        <span
          class="text-workspace-chrome font-medium tabular-nums {health.rateTone === 'good'
            ? 'text-[color:var(--solus-status-complete)]'
            : health.rateTone === 'mixed'
              ? 'text-[color:var(--solus-status-permission)]'
              : 'text-[color:var(--solus-status-error)]'}"
        >
          {health.successRate}%
        </span>
        <span class="text-xs whitespace-nowrap text-muted-foreground">
          {health.clean} of {health.total} clean
        </span>
      </div>
    {/if}
  </div>
{/if}
