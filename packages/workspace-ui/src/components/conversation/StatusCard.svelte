<script lang="ts">
  import {
    Check as CheckIcon,
    TriangleAlert as WarningIcon,
  } from "@lucide/svelte";
  import { localApi } from "@solus/client-core/local-api";
  import type { StatusCardState } from "@solus/contracts/types";
  import TranscriptCard from "./TranscriptCard.svelte";
  import TranscriptCardAction from "./TranscriptCardAction.svelte";
  import { SetupStepTiming, formatStepDuration } from "./lib/setup-timing.svelte";
  import { statusCardLine } from "./lib/status-card";

  interface Props {
    card: StatusCardState;
    skipMotion?: boolean;
    onRetry?: () => void;
    onWorkLocally?: () => void;
  }

  let { card, skipMotion = false, onRetry, onWorkLocally }: Props = $props();

  const timing = new SetupStepTiming();
  // Transitions can only be observed as they arrive; nothing about "how long did
  // the user wait" is derivable from the current payload alone.
  $effect(() => timing.observe(card, Date.now()));

  const isDone = $derived(card.status === "done");
  const isError = $derived(card.status === "error");
  const line = $derived(statusCardLine(card, timing.totalMs));

  // The steps show while setup runs or fails. Once everything has finished the
  // card collapses to its line, unless the user chose otherwise.
  let userExpanded = $state<boolean | null>(null);
  const expanded = $derived(userExpanded ?? !isDone);
</script>

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
      {#if isError && card.recovery === "worktree"}
        {#if onWorkLocally}<TranscriptCardAction kind="ghost" onclick={onWorkLocally}>Work locally</TranscriptCardAction>{/if}
        {#if onRetry}<TranscriptCardAction kind="primary" onclick={onRetry}>Retry setup</TranscriptCardAction>{/if}
      {/if}
    {/snippet}
    {#snippet body()}
      <!-- Compact rows, no dividers, no filled discs. -->
      <ul class="flex flex-col" role="list">
        {#each card.steps as step (step.id)}
          {@const stepMs = timing.msFor(step.id)}
          <li
            class="setup-step flex min-h-7 items-center gap-2.5 rounded-md px-2 py-[0.3125rem] pointer-fine:[.is-laptop-display_&]:min-h-6 pointer-fine:[.is-laptop-display_&]:gap-2 pointer-fine:[.is-laptop-display_&]:px-1.5 pointer-fine:[.is-laptop-display_&]:py-[0.1875rem]"
            class:is-active={step.status === "active"}
          >
            {#if step.status === "done"}
              <CheckIcon size={12} class="shrink-0 text-[color:color-mix(in_oklch,var(--chart-3)_62%,var(--foreground))]" aria-hidden="true" />
            {:else if step.status === "error"}
              <span class="setup-dot setup-dot--error" aria-hidden="true"></span>
            {:else if step.status === "active"}
              <!-- The same indeterminate hairline used everywhere else, not a
                   spinner. -->
              <span class="setup-indet shrink-0" aria-hidden="true"><span></span></span>
            {:else}
              <span class="setup-dot" aria-hidden="true"></span>
            {/if}

            <span
              class="min-w-0 flex-1 truncate text-transcript-card"
              class:setup-label--done={step.status === "done"}
              class:setup-label--active={step.status === "active"}
              class:setup-label--pending={step.status === "pending"}
              class:setup-label--error={step.status === "error"}
            >
              {step.label}
            </span>

            {#if step.status === "active"}
              <span class="setup-elapsed shrink-0">running</span>
            {:else if stepMs}
              <span class="setup-elapsed shrink-0">{formatStepDuration(stepMs)}</span>
            {/if}
          </li>
          {#if step.detail && step.status === "error"}
            <li class="setup-detail px-2 pb-1.5 pointer-fine:[.is-laptop-display_&]:px-1.5 pointer-fine:[.is-laptop-display_&]:pb-1">
              {step.detail}
            </li>
          {/if}
        {/each}
      </ul>
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
    background: color-mix(in oklch, var(--primary) 7%, transparent);
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
