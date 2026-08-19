<script lang="ts">
  import { CaretRightIcon } from "phosphor-svelte";
  import type { Message } from "@solus/contracts/types";
  import { getSessionEnvironmentStore, getWorkspaceContext } from "../../contexts";
  import { formatActivityDuration } from "./lib/activity-summary";
  import { subagentGroupSummary, subagentRow } from "./lib/subagent-group";
  import SubagentReturnCard from "./SubagentReturnCard.svelte";
  import SubagentRow from "./SubagentRow.svelte";
  import SubagentRunCard from "./SubagentRunCard.svelte";
  import { liveActivityClock } from "../../lib/shared-clock";

  /**
   * §18 — a fan-out is one object, not n cards. Several sub-agents dispatched by
   * one decision render as one card with one row each; a lone sub-agent is the
   * same card with one row, so nothing about the anatomy shifts as a turn adds
   * agents. When the last one lands the whole card folds to a single activity
   * row, the same shape §16 gives a finished turn.
   */
  interface Props {
    messages: Message[];
    tabId: string;
    skipMotion?: boolean;
  }
  let { messages, tabId, skipMotion = false }: Props = $props();

  /** Past this the card is a list, not a glance — the tail folds behind a row. */
  const MAX_ROWS = 8;

  const session = getWorkspaceContext();
  const environments = getSessionEnvironmentStore();
  const sess = $derived(session.sessionFor(tabId));

  const isBatch = $derived(messages.length > 1);

  // Read off the messages, not off `summary` — a clock the summary depends on
  // would tear down and rebuild its own interval on every tick.
  const runningCount = $derived(
    messages.filter((message) => message.toolStatus === "running").length,
  );

  let now = $state(Date.now());
  const rows = $derived(
    messages.map((message) =>
      subagentRow(message, now, {
        model: (sess?.sessionModel || sess?.run.modelConfig.modelId || "").trim(),
        effort: (sess?.run.modelConfig.reasoningEffort || "").trim(),
      }),
    ),
  );
  // The agents share the checkout they run in, so that — not their models — is
  // the environment fact the header carries.
  const environment = $derived(environments.environmentFor(session.sessionFor(tabId)?.run));
  const summary = $derived(
    subagentGroupSummary(
      messages,
      rows,
      now,
      environment.isolated ? environment.name : "",
    ),
  );
  $effect(() => {
    if (runningCount === 0) return;
    return liveActivityClock.subscribe((value) => { now = value; });
  });

  const elapsed = $derived(formatActivityDuration(summary.elapsedMs));

  // The group speaks for itself once every agent has landed, so it folds by
  // default — until the reader asks for it back.
  let expandedByUser = $state<boolean | null>(null);
  const collapsed = $derived(
    expandedByUser === null ? runningCount === 0 : !expandedByUser,
  );

  let showAllRows = $state(false);
  const visibleRows = $derived(showAllRows ? rows : rows.slice(0, MAX_ROWS));
  const hiddenCount = $derived(rows.length - visibleRows.length);
</script>

