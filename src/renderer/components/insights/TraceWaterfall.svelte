<script lang="ts">
  import { scaleBand } from "d3-scale";
  import { Axis, Bars, Chart, Svg } from "layerchart";
  import { formatDuration, formatPercent } from "./lib/format";
  import { colorForStatus } from "./lib/span-palette";
  import {
    barExtent,
    rowsByKind,
    spanAttributes,
    spanPayload,
    type TraceView,
    type WaterfallRow,
  } from "./lib/waterfall";

  /**
   * One turn's spans on a shared time axis.
   *
   * The bars are a LayerChart chart: a band scale over the span rows and one
   * linear time scale across the whole trace, so every bar is placed by the same
   * axis rather than by a per-row percentage. That is what makes a child which
   * overlaps a sibling visibly overlap it instead of being stacked into a false
   * sequence, and it is why the ruler and its gridlines are the axis rather than
   * a drawn approximation of one.
   *
   * Labels and durations are HTML columns beside the plot, pinned to the same
   * row height as the band scale. They carry the indentation, truncation, and
   * hit targets that SVG axis ticks cannot.
   *
   * Selecting a row opens its detail below the plot rather than inline: rows
   * share one axis here, so pushing them apart mid-trace would break the very
   * alignment the chart exists to provide.
   */
  interface Props {
    trace: TraceView;
    /** Rendered inside a page (roomy) or a drawer (compact). */
    dense?: boolean;
    /** Span whose detail opens on arrival — how a deep link lands on one span.
     *  A click on any row takes over from there. */
    selectedSpanId?: string | null;
  }

  let { trace, dense = false, selectedSpanId = null }: Props = $props();

  /** `undefined` = no click yet, follow the deep link; a click owns it after. */
  let openSpanIdOverride = $state<string | null | undefined>(undefined);
  const openSpanId = $derived(
    openSpanIdOverride === undefined ? selectedSpanId : openSpanIdOverride,
  );
  let hoveredSpanId = $state<string | null>(null);

  /** Row height, shared by the band scale and the HTML columns beside it —
   *  the one number that keeps the three columns on the same lines. */
  const ROW_HEIGHT = 30;
  /** Space the top axis and its labels occupy above the first row. */
  const AXIS_HEIGHT = 20;

  const rows = $derived(trace.rows);
  const bandDomain = $derived(rows.map((row) => row.spanId));
  const plotHeight = $derived(AXIS_HEIGHT + rows.length * ROW_HEIGHT);
  const kindGroups = $derived(rowsByKind(rows));

  const openRow = $derived(rows.find((row) => row.spanId === openSpanId) ?? null);
  const highlightRows = $derived(
    rows.filter((row) => row.spanId === openSpanId || row.spanId === hoveredSpanId),
  );

  const extent = (row: WaterfallRow) => barExtent(row, trace.totalMs);
  const bandOf = (row: WaterfallRow) => row.spanId;
  const fullWidth = (): [number, number] => [0, trace.totalMs];

  function toggle(spanId: string): void {
    openSpanIdOverride = openSpanId === spanId ? null : spanId;
  }

  function durationColor(row: WaterfallRow): string {
    if (row.status === "error") return "var(--failure)";
    if (row.share != null && row.share > 0.25) return "var(--warning)";
    return "var(--muted-foreground)";
  }
</script>

