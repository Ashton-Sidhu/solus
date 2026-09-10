<script lang="ts">
  import { Check as CheckIcon, Circle as CircleIcon, LoaderCircle as SpinnerGapIcon } from "@lucide/svelte";
  import {
    REVIEW_PROGRESS_STEPS,
    type ReviewProgressStep,
  } from "@solus/contracts/review";

  import { Button } from "../ui/button";

  // Stepped indicator shown while a review companion generates, in place of the
  // bare spinner. `step` drives which row is active.
  let { step, queued = false, onCancel }: { step: ReviewProgressStep; queued?: boolean; onCancel?: () => void } = $props();

  const steps = REVIEW_PROGRESS_STEPS;
  const activeIndex = $derived(Math.max(0, steps.findIndex((s) => s.id === step)));

</script>

<div class="flex h-full items-center justify-center px-6">
  <div class="prog-card w-full max-w-[17rem]">
    <p role="status" class="mb-5 text-sm font-medium">{queued ? "Guide queued" : steps[activeIndex].label}</p>
    {#if queued}
      <p class="text-sm text-muted-foreground">Generation will start when the review companion is available.</p>
    {:else}
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
              class="text-sm leading-4 transition-colors {state === 'active'
                ? 'font-medium text-(--solus-text-primary)'
                : state === 'done'
                  ? 'font-secondary text-(--solus-text-secondary)'
                  : 'text-(--solus-text-tertiary)'}"
            >
              {s.label}
            </span>
          </div>
        </li>
      {/each}
    </ul>
    {/if}
    {#if onCancel}<Button variant="ghost" class="mt-5" onclick={onCancel}>Cancel generation</Button>{/if}
  </div>
</div>

<style>
  /* The generation state fades up on mount, then its steps stagger in — so the
     guide's loading screen resolves rather than snapping into place. Each step follows the host generation state. */
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
