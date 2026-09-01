<script lang="ts">
  import {
    Check as CheckIcon,
    Minus as MinusIcon,
  } from "@lucide/svelte";
  import type { SessionProgress } from "@solus/contracts/types";
  import * as Popover from "../ui/popover";
  import { buildSessionProgressRing } from "./lib/session-progress-ring";

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

  let stepsLeft = $derived(
    progress.todos.filter((t) => t.status !== "completed").length,
  );

  let iconRing = $derived(buildSessionProgressRing(progress));

  let stepsListEl: HTMLUListElement | null = $state(null);
  $effect(() => {
    if (!stepsOpen || !stepsListEl) return;
    requestAnimationFrame(() => {
      stepsListEl
        ?.querySelector("[data-active-step]")
        ?.scrollIntoView({ block: "nearest" });
    });
  });
</script>

{#snippet progressRing(fraction: number)}
  <span class="size-[calc(1.3rem*var(--orb-scale))] shrink-0" aria-hidden="true">
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
    class="flex size-[calc(1.3rem*var(--orb-scale))] shrink-0 items-center justify-center rounded-full bg-primary/15"
    aria-hidden="true"
  >
    <CheckIcon
      class="size-[calc(0.82rem*var(--orb-scale))] text-primary"
      weight="bold"
    />
  </span>
{/snippet}

{#snippet dashedDot()}
  <span
    class="size-[calc(1.3rem*var(--orb-scale))] shrink-0 rounded-full border border-dashed border-muted-foreground/45"
    aria-hidden="true"
  ></span>
{/snippet}

<Popover.Root bind:open={stepsOpen}>
  <Popover.Content
    class="progress-popover flex w-[min(calc(34rem*var(--orb-scale)),calc(100vw-1.5rem))] max-h-[calc(100vh-8rem)] flex-col gap-0 p-0 [--pop-body-size:calc(0.875rem * var(--orb-scale))] [--pop-title-size:calc(0.875rem * var(--orb-scale))]"
    side="top"
    sideOffset={8}
    style={`--orb-scale: calc(var(--solus-font-scale, 1) * ${orbScreenScale})`}
    role="group"
    aria-label="Task steps"
  >
    <div
      class="flex shrink-0 items-center gap-[calc(0.5rem*var(--orb-scale))] border-b border-border/30 px-[calc(1rem*var(--orb-scale))] py-[calc(0.6875rem*var(--orb-scale))]"
    >
      {#if stepsLeft === 0}
        {@render checkDot()}
      {:else}
        {@render progressRing(progressFraction)}
      {/if}
      <span
        class="min-w-0 flex-1 truncate text-[length:var(--pop-title-size)] font-medium text-foreground"
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
    <ul
      bind:this={stepsListEl}
      class="m-0 flex min-h-0 flex-1 list-none flex-col gap-[calc(0.125rem*var(--orb-scale))] overflow-y-auto overscroll-contain px-[calc(0.625rem*var(--orb-scale))] py-[calc(0.5rem*var(--orb-scale))]"
      role="list"
    >
      {#each progress.todos as todo, i (i)}
        <li
          class="flex scroll-my-[calc(0.5rem*var(--orb-scale))] items-start gap-[calc(0.625rem*var(--orb-scale))] rounded-[calc(0.75rem*var(--orb-scale))] border px-[calc(0.625rem*var(--orb-scale))] py-[calc(0.5rem*var(--orb-scale))] {todo.status ===
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
            class="min-w-0 flex-1 [overflow-wrap:anywhere] text-[length:var(--pop-body-size)] leading-[1.5] {todo.status ===
            'completed'
              ? 'text-muted-foreground line-through opacity-70'
              : todo.status === 'in_progress'
                ? 'font-medium text-foreground'
                : 'font-normal text-[var(--solus-text-secondary)]'}"
            >{todo.content}</span
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
        class:progress-toggle-done={progressAllDone}
        style="--progress:{progressFraction};--item-index:-1"
        tabindex={expanded ? 0 : -1}
        aria-label={`Progress: step ${progress.currentStep} of ${progress.totalSteps}`}
      >
        <span
          class="pt-fill {isRunning && !progressAllDone ? 'pt-fill-live' : ''}"
          aria-hidden="true"
        ></span>
        <span class="pt-dial" data-mode={iconRing.mode} aria-hidden="true">
          <svg class="pt-svg" viewBox="0 0 36 36">
            {#each iconRing.segments as segment, index (`${iconRing.mode}-${index}`)}
              <circle
                class="pt-segment pt-segment-{segment.state} {segment.state ===
                  'in_progress' &&
                isRunning &&
                !progressAllDone
                  ? 'pt-segment-live'
                  : ''}"
                cx="18"
                cy="18"
                r="16.5"
                pathLength="100"
                stroke-dasharray={`${segment.length} ${100 - segment.length}`}
                stroke-dashoffset={-segment.start}
              />
            {/each}
          </svg>
          <span class="pt-glyph">
            <CheckIcon class="pt-glyph-icon" />
          </span>
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
  .progress-toggle-done {
    opacity: 0.9;
  }
  .progress-toggle-done:hover {
    opacity: 1;
  }
  /* Completed → the fill (pill) and ring (circle) shift to the success green. */
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
  .progress-toggle-done .pt-dial {
    background: linear-gradient(
      90deg,
      color-mix(in srgb, var(--solus-status-complete) 11%, transparent) 0%,
      color-mix(in srgb, var(--solus-status-complete) 19%, transparent) 100%
    );
  }
  .progress-toggle-done .pt-dial .pt-svg {
    display: none;
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
  /* Short tasks show one arc per step. Longer tasks use the same continuous
     summary as the session sidebar so the icon stays calm at small sizes. */
  .pt-svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    transform: rotate(-90deg);
  }
  .pt-segment {
    fill: none;
    stroke-width: 2.75;
    stroke-linecap: round;
    transition:
      stroke 0.18s ease,
      stroke-width 0.18s ease,
      stroke-dasharray 0.7s cubic-bezier(0.16, 1, 0.3, 1),
      stroke-dashoffset 0.7s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .pt-segment-pending {
    stroke: color-mix(in srgb, var(--solus-text-tertiary) 28%, transparent);
  }
  .pt-segment-completed {
    stroke: var(--solus-status-complete);
    opacity: 0.9;
  }
  .pt-segment-in_progress {
    stroke: var(--solus-status-running);
    stroke-width: 3.25;
  }
  .pt-dial[data-mode="continuous"] .pt-segment {
    stroke-linecap: butt;
  }
  .pt-dial[data-mode="continuous"] .pt-segment-in_progress {
    stroke-linecap: round;
  }
  .pt-glyph {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--solus-text-tertiary);
    opacity: 0.52;
    transition:
      color 0.18s ease,
      opacity 0.18s ease;
  }
  .pt-glyph :global(.pt-glyph-icon) {
    width: calc(0.9688rem * var(--orb-scale));
    height: calc(0.9688rem * var(--orb-scale));
  }
  .progress-toggle-done .pt-glyph {
    color: var(--solus-status-complete);
    opacity: 1;
  }
  .pt-sep {
    margin: 0 0.0313rem;
    color: var(--solus-text-tertiary);
  }
  .pt-segment-live {
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
    font-size: calc(0.75rem * var(--orb-scale));
    font-weight: 500;
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
