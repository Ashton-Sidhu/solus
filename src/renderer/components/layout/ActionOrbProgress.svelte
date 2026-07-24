<script lang="ts">
  import { CheckIcon, MinusIcon } from "phosphor-svelte";
  import type { SessionProgress } from "../../../shared/types";
  import * as Popover from "../ui/popover";

  interface Props {
    progress: SessionProgress;
    isRunning: boolean;
    progressAllDone: boolean;
    progressFraction: number;
    progressHeader: string | null;
    stepsOpen: boolean;
    expanded: boolean;
    orbScreenScale: string;
  }

  let {
    progress,
    isRunning,
    progressAllDone,
    progressFraction,
    progressHeader,
    stepsOpen = $bindable(),
    expanded,
    orbScreenScale,
  }: Props = $props();

  function scrollToActiveStep(node: HTMLElement) {
    node
      .querySelector("[data-active-step]")
      ?.scrollIntoView({ block: "nearest" });
  }

  let stepsLeft = $derived(
    progress.todos.filter((t) => t.status !== "completed").length,
  );

  let stepsContentEl: HTMLDivElement | null = $state(null);
  $effect(() => {
    if (!stepsOpen || !stepsContentEl) return;
    requestAnimationFrame(() => {
      if (stepsContentEl) scrollToActiveStep(stepsContentEl);
    });
  });
</script>

