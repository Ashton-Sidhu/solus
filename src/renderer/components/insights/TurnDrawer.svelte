<script lang="ts">
  import { ArrowSquareOutIcon, CaretLeftIcon, CaretRightIcon, XIcon } from "phosphor-svelte";
  import type { MetricsSessionSummary } from "../../../shared/observability-types";
  import {
    formatClock,
    formatCost,
    formatDuration,
    formatTokens,
    shortModel,
  } from "./lib/format";
  import type { TraceView } from "./lib/waterfall";
  import type { TurnRow } from "./lib/turn-rows";
  import TraceSummary from "./TraceSummary.svelte";

  /**
   * A turn, read without leaving the list.
   *
   * The drawer answers "what happened in this turn" at a glance and hands off
   * to the full page for the waterfall. Previous/next step through the list in
   * the order the user is looking at, so scanning a query's results never means
   * closing and reopening.
   */
  interface Props {
    turn: TurnRow;
    trace: TraceView | null;
    traceLoading: boolean;
    session: MetricsSessionSummary | null;
    /** Position in the visible list, for the counter and the steppers. */
    index: number;
    total: number;
    onPrevious: (() => void) | null;
    onNext: (() => void) | null;
    onClose: () => void;
    onOpenFullPage: () => void;
    onOpenTurn: (traceId: string) => void;
  }

  let {
    turn,
    trace,
    traceLoading,
    session,
    index,
    total,
    onPrevious,
    onNext,
    onClose,
    onOpenFullPage,
    onOpenTurn,
  }: Props = $props();

  type DrawerTab = "trace" | "prompt" | "session";
  let tab = $state<DrawerTab>("trace");

  const TABS: { id: DrawerTab; label: string }[] = [
    { id: "trace", label: "Trace" },
    { id: "prompt", label: "Prompt" },
    { id: "session", label: "Session" },
  ];

  const tokens = $derived(
    turn.inputTokens == null && turn.outputTokens == null
      ? null
      : (turn.inputTokens ?? 0) + (turn.outputTokens ?? 0),
  );

  const facts = $derived([
    { label: "Duration", value: formatDuration(turn.durationMs) },
    { label: "Tokens", value: formatTokens(tokens) },
    { label: "Cost", value: formatCost(turn.costUsd) },
    { label: "Tools", value: turn.toolCallCount == null ? "—" : String(turn.toolCallCount) },
  ]);

  const statusTone = $derived(
    turn.status === "error"
      ? "var(--failure)"
      : turn.status === "interrupted"
        ? "var(--warning)"
        : "var(--muted-foreground)",
  );

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div
  class="absolute inset-0 z-40 flex justify-end"
  style="background:radial-gradient(120% 90% at 60% 40%, rgba(20,16,10,.10), rgba(20,16,10,.24))"
  role="presentation"
  onclick={onClose}
