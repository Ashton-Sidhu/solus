<script lang="ts">
  import {
    GitBranchIcon,
    CheckCircleIcon,
    CircleNotchIcon,
    CircleIcon,
    WarningCircleIcon,
  } from "phosphor-svelte";
  import type { StatusCardState } from "../../../shared/types";

  interface Props {
    card: StatusCardState;
    skipMotion?: boolean;
  }

  let { card, skipMotion = false }: Props = $props();

  const doneCount = $derived(card.steps.filter((s) => s.status === "done").length);
  const total = $derived(card.steps.length);
</script>

<div class="px-4 py-2 {skipMotion ? '' : 'animate-msg-in-side'}">
  <div
    class="status-card w-fit min-w-[16rem] max-w-md rounded-2xl bg-(--solus-container-bg) p-4"
    class:is-error={card.status === "error"}
    class:no-motion={skipMotion}
    role="status"
    aria-live="polite"
    data-testid="status-card"
  >
    <!-- Header -->
    <div class="flex items-center gap-2.5">
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

      <span
        class="min-w-0 flex-1 truncate text-[0.8125rem] font-semibold tracking-[-0.01em] text-(--solus-text-primary)"
      >
        {card.title}
      </span>

      {#if card.status === "error"}
        <span
          class="shrink-0 rounded-full bg-(--solus-status-error-bg) px-2 py-0.5 text-[0.625rem] font-medium text-(--solus-status-error)"
        >
          Failed
        </span>
      {:else}
        <span
          class="shrink-0 rounded-full bg-(--solus-surface-hover) px-2 py-0.5 text-[0.625rem] font-medium tabular-nums text-(--solus-text-tertiary)"
        >
          {doneCount}/{total}
        </span>
      {/if}
    </div>

    <!-- Steps -->
    <ul class="mt-3.5 flex flex-col" role="list">
      {#each card.steps as step, i (step.id)}
        {@const isActive = step.status === "active"}
        {@const isDone = step.status === "done"}
        {@const isError = step.status === "error"}
        {@const isLast = i === card.steps.length - 1}
        <li
          class="status-step flex items-stretch gap-3"
          style={skipMotion ? "" : `animation-delay:${60 + i * 55}ms`}
        >
          <!-- Icon rail + connector -->
          <div class="flex flex-col items-center pt-px">
            <span
              class="relative grid size-4 shrink-0 place-items-center"
              class:status-glow={isActive}
            >
              {#if isDone}
                <CheckCircleIcon
                  size={16}
                  weight="fill"
                  class="relative z-[1]"
                  style="color:var(--solus-status-complete)"
                />
              {:else if isActive}
                <CircleNotchIcon
                  size={16}
                  weight="bold"
                  class="relative z-[1] animate-spin motion-reduce:animate-none"
                  style="color:var(--solus-accent)"
                />
              {:else if isError}
                <WarningCircleIcon
                  size={16}
                  weight="fill"
                  class="relative z-[1]"
                  style="color:var(--solus-status-error)"
                />
              {:else}
                <CircleIcon
                  size={16}
                  weight="regular"
                  class="relative z-[1] opacity-40"
                  style="color:var(--solus-text-tertiary)"
                />
              {/if}
            </span>

            {#if !isLast}
              <span
                class="my-1 w-0.5 flex-1 rounded-full"
                style:background={isDone
                  ? "var(--solus-status-complete)"
                  : isActive
                    ? "linear-gradient(var(--solus-accent), color-mix(in srgb, var(--solus-accent) 15%, transparent))"
                    : "var(--solus-tool-border)"}
              ></span>
            {/if}
          </div>

          <!-- Label -->
          <span
            class="pb-3 text-[0.8125rem] leading-tight transition-colors duration-300 ease-(--ease-premium) last:pb-0"
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
  </div>
</div>

<style>
  .status-card {
    box-shadow: var(--solus-card-shadow-collapsed);
  }
  .status-card.is-error {
    box-shadow:
      0 0 0 0.0625rem color-mix(in srgb, var(--solus-status-error) 22%, transparent),
      var(--solus-card-shadow-collapsed);
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
  .status-glow::before {
    content: "";
    position: absolute;
    inset: -0.25rem;
    border-radius: 9999px;
    background: var(--solus-accent-soft);
    filter: blur(0.3125rem);
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

  .no-motion .status-step {
    animation: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .status-step {
      animation: none;
    }
    .icon-chip.is-active::before,
    .status-glow::before {
      animation: none;
    }
  }
</style>