{#snippet progressRing(fraction: number)}
  <span class="size-[calc(1.15rem*var(--orb-scale))] shrink-0" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none" class="size-full -rotate-90">
      <circle cx="12" cy="12" r="9" stroke-width="2.5" class="stroke-primary/20" />
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke-width="2.5"
        stroke-linecap="round"
        pathLength="100"
        stroke-dasharray="100"
        class="stroke-primary [transition:stroke-dashoffset_0.5s_cubic-bezier(0.16,1,0.3,1)]"
        style="stroke-dashoffset:{100 - Math.max(0, Math.min(1, fraction)) * 100}"
      />
    </svg>
  </span>
{/snippet}

{#snippet checkDot()}
  <span
    class="flex size-[calc(1.15rem*var(--orb-scale))] shrink-0 items-center justify-center rounded-full bg-primary/15"
    aria-hidden="true"
  >
    <CheckIcon
      class="size-[calc(0.72rem*var(--orb-scale))] text-primary"
      weight="bold"
    />
  </span>
{/snippet}

{#snippet dashedDot()}
  <span
    class="size-[calc(1.15rem*var(--orb-scale))] shrink-0 rounded-full border border-dashed border-muted-foreground/45"
    aria-hidden="true"
  ></span>
{/snippet}

<Popover.Root bind:open={stepsOpen}>
  <Popover.Content
    bind:ref={stepsContentEl}
    class="progress-popover w-[min(calc(30rem*var(--orb-scale)),calc(100vw-1.5rem))] max-h-[min(calc(22rem*var(--orb-scale)),60vh)] gap-0 overflow-y-auto px-[calc(1rem*var(--orb-scale))] pt-[calc(0.875rem*var(--orb-scale))] pb-[calc(0.375rem*var(--orb-scale))] [scrollbar-width:thin]"
    side="top"
    sideOffset={8}
    style={`--orb-scale: calc(var(--solus-font-scale, 1) * ${orbScreenScale})`}
    role="group"
    aria-label="Task steps"
  >
    <div
      class="mb-[calc(0.4375rem*var(--orb-scale))] flex items-center gap-[calc(0.5rem*var(--orb-scale))]"
    >
      {#if stepsLeft === 0}
        {@render checkDot()}
      {:else}
        {@render progressRing(progressFraction)}
      {/if}
      <span
        class="min-w-0 flex-1 truncate text-[length:var(--pop-title-size)] font-semibold text-foreground"
      >
        {#if stepsLeft > 0}
          {stepsLeft} step{stepsLeft === 1 ? "" : "s"} left
        {:else}
          All steps done
        {/if}
      </span>
      <button
        class="flex size-[calc(1.5rem*var(--orb-scale))] shrink-0 items-center justify-center rounded-[calc(0.5rem*var(--orb-scale))] border border-border/40 bg-muted-foreground/[0.08] text-muted-foreground transition-colors hover:bg-muted-foreground/15 hover:text-foreground"
        onclick={() => (stepsOpen = false)}
        aria-label="Collapse steps"
      >
        <MinusIcon
          class="size-[calc(0.875rem*var(--orb-scale))]"
          weight="bold"
        />
      </button>
    </div>
    <ul class="m-0 flex list-none flex-col gap-[calc(0.125rem*var(--orb-scale))] p-0" role="list">
      {#each progress.todos as todo, i (i)}
        <li
          class="flex items-center gap-[calc(0.625rem*var(--orb-scale))] rounded-[calc(0.75rem*var(--orb-scale))] border px-[calc(0.5rem*var(--orb-scale))] py-[calc(0.4375rem*var(--orb-scale))] {todo.status ===
          'in_progress'
            ? 'border-primary/30 bg-primary/[0.07] dark:border-primary/40 dark:bg-primary/10'
            : 'border-transparent'}"
          data-active-step={todo.status === "in_progress" ? "" : undefined}
        >
          {#if todo.status === "completed"}
            {@render checkDot()}
          {:else if todo.status === "in_progress"}
            {@render progressRing(progressFraction)}
          {:else}
            {@render dashedDot()}
          {/if}
          <span
            class="min-w-0 flex-1 truncate text-[length:var(--pop-body-size)] {todo.status ===
            'completed'
              ? 'text-muted-foreground line-through opacity-70'
              : todo.status === 'in_progress'
                ? 'font-medium text-foreground'
                : 'font-normal text-[var(--solus-text-secondary)]'}"
            title={todo.content}>{todo.content}</span
          >
        </li>
      {/each}
    </ul>
  </Popover.Content>

  <Popover.Trigger openOnHover openDelay={0} closeDelay={120}>
    {#snippet child({ props })}
      <button
        {...props}
        class="progress-toggle stagger-item"
        class:progress-toggle-active={stepsOpen}
        class:progress-toggle-done={progressAllDone}
        style="--progress:{progressFraction};--item-index:-1"
        tabindex={expanded ? 0 : -1}
        aria-label={`Progress: step ${progress.currentStep} of ${progress.totalSteps}`}
      >
        <span
          class="pt-fill {isRunning && !progressAllDone ? 'pt-fill-live' : ''}"
          aria-hidden="true"
        ></span>
        <span class="pt-dial" aria-hidden="true">
          <svg class="pt-svg" viewBox="0 0 36 36">
            <circle class="pt-track" cx="18" cy="18" r="16.5" />
            <circle
              class="pt-arc {isRunning && !progressAllDone ? 'pt-arc-live' : ''}"
              cx="18"
              cy="18"
              r="16.5"
              pathLength="100"
              stroke-dasharray="100"
              style="stroke-dashoffset:{100 - progressFraction * 100}"
            />
          </svg>
          <span class="pt-count tabular-nums"
            >{progress.currentStep}<span class="pt-sep">/</span>{progress.totalSteps}</span
          >
        </span>
        <span class="pt-text">
          <span class="pt-count-text tabular-nums"
            >{progress.currentStep}<span class="pt-sep">/</span>{progress.totalSteps}</span
          >
          {#if progressHeader}
            <span class="pt-label">{progressHeader}</span>
          {/if}
        </span>
      </button>
    {/snippet}
  </Popover.Trigger>
</Popover.Root>

<style>
  .progress-toggle {
    position: relative;
    overflow: hidden;
    display: inline-flex;
    align-items: center;
    gap: calc(0.4375rem * var(--orb-scale));
    min-height: var(--orb-btn-min);
    padding: 0 calc(0.75rem * var(--orb-scale));
    border-radius: 624.9375rem;
    border: 0.0313rem solid
      color-mix(in srgb, var(--solus-container-border) 45%, transparent);
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--solus-container-bg) 22%, transparent) 0%,
      color-mix(in srgb, var(--solus-container-bg) 16%, transparent) 100%
    );
    backdrop-filter: blur(1.25rem) saturate(1.8);
    -webkit-backdrop-filter: blur(1.25rem) saturate(1.8);
    box-shadow:
      inset 0 0.0625rem 0 0 color-mix(in srgb, white 8%, transparent),
      0 0.125rem 0.375rem rgba(0, 0, 0, 0.06);
    cursor: pointer;
    transition:
      box-shadow 0.15s ease,
      border-color 0.15s ease,
      transform 0.15s cubic-bezier(0.16, 1, 0.3, 1);
  }
  :global(.dark) .progress-toggle {
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--solus-container-bg) 26%, transparent) 0%,
      color-mix(in srgb, var(--solus-container-bg) 18%, transparent) 100%
    );
    border: 0.0313rem solid color-mix(in srgb, white 8%, transparent);
    box-shadow:
      inset 0 0.0625rem 0 0 color-mix(in srgb, white 4%, transparent),
      0 0.125rem 0.375rem rgba(0, 0, 0, 0.2);
  }
  .progress-toggle:hover {
    box-shadow:
      inset 0 0.0625rem 0 0 color-mix(in srgb, white 10%, transparent),
      0 0.125rem 0.5rem rgba(0, 0, 0, 0.1);
  }
  .progress-toggle:active {
    transform: scale(0.96);
  }
  .progress-toggle:focus-visible {
    outline: none;
    box-shadow:
      inset 0 0.0625rem 0 0 color-mix(in srgb, white 10%, transparent),
      0 0 0 0.1875rem color-mix(in srgb, var(--solus-accent) 18%, transparent);
  }
  .progress-toggle-active {
    border-color: color-mix(in srgb, var(--solus-accent) 24%, transparent);
  }
  .progress-toggle-done {
    opacity: 0.9;
  }
  .progress-toggle-done:hover {
    opacity: 1;
  }
  /* Completed → the fill (pill) and ring (circle) shift to the success green. */
  .progress-toggle-done .pt-arc {
    stroke: var(--solus-status-complete);
  }
  .progress-toggle-done .pt-fill {
    background: linear-gradient(
      90deg,
      color-mix(in srgb, var(--solus-status-complete) 11%, transparent) 0%,
      color-mix(in srgb, var(--solus-status-complete) 19%, transparent) 100%
    );
    border-right-color: color-mix(
      in srgb,
      var(--solus-status-complete) 32%,
      transparent
    );
  }
  .pt-fill {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 100%;
    transform-origin: left center;
    transform: scaleX(var(--progress, 0));
    background: linear-gradient(
      90deg,
      color-mix(in srgb, var(--solus-accent) 9%, transparent) 0%,
      color-mix(in srgb, var(--solus-accent) 16%, transparent) 100%
    );
    border-right: 0.0313rem solid
      color-mix(in srgb, var(--solus-accent) 28%, transparent);
    transition: transform 0.7s cubic-bezier(0.16, 1, 0.3, 1);
    pointer-events: none;
  }
  .pt-fill-live::after {
    content: "";
    position: absolute;
    inset: 0;
    background: linear-gradient(
      90deg,
      transparent 0%,
      color-mix(in srgb, var(--solus-accent) 18%, transparent) 50%,
      transparent 100%
    );
    background-size: 200% 100%;
    animation: pbi-flow 2.6s ease-in-out infinite;
  }
  .pt-dial {
    display: none;
    position: relative;
    flex-shrink: 0;
    width: calc(1.75rem * var(--orb-scale));
    height: calc(1.75rem * var(--orb-scale));
  }
  /* Smooth anti-aliased stroke ring (round caps) — matches the elegance of the
     pill's horizontal fill, where a masked conic gradient read as jagged. */
  .pt-svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    transform: rotate(-90deg);
  }
  .pt-track {
    fill: none;
    stroke: color-mix(in srgb, var(--solus-text-tertiary) 16%, transparent);
    stroke-width: 2.75;
  }
  .pt-arc {
    fill: none;
    stroke: color-mix(in srgb, var(--solus-accent) 85%, transparent);
    stroke-width: 2.75;
    stroke-linecap: round;
    transition: stroke-dashoffset 0.7s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .pt-count {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: calc(0.5469rem * var(--orb-scale));
    font-weight: 600;
    line-height: 1;
    color: var(--solus-text-secondary);
  }
  .pt-sep {
    margin: 0 0.0313rem;
    color: var(--solus-text-tertiary);
  }
  .pt-arc-live {
    animation: ring-glow 2.6s ease-in-out infinite;
  }
  @keyframes ring-glow {
    0%, 100% { opacity: 0.85; }
    50% { opacity: 1; }
  }
  .pt-text {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: calc(0.4375rem * var(--orb-scale));
    min-width: 0;
  }
  .pt-count-text {
    flex-shrink: 0;
    font-size: calc(0.6563rem * var(--orb-scale));
    font-weight: 600;
    line-height: 1;
    color: var(--solus-text-secondary);
  }
  .pt-label {
    max-width: calc(9rem * var(--orb-scale));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--orb-btn-font);
    font-weight: 500;
    color: var(--solus-text-secondary);
  }
  :global(.compact) .pt-fill,
  :global(.pill-mode) .pt-fill,
  :global(.compact) .pt-text,
  :global(.pill-mode) .pt-text {
    display: none;
  }
  /* Circle form: the dial fills the whole button so the ring reads as a border
     hugging the edge, rather than a small disc floating inside. */
  :global(.compact) .pt-dial,
  :global(.pill-mode) .pt-dial {
    display: block;
    position: absolute;
    inset: 0;
    width: auto;
    height: auto;
  }
  :global(.compact) .progress-toggle,
  :global(.pill-mode) .progress-toggle {
    width: var(--orb-btn-min);
    height: var(--orb-btn-min);
    padding: 0;
    gap: 0;
  }
  @keyframes pbi-flow {
    0% { background-position: -50% 0; }
    100% { background-position: 150% 0; }
  }
</style>
