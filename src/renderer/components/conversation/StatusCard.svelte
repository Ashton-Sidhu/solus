<script lang="ts">
  import { CaretDownIcon } from "phosphor-svelte";
  import type { StatusCardState } from "../../../shared/types";
  import TranscriptChip from "./TranscriptChip.svelte";
  import { SetupStepTiming, formatStepDuration } from "./lib/setup-timing.svelte";

  interface Props {
    card: StatusCardState;
    skipMotion?: boolean;
  }

  let { card, skipMotion = false }: Props = $props();

  const timing = new SetupStepTiming();
  // Transitions can only be observed as they arrive; nothing about "how long did
  // the user wait" is derivable from the current payload alone.
  $effect(() => timing.observe(card, Date.now()));

  const doneCount = $derived(card.steps.filter((s) => s.status === "done").length);
  const total = $derived(card.steps.length);
  const activeStep = $derived(card.steps.find((s) => s.status === "active"));
  const isDone = $derived(card.status === "done");
  const isError = $derived(card.status === "error");

  // Once everything has finished the card collapses to its header.
  let expandedAfterDone = $state(false);
  const collapsed = $derived(isDone && !expandedAfterDone);

  const meta = $derived.by(() => {
    if (isError) return card.steps.find((s) => s.status === "error")?.detail || "Setup failed";
    if (isDone) {
      const elapsed = formatStepDuration(timing.totalMs);
      return [`${total} step${total === 1 ? "" : "s"}`, elapsed].filter(Boolean).join(" · ");
    }
    return [activeStep?.label ?? "Preparing the environment", `step ${Math.min(doneCount + 1, total)} of ${total}`]
      .filter(Boolean)
      .join(" · ");
  });

  const chip = $derived(
    isError
      ? { label: "Failed", state: "destructive" as const }
      : isDone
        ? { label: "Ready", state: "positive" as const }
        : { label: "Setting up", state: "active" as const },
  );

  const progressPercent = $derived(total > 0 ? Math.round((doneCount / total) * 100) : 0);
</script>

{#snippet check()}
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="color-mix(in oklch, var(--chart-3) 62%, var(--foreground))"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="shrink-0"
    aria-hidden="true"
  >
    <path d="M2 6.3l2.7 2.7L10 3.4" />
  </svg>
{/snippet}

<div class="mx-auto w-[88%] py-2 {skipMotion ? '' : 'animate-msg-in-side'}">
  <div
    class="setup-card overflow-hidden rounded-2xl"
    class:is-error={isError}
    role="status"
    aria-live="polite"
    data-testid="status-card"
  >
    <div class="flex items-center gap-3 px-[1.0625rem] pt-[0.9375rem] pb-3">
      <div class="min-w-0 flex-1">
        <div class="setup-kicker">Setup</div>
        <div class="truncate text-sm leading-tight font-medium ">
          {card.title}
        </div>
        <div class="mt-0.5 truncate text-xs text-(--muted-foreground)">{meta}</div>
      </div>
      <TranscriptChip state={chip.state}>{chip.label}</TranscriptChip>
      {#if isDone}
        <button
          type="button"
          class="setup-disclosure"
          aria-expanded={expandedAfterDone}
          aria-label={expandedAfterDone ? "Hide setup steps" : "Show setup steps"}
          onclick={() => (expandedAfterDone = !expandedAfterDone)}
        >
          <CaretDownIcon size={10} weight="bold" class={expandedAfterDone ? "rotate-180" : ""} />
        </button>
      {/if}
    </div>

    {#if !collapsed}
      <!-- The progress bar reads as the card's own state, so it sits as a rule
           directly under the header rather than floating in it. -->
      <div class="mx-3.5 h-[0.1875rem] overflow-hidden rounded-full setup-track">
        <div class="h-full rounded-full setup-track-fill" style="width:{progressPercent}%"></div>
      </div>

      <!-- 28px rows on an 8px inset; no dividers, no filled discs. -->
      <ul class="flex flex-col px-2 py-2.5" role="list">
        {#each card.steps as step (step.id)}
          {@const stepMs = timing.msFor(step.id)}
          <li
            class="setup-step flex min-h-7 items-center gap-2.5 rounded-md px-2 py-[0.3125rem]"
            class:is-active={step.status === "active"}
          >
            {#if step.status === "done"}
              {@render check()}
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
              class="min-w-0 flex-1 truncate text-sm"
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
            <li class="setup-detail px-2 pb-1.5">{step.detail}</li>
          {/if}
        {/each}
      </ul>
    {/if}
  </div>
</div>

<style>
  .setup-card {
    background: var(--solus-tx-card-bg);
    box-shadow: var(--solus-tx-card-shadow);
  }

  .setup-card.is-error {
    box-shadow:
      0 0 0 0.03125rem color-mix(in oklch, var(--destructive) 26%, transparent),
      inset 0 0.0625rem 0 var(--solus-tx-card-highlight),
      var(--solus-tx-card-lift);
  }

  .setup-kicker {
    margin-bottom: 0.3125rem;
    font-size: var(--text-xs);
    font-weight: 500;

    text-transform: uppercase;
    color: var(--muted-foreground);
    opacity: 0.7;
  }

  .setup-disclosure {
    display: inline-flex;
    width: 1.25rem;
    height: 1.25rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 0.375rem;
    background: transparent;
    color: var(--muted-foreground);
    cursor: pointer;
    opacity: 0.5;
    transition: background var(--duration-quick) var(--ease-premium);
  }
  .setup-disclosure:hover {
    background: color-mix(in oklch, var(--foreground) 7%, transparent);
    opacity: 1;
  }

  .setup-track {
    background: color-mix(in oklch, var(--foreground) 7%, transparent);
  }
  .setup-track-fill {
    background: var(--primary);
    transition: width 0.35s var(--ease-premium);
  }
  .setup-card.is-error .setup-track-fill {
    background: var(--destructive);
  }

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
    font-size: var(--text-xs);
    color: var(--muted-foreground);
    opacity: 0.7;
  }

  .setup-detail {
    font-size: var(--text-xs);
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
    .setup-track-fill {
      transition: none;
    }
  }
</style>