<div class="flex w-full items-start">
  <div class="shrink-0" class:w-24={dense} class:w-46={!dense}>
    <div style="height:{AXIS_HEIGHT}px"></div>
    {#each rows as row (row.spanId)}
      <button
        type="button"
        class="flex w-full cursor-pointer items-center truncate rounded-sm pr-2 text-left text-xs transition-colors hover:bg-muted"
        style="height:{ROW_HEIGHT}px;padding-left:{row.depth * 12}px;color:{row.depth === 0
          ? 'var(--muted-foreground)'
          : 'var(--foreground)'};font-weight:{openSpanId === row.spanId
          ? 500
          : 400};background:{openSpanId === row.spanId ? 'var(--wash-2)' : 'transparent'}"
        title={row.label}
        aria-expanded={openSpanId === row.spanId}
        onclick={() => toggle(row.spanId)}
        onmouseenter={() => (hoveredSpanId = row.spanId)}
        onmouseleave={() => (hoveredSpanId = null)}
      >
        <span class="truncate">{row.label}</span>
      </button>
    {/each}
  </div>

  <div class="min-w-0 flex-1" style="height:{plotHeight}px">
    {#key `${trace.traceId}:${rows.length}`}
      <Chart
        data={rows}
        x={extent}
        xDomain={[0, trace.totalMs]}
        y={bandOf}
        yScale={scaleBand()}
        yDomain={bandDomain}
        padding={{ top: AXIS_HEIGHT }}
      >
        <Svg>
          <Axis
            placement="top"
            grid={{ class: "stroke-[var(--hairline)]" }}
            ticks={4}
            tickMarks={false}
            format={(value: unknown) => formatDuration(Number(value))}
            classes={{ tickLabel: "text-[0.6875rem] tabular-nums fill-[var(--muted-foreground)]" }}
          />
          <!-- Row wash first, so the selected and hovered rows sit behind the
               bars rather than tinting them. -->
          <Bars
            data={highlightRows}
            x={fullWidth}
            rounded="none"
            class="fill-[var(--wash-2)]"
          />
          {#each kindGroups as group (group.kind)}
            <Bars
              data={group.rows}
              insets={{ y: (ROW_HEIGHT - 12) / 2 }}
              rounded="all"
              radius={5}
              fill={group.color}
              fillOpacity={group.kind === "turn" ? 0.28 : 1}
              onBarClick={(_event, { data }) => toggle((data as WaterfallRow).spanId)}
              class="cursor-pointer"
            />
          {/each}
        </Svg>
      </Chart>
    {/key}
  </div>

  <div class="shrink-0" class:w-14={dense} class:w-30={!dense}>
    <div style="height:{AXIS_HEIGHT}px"></div>
    {#each rows as row (row.spanId)}
      <button
        type="button"
        class="flex w-full cursor-pointer items-center justify-end gap-3 rounded-sm pl-2 transition-colors hover:bg-muted"
        style="height:{ROW_HEIGHT}px;background:{openSpanId === row.spanId
          ? 'var(--wash-2)'
          : 'transparent'}"
        onclick={() => toggle(row.spanId)}
        onmouseenter={() => (hoveredSpanId = row.spanId)}
        onmouseleave={() => (hoveredSpanId = null)}
        aria-label="Toggle details for {row.label}"
      >
        <span class="text-xs tabular-nums" style="color:{durationColor(row)}"
          >{formatDuration(row.durationMs)}</span
        >
        {#if !dense}
          <span class="w-8 text-right text-[0.625rem] tabular-nums text-muted-foreground"
            >{row.share == null ? "" : formatPercent(row.share)}</span
          >
        {/if}
      </button>
    {/each}
  </div>
</div>

{#if openRow?.span}
  {@const attributes = spanAttributes(openRow.span)}
  {@const payload = spanPayload(openRow.span)}
  <div
    class="mt-2 flex flex-col gap-3.5 rounded-lg bg-[var(--wash-1)] px-4 py-3.5 shadow-[shadow:var(--elev-flat)]"
  >
    <div class="flex items-baseline gap-3">
      <span class="text-xs font-medium">{openRow.span.name}</span>
      <span class="text-[0.6875rem] text-muted-foreground"
        >{openRow.span.kind} · {openRow.span.service} · starts +{formatDuration(
          openRow.startOffsetMs,
        )}</span
      >
      <span class="flex-1"></span>
      <span class="text-[0.6875rem] font-medium" style="color:{colorForStatus(openRow.span.status)}"
        >{openRow.span.status}</span
      >
      <button
        type="button"
        class="cursor-pointer text-[0.6875rem] text-muted-foreground transition-colors hover:text-foreground"
        onclick={() => (openSpanIdOverride = null)}>Close</button
      >
    </div>
    {#if attributes.length > 0}
      <div class="grid grid-cols-2 gap-x-5 gap-y-3.5 sm:grid-cols-4">
        {#each attributes as attribute (attribute.key)}
          <div class="flex min-w-0 flex-col gap-1">
            <span class="text-[0.6875rem] text-muted-foreground"
              >{attribute.key}</span
            >
            <span class="truncate text-xs tabular-nums" title={attribute.value}
              >{attribute.value}</span
            >
          </div>
        {/each}
      </div>
    {/if}
    {#if payload}
      <div class="flex flex-col gap-1.5">
        <span class="text-[0.6875rem] text-muted-foreground"
          >{payload.label}</span
        >
        <pre
          class="max-h-56 overflow-auto rounded-md bg-card px-3 py-2 text-[0.6875rem] leading-[1.7] whitespace-pre-wrap shadow-[shadow:var(--elev-flat)]"
          data-sb>{payload.text}</pre>
      </div>
    {/if}
  </div>
{/if}
