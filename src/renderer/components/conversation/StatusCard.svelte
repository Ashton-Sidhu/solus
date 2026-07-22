<script lang="ts">
  import {
    GitBranchIcon,
    CheckCircleIcon,
    CircleNotchIcon,
    CircleIcon,
    WarningCircleIcon,
  } from "phosphor-svelte";
  import type { StatusCardState } from "../../../shared/types";
  import * as Card from "../ui/card";

  interface Props {
    card: StatusCardState;
    skipMotion?: boolean;
  }

  let { card, skipMotion = false }: Props = $props();

  const doneCount = $derived(card.steps.filter((s) => s.status === "done").length);
  const total = $derived(card.steps.length);
  const progressPercent = $derived(total > 0 ? Math.round((doneCount / total) * 100) : 0);
  const statusLabel = $derived(
    card.status === "error"
      ? "Failed"
      : card.status === "done"
        ? "Complete"
        : `${doneCount} / ${total} steps complete`,
  );
</script>

<div class="mx-auto w-[88%] py-2 {skipMotion ? '' : 'animate-msg-in-side'}">
  <Card.Root
    class="status-card w-full gap-0 overflow-hidden rounded-xl bg-(--solus-container-bg) py-0 {card.status === 'error' ? 'is-error' : ''} {skipMotion ? 'no-motion' : ''}"
    role="status"
    aria-live="polite"
    data-testid="status-card"
    style={`--status-progress:${progressPercent}%`}
  >
    <Card.Header class="flex grid-cols-none grid-rows-none items-center gap-2.5 px-3.5 py-3">
      <span
        class="icon-chip relative grid size-8 shrink-0 place-items-center rounded-lg bg-(--solus-accent-light)"
        class:is-active={card.status === "active"}
        aria-hidden="true"
      >
        {#if card.icon === "git-branch"}
          <GitBranchIcon
            size={16}
            weight="regular"
            class="relative z-[1]"
            style="color:var(--solus-accent)"
          />
        {/if}
      </span>

      <div class="min-w-0 flex-1">
        <h3 class="truncate text-[0.8125rem] font-semibold leading-tight text-(--solus-text-primary)">
          {card.title}
        </h3>
        <p class="mt-0.5 text-[0.6875rem] leading-none text-(--solus-text-tertiary)">
          {statusLabel}
        </p>
      </div>

      <div class="hidden w-20 shrink-0 items-center gap-2 sm:flex" aria-hidden="true">
        <span class="status-progress-track">
          <span class="status-progress-fill"></span>
        </span>
      </div>
    </Card.Header>

    <ul class="status-steps flex flex-col" role="list">
      {#each card.steps as step, i (step.id)}
        {@const isActive = step.status === "active"}
        {@const isDone = step.status === "done"}
        {@const isError = step.status === "error"}
        <li
          class="status-step flex min-h-11 items-center gap-2.5 px-3.5"
          class:is-active={isActive}
          class:is-done={isDone}
          class:is-error={isError}
          style={skipMotion ? "" : `animation-delay:${60 + i * 55}ms`}
        >
          <span
            class="status-step-icon relative grid size-6 shrink-0 place-items-center"
            aria-hidden="true"
          >
            {#if isDone}
              <CheckCircleIcon
                size={18}
                weight="fill"
                class="relative z-[1]"
                style="color:var(--solus-status-complete)"
              />
            {:else if isActive}
              <CircleNotchIcon
                size={20}
                weight="bold"
                class="relative z-[1] animate-spin motion-reduce:animate-none"
                style="color:var(--solus-accent)"
              />
            {:else if isError}
              <WarningCircleIcon
                size={18}
                weight="fill"
                class="relative z-[1]"
                style="color:var(--solus-status-error)"
              />
            {:else}
              <CircleIcon
                size={18}
                weight="regular"
                class="relative z-[1]"
                style="color:var(--solus-text-tertiary)"
              />
            {/if}
          </span>

          <span
            class="min-w-0 flex-1 truncate text-[0.7813rem] leading-tight transition-colors duration-300 ease-(--ease-premium)"
            class:font-medium={isActive}
            style:color={isError
              ? "var(--solus-status-error)"
              : isActive
                ? "var(--solus-text-primary)"
                : isDone
                  ? "var(--solus-text-secondary)"
                  : "var(--solus-text-tertiary)"}
          >
            {step.label}
          </span>
        </li>
      {/each}
    </ul>
  </Card.Root>
</div>

<style>
  :global(.status-card) {
    box-shadow:
      0 0 0 0.0625rem color-mix(in srgb, var(--solus-tool-border) 92%, transparent),
      0 0.5rem 1.25rem color-mix(in srgb, #000 12%, transparent),
      0 0.0625rem 0.25rem color-mix(in srgb, #000 8%, transparent),
      inset 0 0.0625rem 0 color-mix(in srgb, #fff 14%, transparent);
  }
  :global(.status-card.is-error) {
    box-shadow:
      0 0 0 0.0625rem color-mix(in srgb, var(--solus-status-error) 48%, transparent),
      0 0.5rem 1.25rem color-mix(in srgb, #000 12%, transparent),
      0 0.0625rem 0.25rem color-mix(in srgb, #000 8%, transparent);
  }

  .status-progress-track {
    position: relative;
    height: 0.3125rem;
    width: 100%;
    overflow: hidden;
    border-radius: 9999px;
    background: color-mix(in srgb, var(--solus-text-primary) 14%, transparent);
  }
  .status-progress-fill {
    display: block;
    height: 100%;
    width: var(--status-progress);
    min-width: 0.375rem;
    border-radius: inherit;
    background: linear-gradient(
      90deg,
      color-mix(in srgb, var(--solus-accent) 74%, #fff),
      var(--solus-accent)
    );
    box-shadow: 0 0 0.75rem color-mix(in srgb, var(--solus-accent) 45%, transparent);
    transition: width 0.35s var(--ease-premium);
  }
  :global(.status-card.is-error) .status-progress-fill {
    background: var(--solus-status-error);
    box-shadow: 0 0 0.75rem color-mix(in srgb, var(--solus-status-error) 28%, transparent);
  }

  .status-steps {
    border-top: 0.0625rem solid color-mix(in srgb, var(--solus-tool-border) 90%, transparent);
  }
  .status-step + .status-step {
    border-top: 0.0625rem solid color-mix(in srgb, var(--solus-tool-border) 68%, transparent);
  }
  .status-step.is-active {
    background: linear-gradient(
      90deg,
      color-mix(in srgb, var(--solus-accent-light) 100%, transparent),
      transparent 72%
    );
  }
  .status-step-icon {
    color: var(--solus-text-tertiary);
  }
  .status-step-icon :global(svg) {
    opacity: 0.72;
  }
  .status-step.is-done .status-step-icon :global(svg),
  .status-step.is-active .status-step-icon :global(svg),
  .status-step.is-error .status-step-icon :global(svg) {
    opacity: 1;
  }

  /* Breathing accent halo behind the header icon while setup runs */
  .icon-chip.is-active::before {
    content: "";
    position: absolute;
    inset: -0.1875rem;
    border-radius: 0.75rem;
    background: var(--solus-accent-soft);
    filter: blur(0.375rem);
    z-index: 0;
    animation: breathing-glow 2.6s cubic-bezier(0.4, 0, 0.2, 1) infinite;
  }

  /* Soft pulse behind the active step's spinner */
  .status-step.is-active .status-step-icon::before {
    content: "";
    position: absolute;
    inset: -0.1875rem;
    border-radius: 9999px;
    background: var(--solus-accent-soft);
    filter: blur(0.375rem);
    z-index: 0;
    animation: breathing-glow 2.6s cubic-bezier(0.4, 0, 0.2, 1) infinite;
  }

  /* Staggered entrance for each step */
  .status-step {
    animation: status-step-in 0.42s var(--ease-premium) both;
  }
  @keyframes status-step-in {
    from {
      opacity: 0;
      transform: translateY(0.25rem);
      filter: blur(0.125rem);
    }
    to {
      opacity: 1;
      transform: none;
      filter: none;
    }
  }

  :global(.no-motion) .status-step {
    animation: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .status-step {
      animation: none;
    }
    .icon-chip.is-active::before,
    .status-step.is-active .status-step-icon::before {
      animation: none;
    }
    .status-progress-fill {
      transition: none;
    }
  }
</style>
