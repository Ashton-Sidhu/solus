<script lang="ts">
  import type { Snippet } from "svelte";
  import {
    Check as CheckIcon,
    TriangleAlert as WarningIcon,
  } from "@lucide/svelte";
  import { localApi } from "@solus/client-core/local-api";
  import type { StatusCardState, StatusCardStep } from "@solus/contracts/types";
  import TranscriptCard from "./TranscriptCard.svelte";
  import TranscriptCardAction from "./TranscriptCardAction.svelte";
  import StepRail from "../steps/StepRail.svelte";
  import SetupBranches from "./SetupBranches.svelte";
  import { TerminalOutput } from "../ui/terminal-output";
  import { SetupStepTiming } from "./lib/setup-timing.svelte";
  import { setupOutputHome, showsStepDetail, statusCardLine, stepRailStateOf, stepTrailingNote } from "./lib/status-card";
  import { sessionSyncFailureAction } from "@solus/client-core/session-sync-card";
  import {
    isWorktreeSetupCard,
    mayWorkLocallyDuringSetup,
    setupOutputTail,
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
    /** What the person needs under a step while it runs, such as the check code of an approval request. */
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

  const railSteps = $derived(card.steps.map((step) => ({ title: step.label, state: stepRailStateOf(step.status) })));
  // The host's output sits next to what failed.
  const outputHome = $derived(setupOutputHome(card));
  const output = $derived(outputHome && card.output ? setupOutputTail(card.output) : "");
</script>

<!-- The time a finished setup took; the line has no step count. -->
{#snippet railTime()}{line.rail}{/snippet}

<div role="status" aria-live="polite">
  <TranscriptCard
    title={card.title}
    type={line.type}
    rail={line.rail ? railTime : undefined}
    {expanded}
    failed={isError}
    glyphClass={isError ? "is-failed" : isDone ? "is-done" : ""}
    bodyLayout="steps"
    actionsOnCardLine
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
    {#snippet actions()}
      {#if isError && card.recovery === "connect-github" && card.recoveryUrl}
        {@const connectUrl = card.recoveryUrl}
        <TranscriptCardAction pill kind="filled" onclick={() => void localApi.openExternal(connectUrl)}>Connect GitHub</TranscriptCardAction>
      {/if}
      {#if syncAction === "connect-seat" && onConnectSeat}
        <TranscriptCardAction pill kind="filled" onclick={onConnectSeat}>{connectSeatLabel}</TranscriptCardAction>
      {/if}
      {#if isError && card.recovery === "worktree"}
        {#if onWorkLocally}<TranscriptCardAction pill kind="ghost" onclick={onWorkLocally}>Work locally</TranscriptCardAction>{/if}
        {#if onRetry}<TranscriptCardAction pill kind="primary" onclick={onRetry}>Retry setup</TranscriptCardAction>{/if}
      {/if}
      {#if canWorkLocally}
        <TranscriptCardAction pill kind="ghost" onclick={onWorkLocally}>Work locally</TranscriptCardAction>
      {/if}
      {#if canCancel}
        <TranscriptCardAction pill kind="ghost" onclick={onCancel}>Cancel</TranscriptCardAction>
      {/if}
    {/snippet}
    {#snippet body()}
      <!-- The steps on the step timeline every "this, then that" uses. A step
           of several repositories shows each one as a branch off its rail. -->
      <div class="text-transcript-card">
        <StepRail steps={railSteps}>
          {#snippet trailing(_railStep, index)}
            {@const note = stepTrailingNote(card.steps[index]!, timing.msFor(card.steps[index]!.id))}
            {#if note}
              <span class="shrink-0 text-transcript-meta leading-5.5 text-(--solus-text-tertiary) tabular-nums">{note}</span>
            {/if}
          {/snippet}
          {#snippet detail(_railStep, index)}
            {@const step = card.steps[index]!}
            {#if step.status === "active" && step.percent !== undefined && !step.substeps?.length}
              <!-- A running step that reports its share (a clone, a checkout) shows it on a bar. -->
              <div class="mt-1.5 flex items-center gap-2.5">
                <span class="flex h-0.5 w-60 max-w-full overflow-hidden rounded-full bg-(--hairline)">
                  <span class="h-full rounded-full bg-(--solus-text-primary) transition-[width] duration-350 ease-(--ease-premium) motion-reduce:transition-none" style:width="{step.percent}%"></span>
                </span>
                <span class="text-transcript-meta text-(--solus-text-secondary) tabular-nums">{step.percent}%</span>
              </div>
            {/if}
            {#if showsStepDetail(step)}
              <p
                class="m-0 mt-0.5 text-transcript-meta text-pretty {step.status === 'error'
                  ? 'text-destructive'
                  : 'text-[color:color-mix(in_oklch,var(--warning)_70%,var(--foreground))]'}"
              >
                {step.detail}
              </p>
            {/if}
            {#if step.substeps?.length}
              <SetupBranches
                substeps={step.substeps}
                outputSubstepId={outputHome?.kind === "substep" && outputHome.stepId === step.id ? outputHome.substepId : undefined}
                {output}
              />
            {/if}
            {#if outputHome?.kind === "step" && outputHome.stepId === step.id}
              <TerminalOutput {output} label="Setup output" class="mt-2 max-h-48" />
            {/if}
            {@render stepAddon?.(step)}
          {/snippet}
        </StepRail>
        {#if outputHome?.kind === "end"}
          <TerminalOutput {output} label="Setup output" class="mt-3 ml-9 max-h-48" />
        {/if}
      </div>
    {/snippet}
  </TranscriptCard>
</div>
