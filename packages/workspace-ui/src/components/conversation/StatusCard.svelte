<script lang="ts">
  import type { Snippet } from "svelte";
  import {
    Check as CheckIcon,
    TriangleAlert as WarningIcon,
  } from "@lucide/svelte";
  import { localApi } from "@solus/client-core/local-api";
  import type { StatusCardState, StatusCardStep, StatusCardStepStatus } from "@solus/contracts/types";
  import TranscriptCard from "./TranscriptCard.svelte";
  import TranscriptCardAction from "./TranscriptCardAction.svelte";
  import { TerminalOutput } from "../ui/terminal-output";
  import { SetupStepTiming } from "./lib/setup-timing.svelte";
  import { showsStepDetail, statusCardLine, substepNote } from "./lib/status-card";
  import { sessionSyncFailureAction } from "@solus/client-core/session-sync-card";
  import {
    formatStepDuration,
    isWorktreeSetupCard,
    mayWorkLocallyDuringSetup,
    setupOutputTail,
    stepDurationMs,
  } from "@solus/contracts/setup-card";

  interface Props {
    card: StatusCardState;
    skipMotion?: boolean;
    /** Keep the steps open once done: the last step is the result to read (adding a machine over SSH). */
    keepsStepsOpen?: boolean;
    onRetry?: () => void;
    onWorkLocally?: () => void;
    onCancel?: () => void;
    /** A session sync failed for want of a seat: open the connect flow. */
    onConnectSeat?: () => void;
    /** "Connect Claude" or "Connect Codex". */
    connectSeatLabel?: string;
    /** What the person needs under a step while it runs, such as the check code of an approval request. It renders its own `<li>`. */
    stepAddon?: Snippet<[StatusCardStep]>;
  }

  let { card, skipMotion = false, keepsStepsOpen = false, onRetry, onWorkLocally, onCancel, onConnectSeat, connectSeatLabel = "Connect", stepAddon }: Props = $props();
  const syncAction = $derived(card.status === "error" && card.syncFailureReason ? sessionSyncFailureAction(card.syncFailureReason) : null);

  // A card the client makes has no host times: its step times are what this
  // client sees as the steps change. A host card's steps carry their own.
  const timing = new SetupStepTiming();
  $effect(() => timing.observe(card, Date.now()));

  const isDone = $derived(card.status === "done");
  const isError = $derived(card.status === "error");
  const line = $derived(statusCardLine(card, timing.totalMs));
  // Only the host's worktree setup can be stopped, through the run it belongs to.
  const canCancel = $derived(card.status === "active" && isWorktreeSetupCard(card) && !!onCancel);
  // While the host makes the worktree, the person can stop it and work in the project folder.
  const canWorkLocally = $derived(mayWorkLocallyDuringSetup(card) && !!onWorkLocally);

  // The steps show while setup runs or fails. Once everything has finished the
  // card collapses to its line, unless the user chose otherwise.
  let userExpanded = $state<boolean | null>(null);
  // A step with a warning is what the reader must see, so its card stays open.
  const hasWarning = $derived(card.steps.some((step) => step.status === "warning"));
  const expanded = $derived(userExpanded ?? (!isDone || keepsStepsOpen || hasWarning));
</script>