>
  <div
    class="flex h-full w-[33.75rem] max-w-[94%] flex-col overflow-hidden rounded-l-2xl bg-popover shadow-[shadow:var(--elev-lift)]"
    role="dialog"
    aria-label="Turn detail"
    tabindex="-1"
    onclick={(event) => event.stopPropagation()}
    onkeydown={(event) => event.stopPropagation()}
  >
    <header
      class="flex h-12 shrink-0 items-center gap-2.5 px-4 shadow-[inset_0_-0.5px_0_var(--hairline)]"
    >
      <span
        class="text-[0.625rem] font-medium uppercase"
        style="color:{statusTone}">{turn.status}</span
      >
      <span class="truncate text-xs font-medium">{turn.traceId}</span>
      <span class="shrink-0 text-[0.625rem] text-muted-foreground"
        >{formatClock(turn.startedAt)} · {shortModel(turn.model)}</span
      >
      <span class="flex-1"></span>
      <button
        type="button"
        class="flex h-6.5 cursor-pointer items-center gap-1.5 rounded-lg bg-card px-2.5 text-[0.6875rem] font-medium shadow-[shadow:var(--elev-ring)] transition-colors hover:bg-muted"
        onclick={onOpenFullPage}>Open full page <ArrowSquareOutIcon size={9} /></button
      >
      <button
        type="button"
        class="flex size-6.5 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted"
        onclick={onClose}
        aria-label="Close"><XIcon size={11} /></button
      >
    </header>

    <div
      class="flex h-9 shrink-0 items-center gap-1 px-4 shadow-[inset_0_-0.5px_0_var(--hairline)]"
      role="tablist"
      aria-label="Turn sections"
    >
      {#each TABS as entry (entry.id)}
        <button
          type="button"
          role="tab"
          aria-selected={tab === entry.id}
          class="h-6 cursor-pointer rounded-md px-2.5 text-[0.6875rem] font-medium transition-colors"
          style="background:{tab === entry.id ? 'var(--card)' : 'transparent'};color:{tab ===
          entry.id
            ? 'var(--foreground)'
            : 'var(--muted-foreground)'};box-shadow:{tab === entry.id
            ? 'var(--elev-ring)'
            : 'none'}"
          onclick={() => (tab = entry.id)}>{entry.label}</button
        >
      {/each}
      <span class="flex-1"></span>
      <span class="text-[0.625rem] text-muted-foreground">{index + 1} / {total}</span>
      <button
        type="button"
        class="flex size-5.5 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted disabled:cursor-default disabled:opacity-30"
        disabled={!onPrevious}
        onclick={() => onPrevious?.()}
        aria-label="Previous turn"><CaretLeftIcon size={10} weight="bold" /></button
      >
      <button
        type="button"
        class="flex size-5.5 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted disabled:cursor-default disabled:opacity-30"
        disabled={!onNext}
        onclick={() => onNext?.()}
        aria-label="Next turn"><CaretRightIcon size={10} weight="bold" /></button
      >
    </div>

    <div class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-4" data-sb>
      {#if tab === "trace"}
        <div
          class="grid grid-cols-4 gap-px overflow-hidden rounded-lg bg-[var(--hairline)] shadow-[shadow:var(--elev-ring)]"
        >
          {#each facts as fact (fact.label)}
            <div class="flex flex-col gap-1 bg-popover px-2.5 py-2">
              <span
                class="text-[0.5938rem] font-medium text-muted-foreground uppercase"
                >{fact.label}</span
              >
              <span class="text-[0.8125rem] font-medium tabular-nums">{fact.value}</span>
            </div>
          {/each}
        </div>

        {#if traceLoading}
          <p class="text-[0.6875rem] text-muted-foreground">Loading the turn’s spans…</p>
        {:else if trace}
          <TraceSummary {trace} dense />
          <button
            type="button"
            class="h-6.5 cursor-pointer self-start rounded-lg bg-card px-3 text-[0.6875rem] font-medium shadow-[shadow:var(--elev-ring)] transition-colors hover:bg-muted"
            onclick={onOpenFullPage}>View full waterfall</button
          >
        {:else}
          <p class="text-[0.6875rem] text-muted-foreground">
            No spans were recorded for this turn. Child spans start at the version that first
            instrumented them, so older turns hold only the root.
          </p>
        {/if}
      {:else if tab === "prompt"}
        <div class="flex flex-col gap-1.5">
          <div class="flex items-baseline gap-2">
            <span
              class="text-[0.5938rem] font-medium text-muted-foreground uppercase"
              >Prompt</span
            >
            <span class="text-[0.625rem] text-muted-foreground"
              >{turn.promptSource ?? turn.origin ?? "typed"}</span
            >
          </div>
          <div
            class="rounded-lg bg-card px-3 py-2.5 text-[0.8125rem] leading-[1.75] whitespace-pre-wrap shadow-[shadow:var(--elev-flat)]"
          >
            {turn.prompt || "This turn recorded no prompt text."}
          </div>
          <p class="text-[0.625rem] text-muted-foreground">
            Prompts are capped at 4 KB. Replies are not stored in metrics — open the session to read
            the conversation.
          </p>
        </div>
      {:else if session}
        <div
          class="grid grid-cols-4 gap-px overflow-hidden rounded-lg bg-[var(--hairline)] shadow-[shadow:var(--elev-ring)]"
        >
          {#each [{ label: "Turns", value: String(session.turnCount) }, { label: "Duration", value: formatDuration(session.totalDurationMs) }, { label: "Spend", value: formatCost(session.totalCostUsd) }, { label: "Tokens", value: formatTokens(session.totalInputTokens + session.totalOutputTokens) }] as fact (fact.label)}
            <div class="flex flex-col gap-1 bg-popover px-2.5 py-2">
              <span
                class="text-[0.5938rem] font-medium text-muted-foreground uppercase"
                >{fact.label}</span
              >
              <span class="truncate text-[0.8125rem] font-medium tabular-nums">{fact.value}</span>
            </div>
          {/each}
        </div>
        <div class="overflow-hidden rounded-lg shadow-[shadow:var(--elev-flat)]">
          {#each session.turns as summary, position (summary.traceId)}
            <button
              type="button"
              class="grid h-8.5 w-full cursor-pointer items-center gap-3 px-3 text-left transition-colors hover:bg-muted"
              style="grid-template-columns:1.75rem minmax(0,1fr) 3.625rem 3.5rem;background:{summary.traceId ===
              turn.traceId
                ? 'var(--wash-3)'
                : 'transparent'};box-shadow:{position ? 'inset 0 0.5px 0 var(--hairline)' : 'none'}"
              onclick={() => onOpenTurn(summary.traceId)}
            >
              <span class="text-[0.625rem] tabular-nums text-muted-foreground"
                >#{summary.turnNumber}</span
              >
              <span class="truncate text-xs">{formatClock(summary.startedAt)} · {shortModel(summary.model)}</span>
              <span
                class="text-right text-[0.625rem] tabular-nums"
                style="color:{summary.status === 'error'
                  ? 'var(--failure)'
                  : 'var(--muted-foreground)'}">{formatDuration(summary.durationMs)}</span
              >
              <span class="text-right text-[0.625rem] tabular-nums text-muted-foreground"
                >{formatCost(summary.costUsd)}</span
              >
            </button>
          {/each}
        </div>
      {:else}
        <p class="text-[0.6875rem] text-muted-foreground">
          {turn.sessionId
            ? "Loading this session’s turns…"
            : "This turn is not attached to a session."}
        </p>
      {/if}
      <div class="h-4"></div>
    </div>
  </div>
</div>
