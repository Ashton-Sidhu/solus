<script lang="ts">
  import { ChevronLeft as PreviousIcon, ChevronRight as NextIcon, History as EarlierIcon, X as ClearIcon } from "@lucide/svelte";
  import { scaleBand } from "d3-scale";
  import { curveMonotoneX } from "d3-shape";
  import { Area, Bar, Chart, Rule, Spline, Svg } from "layerchart";
  import { formatElapsed } from "@solus/client-core/elapsed-time";
  import {
    breakLabel,
    costAxisTop,
    timelineBarText,
    timelineChartRows,
    timelineLabels,
    timelineLayout,
    timelineWorkMs,
    type TimelineChartRow,
    type TimelineTurn,
    type TurnCost,
  } from "@solus/client-core/turn-timeline";
  import { formatCost, formatCostTick } from "../../insights/lib/format";
  import { barClockTime, clockTime, turnClockLabel } from "./lib/overview-view";

  /**
   * The session as its work and its spend over time
   * (docs/plans/session-artifacts.md). Each bar is one round span of working
   * time, as tall as the tool calls the agent made in it; a span with none
   * draws nothing. Over the bars, on its own axis at the right, a smooth line
   * climbs with what the turns cost so far: each turn's cost is spread over its
   * working time, so a costly turn is a steep climb. The time axis names when
   * each turn started and marks where every turn begins. A wait of an hour or
   * more is a break, and the line says how long it was. Pointing shows a card
   * with the bar in numbers. Selecting a turn scopes the surface to it: one
   * brush glides from turn to turn, and selecting the same turn again shows
   * the whole session. A turn with no known cost adds nothing to the line, and
   * with no known cost at all there is no line.
   */
  interface Props {
    turns: readonly TimelineTurn[];
    toolCallTimes: readonly number[];
    /** The tool calls of the sessions it started, stacked on its own bars. Empty draws its own alone. */
    agentCallTimes?: readonly number[];
    /** What its turns cost, and under the whole tree its agents' turns too. Empty draws no cost line. */
    turnCosts?: readonly TurnCost[];
    /** The session still works: the line ends at "now". */
    live: boolean;
    /** The turn the surface is scoped to, by its prompt's id. Null is the whole session. */
    scopeTurnId: string | null;
    onScope: (turnId: string | null) => void;
    /** Reads the turns before the first one shown. Present while the conversation holds only its recent history. */
    onLoadEarlier?: () => void;
    loadingEarlier?: boolean;
  }
  let { turns, toolCallTimes, agentCallTimes = [], turnCosts = [], live, scopeTurnId, onScope, onLoadEarlier, loadingEarlier = false }: Props = $props();

  /** Tall enough that a costly turn reads as a climb and a busy minute as a peak. */
  const PLOT_HEIGHT = 160;
  /** The room under the plot for the turn marks and the start times. */
  const LABEL_ROOM = 22;
  /** The scroller's top padding: room for the brush, which reaches a little over the bars. */
  const PLOT_TOP = 6;
  const MIN_PITCH = 5;
  const LABEL_WIDTH = 52;
  /** Room at the line's end for the "now" rule and its label. */
  const NOW_GUTTER = 28;
  /** A bar with one call is still this tall. */
  const MIN_BAR_PX = 3;

  let viewWidth = $state(0);
  let scrollLeft = $state(0);
  let scroller = $state<HTMLDivElement | null>(null);
  let turnButtons = $state<(HTMLButtonElement | null)[]>([]);
  let pointedBar = $state<number | null>(null);
  /** Where the brush last was, so it fades in place when the scope clears. */
  let lastScopeIndex = $state(0);
  /** False until the plot has its width, so the brush is placed, not flown in, on the first paint. */
  let placed = $state(false);

  const gutter = $derived(live ? NOW_GUTTER : 0);
  const roomWidth = $derived(Math.max(0, viewWidth - gutter));
  const layout = $derived(timelineLayout(turns, toolCallTimes, Math.max(1, Math.floor(roomWidth / MIN_PITCH)), agentCallTimes, turnCosts));
  const drawsAgents = $derived(layout.bars.some((bar) => bar.agentCalls > 0));
  const drawsCost = $derived(layout.totalCostUsd > 0);
  const costTop = $derived(costAxisTop(layout.totalCostUsd));
  const rows = $derived(timelineChartRows(layout, costTop, MIN_BAR_PX / PLOT_HEIGHT));
  const barIndexes = $derived(rows.map((row) => row.index));
  // With more turns than the pane has room for, the plot keeps its bars readable and scrolls.
  const plotWidth = $derived(Math.max(roomWidth, layout.bars.length * MIN_PITCH));
  const pitch = $derived(layout.bars.length > 0 ? plotWidth / layout.bars.length : MIN_PITCH);
  const barWidth = $derived(Math.max(2, Math.min(5, Math.round(pitch * 0.6))));

  /** A turn's stretch of the line: its bars and the wait after them, up to the next turn's start. */
  const stretches = $derived(
    layout.ranges.map((range, index) => {
      const end = layout.ranges[index + 1]?.from ?? layout.bars.length;
      return { from: range.from, end, left: range.from * pitch, width: (end - range.from) * pitch };
    }),
  );
  /** The turn each bar's stretch belongs to. */
  const barTurns = $derived.by(() => {
    const owners: number[] = [];
    stretches.forEach((stretch, index) => {
      for (let bar = stretch.from; bar < stretch.end; bar++) owners[bar] = index;
    });
    return owners;
  });
  const labelled = $derived(timelineLabels(layout.ranges, pitch, plotWidth, LABEL_WIDTH));

  const scopeIndex = $derived.by(() => {
    if (scopeTurnId === null) return null;
    const index = turns.findIndex((turn) => turn.id === scopeTurnId);
    return index === -1 ? null : index;
  });
  const brush = $derived(stretches[scopeIndex ?? lastScopeIndex]);
  const scopedTurn = $derived(scopeIndex === null ? null : turns[scopeIndex]);
  const scopedTurnCost = $derived(scopeIndex === null ? null : (layout.turnCostUsd[scopeIndex] ?? null));

  const pointed = $derived(pointedBar === null ? null : (layout.bars[pointedBar] ?? null));
  const pointedTurn = $derived(pointedBar === null ? null : (barTurns[pointedBar] ?? null));
  const pointedTurnCost = $derived(pointed?.turn == null ? null : (layout.turnCostUsd[pointed.turn] ?? null));
  /** Where the card sits: beside the pointed bar, on the side with room. */
  const cardX = $derived(pointedBar === null ? 0 : (pointedBar + 0.5) * pitch - scrollLeft);
  const cardFlips = $derived(cardX > viewWidth / 2);

  $effect(() => {
    if (viewWidth === 0 || placed) return;
    const frame = requestAnimationFrame(() => (placed = true));
    return () => cancelAnimationFrame(frame);
  });

  // The newest turn is at the end of the line: a plot too wide for the pane starts there.
  $effect(() => {
    if (scroller && plotWidth > roomWidth) scroller.scrollLeft = scroller.scrollWidth;
  });

  function select(index: number | null) {
    if (index !== null) lastScopeIndex = index;
    onScope(index === null ? null : turns[index].id);
  }

  /** One turn forward or back. A step past either end returns to the whole session. */
  function step(delta: number, moveFocus: boolean) {
    const from = scopeIndex ?? (delta > 0 ? -1 : turns.length);
    const next = from + delta;
    const inRange = next >= 0 && next < turns.length;
    select(inRange ? next : null);
    if (moveFocus && inRange) turnButtons[next]?.focus();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      step(event.key === "ArrowRight" ? 1 : -1, true);
    } else if (event.key === "Escape" && scopeIndex !== null) {
      event.preventDefault();
      event.stopPropagation();
      select(null);
    }
  }

  function handlePointerMove(event: PointerEvent & { currentTarget: HTMLDivElement }) {
    if (layout.bars.length === 0) return;
    const x = event.clientX - event.currentTarget.getBoundingClientRect().left;
    pointedBar = Math.max(0, Math.min(layout.bars.length - 1, Math.floor(x / pitch)));
  }

  const BAR_TONE = {
    rest: "fill-[color-mix(in_srgb,var(--solus-accent)_42%,transparent)]",
    near: "fill-[color-mix(in_srgb,var(--solus-accent)_70%,transparent)]",
    on: "fill-(--solus-accent)",
    far: "fill-[color-mix(in_srgb,var(--solus-accent)_20%,transparent)]",
    pointed: "fill-(--solus-accent)",
    pointedOn: "fill-[color-mix(in_srgb,var(--solus-accent)_62%,var(--foreground))]",
  };
  /** The bars are the accent, as the app's charts are: soft at rest, stronger for the turn under the pointer, full for the bar under it and for the selected turn, and faint for the turns a selection steps back. */
  function barTone(barIndex: number, turnIndex: number): keyof typeof BAR_TONE {
    const selected = scopeIndex === turnIndex;
    if (barIndex === pointedBar) return selected ? "pointedOn" : "pointed";
    if (selected) return "on";
    if (pointedTurn === turnIndex) return "near";
    return scopeIndex === null ? "rest" : "far";
  }

  function turnDuration(index: number): string {
    return formatElapsed(turns[index].endedAt - turns[index].startedAt);
  }
