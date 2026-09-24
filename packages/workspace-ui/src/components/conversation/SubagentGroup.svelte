<script lang="ts">
  import { getTranscriptDisclosure } from "./lib/transcript-disclosure.svelte";
  import type { Message } from "@solus/contracts/types";
  import { getWorkspaceContext } from "../../contexts";
  import { formatActivityDuration } from "./lib/activity-summary";
  import {
    subagentGroupRail,
    subagentGroupSummary,
    subagentGroupType,
    subagentRow,
  } from "./lib/subagent-group";
  import ActivityRow from "./ActivityRow.svelte";
  import SubagentReturnCard from "./SubagentReturnCard.svelte";
  import SubagentRow from "./SubagentRow.svelte";
  import SubagentRunCard from "./SubagentRunCard.svelte";
  import TranscriptCard from "./TranscriptCard.svelte";
  import { liveActivityClock } from "../../lib/shared-clock";

  /**
   * §18 — a fan-out is one object, not n cards. Several sub-agents dispatched by
   * one decision render as one card with one row each; a lone sub-agent is the
   * same card with one row, so nothing about the anatomy shifts as a turn adds
   * agents. When the last one lands the whole card folds to a single activity
   * row, the same shape §16 gives a finished turn. The reader can open it
   * again and fold it back.
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
        model: (
          sess?.sessionModel ||
          sess?.run.modelConfig.modelId ||
          ""
        ).trim(),
        effort: (sess?.run.modelConfig.reasoningEffort || "").trim(),
      }),
    ),
  );
  const summary = $derived(subagentGroupSummary(messages, rows, now));
  $effect(() => {
    if (runningCount === 0) return;
    return liveActivityClock.subscribe((value) => {
      now = value;
    });
  });

  const elapsed = $derived(formatActivityDuration(summary.elapsedMs));
  const railText = $derived(subagentGroupRail(summary));

  // The group speaks for itself once every agent has landed, so it folds by
  // default — until the reader asks for it back.
  const disclosure = getTranscriptDisclosure();
  const view = $derived(disclosure.forKey(`subagents:${messages[0]?.id}`));
  const collapsed = $derived(
    view.openedByUser === null ? runningCount === 0 : !view.openedByUser,
  );

  const visibleRows = $derived(view.showAllRows ? rows : rows.slice(0, MAX_ROWS));
  const hiddenCount = $derived(rows.length - visibleRows.length);
</script>

{#snippet fanOutGlyph()}
  <svg
    width="11"
    height="11"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <circle cx="4" cy="3.4" r="1.6" />
    <circle cx="4" cy="8.6" r="1.6" />
    <circle cx="9" cy="3.4" r="1.6" />
    <circle cx="9" cy="8.6" r="1.6" />
  </svg>
{/snippet}

{#snippet foldLabel()}
  {summary.total} subagents worked{elapsed ? " for " : ""}<span
    class="text-(--solus-text-primary)">{elapsed}</span
  >
{/snippet}

{#snippet foldRail()}
  <span class="text-[color-mix(in_oklch,var(--destructive)_70%,var(--foreground))]"
    >{summary.failed} failed</span
  >
{/snippet}

{#snippet groupRail()}{railText}{/snippet}

{#snippet agentRows()}
  {#each visibleRows as row (row.id)}
    <SubagentRow {row} {tabId} />
  {/each}
  {#if hiddenCount > 0}
    <button
      type="button"
      class="h-(--tx-card-row) cursor-pointer rounded-(--tx-card-row-radius) border-none bg-transparent px-2 text-left text-transcript-meta text-muted-foreground transition-colors hover:bg-[color-mix(in_oklch,var(--foreground)_4%,transparent)]"
      onclick={() => (view.showAllRows = true)}
    >
      {hiddenCount} more agent{hiddenCount === 1 ? "" : "s"}
    </button>
  {/if}
{/snippet}

{#if !isBatch}
  <!-- §3 — one agent has two faces, and which one it wears is the whole state:
       while it runs it is one line with a step seam, and when it lands it opens
       a body, because only then is there something to read. -->
  {#if rows[0].state === "done"}
    <SubagentReturnCard
      message={messages[0]}
      row={rows[0]}
      {tabId}
      {skipMotion}
    />
  {:else}
    <SubagentRunCard row={rows[0]} {tabId} {skipMotion} />
  {/if}
{:else if collapsed}
  <!-- §16's turn-collapse row with the fan-out glyph in the icon slot.
       Expanding brings the group card back, not a list of n cards.
       `activity-host` opts the row out of the transcript's paint containment. -->
  <div class="activity-host py-1 {skipMotion ? '' : 'animate-msg-in-side'}">
    <ActivityRow
      glyph={fanOutGlyph}
      label={foldLabel}
      rail={summary.failed > 0 ? foldRail : undefined}
      onToggle={() => (view.openedByUser = true)}
      testid="subagent-group-folded"
    />
  </div>
{:else}
  <!-- The line carries only what the agents share: the objective, the count,
       and a tally. Progress and elapsed time vary per agent, so they live on
       the row. Once every agent has landed, the line folds the group away. -->
  <TranscriptCard
    title={summary.title}
    type={subagentGroupType(summary)}
    bodyLayout="rows"
    expanded={runningCount === 0 ? true : undefined}
    ariaLabel="Fold sub-agents"
    onOpen={runningCount === 0 ? () => (view.openedByUser = false) : undefined}
    data-testid="subagent-group"
    {skipMotion}
    glyph={fanOutGlyph}
    rail={groupRail}
    body={agentRows}
  />
{/if}