<!-- The mark of a row: the same one for a step and for a sub-step. -->
{#snippet stepMarker(status: StatusCardStepStatus)}
  {#if status === "done"}
    <CheckIcon size={12} class="shrink-0 text-[color:color-mix(in_oklch,var(--chart-3)_62%,var(--foreground))]" aria-hidden="true" />
  {:else if status === "error"}
    <span class="setup-dot setup-dot--error" aria-hidden="true"></span>
  {:else if status === "warning"}
    <WarningIcon size={12} class="shrink-0 text-[color:var(--warning)]" aria-hidden="true" />
  {:else if status === "skipped"}
    <span class="setup-dash shrink-0" aria-hidden="true"></span>
  {:else if status === "active"}
    <!-- The same indeterminate hairline used everywhere else, not a
         spinner. -->
    <span class="setup-indet shrink-0" aria-hidden="true"><span></span></span>
  {:else}
    <span class="setup-dot" aria-hidden="true"></span>
  {/if}
{/snippet}

{#snippet stepLabel(row: Pick<StatusCardStep, "label" | "status">)}
  <span
    class="min-w-0 flex-1 truncate text-transcript-card"
    class:setup-label--done={row.status === "done"}
    class:setup-label--active={row.status === "active"}
    class:setup-label--pending={row.status === "pending" || row.status === "skipped"}
    class:setup-label--error={row.status === "error"}
    class:setup-label--warning={row.status === "warning"}
  >
    {row.label}
  </span>
{/snippet}

<!-- A hairline joins a mark to the next one in its column, green below a finished row. -->
{#snippet stepRail(status: StatusCardStepStatus, left: string)}
  <span
    class="absolute top-[calc(50%+0.5625rem)] -bottom-[0.3125rem] w-[1.5px] rounded-full {left} {status === 'done'
      ? 'bg-[color:color-mix(in_oklch,var(--chart-3)_45%,transparent)]'
      : 'bg-[color:color-mix(in_oklch,var(--foreground)_12%,transparent)]'}"
    aria-hidden="true"
  ></span>
{/snippet}

<div role="status" aria-live="polite">
  <TranscriptCard
    title={card.title}
    type={line.type}
    {expanded}
    failed={isError}
    glyphClass={isError ? "is-failed" : isDone ? "is-done" : ""}
    bodyLayout="rows"
    ariaLabel={expanded ? "Hide setup steps" : "Show setup steps"}
    data-testid="status-card"
    {skipMotion}
    onOpen={() => (userExpanded = !expanded)}
  >
    {#snippet glyph()}
      {#if isError}
        <WarningIcon />
      {:else if isDone}
        <CheckIcon />
      {:else}
        <span class="activity-spinner"></span>
      {/if}
    {/snippet}
    {#snippet rail()}{line.rail}{/snippet}
    {#snippet actions()}
      {#if isError && card.recovery === "connect-github" && card.recoveryUrl}
        {@const connectUrl = card.recoveryUrl}
        <TranscriptCardAction kind="filled" onclick={() => void localApi.openExternal(connectUrl)}>Connect GitHub</TranscriptCardAction>
      {/if}
      {#if syncAction === "connect-seat" && onConnectSeat}
        <TranscriptCardAction kind="filled" onclick={onConnectSeat}>{connectSeatLabel}</TranscriptCardAction>
      {/if}
      {#if isError && card.recovery === "worktree"}
        {#if onWorkLocally}<TranscriptCardAction kind="ghost" onclick={onWorkLocally}>Work locally</TranscriptCardAction>{/if}
        {#if onRetry}<TranscriptCardAction kind="primary" onclick={onRetry}>Retry setup</TranscriptCardAction>{/if}
      {/if}
      {#if canWorkLocally}
        <TranscriptCardAction kind="ghost" onclick={onWorkLocally}>Work locally</TranscriptCardAction>
      {/if}
      {#if canCancel}
        <TranscriptCardAction kind="ghost" onclick={onCancel}>Cancel</TranscriptCardAction>
      {/if}
    {/snippet}
    {#snippet body()}
      <!-- Compact rows, no dividers, no filled discs. A hairline rail joins
           each marker to the next, green below a finished step. -->
      <ul class="flex flex-col" role="list">
        {#each card.steps as step, index (step.id)}
          {@const stepMs = stepDurationMs(step) ?? timing.msFor(step.id)}
          <!-- A running step that reports its percentage (a clone, an install) fills its
               own tint from the left: the bar is the row, not one more line. -->
          <li
            class="setup-step relative flex min-h-7 items-center gap-2.5 rounded-md px-2 py-[0.3125rem]"
            class:is-active={step.status === "active"}
            style:--step-percent={step.status === "active" && step.percent !== undefined ? `${step.percent}%` : undefined}
          >
            <!-- A failed or warned step shows its detail under it, and a step of
                 several repositories shows their rows, so the rail stops there. -->
            {#if index < card.steps.length - 1 && !showsStepDetail(step) && !step.substeps?.length}
              {@render stepRail(step.status, "left-[calc(0.875rem-0.75px)]")}
            {/if}
            {@render stepMarker(step.status)}
            {@render stepLabel(step)}

            {#if step.status === "active"}
              <span class="setup-elapsed shrink-0">{step.percent === undefined ? "running" : `${step.percent}%`}</span>
            {:else if step.status === "skipped"}
              <span class="setup-elapsed shrink-0">skipped</span>
            {:else if stepMs}
              <span class="setup-elapsed shrink-0">{formatStepDuration(stepMs)}</span>
            {/if}
          </li>
          {#if showsStepDetail(step)}
            <li class="setup-detail px-2 pb-1.5" class:setup-detail--warning={step.status === "warning"}>
              {step.detail}
            </li>
          {/if}
          {@render stepAddon?.(step)}
          <!-- The part of each repository in the step: the row of a step, one level in. -->
          {#each step.substeps ?? [] as substep, substepIndex (substep.id)}
            {@const note = substepNote(substep)}
            <li class="relative flex min-h-7 items-center gap-2.5 py-[0.3125rem] pr-2 pl-[1.875rem]">
              {#if substepIndex < (step.substeps?.length ?? 0) - 1 && !showsStepDetail(substep)}
                {@render stepRail(substep.status, "left-[calc(2.25rem-0.75px)]")}
              {/if}
              {@render stepMarker(substep.status)}
              {@render stepLabel(substep)}
              {#if note}<span class="setup-elapsed shrink-0">{note}</span>{/if}
            </li>
            {#if showsStepDetail(substep)}
              <li class="setup-detail pr-2 pb-1.5 pl-[1.875rem]" class:setup-detail--warning={substep.status === "warning"}>
                {substep.detail}
              </li>
            {/if}
          {/each}
        {/each}
      </ul>
      {#if isError && card.output?.length}
        <!-- The end of the host's output, in the terminal panel every command
             output uses. -->
        <TerminalOutput
          output={setupOutputTail(card.output)}
          label="Setup output"
          class="mx-2 mt-1 mb-1.5 max-h-48"
        />
      {/if}
    {/snippet}
    {#snippet seam()}
      <!-- Progress is the card's own state, so it runs along its bottom edge
           until setup is done. -->
      {#if !isDone}
        <span
          class="h-full transition-[width] duration-350 ease-(--ease-premium) motion-reduce:transition-none {isError
            ? 'bg-destructive'
            : 'bg-primary'}"
          style="width:{line.progressPercent}%"
        ></span>
      {/if}
    {/snippet}
  </TranscriptCard>
</div>

<style>
  .setup-step.is-active {
    background: linear-gradient(
      to right,
      color-mix(in oklch, var(--primary) 16%, transparent) var(--step-percent, 0%),
      color-mix(in oklch, var(--primary) 7%, transparent) var(--step-percent, 0%)
    );
  }

  /* Pending is a ring, not an empty circle. */
  .setup-dot {
    width: 0.75rem;
    height: 0.75rem;
    flex-shrink: 0;
    border-radius: 9999px;
    box-shadow: inset 0 0 0 0.09375rem
      color-mix(in oklch, var(--foreground) 14%, transparent);
  }
  .setup-dot--error {
    box-shadow: inset 0 0 0 0.09375rem
      color-mix(in oklch, var(--destructive) 55%, transparent);
  }

  /* Skipped: a short dash, the step had no work. */
  .setup-dash {
    width: 0.75rem;
    height: 0.09375rem;
    border-radius: 9999px;
    background: color-mix(in oklch, var(--foreground) 22%, transparent);
  }

  .setup-indet {
    display: inline-flex;
    align-items: center;
    width: 0.75rem;
    height: 0.125rem;
    overflow: hidden;
    border-radius: 9999px;
    background: color-mix(in oklch, var(--primary) 25%, transparent);
  }
  .setup-indet > span {
    display: block;
    width: 0.375rem;
    height: 0.125rem;
    border-radius: 9999px;
    background: var(--primary);
    animation: setup-indet 1.3s ease-in-out infinite;
  }

  /* Step labels are present participles while running and stay in that tense
     once done — only the collapsed summary speaks in the past. */
  .setup-label--active {
    font-weight: 500;
    color: var(--solus-text-primary);
  }
  .setup-label--done {
    color: var(--solus-text-primary);
    opacity: 0.6;
  }
  .setup-label--pending {
    color: var(--muted-foreground);
  }
  .setup-label--error {
    color: var(--destructive);
  }
  .setup-label--warning {
    color: var(--solus-text-primary);
  }

  .setup-elapsed {
    font-size: var(--text-transcript-meta);
    color: var(--muted-foreground);
    opacity: 0.7;
  }

  .setup-detail {
    font-size: var(--text-transcript-meta);
    line-height: 1.5;
    color: var(--muted-foreground);
    text-wrap: pretty;
  }
  .setup-detail--warning {
    color: color-mix(in oklch, var(--warning) 70%, var(--foreground));
  }

  @keyframes setup-indet {
    0% {
      transform: translateX(-40%);
    }
    100% {
      transform: translateX(240%);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .setup-indet > span {
      animation: none;
      width: 100%;
    }
  }
</style>
