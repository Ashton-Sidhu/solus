<script lang="ts">
  import { scaleBand } from "d3-scale";
  import { Axis, Bar, Bars, Chart, Svg } from "layerchart";
  import { CaretRightIcon, XIcon } from "phosphor-svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { fly } from "svelte/transition";
  import { TIME_AXIS_INSET_PX, TIME_AXIS_LABEL_GAP_PX } from "./lib/chart-axis";
  import { formatDuration, formatPercent } from "./lib/format";
  import CopyButton from "../ui/CopyButton.svelte";
  import { colorForStatus, labelForKind } from "./lib/span-palette";
  import { spanAttributes, spanPayload, visibleRows, type TraceView } from "./lib/waterfall";
  import {
    activation,
    barsForLines,
    buildWaterfallTree,
    expandableIds,
    flattenTree,
    pathToSpan,
    type WaterfallBar,
    type WaterfallLine,
  } from "./lib/waterfall-tree";

  /**
   * One turn's spans on a shared time axis, folded into lanes.
   *
   * The bars are a LayerChart chart: a band scale over the visible lines and one
   * linear time scale across the whole trace, so every bar is placed by the same
   * axis rather than by a per-row percentage. That is what makes a child which
   * overlaps a sibling visibly overlap it instead of being stacked into a false
   * sequence, and it is why the ruler and its gridlines are the axis rather than
   * a drawn approximation of one.
   *
   * A trace is long and mostly repetition, so a run of consecutive siblings of
   * one kind opens as a single lane with every member still drawn on it. The
   * fold is by run, not by kind, because sequence is what a waterfall is for:
   * thinking, three tools, thinking again, five more tools stays four rows in
   * that order. Nothing is hidden from the picture by the fold — only from the
   * label column — and a member stays clickable from the folded lane, so the
   * reader opens a lane to read names, not to find a span.
   *
   * Labels and durations are HTML columns beside the plot, pinned to the same
   * row height as the band scale. They carry the indentation, truncation, and
   * hit targets that SVG axis ticks cannot. A label carries no coloured dot:
   * the bar on that same line already wears the kind's hue, so a dot beside the
   * name only spends left margin the name needs.
   *
   * Selecting a span opens its detail in a dock at the foot of the plot rather
   * than inline: rows share one axis here, so pushing them apart mid-trace
   * would break the very alignment the chart exists to provide. The dock is
   * sticky, so a trace hundreds of rows long can be read from top to bottom
   * with the open span's detail still on screen — the reader picks a row and
   * keeps reading instead of scrolling to the end and back for every pick.
   * Because the detail is no longer beside its own row, the dock carries a
   * position track showing where in the trace the open span sits.
   */
  interface Props {
    trace: TraceView;
    /** Span whose detail opens on arrival — how a deep link lands on one span.
     *  A click on any row takes over from there. */
    selectedSpanId?: string | null;
    /** Draw the work Solus did around the agent's — dispatch and its steps, the
     *  queue, settlement — as rows of their own. */
    showInternals?: boolean;
  }

  let { trace, selectedSpanId = null, showInternals = false }: Props = $props();

  /** Row height, shared by the band scale and the HTML columns beside it —
   *  the one number that keeps the three columns on the same lines. */
  const ROW_HEIGHT = 30;
  /** Space the top axis and its labels occupy above the first row. */
  const AXIS_HEIGHT = TIME_AXIS_INSET_PX;
  const BAR_HEIGHT = 12;

  const rows = $derived(visibleRows(trace.rows, showInternals));
  const tree = $derived(buildWaterfallTree(rows, trace.totalMs));
  const expandable = $derived(expandableIds(tree));

  /** Lanes opened so a deep-linked span is on screen. Everything else stays
   *  folded: the fold is the point. */
  const deepLinkExpanded = $derived(
    new Set(selectedSpanId ? pathToSpan(tree, selectedSpanId) : []),
  );

  /** The reader's own expansion, and the trace it was made in — so moving to
   *  another turn falls back to that turn's deep link rather than carrying
   *  span ids from the previous one. */
  const userExpanded = new SvelteSet<string>();
  let userExpandedTraceId = $state<string | null>(null);
  const expanded = $derived(
    userExpandedTraceId === trace.traceId ? userExpanded : deepLinkExpanded,
  );

  const lines = $derived(flattenTree(tree, expanded));
  const lineIds = $derived(lines.map((line) => line.id));
  const bars = $derived(barsForLines(lines, tree, trace.totalMs));
  const plotHeight = $derived(AXIS_HEIGHT + lines.length * ROW_HEIGHT);
  const allExpanded = $derived(
    expandable.length > 0 && expandable.every((id) => expanded.has(id)),
  );

  /** `undefined` = no click yet, follow the deep link; a click owns it after. */
  let openSpanIdOverride = $state<string | null | undefined>(undefined);
  const openSpanId = $derived(
    openSpanIdOverride === undefined ? selectedSpanId : openSpanIdOverride,
  );
  const openRow = $derived(rows.find((row) => row.spanId === openSpanId) ?? null);

  let hoveredLineId = $state<string | null>(null);
  let hoveredBar = $state<WaterfallBar | null>(null);

  /** The lines the open span is drawn on — its own row when it has one, and
   *  the folded lane that still carries its bar when it does not. */
  const openLineIds = $derived(
    bars.filter((bar) => bar.spanId === openSpanId).map((bar) => bar.lineId),
  );
  const highlightIds = $derived(
    new Set([...openLineIds, hoveredLineId, hoveredBar?.lineId].filter((id) => id != null)),
  );
  const highlightBands = $derived([...highlightIds].map((lineId) => ({ lineId })));

  function takeOwnership(): void {
    if (userExpandedTraceId === trace.traceId) return;
    userExpanded.clear();
    for (const id of deepLinkExpanded) userExpanded.add(id);
    userExpandedTraceId = trace.traceId;
  }

  function setExpanded(id: string, open: boolean): void {
    takeOwnership();
    if (open) userExpanded.add(id);
    else userExpanded.delete(id);
  }

  function toggleAll(): void {
    takeOwnership();
    if (allExpanded) userExpanded.clear();
    else for (const id of expandable) userExpanded.add(id);
  }

  function selectSpan(spanId: string): void {
    openSpanIdOverride = openSpanId === spanId ? null : spanId;
  }

  /** A row with a caret unfolds on click; a span's row opens its detail in the
   *  same click. A lane has no detail of its own — its members do, and they are
   *  one click away either from the lane's bars or from the rows it reveals. */
  function activate(line: WaterfallLine): void {
    const { toggleId, selectSpanId } = activation(line);
    if (toggleId) setExpanded(toggleId, !line.expanded);
    if (selectSpanId) selectSpan(selectSpanId);
  }

  function onLineKeydown(event: KeyboardEvent, line: WaterfallLine): void {
    const expandableLine = line.type === "group" || line.expandable;
    if (!expandableLine) return;
    if (event.key === "ArrowRight" && !line.expanded) {
      event.preventDefault();
      setExpanded(line.id, true);
    } else if (event.key === "ArrowLeft" && line.expanded) {
      event.preventDefault();
      setExpanded(line.id, false);
    }
  }

  /** What the label column reads for a line: the lane's name, or — while the
   *  pointer is on one of its bars — the span under the pointer. */
  function labelOf(line: WaterfallLine): string {
    if (hoveredBar?.lineId === line.id) return hoveredBar.label;
    return line.type === "group" ? line.group.label : line.row.label;
  }

  function durationOf(line: WaterfallLine): number | null {
    if (hoveredBar?.lineId === line.id) return hoveredBar.durationMs;
    return line.type === "group" ? line.group.totalMs : line.row.durationMs;
  }

  function shareOf(line: WaterfallLine): number | null {
    if (hoveredBar?.lineId === line.id) return null;
    return line.type === "group" ? line.group.share : line.row.share;
  }

  function durationColor(line: WaterfallLine): string {
    if (line.type === "span" && line.row.status === "error") return "var(--failure)";
    if (line.type === "group" && line.group.errorCount > 0) return "var(--failure)";
    const share = line.type === "group" ? line.group.share : line.row.share;
    if (line.depth > 0 && share != null && share > 0.25) return "var(--warning)";
    return "var(--muted-foreground)";
  }

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /** Where the open span sits in the trace, as the dock's position track. The
   *  detail is at the foot of the plot rather than beside its row, so this is
   *  the only thing left saying when in the turn the span ran. */
  const openExtent = $derived(
    openRow && trace.totalMs > 0
      ? {
          left: (openRow.startOffsetMs / trace.totalMs) * 100,
          width: Math.max((openRow.durationMs ?? 0) / trace.totalMs, 0.006) * 100,
        }
      : null,
  );

  function onDockKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    openSpanIdOverride = null;
  }

  const extentOf = (bar: WaterfallBar): [number, number] => [bar.from, bar.to];
  const bandOf = (item: { lineId: string }): string => item.lineId;
  const fullWidth = (): [number, number] => [0, trace.totalMs];
