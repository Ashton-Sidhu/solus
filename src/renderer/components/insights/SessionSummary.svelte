<script lang="ts">
  import type { MetricsSessionSummary } from "../../../shared/observability-types";
  import CopyButton from "../ui/CopyButton.svelte";
  import * as TooltipUI from "../ui/tooltip";
  import { formatCost, formatDuration, formatTokens, shortId } from "./lib/format";
  import type { SessionSummaryView } from "./lib/session-summary";
  import SessionTurnTooltip from "./SessionTurnTooltip.svelte";

  /**
   * The session this turn belongs to, beside the turn's longest tool calls when
   * the panel has room.
   *
   * The card answers one question — where am I in this session, and what were
   * the neighbours — so the turns are a plain ordered list. The turn being read
   * is the only one at full reading strength; its neighbours stay muted. There
   * is no wash, no heavier weight, no dot and no rail: the header already says
   * "Turn 5 of 8", so the list needs the quietest mark that still reads, and a
   * wash on a row that is also hoverable and selectable says the wrong thing.
   * There are no status marks either: a column of dots asks the reader to learn
   * a colour key to read a list they can already read, and a turn that ended
   * badly says so in the ink of its duration and in words on hover.
   *
   * The turn's own tool calls are not merged into this card: they measure one
   * turn, so they stay in a distinct card beside this session-level context.
   */
  interface Props {
    session: MetricsSessionSummary;
    view: SessionSummaryView;
    /** How the host lists this session; the id shows when it has no name. */
    sessionName: string | null;
    /** The task this turn ran under. Its title falls back to the session name
     *  while the durable session binding loads. */
    taskTitle: string | null;
    currentTraceId: string;
    onOpenTurn: (traceId: string) => void;
    onOpenTask: () => void;
  }

  let {
    session,
    view,
    sessionName,
    taskTitle,
    currentTraceId,
    onOpenTurn,
    onOpenTask,
  }: Props = $props();

  const totalTokens = $derived(session.totalInputTokens + session.totalOutputTokens);

  /** The list scrolls to the turn being read, so arriving from anywhere — a
   *  deep link, the header stepper, a neighbouring turn — lands with the
   *  reader's place in view rather than at the session's first turn. */
  let list = $state<HTMLElement | null>(null);
  $effect(() => {
    const id = currentTraceId;
    if (!list) return;
    list
      .querySelector<HTMLElement>(`[data-trace="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  });
</script>

<section
  class="overflow-hidden rounded-xl bg-card text-xs shadow-[shadow:var(--insights-card-shadow)]"
  aria-label="Session"
>
  <header class="flex h-11 items-center gap-2.5 pr-3 pl-5 shadow-[inset_0_-0.5px_0_var(--hairline)]">
    <!-- This is the task affordance the full turn page exposes. It remains a
         button while the durable session binding loads; the click resolves
         that binding before it navigates. -->
    <button
      type="button"
      class="h-10 min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-left text-sm font-medium underline decoration-muted-foreground/35 underline-offset-4 transition-colors hover:decoration-foreground focus-visible:rounded-sm focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_oklch,var(--primary)_45%,transparent)] active:scale-[0.96]"
      title="Open task in the trailing pane"
      onclick={onOpenTask}
    >{taskTitle ?? sessionName ?? shortId(session.sessionId)}</button
    >
    <span class="shrink-0 font-mono text-muted-foreground opacity-50" title={session.sessionId}
      >{shortId(session.sessionId)}</span
    >
    <CopyButton text={session.sessionId} title="Copy the session id" iconOnly />
    <span class="flex-1"></span>
    <span class="shrink-0 tabular-nums">
      Turn {view.position || "—"}
      <span class="text-muted-foreground">of {view.turnCount}</span>
    </span>
    <span class="shrink-0 text-muted-foreground" aria-hidden="true">·</span>
    <span class="shrink-0 truncate text-muted-foreground tabular-nums"
      >{formatDuration(session.totalDurationMs)} · {formatCost(session.totalCostUsd)} · {formatTokens(
        totalTokens,
      )}</span
    >
  </header>

  <!-- The rows are `shrink-0` because this column is bounded: a flex item's
       height is a suggestion its container may take back, so without it eight
       rows quietly compress to fit the cap and the list never scrolls at all.

       Three rows (1.75rem each, plus the block's own padding), and five on a
       desktop display: the card is context beside the turn being read, not the
       listing, so it is bounded by the height the screen actually has rather
       than by the width of the panel. A short session still takes only the
       height it needs, and the rest scrolls under the standard bounded-list
       thumb. -->
  <div
    class="scrollbar-on-hover flex max-h-[6.25rem] min-w-0 flex-col overflow-y-auto overscroll-contain px-2 py-2 [@media(min-height:1000px)]:max-h-[9.75rem]"
    bind:this={list}
  >
    {#each view.rows as row (row.traceId)}
      <TooltipUI.Root>
        <TooltipUI.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              type="button"
              data-trace={row.traceId}
              class="flex h-7 w-full shrink-0 cursor-pointer items-center gap-3 rounded-md px-2 text-left transition-colors select-none hover:bg-[var(--wash-2)] focus-visible:outline-1 focus-visible:outline-offset-[-1px] focus-visible:outline-[color-mix(in_oklch,var(--primary)_45%,transparent)]"
              aria-current={row.isCurrent ? "true" : undefined}
              onclick={() => onOpenTurn(row.traceId)}
            >
              <span
                class="w-6 shrink-0 text-right tabular-nums {row.isCurrent
                  ? 'text-muted-foreground'
                  : 'text-muted-foreground opacity-60'}">{row.turnNumber}</span
              >
              <span
                class="min-w-0 flex-1 truncate {row.isCurrent
                  ? 'text-foreground'
                  : 'text-muted-foreground'}">{row.title}</span
              >
              <span class="shrink-0 text-muted-foreground tabular-nums opacity-70"
                >{row.tokens == null ? "" : formatTokens(row.tokens)}</span
              >
              <span
                class="w-12 shrink-0 text-right tabular-nums {row.failed
                  ? 'text-(--failure)'
                  : 'text-muted-foreground'}">{formatDuration(row.durationMs)}</span
              >
            </button>
          {/snippet}
        </TooltipUI.Trigger>
        <SessionTurnTooltip {row} />
      </TooltipUI.Root>
    {/each}
  </div>
</section>
