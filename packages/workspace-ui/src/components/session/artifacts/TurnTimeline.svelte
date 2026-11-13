<script lang="ts">
  import { ChevronLeft as PreviousIcon, ChevronRight as NextIcon, History as EarlierIcon, X as ClearIcon } from "@lucide/svelte";
  import { formatElapsed } from "@solus/client-core/elapsed-time";
  import {
    barHeightShare,
    breakLabel,
    timelineBarText,
    timelineLabels,
    timelineLayout,
    timelineWorkMs,
    type TimelineTurn,
  } from "@solus/client-core/turn-timeline";
  import { barClockTime, clockTime, turnClockLabel } from "./lib/overview-view";

  /**
   * The session as its tool calls over time (docs/plans/session-artifacts.md).
   * Each bar is one round span of working time, as tall as the tool calls the
   * agent made in it; a span with none is a dot, so the line runs on. A
   * divider stands where each turn starts and runs down beside the turn's
   * start time, so a turn reads as one column. The wait before the next
   * prompt is one dot; a wait of an hour or more is a break, and the line
   * says how long it was. Pointing reads out the bar under the pointer and
   * names its turn in the caption. Selecting a turn scopes the surface to it:
   * one brush glides from turn to turn, and selecting the same turn again
   * shows the whole session.
   */
  interface Props {
    turns: readonly TimelineTurn[];
    toolCallTimes: readonly number[];
    /** The session still works: the line ends at "now". */
    live: boolean;
    /** The turn the surface is scoped to, by its prompt's id. Null is the whole session. */
    scopeTurnId: string | null;
    onScope: (turnId: string | null) => void;
    /** Reads the turns before the first one shown. Present while the conversation holds only its recent history. */
    onLoadEarlier?: () => void;
    loadingEarlier?: boolean;
  }
  let { turns, toolCallTimes, live, scopeTurnId, onScope, onLoadEarlier, loadingEarlier = false }: Props = $props();

  const PLOT_HEIGHT = 44;
  /** The room under the plot for the start times, which the dividers run down through. */
  const LABEL_ROOM = 20;
  const MIN_PITCH = 5;
  const LABEL_WIDTH = 46;
  /** Room at the line's end for the "now" rule and its label. */
  const NOW_GUTTER = 28;

  let viewWidth = $state(0);
  let scroller = $state<HTMLDivElement | null>(null);
  let turnButtons = $state<(HTMLButtonElement | null)[]>([]);
  let pointedBar = $state<number | null>(null);
  /** Where the brush last was, so it fades in place when the scope clears. */
  let lastScopeIndex = $state(0);
  /** False until the plot has its width, so the brush is placed, not flown in, on the first paint. */
  let placed = $state(false);

  const gutter = $derived(live ? NOW_GUTTER : 0);
  const roomWidth = $derived(Math.max(0, viewWidth - gutter));
  const layout = $derived(timelineLayout(turns, toolCallTimes, Math.max(1, Math.floor(roomWidth / MIN_PITCH))));
  // With more turns than the pane has room for, the plot keeps its bars readable and scrolls.
  const plotWidth = $derived(Math.max(roomWidth, layout.bars.length * MIN_PITCH));
  const pitch = $derived(layout.bars.length > 0 ? plotWidth / layout.bars.length : MIN_PITCH);

  const barWidth = $derived(Math.max(2, Math.min(4, Math.round(pitch - 2))));

  /** A turn's stretch of the line: its bars and the wait after them, up to the next turn's divider. */
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

  const pointed = $derived(pointedBar === null ? null : (layout.bars[pointedBar] ?? null));
  const pointedTurn = $derived(pointedBar === null ? null : (barTurns[pointedBar] ?? null));
  const shownIndex = $derived(pointedTurn ?? scopeIndex);
  const shownTurn = $derived(shownIndex === null ? null : turns[shownIndex]);

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
    rest: "fill-[color-mix(in_srgb,var(--solus-accent)_46%,transparent)]",
    near: "fill-[color-mix(in_srgb,var(--solus-accent)_78%,transparent)]",
    on: "fill-(--solus-accent)",
    far: "fill-[color-mix(in_srgb,var(--solus-accent)_22%,transparent)]",
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