</script>

<div class="px-4 pt-3.5 pb-3">
  <!-- The caption: the selected turn, else the whole session. At its end, the key to the chart. -->
  <div class="flex h-6 min-w-0 items-center gap-3">
    <span class="flex min-w-0 flex-1 items-baseline gap-2">
      {#if scopedTurn && scopeIndex !== null}
        <!-- The turn's start leads, as "Whole session" does; the prompt follows it and gives way first. -->
        <span class="shrink-0 text-[13px] font-medium tabular-nums text-foreground">{clockTime(scopedTurn.startedAt)}</span>
        <span class="shrink-0 text-xs tabular-nums text-muted-foreground">{turnDuration(scopeIndex)}</span>
        {#if scopedTurnCost !== null}
          <span class="shrink-0 text-xs tabular-nums text-[color-mix(in_oklab,var(--solus-art-4)_70%,var(--foreground))]" title="What this turn cost">{formatCost(scopedTurnCost)}</span>
        {/if}
        <span class="min-w-0 truncate text-[13px] text-(--solus-text-secondary)" title={scopedTurn.prompt}>
          {scopedTurn.prompt || "Prompt with no text"}
        </span>
      {:else}
        <span class="shrink-0 text-[13px] font-medium text-foreground">Whole session</span>
        <span class="min-w-0 truncate text-xs tabular-nums text-muted-foreground">
          {formatElapsed(timelineWorkMs(turns))} of work <span class="opacity-60">·</span>
          {turns.length}
          {turns.length === 1 ? "turn" : "turns"}{#if drawsCost}<span class="opacity-60"> ·</span>
            <span class="text-[color-mix(in_oklab,var(--solus-art-4)_70%,var(--foreground))]" title="What the turns on the line cost, where it is known">{formatCost(layout.totalCostUsd)}</span>{/if}
        </span>
      {/if}
    </span>
    <!-- The key: what a bar is, the agents' part of it, and the line. -->
    <span class="flex shrink-0 items-center gap-3 text-[11px] text-muted-foreground @max-[34rem]/pane:hidden">
      <span class="flex items-center gap-1.5">
        <span class="size-2 rounded-[2px] bg-[color-mix(in_srgb,var(--solus-accent)_60%,transparent)]"></span>Tool calls per {layout.span.label}
      </span>
      {#if drawsAgents}
        <span class="flex items-center gap-1.5">
          <span class="size-2 rounded-[2px] bg-[color-mix(in_oklab,var(--solus-art-5)_62%,transparent)]"></span>Agents
        </span>
      {/if}
      {#if drawsCost}
        <span class="flex items-center gap-1.5">
          <span class="h-0.5 w-3 rounded-full bg-[color-mix(in_oklab,var(--solus-art-4)_82%,var(--foreground))]"></span>Cost so far
        </span>
      {/if}
    </span>
    <span class="-mr-1.5 flex shrink-0 items-center">
      {#if onLoadEarlier}
        <button
          type="button"
          class="flex size-6 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground transition-colors duration-(--duration-quick) ease-(--ease-premium) hover:bg-[var(--wash-2)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-(--solus-accent-border-medium) disabled:cursor-default disabled:opacity-50 pointer-coarse:tap-area"
          aria-label="Earlier turns are not loaded. Load all."
          title={loadingEarlier ? "Loading the earlier turns…" : "Earlier turns are not loaded. Load all."}
          disabled={loadingEarlier}
          data-testid="artifacts-load-earlier"
          onclick={onLoadEarlier}
        >
          <EarlierIcon size={14} />
        </button>
      {/if}
      <button
        type="button"
        class="flex size-6 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground transition-colors duration-(--duration-quick) ease-(--ease-premium) hover:bg-[var(--wash-2)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-(--solus-accent-border-medium) pointer-coarse:tap-area"
        aria-label="Previous turn"
        title="Previous turn"
        onclick={() => step(-1, false)}
      >
        <PreviousIcon size={14} />
      </button>
      <button
        type="button"
        class="flex size-6 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground transition-colors duration-(--duration-quick) ease-(--ease-premium) hover:bg-[var(--wash-2)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-(--solus-accent-border-medium) pointer-coarse:tap-area"
        aria-label="Next turn"
        title="Next turn"
        onclick={() => step(1, false)}
      >
        <NextIcon size={14} />
      </button>
      {#if scopeIndex !== null}
        <button
          type="button"
          class="flex size-6 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground transition-colors duration-(--duration-quick) ease-(--ease-premium) hover:bg-[var(--wash-2)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-(--solus-accent-border-medium) pointer-coarse:tap-area"
          aria-label="Show the whole session"
          title="Show the whole session"
          data-testid="artifacts-scope-clear"
          onclick={() => select(null)}
        >
          <ClearIcon size={14} />
        </button>
      {/if}
    </span>
  </div>

  <div class="relative mt-2 flex">
    <div
      bind:this={scroller}
      bind:clientWidth={viewWidth}
      class="min-w-0 flex-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style:padding-top="{PLOT_TOP}px"
      onscroll={() => (scrollLeft = scroller?.scrollLeft ?? 0)}
    >
      <div class="relative" style:width="{plotWidth + gutter}px" style:height="{PLOT_HEIGHT + LABEL_ROOM}px">
        <!-- The group takes no focus of its own: the turn in the tab order is one of its stretches. -->
        <!-- svelte-ignore a11y_interactive_supports_focus -->
        <div
          role="radiogroup"
          aria-label="Turn"
          class="relative"
          style:width="{plotWidth}px"
          style:height="{PLOT_HEIGHT}px"
          data-testid="artifacts-timeline"
          onkeydown={handleKeydown}
          onpointermove={handlePointerMove}
          onpointerleave={() => (pointedBar = null)}
        >
          {#if brush}
            <span
              aria-hidden="true"
              class="pointer-events-none absolute -inset-y-1.5 rounded-[10px] bg-[color-mix(in_srgb,var(--solus-accent)_7%,transparent)] shadow-[inset_0_0_0_.5px_color-mix(in_srgb,var(--solus-accent)_32%,transparent)] ease-(--ease-premium) motion-reduce:transition-none {placed
                ? 'transition-[left,width,opacity] duration-[420ms]'
                : ''} {scopeIndex === null ? 'opacity-0' : 'opacity-100'}"
              style:left="{brush.left + 2}px"
              style:width="{Math.max(0, brush.width - 4)}px"
            ></span>
          {/if}
          <!-- One plot 1 tall: the bars on the calls' scale, the line on the cost's. Neither takes the pointer: the turns under them do. -->
          <div class="pointer-events-none absolute inset-0" aria-hidden="true">
            <Chart
              data={rows}
              x={(row: TimelineChartRow) => row.index}
              xScale={scaleBand().paddingInner(0).paddingOuter(0)}
              xDomain={barIndexes}
              y={(row: TimelineChartRow) => row.own?.[1] ?? 0}
              yDomain={[0, 1]}
              padding={{ top: 0, right: 0, bottom: 0, left: 0 }}
            >
              <Svg class="overflow-visible">
                {#if drawsCost}
                  <!-- The cost axis's upper rungs; zero is the floor the bars stand on. -->
                  <Rule y={0.5} class="stroke-[var(--hairline)]" />
                  <Rule y={1} class="stroke-[var(--hairline)]" />
                  <Area
                    y1={(row: TimelineChartRow) => row.cost}
                    curve={curveMonotoneX}
                    class="fill-[color-mix(in_oklab,var(--solus-art-4)_9%,transparent)]"
                  />
                {/if}
                {#each rows as row (row.index)}
                  {#if row.own}
                    <Bar
                      data={row}
                      y={(bar: TimelineChartRow) => bar.own}
                      insets={{ x: (pitch - barWidth) / 2 }}
                      rounded="top"
                      radius={Math.min(2, barWidth / 2)}
                      class="transition-[fill] duration-200 ease-(--ease-premium) motion-reduce:transition-none {BAR_TONE[barTone(row.index, barTurns[row.index])]}"
                    />
                  {/if}
                  {#if row.agents}
                    <!-- The agents' calls of the same span, on top: the blue of the Changes card's kinds. -->
                    <Bar
                      data={row}
                      y={(bar: TimelineChartRow) => bar.agents}
                      insets={{ x: (pitch - barWidth) / 2 }}
                      rounded="top"
                      radius={Math.min(2, barWidth / 2)}
                      class="fill-[color-mix(in_oklab,var(--solus-art-5)_62%,transparent)]"
                    />
                  {/if}
                {/each}
                <Rule y={0} class="stroke-[var(--hairline-strongest)]" />
                <!-- Where each turn starts, marked on the time axis. -->
                {#each stretches as stretch, index (turns[index].id)}
                  <line
                    class="stroke-[color-mix(in_srgb,var(--foreground)_24%,transparent)]"
                    x1={stretch.left}
                    x2={stretch.left}
                    y1={PLOT_HEIGHT}
                    y2={PLOT_HEIGHT + 4}
                  />
                {/each}
                {#if drawsCost}
                  <!-- A ring of card under the line keeps it a line where it crosses a bar. -->
                  <Spline
                    y={(row: TimelineChartRow) => row.cost}
                    curve={curveMonotoneX}
                    class="fill-none stroke-(--solus-tx-card-bg) stroke-[5]"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                  <Spline
                    y={(row: TimelineChartRow) => row.cost}
                    curve={curveMonotoneX}
                    class="fill-none stroke-[color-mix(in_oklab,var(--solus-art-4)_85%,var(--foreground))] stroke-2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                  {#if pointedBar !== null}
                    <!-- What was spent by the pointed bar. -->
                    <circle
                      class="fill-(--solus-tx-card-bg) stroke-[color-mix(in_oklab,var(--solus-art-4)_85%,var(--foreground))] stroke-2"
                      cx={(pointedBar + 0.5) * pitch}
                      cy={PLOT_HEIGHT * (1 - rows[pointedBar].cost)}
                      r="3.5"
                    />
                  {/if}
                {/if}
              </Svg>
            </Chart>
          </div>
          {#each stretches as stretch, index (turns[index].id)}
            <button
              bind:this={turnButtons[index]}
              type="button"
              role="radio"
              aria-checked={scopeIndex === index}
              aria-label="Turn {index + 1}, {clockTime(turns[index].startedAt)}: {turns[index].prompt}"
              tabindex={(scopeIndex ?? turns.length - 1) === index ? 0 : -1}
              class="absolute -inset-y-1.5 cursor-pointer rounded-[10px] border-0 bg-transparent p-0 focus-visible:outline-2 focus-visible:outline-(--solus-accent-border-medium)"
              style:left="{stretch.left + 2}px"
              style:width="{Math.max(0, stretch.width - 4)}px"
              data-testid="artifacts-timeline-turn"
              onclick={() => select(scopeIndex === index ? null : index)}
            ></button>
          {/each}
          <!-- A break: the person was away, and the line says for how long. -->
          {#each layout.gaps as gap (gap.from)}
            {#if gap.isBreak}
              <span
                class="pointer-events-none absolute bottom-1 -translate-x-1/2 text-[11px] leading-none whitespace-nowrap tabular-nums text-muted-foreground"
                style:left="{((gap.from + gap.to) / 2) * pitch}px"
                title="{formatElapsed(gap.waitMs)} between these turns"
              >
                {breakLabel(gap.waitMs)}
              </span>
            {/if}
          {/each}
        </div>
        {#if live}
          <!-- Now: the line the session has reached. The bars stop here. -->
          <span
            aria-hidden="true"
            class="absolute -top-1 w-px bg-[color-mix(in_srgb,var(--foreground)_34%,transparent)]"
            style:left="{plotWidth + 6}px"
            style:height="{PLOT_HEIGHT + 4}px"
          ></span>
        {/if}
        <!-- When each turn started, beside its mark. -->
        <div class="absolute inset-x-0 h-3.5 text-[11px] leading-[14px] tabular-nums text-muted-foreground" style:top="{PLOT_HEIGHT + 7}px">
          {#each labelled as index (turns[index].id)}
            <span
              class="absolute top-0 whitespace-nowrap transition-colors duration-200 ease-(--ease-premium) {scopeIndex === index
                ? 'font-medium text-foreground'
                : pointedTurn === index
                  ? 'text-(--solus-text-secondary)'
                  : ''}"
              style:left="{stretches[index].left + (index === 0 ? 0 : 4)}px"
            >
              {turnClockLabel(turns[index].startedAt, index > 0 ? turns[index - 1].startedAt : null)}
            </span>
          {/each}
          {#if live}
            <span class="absolute top-0 right-0">now</span>
          {/if}
        </div>
      </div>
    </div>
    {#if drawsCost}
      <!-- The cost axis, beside the scroller so it stays in view however far the line scrolls. -->
      <div class="relative w-10 shrink-0" aria-hidden="true">
        {#each [0, costTop / 2, costTop] as tick (tick)}
          <span
            class="absolute right-0 -translate-y-1/2 text-[10.5px] leading-none tabular-nums text-muted-foreground"
            style:top="{PLOT_TOP + PLOT_HEIGHT * (1 - tick / costTop)}px"
          >
            {formatCostTick(tick)}
          </span>
        {/each}
      </div>
    {/if}
    {#if pointed && pointedBar !== null}
      <!-- The pointed bar in numbers, beside it on the side with room. -->
      <div
        class="pointer-events-none absolute top-0 z-10 rounded-lg bg-(--solus-tx-card-bg) px-2.5 py-1.5 text-[11.5px] leading-[1.5] whitespace-nowrap tabular-nums shadow-[shadow:var(--solus-menu-shadow)]"
        style:left="{cardX}px"
        style:transform={cardFlips ? "translateX(calc(-100% - 12px))" : "translateX(12px)"}
        data-testid="artifacts-timeline-readout"
      >
        <div>
          <span class="font-medium text-foreground">{pointed.turn === null ? "Between turns" : `Turn ${pointed.turn + 1}`}</span>
          {#if pointed.turn !== null}<span class="text-muted-foreground"> · {barClockTime(pointed.startedAt, layout.span.seconds)}</span>{/if}
        </div>
        <div class="text-(--solus-text-secondary)">{timelineBarText(pointed)}</div>
        {#if drawsCost}
          <div>
            <span class="text-[color-mix(in_oklab,var(--solus-art-4)_70%,var(--foreground))]">{formatCost(layout.runningCostUsd[pointedBar])} so far</span>
            {#if pointedTurnCost !== null}<span class="text-muted-foreground"> · this turn {formatCost(pointedTurnCost)}</span>{/if}
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>
