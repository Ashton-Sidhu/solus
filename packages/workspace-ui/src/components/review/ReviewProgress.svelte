<script lang="ts">
  import { Check as CheckIcon, LoaderCircle as SpinnerIcon } from "@lucide/svelte";
  import {
    REVIEW_PROGRESS_STEPS,
    type ReviewProgressStep,
  } from "@solus/contracts/review";

  import { Button } from "../ui/button";
  import ReviewGuideGlyph from "./ReviewGuideGlyph.svelte";

  // Stepped indicator shown while a review companion generates, in place of the
  // bare spinner. `step` drives which row is active. It stands in the same
  // canvas as the guide's empty offer, so it wears the same shape: one
  // medallion, one headline, one line of copy, one action.
  let { step, queued = false, onCancel }: { step: ReviewProgressStep; queued?: boolean; onCancel?: () => void } = $props();

  const steps = REVIEW_PROGRESS_STEPS;
  const activeIndex = $derived(Math.max(0, steps.findIndex((s) => s.id === step)));
</script>

<!-- The chrome rung, not the surface's prose size: this is a state screen, and
     it steps down with the rail and the notices on a laptop display. -->
<div class="flex min-h-0 flex-1 items-center justify-center overflow-auto px-[clamp(20px,2.6cqi,56px)] py-10 text-workspace-chrome">
  <div class="prog-card flex max-w-[520px] flex-col items-center text-center">
    <!-- The same neutral medallion the empty offer uses, so generating reads as
         the next beat of that state rather than a different screen. -->
    <span
      class="flex size-[44px] shrink-0 items-center justify-center rounded-2xl bg-[color:color-mix(in_oklab,var(--muted)_70%,transparent)] text-muted-foreground [.is-laptop-display_&]:size-10"
      aria-hidden="true"
    >
      <ReviewGuideGlyph size={20} />
    </span>

    <h2 role="status" class="mt-4 font-medium">
      {queued ? "Guide queued" : steps[activeIndex].label}
    </h2>

    <p class="mt-2 leading-[1.7] text-pretty text-muted-foreground">
      {queued
        ? "Generation will start when the review companion is available."
        : "The review companion is reading the diff and writing the guide."}
    </p>

    {#if !queued}
      <ul class="prog-steps mt-5 flex flex-col items-start gap-2.5 text-left" role="list">
        {#each steps as s, i (s.id)}
          {@const state = i < activeIndex ? "done" : i === activeIndex ? "active" : "pending"}
          <li class="flex items-center gap-2.5" style="--row: {i}">
            <span class="flex size-4 shrink-0 items-center justify-center">
              {#if state === "done"}
                <CheckIcon size={14} class="text-muted-foreground" />
              {:else if state === "active"}
                <SpinnerIcon
                  size={14}
                  class="animate-spin text-(--solus-accent) motion-reduce:animate-none"
                />
              {:else}
                <span class="size-1.5 rounded-full bg-current text-muted-foreground opacity-40"></span>
              {/if}
            </span>

            <span
              class="transition-colors {state === 'active'
                ? 'font-medium text-foreground'
                : state === 'done'
                  ? 'text-muted-foreground'
                  : 'text-muted-foreground/60'}"
            >
              {s.label}
            </span>
          </li>
        {/each}
      </ul>
    {/if}

    {#if onCancel}
      <Button
        type="button"
        class="mt-5 inline-flex h-[34px] cursor-pointer items-center rounded-lg border-0 bg-muted px-3 font-medium text-muted-foreground transition-colors hover:text-foreground pointer-fine:[.is-laptop-display_&]:h-[30px]"
        onclick={onCancel}
      >
        Cancel generation
      </Button>
    {/if}
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
