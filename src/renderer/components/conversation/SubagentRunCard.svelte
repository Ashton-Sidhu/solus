<script lang="ts">
  import { getWorkspaceContext } from "../../contexts";
  import { formatActivityDuration } from "./lib/activity-summary";
  import {
    seamSegments,
    stepsFigure,
    subagentTargetPath,
  } from "./lib/subagent-card";
  import type { SubagentRow } from "./lib/subagent-group";

  /**
   * §3a — a subagent while it runs, and when it dies. An instrument, not a widget:
   * the task leads, the step in flight sits under it, the rail is machine facts
   * separated by hairline rules, and the step meter is a seam across the bottom
   * edge where a progress bar can't be mistaken for content.
   *
   * State changes the glyph, the ring and one segment — never the geometry — so a
   * row switching state doesn't reflow the thread.
   */
  interface Props {
    row: SubagentRow;
    tabId: string;
  }
  let { row, tabId }: Props = $props();

  const session = getWorkspaceContext();
  const router = session.router;

  const seam = $derived(seamSegments(row.steps, row.state));
  const steps = $derived(stepsFigure(row.steps));
  const path = $derived(subagentTargetPath(row.target));
  const elapsed = $derived(formatActivityDuration(row.elapsedMs));
  const failed = $derived(row.state === "failed");
  // A fraction with no noun next to a moving clock reads as a hang, so a plan-less
  // agent that hasn't called a tool yet prints nothing rather than a bare zero.
  const hasSteps = $derived(row.steps.total > 0 || row.steps.done > 0);
  const isOpen = $derived(
    router.overlay?.name === "subagent" && router.overlay.params.messageId === row.id,
  );
</script>

<section
  class="run-card mx-auto w-[88%] overflow-hidden rounded-2xl bg-(--solus-tx-card-bg)"
  class:is-failed={failed}
  class:is-open={isOpen}
  aria-label="Sub-agent"
  data-testid="subagent-group"
