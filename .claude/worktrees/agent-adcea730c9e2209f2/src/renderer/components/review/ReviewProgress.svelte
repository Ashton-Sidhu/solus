<script lang="ts">
  import { CheckIcon, CircleIcon, SpinnerGapIcon } from "phosphor-svelte";
  import {
    REVIEW_PROGRESS_STEPS,
    type ReviewProgressStep,
  } from "../../../shared/review";

  // Stepped indicator shown while a review companion generates, in place of the
  // bare spinner. `step` drives which row is active.
  let { step }: { step: ReviewProgressStep } = $props();

  const steps = REVIEW_PROGRESS_STEPS;
  const activeIndex = $derived(Math.max(0, steps.findIndex((s) => s.id === step)));
  const pct = $derived(((activeIndex + 1) / steps.length) * 100);
</script>

<div class="flex h-full items-center justify-center px-6">
  <div class="prog-card w-full max-w-[17rem]">
    <div class="mb-5 h-1 overflow-hidden rounded-full bg-(--solus-accent-soft)">
      <div
        class="h-full rounded-full bg-(--solus-accent) transition-[width] duration-500 ease-out motion-reduce:transition-none"
        style="width: {pct}%"
      ></div>
    </div>

    <ul class="prog-steps flex flex-col gap-3" role="list">
      {#each steps as s, i (s.id)}
        {@const state = i < activeIndex ? "done" : i === activeIndex ? "active" : "pending"}
        <li class="flex items-start gap-2.5" style="--row: {i}">
          <span
            class="mt-px flex size-4 shrink-0 items-center justify-center {state ===
            'pending'
              ? 'text-(--solus-text-tertiary)'
              : 'text-(--solus-accent)'}"
          >
            {#if state === "done"}
              <CheckIcon size={14} weight="bold" />
            {:else if state === "active"}
              <span class="animate-spin motion-reduce:animate-none">
                <SpinnerGapIcon size={14} weight="bold" />
              </span>
            {:else}
              <CircleIcon size={7} weight="fill" class="opacity-40" />
            {/if}
          </span>

          <div class="flex min-w-0 flex-col">
            <span
              class="text-[0.8125rem] leading-4 transition-colors {state === 'active'
                ? 'font-medium text-(--solus-text-primary)'
                : state === 'done'
                  ? 'text-(--solus-text-secondary)'
                  : 'text-(--solus-text-tertiary)'}"
            >
              {s.label}
            </span>
          </div>
        </li>
      {/each}
    </ul>
  </div>
</div>

<style>
  /* The generation state fades up on mount, then its steps stagger in — so the
     guide's loading screen resolves rather than snapping into place. The bar
     width keeps animating as steps advance (handled inline above). */
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
