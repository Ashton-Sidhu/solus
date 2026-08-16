<script lang="ts">
  import { formatDuration, formatPercent } from "./lib/format";
  import { spanDetailLabel, type TraceView } from "./lib/waterfall";

  /**
   * Where a turn's time went, above the waterfall.
   *
   * The share bar and its legend are one reading of the same union — a kind's
   * slice is the time covered by its spans, counted once even when two of them
   * overlapped. Uninstrumented time leads the bar because on most turns it is
   * the model thinking, and a person looking for a bottleneck should see that
   * before they start reading tool names.
   */
  interface Props {
    trace: TraceView;
    /** Compact spacing for the drawer. */
    dense?: boolean;
  }

  let { trace, dense = false }: Props = $props();

  const maxToolMs = $derived(Math.max(1, ...trace.toolTotals.map((total) => total.ms)));
  const visibleTools = $derived(trace.toolTotals.slice(0, dense ? 5 : 8));
</script>

<div class="flex flex-col gap-2.5">
  <div class="flex items-baseline gap-2">
    <span
      class="text-[0.5938rem] font-medium text-muted-foreground uppercase"
      >Where the time went</span
    >
    <span class="flex-1"></span>
    <span class="text-[0.625rem] text-muted-foreground"
      >{trace.spanCount} {trace.spanCount === 1 ? "span" : "spans"}</span
    >
  </div>

  <div class="flex h-2.5 gap-px overflow-hidden rounded-full" role="img" aria-label="Duration share by span kind">
    {#each trace.legend as entry (entry.kind)}
      <span
        style="width:{Math.max(1, entry.share * 100)}%;background:{entry.color}"
        title="{entry.label} — {formatPercent(entry.share)}"
      ></span>
    {/each}
  </div>

  <div class="flex flex-wrap gap-x-5 gap-y-1.5">
    {#each trace.legend as entry (entry.kind)}
      <span class="flex items-baseline gap-1.5">
        <span class="size-1.75 rounded-sm" style="background:{entry.color}"></span>
        <span class="text-[0.625rem] text-muted-foreground">{entry.label}</span>
        <span class="text-[0.6875rem] font-medium tabular-nums">{formatPercent(entry.share)}</span>
        <span class="text-[0.625rem] tabular-nums text-muted-foreground"
          >{formatDuration(entry.ms)}</span
        >
      </span>
    {/each}
  </div>
</div>

{#if visibleTools.length > 0}
  <div class="flex flex-col gap-2">
    <span
      class="text-[0.5938rem] font-medium text-muted-foreground uppercase"
      >Longest tool calls</span
    >
    <div class="overflow-hidden rounded-lg shadow-[shadow:var(--elev-flat)]">
      {#each visibleTools as total, index (total.tool)}
        <div
          class="grid h-7.5 items-center gap-3 px-2.5"
          style="grid-template-columns:minmax(0,1fr) 1.875rem 4.25rem 3.25rem 2.5rem;box-shadow:{index
            ? 'inset 0 0.5px 0 var(--hairline)'
            : 'none'}"
        >
          <span class="truncate text-[0.6875rem]" title={total.tool}>{total.tool}</span>
          <span class="text-right text-[0.625rem] tabular-nums text-muted-foreground"
            >×{total.calls}</span
          >
          <span class="relative block h-1.5">
            <span
              class="absolute top-0 left-0 h-1.5 rounded-full bg-[var(--solus-art-4)]"
              style="width:{(total.ms / maxToolMs) * 100}%"
            ></span>
          </span>
          <span class="text-right text-[0.6875rem] tabular-nums">{formatDuration(total.ms)}</span>
          <span class="text-right text-[0.625rem] tabular-nums text-muted-foreground"
            >{formatPercent(total.share)}</span
          >
        </div>
      {/each}
    </div>
  </div>
{/if}

{#if trace.deniedPermissions.length > 0}
  <div
    class="flex flex-col gap-1 rounded-lg px-3 py-2.5"
    style="background:color-mix(in oklch, var(--warning) 8%, transparent);box-shadow:inset 0 0 0 .5px color-mix(in oklch,var(--warning) 34%,transparent)"
  >
    <span
      class="text-[0.5938rem] font-medium uppercase"
      style="color:var(--warning)"
      >{trace.deniedPermissions.length === 1
        ? "Permission denied"
        : `${trace.deniedPermissions.length} permissions denied`}</span
    >
    {#each trace.deniedPermissions as denial (denial.spanId)}
      <span class="text-[0.6875rem] leading-relaxed">
        {denial.name}{#if spanDetailLabel(denial)}
          — {spanDetailLabel(denial)}{/if} · waited {formatDuration(denial.durationMs)}
      </span>
    {/each}
  </div>
{/if}