<div class="py-2 {skipMotion ? '' : 'animate-msg-in-side'}">
  {#if !isBatch}
    <!-- §3 — one agent has two faces, and which one it wears is the whole state:
         while it runs it is a row on a chassis with a step seam, and when it lands
         it is a card, because only then is there something to read. Each owns its
         own shell, so nothing here wraps them. -->
    {#if rows[0].state === "done"}
      <SubagentReturnCard
        message={messages[0]}
        row={rows[0]}
        {tabId}
        worktree={environment.isolated ? environment.name : ""}
      />
    {:else}
      <SubagentRunCard row={rows[0]} {tabId} />
    {/if}
  {:else if collapsed}
    <!-- §16's turn-collapse row with the fan-out glyph in the icon slot.
         Expanding brings the group card back, not a list of n cards. -->
    <button
      type="button"
      class="subagent-fold mx-auto w-[88%]"
      data-testid="subagent-group-folded"
      onclick={() => (expandedByUser = true)}
    >
      <CaretRightIcon size={10} aria-hidden="true" class="subagent-fold__caret shrink-0" />
      <span class="subagent-fold__glyph" aria-hidden="true">
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="4" cy="3.4" r="1.6" />
          <circle cx="4" cy="8.6" r="1.6" />
          <circle cx="9" cy="3.4" r="1.6" />
          <circle cx="9" cy="8.6" r="1.6" />
        </svg>
      </span>
      <span class="subagent-fold__label"
        >{summary.total} subagents worked{elapsed ? " for " : ""}<span
          class="subagent-fold__figure">{elapsed}</span
        ></span
      >
      <span class="flex-1"></span>
      {#if summary.failed > 0}
        <span class="subagent-fold__rail subagent-fold__rail--failed"
          >{summary.failed} failed</span
        >
      {/if}
    </button>
  {:else}
    <section
      class="subagent-group mx-auto w-[88%] overflow-hidden rounded-2xl"
      aria-label={`${messages.length} sub-agents`}
      data-testid="subagent-group"
    >
      <!-- The header carries only what is genuinely shared: the objective, the
           worktree, and a tally of how many are in each state. Model, effort,
           progress and elapsed vary per agent, so they live on the row. -->
      <header class="subagent-group__header">
        <div class="subagent-group__kicker">Subagents</div>
        <div class="flex items-center gap-2">
          <span class="subagent-group__title">{summary.title}</span>
          <span
            class="subagent-group__chip"
            class:is-live={summary.running > 0}
            data-testid="subagent-group-chip"
          >
            {#if summary.running > 0}
              <span class="subagent-group__chip-dot" aria-hidden="true"></span>
            {/if}
            {summary.chip}
          </span>
        </div>
        <div class="subagent-group__meta">
          {#each summary.meta as item (item)}
            <span>{item}</span>
            <span class="subagent-group__sep" aria-hidden="true">·</span>
          {/each}
          <span class="">{elapsed}</span>
        </div>
      </header>

      <div class="subagent-group__rows">
        {#each visibleRows as row (row.id)}
          <SubagentRow {row} {tabId} />
        {/each}
        {#if hiddenCount > 0}
          <button
            type="button"
            class="subagent-group__more"
            onclick={() => (showAllRows = true)}
          >
            {hiddenCount} more agent{hiddenCount === 1 ? "" : "s"}
          </button>
        {/if}
      </div>
    </section>
  {/if}
</div>

<style>
  .subagent-group {
    background: var(--solus-tx-card-bg);
    box-shadow: var(--solus-tx-card-shadow);
  }

  .subagent-group__header {
    padding: 0.875rem 1rem 0.75rem;
  }

  /* Geometry only: the type rungs already follow the display, and touch keeps
     the open spacing. */
  @media (pointer: fine) {
    :global(html.is-laptop-display) .subagent-group__header {
      padding: 0.6875rem 0.8125rem 0.625rem;
    }
  }

  .subagent-group__kicker {
    margin-bottom: 0.3125rem;
    font-size: var(--text-transcript-meta);
    font-weight: 500;

    text-transform: uppercase;
    color: var(--muted-foreground);
    opacity: 0.7;
  }

  .subagent-group__title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-transcript-card);
    font-weight: 500;
    color: var(--solus-text-primary);
  }

  .subagent-group__chip {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.375rem;
    border-radius: 9999px;
    padding: 0.125rem 0.5rem;
    font-size: var(--text-transcript-meta);
    font-weight: 500;
    color: var(--muted-foreground);
    background: color-mix(in oklch, var(--foreground) 6%, transparent);
  }

  /* Only "in flight" earns the accent — one failed agent never turns the whole
     group destructive. */
  .subagent-group__chip.is-live {
    padding-left: 0.375rem;
    background: color-mix(in oklch, var(--primary) 13%, transparent);
    color: color-mix(in oklch, var(--primary) 82%, var(--foreground));
  }

  .subagent-group__chip-dot {
    width: 0.3125rem;
    height: 0.3125rem;
    border-radius: 9999px;
    background: currentColor;
  }

  .subagent-group__meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.125rem;
    font-size: var(--text-transcript-meta);
    color: var(--muted-foreground);
  }

  .subagent-group__sep {
    opacity: 0.4;
  }

  .subagent-group__rows {
    display: flex;
    flex-direction: column;
    gap: 0.0625rem;
    padding: 0 0.8125rem 0.5rem;
  }

  .subagent-group__more {
    border: none;
    border-radius: 0.375rem;
    background: transparent;
    padding: 0.375rem;
    text-align: left;
    font-size: var(--text-transcript-meta);
    color: var(--muted-foreground);
    cursor: pointer;
    transition: background var(--duration-quick) var(--ease-premium);
  }

  .subagent-group__more:hover {
    background: color-mix(in oklch, var(--foreground) 4%, transparent);
  }

  .subagent-fold {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    border: none;
    border-radius: 0.5rem;
    background: transparent;
    padding: 0.375rem 0.5rem;
    text-align: left;
    cursor: pointer;
    transition: background var(--duration-quick) var(--ease-premium);
  }

  .subagent-fold:hover {
    background: color-mix(in oklch, var(--foreground) 4%, transparent);
  }

  :global(.subagent-fold__caret) {
    color: var(--muted-foreground);
    opacity: 0.45;
  }

  .subagent-fold__glyph {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    color: var(--muted-foreground);
    opacity: 0.6;
  }

  .subagent-fold__label {
    font-size: var(--text-transcript-card);
    color: var(--muted-foreground);
  }

  .subagent-fold__figure {
    color: var(--solus-text-primary);
  }

  .subagent-fold__rail {
    flex-shrink: 0;
    font-size: var(--text-transcript-meta);
    color: var(--muted-foreground);
    opacity: 0.55;
    font-variant-numeric: tabular-nums;
  }

  .subagent-fold__rail--failed {
    color: color-mix(in oklch, var(--destructive) 70%, var(--foreground));
    opacity: 0.85;
  }

</style>