</script>

<div class="flex w-full items-start">
  <div class="w-52 shrink-0">
    <div class="flex items-center" style="height:{AXIS_HEIGHT}px">
      {#if expandable.length > 0}
        <button
          type="button"
          class="cursor-pointer rounded-sm pr-1 py-0.5 text-[0.625rem] text-muted-foreground outline-none transition-colors select-none hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--primary)"
          onclick={toggleAll}>{allExpanded ? "Collapse all" : "Expand all"}</button
        >
      {/if}
    </div>
    {#each lines as line (line.id)}
      {@const isExpandable = line.type === "group" || line.expandable}
      {@const isOpen = line.type === "span" && line.row.spanId === openSpanId}
      <!-- The caret hangs in the gutter: the row is pulled left by exactly the
           caret slot and its gap, so a top-level name starts on the column's own
           edge, level with the expand control above it, and the disclosure
           triangle sits outside the text rather than pushing every name right. -->
      <button
        type="button"
        class="-ml-3.5 flex w-full cursor-pointer items-center gap-1 rounded-sm pr-2 text-left text-xs outline-none transition-colors select-none hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--primary)"
        class:font-medium={line.type === "group" || isOpen}
        style="height:{ROW_HEIGHT}px;color:{line.depth === 0
          ? 'var(--muted-foreground)'
          : 'var(--foreground)'};background:{isOpen ? 'var(--wash-2)' : 'transparent'}"
        title={line.type === "group" && line.group.detail
          ? `${line.group.label} — ${line.group.detail}`
          : labelOf(line)}
        aria-expanded={isExpandable ? line.expanded : undefined}
        onclick={() => activate(line)}
        onkeydown={(event) => onLineKeydown(event, line)}
        onmouseenter={() => (hoveredLineId = line.id)}
        onmouseleave={() => (hoveredLineId = null)}
      >
        {#each { length: line.depth } as _, level (level)}
          <span class="h-full w-1.5 shrink-0 border-l border-[var(--hairline)]"></span>
        {/each}
        <span class="flex size-2.5 shrink-0 items-center justify-center">
          {#if isExpandable}
            <CaretRightIcon
              size={9}
              weight="bold"
              class="opacity-45 transition-transform duration-150 {line.expanded ? 'rotate-90' : ''}"
            />
          {/if}
        </span>
        <span class="truncate">{labelOf(line)}</span>
        {#if line.type === "group"}
          <span
            class="shrink-0 rounded-sm bg-[var(--wash-2)] px-1 text-[0.625rem] font-normal tabular-nums text-muted-foreground"
            >{line.group.memberCount}</span
          >
          {#if line.group.errorCount > 0}
            <span
              class="shrink-0 rounded-sm px-1 text-[0.625rem] font-normal tabular-nums"
              style="background:color-mix(in oklch, var(--failure) 12%, transparent);color:var(--failure)"
              title="{line.group.errorCount} failed">{line.group.errorCount}</span
            >
          {/if}
        {:else if !line.expanded && line.hiddenCount > 0}
          <span
            class="shrink-0 rounded-sm bg-[var(--wash-2)] px-1 text-[0.625rem] font-normal tabular-nums text-muted-foreground"
            title="{line.hiddenCount} nested spans">+{line.hiddenCount}</span
          >
        {/if}
      </button>
    {/each}
  </div>

  <div class="min-w-0 flex-1" style="height:{plotHeight}px">
    {#key trace.traceId}
      <Chart
        data={bars}
        x={extentOf}
        xDomain={[0, trace.totalMs]}
        y={bandOf}
        yScale={scaleBand()}
        yDomain={lineIds}
        padding={{ top: AXIS_HEIGHT }}
      >
        <Svg>
          <Axis
            placement="top"
            grid={{ class: "stroke-[var(--hairline)]" }}
            ticks={4}
            tickMarks={false}
            tickLength={0}
            tickLabelProps={{ dy: -TIME_AXIS_LABEL_GAP_PX }}
            format={(value: unknown) => formatDuration(Number(value))}
            classes={{ tickLabel: "text-[0.6875rem] tabular-nums fill-[var(--muted-foreground)]" }}
          />
          <!-- Row wash first, so the selected and hovered rows sit behind the
               bars rather than tinting them. -->
          <Bars data={highlightBands} x={fullWidth} rounded="none" class="fill-[var(--wash-2)]" />
          {#each bars as bar (bar.id)}
            <Bar
              data={bar}
              insets={{ y: (ROW_HEIGHT - BAR_HEIGHT) / 2 }}
              rounded="all"
              radius={3}
              fill={bar.color}
              fillOpacity={bar.faded ? 0.26 : 0.92}
              class="cursor-pointer transition-[fill-opacity] duration-150"
              onclick={() => selectSpan(bar.spanId)}
              onpointerenter={() => (hoveredBar = bar)}
              onpointerleave={() => (hoveredBar = null)}
            />
          {/each}
        </Svg>
      </Chart>
    {/key}
  </div>

  <div class="w-30 shrink-0">
    <div style="height:{AXIS_HEIGHT}px"></div>
    {#each lines as line (line.id)}
      {@const share = shareOf(line)}
      <button
        type="button"
        class="flex w-full cursor-pointer items-center justify-end gap-3 rounded-sm pl-2 outline-none transition-colors select-none hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--primary)"
        style="height:{ROW_HEIGHT}px;background:{line.type === 'span' &&
        line.row.spanId === openSpanId
          ? 'var(--wash-2)'
          : 'transparent'}"
        onclick={() => activate(line)}
        onmouseenter={() => (hoveredLineId = line.id)}
        onmouseleave={() => (hoveredLineId = null)}
        aria-label={line.type === "group"
          ? `Expand ${labelOf(line)}`
          : `Toggle details for ${labelOf(line)}`}
      >
        <span class="text-xs tabular-nums" style="color:{durationColor(line)}"
          >{formatDuration(durationOf(line))}</span
        >
        <span class="w-8 text-right text-[0.625rem] tabular-nums text-muted-foreground"
          >{share == null ? "" : formatPercent(share)}</span
        >
      </button>
    {/each}
  </div>
</div>

{#if openRow?.span}
  {@const attributes = spanAttributes(openRow.span)}
  {@const payload = spanPayload(openRow.span)}
  <!-- The dock sticks to the foot of the reader's view while any of the plot is
       still on screen, so picking a row deep in a long trace never costs a
       round trip to the bottom of the page. `bottom-0` is the scroller's own
       edge; the card keeps its own inset so it reads as lifted off the page. -->
  <div class="sticky bottom-0 z-10 pt-3 pb-1">
    <!-- The dock is a region, not a control; the keydown is only there so Escape
         dismisses it from anywhere inside it. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="flex max-h-[min(24rem,45vh)] flex-col overflow-hidden rounded-xl bg-card shadow-[shadow:var(--elev-lift)]"
      role="group"
      aria-label="Span detail"
      tabindex="-1"
      onkeydown={onDockKeydown}
      transition:fly={{ y: 10, duration: reduceMotion ? 0 : 160 }}
    >
      <!-- The head states the span in three descending registers — what it is,
           what it is called, how long it took — and closes on the ruler that
           says where in the turn it ran. Colour is spent only where it carries
           a fact: a failed status. -->
      <div class="shrink-0">
        <div class="flex items-center gap-3 px-4 pt-3">
          <span class="min-w-0 truncate text-[0.6875rem] text-muted-foreground"
            >{labelForKind(openRow.span.kind)} · {openRow.span.service}</span
          >
          <span class="flex-1"></span>
          <button
            type="button"
            class="-mr-1 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--primary)"
            title="Close detail"
            aria-label="Close span detail"
            onclick={() => (openSpanIdOverride = null)}><XIcon size={12} weight="bold" /></button
          >
        </div>
        <div class="truncate px-4 pt-0.5 text-sm font-medium">{openRow.span.name}</div>
        <div class="flex items-baseline gap-2.5 px-4 pt-1.5 pb-2.5">
          <span class="text-sm font-medium tabular-nums">{formatDuration(openRow.durationMs)}</span>
          {#if openRow.share != null}
            <span class="text-[0.6875rem] tabular-nums text-muted-foreground"
              >{formatPercent(openRow.share)} of turn</span
            >
          {/if}
          <span class="text-[0.6875rem] tabular-nums text-muted-foreground"
            >starts +{formatDuration(openRow.startOffsetMs)}</span
          >
          <span class="flex-1"></span>
          <span
            class="shrink-0 text-[0.6875rem]"
            style="color:{openRow.span.status === 'error'
              ? colorForStatus(openRow.span.status)
              : 'var(--muted-foreground)'}">{openRow.span.status}</span
          >
        </div>
        <!-- Where in the turn this span ran, drawn edge to edge so the head sits
             on the trace's own clock. The detail is no longer beside its row,
             and this is what replaces that adjacency. -->
        <div class="relative h-0.5 bg-[var(--wash-2)]">
          {#if openExtent}
            <span
              class="absolute inset-y-0 bg-[var(--muted-foreground)]"
              style="left:{openExtent.left}%;width:{openExtent.width}%"
            ></span>
          {/if}
        </div>
      </div>
      <div class="flex min-h-0 flex-col gap-3.5 overflow-y-auto px-4 pt-3.5 pb-3.5" data-sb>
        {#if attributes.length > 0}
          <div class="grid grid-cols-2 gap-x-5 gap-y-3.5 sm:grid-cols-4">
            {#each attributes as attribute (attribute.key)}
              <div class="flex min-w-0 flex-col gap-1">
                <span class="text-[0.6875rem] text-muted-foreground">{attribute.key}</span>
                <!-- Wraps rather than truncates: a value clipped by CSS cannot be
                     dragged over, and this block exists to be read and copied. -->
                <span class="text-xs tabular-nums wrap-anywhere select-text">{attribute.value}</span>
              </div>
            {/each}
          </div>
        {/if}
        {#if payload}
          <div class="flex flex-col gap-1.5">
            <span class="flex items-center gap-1 text-[0.6875rem] text-muted-foreground"
              >{payload.label}
              <CopyButton text={payload.text} title="Copy {payload.label.toLowerCase()}" iconOnly />
            </span>
            <pre
              class="overflow-x-auto rounded-md bg-[var(--wash-1)] px-3 py-2 text-[0.6875rem] leading-[1.7] whitespace-pre-wrap select-text shadow-[shadow:var(--elev-flat)]"
              data-sb>{payload.text}</pre>
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}