<div class="px-4 pt-3.5 pb-3.5">
  <!-- The caption: the turn under the pointer, else the selected one, else the whole session.
       At its end, what a bar is; while a bar is pointed at, that bar in numbers. -->
  <div class="flex h-6 min-w-0 items-center gap-3">
    <span class="flex min-w-0 flex-1 items-baseline gap-2">
      {#if shownTurn && shownIndex !== null}
        <!-- The turn's start leads, as "Whole session" does; the prompt follows it and gives way first. -->
        <span class="shrink-0 text-[13px] font-medium tabular-nums text-foreground">{clockTime(shownTurn.startedAt)}</span>
        <span class="shrink-0 text-xs tabular-nums text-muted-foreground">{turnDuration(shownIndex)}</span>
        <span class="min-w-0 truncate text-[13px] text-(--solus-text-secondary)" title={shownTurn.prompt}>
          {shownTurn.prompt || "Prompt with no text"}
        </span>
      {:else}
        <span class="shrink-0 text-[13px] font-medium text-foreground">Whole session</span>
        <span class="min-w-0 truncate text-xs tabular-nums text-muted-foreground">
          {formatElapsed(timelineWorkMs(turns))} of work <span class="opacity-60">·</span>
          {turns.length}
          {turns.length === 1 ? "turn" : "turns"}
        </span>
      {/if}
    </span>
    {#if pointed}
      <!-- In a ring of its own, so the bar's time does not run into the turn's. -->
      <span
        class="flex h-5 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[11px] tabular-nums text-(--solus-text-secondary) shadow-[inset_0_0_0_.5px_var(--hairline-strong)]"
        data-testid="artifacts-timeline-readout"
      >
        {#if pointed.turn !== null}<span class="text-muted-foreground">{barClockTime(pointed.startedAt, layout.span.seconds)}</span>{/if}
        {timelineBarText(pointed)}
      </span>
    {:else}
      <span class="shrink-0 text-[11px] text-muted-foreground @max-[34rem]/pane:hidden">Tool calls per {layout.span.label}</span>
    {/if}
    <span class="-mr-1.5 flex shrink-0 items-center">
      {#if onLoadEarlier}
        <button
          type="button"
          class="flex size-6 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground transition-colors duration-(--duration-quick) ease-(--ease-premium) hover:bg-[var(--wash-2)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-(--solus-accent-border-medium) disabled:cursor-default disabled:opacity-50 pointer-coarse:size-10"
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
        class="flex size-6 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground transition-colors duration-(--duration-quick) ease-(--ease-premium) hover:bg-[var(--wash-2)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-(--solus-accent-border-medium) pointer-coarse:size-10"
        aria-label="Previous turn"
        title="Previous turn"
        onclick={() => step(-1, false)}
      >
        <PreviousIcon size={14} />
      </button>
      <button
        type="button"
        class="flex size-6 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground transition-colors duration-(--duration-quick) ease-(--ease-premium) hover:bg-[var(--wash-2)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-(--solus-accent-border-medium) pointer-coarse:size-10"
        aria-label="Next turn"
        title="Next turn"
        onclick={() => step(1, false)}
      >
        <NextIcon size={14} />
      </button>
      {#if scopeIndex !== null}
        <button
          type="button"
          class="flex size-6 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground transition-colors duration-(--duration-quick) ease-(--ease-premium) hover:bg-[var(--wash-2)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-(--solus-accent-border-medium) pointer-coarse:size-10"
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

  <!-- The padding is room for the brush and the dividers, which reach a little over the bars. -->
  <div
    bind:this={scroller}
    bind:clientWidth={viewWidth}
    class="mt-1 overflow-x-auto overflow-y-hidden pt-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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
            class="pointer-events-none absolute -inset-y-1.5 rounded-[10px] bg-[color-mix(in_srgb,var(--solus-accent)_8%,transparent)] shadow-[inset_0_0_0_.5px_color-mix(in_srgb,var(--solus-accent)_36%,transparent)] ease-(--ease-premium) motion-reduce:transition-none {placed
              ? 'transition-[left,width,opacity] duration-[420ms]'
              : ''} {scopeIndex === null ? 'opacity-0' : 'opacity-100'}"
            style:left="{brush.left + 3}px"
            style:width="{Math.max(0, brush.width - 6)}px"
          ></span>
        {/if}
        <svg
          width={plotWidth}
          height={PLOT_HEIGHT + LABEL_ROOM}
          aria-hidden="true"
          class="pointer-events-none absolute top-0 left-0 block overflow-visible"
        >
          <!-- The divider: where a turn starts, from over the bars down beside its start time. -->
          {#each stretches as stretch, index (turns[index].id)}
            {#if index > 0}
              <line
                class="stroke-[color-mix(in_srgb,var(--foreground)_16%,transparent)]"
                stroke-width="1"
                x1={stretch.left}
                x2={stretch.left}
                y1={-4}
                y2={PLOT_HEIGHT + LABEL_ROOM}
              />
            {/if}
          {/each}
          {#each layout.bars as bar, index (index)}
            {@const height = bar.calls > 0 ? Math.max(4, barHeightShare(bar.calls, layout.fullHeightCalls) * PLOT_HEIGHT) : 2}
            <rect
              class="transition-[fill] duration-200 ease-(--ease-premium) motion-reduce:transition-none {BAR_TONE[
                barTone(index, barTurns[index])
              ]} {bar.calls > 0 ? '' : 'opacity-50'}"
              x={index * pitch + (pitch - barWidth) / 2}
              y={PLOT_HEIGHT - height}
              width={barWidth}
              {height}
              rx={barWidth / 2}
            />
          {/each}
        </svg>
        {#each stretches as stretch, index (turns[index].id)}
          <button
            bind:this={turnButtons[index]}
            type="button"
            role="radio"
            aria-checked={scopeIndex === index}
            aria-label="Turn {index + 1}, {clockTime(turns[index].startedAt)}: {turns[index].prompt}"
            tabindex={(scopeIndex ?? turns.length - 1) === index ? 0 : -1}
            class="absolute -inset-y-1.5 cursor-pointer rounded-[10px] border-0 bg-transparent p-0 focus-visible:outline-2 focus-visible:outline-(--solus-accent-border-medium)"
            style:left="{stretch.left + 3}px"
            style:width="{Math.max(0, stretch.width - 6)}px"
            data-testid="artifacts-timeline-turn"
            onclick={() => select(scopeIndex === index ? null : index)}
          ></button>
        {/each}
        <!-- A break: the person was away, and the line says for how long. -->
        {#each layout.gaps as gap (gap.from)}
          {#if gap.isBreak}
            <span
              class="pointer-events-none absolute -translate-x-1/2 text-[11px] leading-none whitespace-nowrap tabular-nums text-muted-foreground"
              style:left="{((gap.from + gap.to) / 2) * pitch}px"
              style:top="{PLOT_HEIGHT - 18}px"
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
      <!-- When each turn started, beside its divider. -->
      <div class="absolute inset-x-0 h-3.5 text-[11px] leading-[14px] tabular-nums text-muted-foreground" style:top="{PLOT_HEIGHT + 6}px">
        {#each labelled as index (turns[index].id)}
          <span
            class="absolute top-0 whitespace-nowrap transition-colors duration-200 ease-(--ease-premium) {scopeIndex === index
              ? 'font-medium text-foreground'
              : pointedTurn === index
                ? 'text-(--solus-text-secondary)'
                : ''}"
            style:left="{stretches[index].left + (index === 0 ? 0 : 6)}px"
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
</div>
