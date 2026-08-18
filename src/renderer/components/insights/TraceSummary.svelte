<script lang="ts">
  import { formatDuration, formatPercent } from "./lib/format";
  import { spanDetailLabel, type TraceView } from "./lib/waterfall";

  /**
   * Where a turn's time went, above the waterfall.
   *
   * The share bar and its legend are one reading of the same union — a kind's
   * slice is the time covered by its spans, counted once even when two of them
   * overlapped. Unattributed time is a coverage remainder. Its gap list says
   * where each interval sits without claiming what the provider did there.
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
  <div class="flex items-baseline gap-2 pl-0.5">
    <span class="text-[0.6875rem] font-normal text-muted-foreground uppercase"
      >Trace coverage</span
    >
    <span class="flex-1"></span>
    {#if trace.traceCoverage != null}
      <span class="text-[0.6875rem] tabular-nums text-muted-foreground"
        >{formatPercent(trace.traceCoverage)} attributed</span
      >
    {:else}
      <span class="text-[0.6875rem] text-muted-foreground"
        >{trace.spanCount} {trace.spanCount === 1 ? "span" : "spans"}</span
      >
    {/if}
  </div>

  <div class="flex h-2 gap-px overflow-hidden rounded-full" role="img" aria-label="Duration share by span kind">
    {#each trace.legend as entry (entry.kind)}
      <span
        style="width:{Math.max(1, entry.share * 100)}%;background:{entry.color}"
        title="{entry.label} — {formatPercent(entry.share)}"
      ></span>
    {/each}
  </div>

  <div class="flex flex-col gap-0.5 pl-0.5">
    {#each trace.legend as entry (entry.kind)}
      <span class="flex items-baseline gap-2">
        <span class="size-1.5 shrink-0 self-center rounded-xs" style="background:{entry.color}"
        ></span>
        <span
          class="min-w-0 flex-1 truncate text-[0.6875rem] text-muted-foreground"
          title={entry.label}>{entry.label}</span
        >
        <span class="shrink-0 text-[0.6875rem] tabular-nums">{formatPercent(entry.share)}</span>
        <span class="w-10 shrink-0 text-right text-[0.6875rem] tabular-nums text-muted-foreground"
          >{formatDuration(entry.ms)}</span
        >
      </span>
    {/each}
  </div>

  {#if trace.gapSummaries.length > 0}
    <div
      class="mt-1 flex flex-col gap-2 rounded-lg bg-[var(--wash-1)] px-2.5 py-2.5 shadow-[inset_0_0_0_0.5px_var(--hairline)]"
    >
      <div class="flex items-baseline gap-2">
        <span class="text-[0.6875rem] font-normal text-muted-foreground uppercase"
          >Unattributed gaps</span
        >
        <span class="flex-1"></span>
        <span class="text-[0.625rem] text-muted-foreground"
          >{trace.gapSummaries.reduce((total, gap) => total + gap.segments, 0)} segments</span
        >
      </div>
      <p class="m-0 text-[0.625rem] leading-relaxed text-muted-foreground text-pretty">
        These rows locate missing trace coverage. They do not identify model work or idle time.
      </p>
      <div class="flex flex-col gap-0.5">
        {#each trace.gapSummaries as gap (gap.category)}
          <div
            class="flex min-h-6 items-center gap-2 rounded-md px-1.5"
            title={gap.description}
          >
            <span class="min-w-0 flex-1 truncate text-[0.6875rem]">{gap.label}</span>
            <span class="shrink-0 text-[0.625rem] tabular-nums text-muted-foreground"
              >×{gap.segments}</span
            >
            <span class="w-8 shrink-0 text-right text-[0.625rem] tabular-nums text-muted-foreground"
              >{formatPercent(gap.share)}</span
            >
            <span class="w-11 shrink-0 text-right text-[0.6875rem] tabular-nums"
              >{formatDuration(gap.ms)}</span
            >
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>

{#if visibleTools.length > 0}
  <div class="flex flex-col gap-1">
    <span class="pl-0.5 text-[0.6875rem] font-normal text-muted-foreground uppercase"
      >Longest tool calls</span
    >
    <!-- The bar is the row's own background rather than a column of its own: in
         a 308px rail a separate track leaves the tool name too narrow to read,
         which is the one thing the list exists to say. -->
    <div class="-mx-1 flex flex-col gap-px">
      {#each visibleTools as total (total.tool)}
        <div
          class="relative flex h-[22px] items-center gap-2 overflow-hidden rounded-md px-2"
          title="{total.tool} · ×{total.calls} · {formatDuration(total.ms)}"
        >
          <span
            class="absolute inset-y-0 left-0 rounded-md"
            style="width:{(total.ms / maxToolMs) *
              100}%;background:color-mix(in oklch, var(--solus-art-4) 22%, transparent)"
            aria-hidden="true"
          ></span>
          <span class="relative min-w-0 flex-1 truncate text-[0.6875rem]">{total.tool}</span>
          <span class="relative shrink-0 text-[0.6875rem] tabular-nums text-muted-foreground"
            >×{total.calls}</span
          >
          <span class="relative w-10 shrink-0 text-right text-[0.6875rem] tabular-nums"
            >{formatDuration(total.ms)}</span
          >
          <span
            class="relative w-7 shrink-0 text-right text-[0.6875rem] tabular-nums text-muted-foreground"
            >{formatPercent(total.share)}</span
          >
        </div>
      {/each}
    </div>
  </div>
{/if}

{#if trace.deniedPermissions.length > 0}
  <div
    class="flex flex-col gap-1 rounded-lg px-2.5 py-2"
    style="background:color-mix(in oklch, var(--warning) 8%, transparent);box-shadow:inset 0 0 0 .5px color-mix(in oklch,var(--warning) 34%,transparent)"
  >
    <span
      class="text-[0.6875rem] font-normal uppercase"
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
