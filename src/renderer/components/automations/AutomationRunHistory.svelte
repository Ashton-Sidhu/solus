<script lang="ts">
  import { CaretDownIcon } from "phosphor-svelte";
  import type { AutomationRun } from "../../../shared/types";
  import {
    RUN_STATUS_META,
    runDate,
    runDuration,
    relativeTime,
  } from "./lib/automation-format";

  // The rail's History block: one line per run — a status dot, what the run did,
  // and when. Clicking a run resumes the session it spawned.
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

  const ROW =
    "flex w-full min-w-0 h-9.5 -mx-2 items-center gap-2.5 rounded-lg border-0 bg-transparent px-2 text-left " +
    "transition-colors duration-100 cursor-pointer hover:not-disabled:bg-muted disabled:cursor-default " +
    "focus-visible:outline-2 focus-visible:[outline-offset:-0.0625rem] focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]";

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

<div class="text-xs text-xs flex min-w-0 flex-col gap-3">
  <div class="flex items-baseline justify-between gap-2.5">
    <span
      class="font-normal text-muted-foreground uppercase"
      >History</span
    >
    {#if runs.length > 0}
      <span class="text-[color:color-mix(in_oklab,var(--muted-foreground)_80%,transparent)]">
        {runs.length}
        {runs.length === 1 ? "run" : "runs"}
      </span>
    {/if}
  </div>

  {#if runs.length === 0}
    <p class="m-0 text-sm leading-normal text-muted-foreground">
      No runs yet. Use Run now to test it.
    </p>
  {:else}
    <ul class="m-0 flex list-none flex-col p-0" role="list">
      {#each visibleRuns as run (run.id)}
        {@const failed = run.status === "failed"}
        <li class="min-w-0">
        <button
          type="button"
          class={ROW}
          title={run.branch ? `Changes from this run live on branch ${run.branch}` : undefined}
          onclick={() => onOpen(run)}
          disabled={!run.agentSessionId}
        >
          <span
            class="size-1.5 shrink-0 rounded-full {failed
 ? 'bg-[var(--solus-status-error,#e53e3e)]'
 : 'bg-[color:color-mix(in_oklab,var(--chart-3)_70%,transparent)]'}"
            aria-hidden="true"
          ></span>
          <span
            class="min-w-0 flex-1 truncate text-sm {failed
 ? 'text-[var(--solus-status-error,#e53e3e)]'
 : 'text-[color:color-mix(in_oklab,var(--foreground)_82%,var(--muted-foreground))]'}"
            >{summary(run)}</span
          >
          <span class="shrink-0 tabular-nums text-muted-foreground"
            >{runDate(run.startedAt) || relativeTime(run.startedAt)}</span
          >
        </button>
        </li>
      {/each}
    </ul>

    {#if hiddenCount > 0 || expanded}
      <button
        type="button"
        class="-mx-2 mt-0.5 inline-flex h-7 cursor-pointer items-center gap-1.5 self-start rounded-lg border-0 bg-transparent px-2 font-medium text-muted-foreground transition-colors duration-100 hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]"
        onclick={onToggle}
        aria-expanded={expanded}
      >
        <CaretDownIcon
          size={11}
          weight="bold"
          class="transition-transform duration-150 {expanded ? 'rotate-180' : ''}"
        />
        {expanded ? "Show fewer" : `Show ${hiddenCount} older ${hiddenCount === 1 ? "run" : "runs"}`}
      </button>
    {/if}
  {/if}
</div>
