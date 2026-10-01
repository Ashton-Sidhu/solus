<script lang="ts">
  import type { MetricsSessionSummary } from "@solus/contracts/observability-types";
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
   * the neighbours — so the turns are a plain ordered list. The header reads
   * like its sibling card: a small caps label with the session's totals, then
   * the task it ran under. The turn being read carries a quiet selected wash,
   * the same mark a selected row has everywhere else in the workspace. There
   * are no status marks: a turn that ended badly says so in the ink of its
   * duration and in words on hover.
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
    /** Absent on a shared report: the other turns stayed on the computer. */
    onOpenTurn?: (traceId: string) => void;
    onOpenTask?: () => void;
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
  class="overflow-hidden rounded-xl bg-card text-insights-chrome shadow-[shadow:var(--insights-card-shadow)]"
  aria-label="Session"
>
  <header class="flex flex-col gap-0.5 pt-2 pr-3 pb-1.5 pl-4">
    <div class="flex h-7 min-w-0 items-baseline gap-2">
      <h2 class="m-0 shrink-0 text-insights-summary font-medium">Session</h2>
      <span class="shrink-0 tabular-nums text-muted-foreground"
        >Turn {view.position || "—"} of {view.turnCount}</span
      >
    </div>
    <!-- The name has the line to itself, and the totals sit under it: in a
         rail this narrow, three figures beside the label cut the figures and
         the id beside the name cut the name. The id stays on the copy control. -->
    <div class="flex min-w-0 items-center gap-1.5">
      <!-- This is the task affordance the full turn page exposes. It remains a
           button while the durable session binding loads; the click resolves
           that binding before it navigates. -->
      <button
        type="button"
        class="min-w-0 truncate border-0 bg-transparent p-0 text-left text-insights-summary decoration-muted-foreground/50 underline-offset-4 transition-colors enabled:cursor-pointer enabled:hover:underline focus-visible:rounded-sm focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_oklch,var(--primary)_45%,transparent)]"
        title={onOpenTask ? "Open task in the trailing pane" : undefined}
        disabled={!onOpenTask}
        onclick={onOpenTask}
      >{taskTitle ?? sessionName ?? shortId(session.sessionId)}</button
      >
      <CopyButton text={session.sessionId} title="Copy the session id {shortId(session.sessionId)}" iconOnly />
    </div>
    <span class="truncate tabular-nums text-muted-foreground" title="Session duration, cost, and tokens"
      >{formatDuration(session.totalDurationMs)} · {formatCost(session.totalCostUsd)} · {formatTokens(
        totalTokens,
      )} tokens</span
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
    class="scrollbar-on-hover flex max-h-[6.25rem] min-w-0 flex-col gap-px overflow-y-auto overscroll-contain px-2 pb-2 text-insights-summary [@media(min-height:1000px)]:max-h-[9.75rem]"
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
              class="flex h-7 w-full shrink-0 items-center gap-3 overflow-hidden rounded-md px-2 text-left transition-colors select-none focus-visible:outline-1 focus-visible:outline-offset-[-1px] focus-visible:outline-[color-mix(in_oklch,var(--primary)_45%,transparent)] {row.isCurrent
                ? 'bg-[var(--wash-3)]'
                : onOpenTurn ? 'cursor-pointer hover:bg-[var(--wash-2)]' : ''}"
              aria-current={row.isCurrent ? "true" : undefined}
              aria-disabled={onOpenTurn ? undefined : "true"}
              onclick={() => onOpenTurn?.(row.traceId)}
            >
              <span
                class="w-5 shrink-0 text-right text-insights-chrome text-muted-foreground tabular-nums">{row.turnNumber}</span
              >
              <span
                class="min-w-0 flex-1 truncate {row.isCurrent
                  ? 'text-foreground'
                  : 'text-muted-foreground'}">{row.title}</span
              >
              <span
                class="w-12 shrink-0 text-right text-insights-chrome text-muted-foreground tabular-nums"
                >{row.tokens == null ? "" : formatTokens(row.tokens)}</span
              >
              <span
                class="w-12 shrink-0 text-right text-insights-chrome tabular-nums {row.failed
                  ? 'text-(--failure)'
                  : row.isCurrent
                    ? 'text-foreground'
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
