<script lang="ts">
  import {
    Check as CheckIcon,
    Minus as MinusIcon,
  } from "@lucide/svelte";
  import type { SessionProgress } from "@solus/contracts/types";
  import * as Popover from "../ui/popover";
  import { PAGE_SOFT_ICON_BTN } from "../../lib/page-chrome";
  import { buildSessionProgressRing } from "./lib/session-progress-ring";

  interface Props {
    progress: SessionProgress;
    isRunning: boolean;
    progressAllDone: boolean;
    progressFraction: number;
    progressHeader: string | null;
    stepsOpen: boolean;
  }

  let {
    progress,
    isRunning,
    progressAllDone,
    progressFraction,
    progressHeader,
    stepsOpen = $bindable(),
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
  <span class="size-[calc(1.3rem*var(--action-scale))] shrink-0" aria-hidden="true">
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
    class="flex size-[calc(1.3rem*var(--action-scale))] shrink-0 items-center justify-center rounded-full bg-primary/15"
    aria-hidden="true"
  >
    <CheckIcon
      class="size-[calc(0.82rem*var(--action-scale))] text-primary"
      weight="bold"
    />
  </span>
{/snippet}

{#snippet dashedDot()}
  <span
    class="size-[calc(1.3rem*var(--action-scale))] shrink-0 rounded-full border border-dashed border-muted-foreground/45"
    aria-hidden="true"
  ></span>
{/snippet}

<Popover.Root bind:open={stepsOpen}>
  <Popover.Content
    class="progress-popover flex w-[min(calc(34rem*var(--action-scale)),calc(100vw-1.5rem))] max-h-[calc(100vh-8rem)] flex-col gap-0 p-0 [--pop-body-size:calc(0.875rem * var(--action-scale))] [--pop-title-size:calc(0.875rem * var(--action-scale))]"
    side="top"
    sideOffset={8}
    role="group"
    aria-label="Task steps"
  >
    <div
      class="flex shrink-0 items-center gap-[calc(0.5rem*var(--action-scale))] border-b border-border/30 px-[calc(1rem*var(--action-scale))] py-[calc(0.6875rem*var(--action-scale))]"
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
        class="flex size-[calc(1.5rem*var(--action-scale))] shrink-0 items-center justify-center rounded-[calc(0.5rem*var(--action-scale))] border border-border/40 bg-muted-foreground/[0.08] text-muted-foreground transition-colors hover:bg-muted-foreground/15 hover:text-foreground"
        onclick={() => (stepsOpen = false)}
        aria-label="Collapse steps"
      >
        <MinusIcon
          class="size-[calc(0.875rem*var(--action-scale))]"
          weight="bold"
        />
      </button>
    </div>
    <ul
      bind:this={stepsListEl}
      class="m-0 flex min-h-0 flex-1 list-none flex-col gap-[calc(0.125rem*var(--action-scale))] overflow-y-auto overscroll-contain px-[calc(0.625rem*var(--action-scale))] py-[calc(0.5rem*var(--action-scale))]"
      role="list"
    >
      {#each progress.todos as todo, i (i)}
        <li
          class="flex scroll-my-[calc(0.5rem*var(--action-scale))] items-start gap-[calc(0.625rem*var(--action-scale))] rounded-[calc(0.75rem*var(--action-scale))] border px-[calc(0.625rem*var(--action-scale))] py-[calc(0.5rem*var(--action-scale))] {todo.status ===
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
      <!-- The page header's window-control circle, like the review
           suggestion: the ring is the progress, and hovering opens the steps. -->
      <button
        {...props}
        class="{PAGE_SOFT_ICON_BTN} progress-toggle relative p-0 after:absolute after:-inset-x-0.5 after:-inset-y-2 after:content-['']"
        class:progress-toggle-done={progressAllDone}
        aria-label={`Progress: step ${progress.currentStep} of ${progress.totalSteps}${progressHeader ? ` — ${progressHeader}` : ""}`}
      >
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
      </button>
    {/snippet}
  </Popover.Trigger>
</Popover.Root>

<style>
  .progress-toggle-done {
    opacity: 0.9;
  }
  .progress-toggle-done:hover {
    opacity: 1;
  }
  /* Completed → the ring gives way to a success-green disc. */
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
  .pt-dial {
    position: absolute;
    inset: 0;
    border-radius: 9999px;
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
    width: calc(0.9688rem * var(--action-scale));
    height: calc(0.9688rem * var(--action-scale));
  }
  .progress-toggle-done .pt-glyph {
    color: var(--solus-status-complete);
    opacity: 1;
  }
  .pt-segment-live {
    animation: ring-glow 2.6s ease-in-out infinite;
  }
  @keyframes ring-glow {
    0%, 100% { opacity: 0.85; }
    50% { opacity: 1; }
  }
</style>
