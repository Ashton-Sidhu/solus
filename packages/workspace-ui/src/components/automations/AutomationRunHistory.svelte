<script lang="ts">
  import { ChevronRight as CaretRightIcon } from "@lucide/svelte";
  import type { AutomationRun } from "@solus/contracts/types";
  import {
    RUN_STATUS_META,
    runDate,
    runDuration,
    relativeTime,
  } from "./lib/automation-format";
  import { LABEL, ROW_BUTTON, VALUE } from "./lib/rail-styles";
  import { worktreeDisplayName } from "../../lib/git-context";

  // The rail's History block: one line per run — what the run did and when.
  // Clicking a run resumes the session it spawned.
  interface Props {
    runs: AutomationRun[];
    expanded: boolean;
    onToggle: () => void;
    onOpen: (run: AutomationRun) => void;
  }
  let { runs, expanded, onToggle, onOpen }: Props = $props();

  const COLLAPSED_RUN_COUNT = 5;
  const visibleRuns = $derived(expanded ? runs : runs.slice(0, COLLAPSED_RUN_COUNT));
  const hiddenCount = $derived(Math.max(0, runs.length - COLLAPSED_RUN_COUNT));

  /** What the run did, in one line. A failed run's error is the only diagnostic
   *  the user gets here (those runs rarely have a session to open), so it takes
   *  the line over the generic status word. */
  function summary(run: AutomationRun): string {
    if (run.status === "failed" && run.error) return run.error.split("\n")[0];
    const duration = runDuration(run);
    const label = RUN_STATUS_META[run.status].label;
    return duration ? `${label} · ${duration}` : label;
  }
</script>

<div class="flex min-w-0 flex-col">
  <div class="menu-heading flex items-baseline justify-between gap-2.5">
    <span>History</span>
    {#if runs.length > 0}
      <span class="font-normal tracking-normal normal-case">
        {runs.length}
        {runs.length === 1 ? "run" : "runs"}
      </span>
    {/if}
  </div>

  {#if runs.length === 0}
    <p class="m-0 px-2.5 py-1.5 text-xs leading-normal text-(--solus-text-tertiary)">
      No runs yet. Use Run now to test it.
    </p>
  {:else}
    <ul class="m-0 flex list-none flex-col p-0" role="list">
      {#each visibleRuns as run (run.id)}
        {@const failed = run.status === "failed"}
        <li class="min-w-0">
        <button
          type="button"
          class={ROW_BUTTON}
          title={run.branch ? `Changes from this run live on branch ${worktreeDisplayName(run.branch)}` : undefined}
          onclick={() => onOpen(run)}
          disabled={!run.sessionId}
        >
          <span class="{VALUE} flex-1 {failed ? 'text-[var(--solus-status-error,#e53e3e)]' : ''}">{summary(run)}</span>
          <span class="shrink-0 text-xs tabular-nums text-(--solus-text-tertiary)"
            >{runDate(run.startedAt) || relativeTime(run.startedAt)}</span
          >
        </button>
        </li>
      {/each}
    </ul>

    {#if hiddenCount > 0}
      <!-- The model picker's "Legacy models" row: it opens in place. -->
      <button type="button" class={ROW_BUTTON} onclick={onToggle} aria-expanded={expanded}>
        <span class="{LABEL} flex-1">Older runs</span>
        <span class="shrink-0 text-(--solus-text-tertiary)">{hiddenCount}</span>
        <CaretRightIcon size={11} class="shrink-0 text-(--solus-text-tertiary) transition-transform duration-150 {expanded ? 'rotate-90' : ''}" />
      </button>
    {/if}
  {/if}
</div>