>
  <button
    type="button"
    class="flex w-full cursor-pointer items-center gap-3.5 border-none bg-transparent pt-3 pr-3.5 pb-[0.8125rem] pl-4 text-left"
    aria-label={`${row.name}, ${row.activity}`}
    aria-current={isOpen ? "true" : undefined}
    data-testid="subagent-card"
    data-state={row.state}
    onclick={() => session.openSubagent(tabId, row.id)}
  >
    {#if failed}
      <span
        class="relative flex h-[0.9375rem] w-[0.9375rem] shrink-0 items-center justify-center"
        aria-hidden="true"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="var(--destructive)"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          ><path d="M3.6 3.6l4.8 4.8M8.4 3.6l-4.8 4.8" /></svg
        >
      </span>
    {/if}
    <span class="min-w-0 max-w-[27.5rem]">
      <span
        class="block truncate text-[0.84375rem] leading-[1.25] font-semibold tracking-[-0.014em]"
        >{row.name}</span
      >
      <!-- One slot, not a fixed field: the live tool while it runs, the reason it
           stopped when it failed. -->
      {#if failed}
        <span
          class="mt-[0.1875rem] block truncate font-mono text-[0.6875rem] leading-[1.4] text-(--muted-foreground) opacity-80"
          >{row.activity}</span
        >
      {:else}
        <span class="mt-[0.1875rem] flex items-baseline gap-[0.4375rem]">
          <span
            class="run-card__shim shrink-0 text-[0.6875rem] font-medium tracking-[0.01em]"
            >{row.activity}</span
          >
          {#if path.file}
            <span
              class="truncate font-mono text-[0.6875rem] text-(--muted-foreground) opacity-80"
              >{#if path.dir}<span class="opacity-55">{path.dir}</span
                >{/if}{path.file}</span
            >
          {/if}
        </span>
      {/if}
    </span>

    <span class="flex-1"></span>

    <span class="flex shrink-0 items-baseline gap-[0.6875rem]">
      {#if hasSteps}
        <span
          class="font-mono text-[0.71875rem] tracking-[-0.01em] tabular-nums"
          ><span class="opacity-95">{steps.done}</span><span
            class="text-(--muted-foreground) opacity-50">{steps.total}</span
          ></span
        >
        <span
          class="h-[0.6875rem] w-px bg-[color-mix(in_oklch,var(--foreground)_11%,transparent)]"
          aria-hidden="true"
        ></span>
      {/if}
      <!-- Locked to its own box so ticking digits never nudge the rail. -->
      <span
        class="w-[3.25rem] text-right font-mono text-[0.71875rem] text-(--muted-foreground) tabular-nums opacity-[0.72]"
        >{elapsed}</span
      >
      {#if row.meta}
        <span
          class="h-[0.6875rem] w-px bg-[color-mix(in_oklch,var(--foreground)_11%,transparent)]"
          aria-hidden="true"
        ></span>
        <span
          class="font-mono text-[0.65625rem] tracking-[0.01em] text-(--muted-foreground) opacity-45"
          >{row.meta}</span
        >
      {/if}
    </span>
  </button>

  <!-- The seam is the meter: full bleed, on the edge, one step per segment. It
       exists only when the agent kept a plan to count against. -->
  {#if seam.length > 0}
    <div class="flex h-0.5 gap-px" aria-hidden="true">
      {#each seam as segment, i (i)}
        {#if segment === "live"}
          <span
            class="relative flex-1 overflow-hidden bg-[color-mix(in_oklch,var(--primary)_22%,transparent)]"
            ><span
              class="run-card__sweep absolute inset-y-0 w-[40%] bg-(--primary)"
            ></span></span
          >
        {:else if segment === "done"}
          <span
            class="flex-1 bg-[color-mix(in_oklch,var(--foreground)_42%,transparent)]"
          ></span>
        {:else if segment === "failed"}
          <span
            class="flex-1 bg-[color-mix(in_oklch,var(--destructive)_45%,transparent)]"
          ></span>
        {:else}
          <span
            class="flex-1 bg-[color-mix(in_oklch,var(--foreground)_8%,transparent)]"
          ></span>
        {/if}
      {/each}
    </div>
  {/if}
</section>

<style>
  /* A ring, an inset top highlight and a short lift are the whole shell — see
     the --solus-tx-card-* tokens for the recipe and how it turns over in dark
     mode. */
  .run-card {
    box-shadow: var(--solus-tx-card-shadow);
  }

  /* State changes the ring's hue and nothing else about the shell. */
  .run-card.is-failed {
    box-shadow:
      0 0 0 0.03125rem color-mix(in oklch, var(--destructive) 26%, transparent),
      inset 0 0.0625rem 0 var(--solus-tx-card-highlight),
      var(--solus-tx-card-lift);
  }

  /* The open agent keeps a ring rather than a fill, so the pane's target stays
     obvious without the card reading as selected-and-destructive. */
  .run-card.is-open {
    box-shadow:
      0 0 0 0.0625rem color-mix(in oklch, var(--primary) 34%, transparent),
      inset 0 0.0625rem 0 var(--solus-tx-card-highlight),
      var(--solus-tx-card-lift);
  }

  .run-card button:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border-medium);
    outline-offset: -0.125rem;
  }

  /* Keep the changing activity legible. Animating a clipped text gradient
     repaints on every frame and flickers when the activity label changes. */
  .run-card__shim {
    color: var(--muted-foreground);
  }

  .run-card__arc {
    transform-origin: center;
    will-change: transform;
    animation: run-card-arc 1.2s linear infinite;
  }

  /* The live seam stays visible without a second perpetual animation. */
  .run-card__sweep {
    width: 100%;
  }

  @keyframes run-card-arc {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .run-card__arc {
      animation: none;
      will-change: auto;
    }
  }
</style>
