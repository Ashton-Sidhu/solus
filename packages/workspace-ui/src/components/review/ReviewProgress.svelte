<script lang="ts">
  import { Aperture as ApertureIcon, Check as CheckIcon, LoaderCircle as SpinnerIcon } from "@lucide/svelte";
  import type { ReviewProgressStep } from "@solus/contracts/review";

  import { Button } from "../ui/button";
  import ReviewGuideGlyph from "./ReviewGuideGlyph.svelte";
  import {
    REVIEW_PROGRESS_COPY,
    progressFraction,
    progressStepIndex,
    type ReviewProgressSubject,
  } from "./lib/review-progress";

  // The one generation screen for the guide and the lens. It stands in the
  // canvas where the empty offer was, so it keeps that shape — one medallion,
  // one headline, one line of copy — and adds the host's steps below it. The
  // ring around the medallion fills as the steps advance.
  let {
    subject,
    step,
    queued = false,
    onCancel,
  }: {
    subject: ReviewProgressSubject;
    step?: ReviewProgressStep;
    queued?: boolean;
    onCancel?: () => void;
  } = $props();

  const copy = $derived(REVIEW_PROGRESS_COPY[subject]);
  const activeIndex = $derived(progressStepIndex(copy.steps, step));
  const fraction = $derived(progressFraction(activeIndex, copy.steps.length, queued));
</script>

<!-- The chrome rung, not the surface's prose size: this is a state screen, and
     it matches the rail and the notices. -->
<div class="flex min-h-0 flex-1 items-center justify-center overflow-auto px-[clamp(20px,2.6cqi,56px)] py-10 text-workspace-chrome">
  <div class="prog-card flex w-full max-w-[22rem] flex-col items-center text-center">
    <span class="relative flex size-16 shrink-0 items-center justify-center" aria-hidden="true">
      <svg viewBox="0 0 64 64" class="absolute inset-0 size-full -rotate-90">
        <circle cx="32" cy="32" r="30" fill="none" stroke-width="2" class="stroke-(--hairline)" stroke-dasharray={queued ? "2 5" : undefined} />
        <circle
          cx="32"
          cy="32"
          r="30"
          fill="none"
          stroke-width="2"
          stroke-linecap="round"
          pathLength="100"
          stroke-dasharray="100"
          stroke-dashoffset={100 - fraction * 100}
          class="stroke-(--solus-accent) transition-[stroke-dashoffset] duration-700 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none {fraction === 0 ? 'opacity-0' : ''}"
        />
      </svg>
      <span class="flex size-12 items-center justify-center rounded-full bg-[color:color-mix(in_oklab,var(--solus-accent)_10%,transparent)] text-(--solus-accent)">
        {#if subject === "lens"}
          <ApertureIcon size={20} />
        {:else}
          <ReviewGuideGlyph size={20} />
        {/if}
      </span>
    </span>

    <h2 role="status" class="mt-5 font-medium text-foreground">
      {queued ? copy.queuedTitle : copy.steps[activeIndex].label}
    </h2>

    <p class="mt-1.5 leading-[1.6] text-pretty text-muted-foreground">
      {queued ? copy.queuedDescription : copy.description}
    </p>

    <ol class="prog-steps mt-6 flex w-full flex-col gap-0.5 text-left" aria-label="Steps">
      {#each copy.steps as s, i (s.id)}
        {@const state = queued ? "pending" : i < activeIndex ? "done" : i === activeIndex ? "active" : "pending"}
        <li
          class="flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors duration-300 {state === 'active'
            ? 'bg-[color:color-mix(in_oklab,var(--solus-accent)_8%,transparent)]'
            : ''}"
          style="--row: {i}"
          aria-current={state === "active" ? "step" : undefined}
        >
          <span
            class="flex size-5 shrink-0 items-center justify-center rounded-full transition-colors duration-300 {state === 'done'
              ? 'bg-[color:color-mix(in_oklab,var(--solus-accent)_14%,transparent)] text-(--solus-accent)'
              : state === 'active'
                ? 'text-(--solus-accent)'
                : 'border border-dashed border-[color:color-mix(in_oklch,var(--foreground)_18%,transparent)]'}"
          >
            {#if state === "done"}
              <CheckIcon size={12} strokeWidth={2.5} />
            {:else if state === "active"}
              <SpinnerIcon size={14} class="animate-spin motion-reduce:animate-none" />
            {/if}
          </span>
          <span
            class="min-w-0 flex-1 truncate transition-colors duration-300 {state === 'active'
              ? 'font-medium text-foreground'
              : state === 'done'
                ? 'text-muted-foreground'
                : 'text-muted-foreground/60'}"
          >
            {s.label}
          </span>
          <span class="shrink-0 text-xs tabular-nums text-muted-foreground/60">{i + 1}/{copy.steps.length}</span>
        </li>
      {/each}
    </ol>

    {#if onCancel}
      <Button variant="ghost" size="xs" class="mt-4 text-muted-foreground" onclick={onCancel}>
        Cancel
      </Button>
    {/if}
  </div>
</div>

<style>
  /* The screen fades up on mount, then its steps stagger in — so the loading
     screen resolves rather than snapping into place. Each step then follows
     the host's generation state. */
  .prog-card {
    animation: prog-card-in 0.3s ease-out backwards;
  }
  .prog-steps > :global(li) {
    animation: prog-row-in 0.32s ease-out backwards;
    /* one row per ~70ms, sequenced off the inline --row index */
    animation-delay: calc(0.1s + var(--row) * 0.07s);
  }

  @keyframes prog-card-in {
    from {
      opacity: 0;
      transform: translateY(0.375rem);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  @keyframes prog-row-in {
    from {
      opacity: 0;
      transform: translateY(0.25rem);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .prog-card,
    .prog-steps > :global(li) {
      animation: none;
    }
  }
</style>
