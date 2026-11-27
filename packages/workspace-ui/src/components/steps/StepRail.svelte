<script lang="ts" generics="Step extends { title: string; hint?: string; state: StepRailState }">
  /**
   * Steps a person follows in order, drawn as the onboarding timeline draws
   * them (docs/plans/one-page-onboarding.md decision 1): a 22 px marker column
   * joined by a 1 px hairline. The current step has a dark number, a done step
   * a green check, and a next step an outlined number in muted text. The
   * sign-in steps, the browser sign-in prompt, the connect card, the add
   * server dialog, and the setup card draw it, so every "do this, then that"
   * reads the same. Work that runs by itself has more states: a step that
   * failed or has a warning has an exclamation mark in its tone, and a
   * skipped step a dashed ring. A caller adds a step's
   * own controls with `detail`, and an action or a time at the end of a step's
   * title row with `trailing`.
   */
  import type { StepRailState } from "./lib/step-rail";
  import type { Snippet } from "svelte";

  let {
    steps,
    detail,
    trailing,
  }: {
    steps: Step[];
    /** Controls under one step's title and hint. */
    detail?: Snippet<[Step, number]>;
    /** An action at the end of one step's title row. */
    trailing?: Snippet<[Step, number]>;
  } = $props();
</script>

<ol class="flex flex-col">
  {#each steps as step, index (index)}
    <li class="relative grid grid-cols-[1.375rem_1fr] items-start gap-x-3.5 pb-5 last:pb-0" aria-current={step.state === "current" ? "step" : undefined}>
      {#if index < steps.length - 1}
        <span class="absolute top-7 bottom-1.5 left-[calc(0.6875rem-0.5px)] w-px bg-(--hairline)" aria-hidden="true"></span>
      {/if}
      {#if step.state === "done"}
        <span class="inline-flex size-5.5 items-center justify-center rounded-full bg-(--solus-status-live-bg)">
          <svg width="11" height="11" viewBox="0 0 24 24" role="img" aria-label="Done">
            <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="var(--solus-status-live)" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
      {:else if step.state === "current"}
        <span class="inline-flex size-5.5 items-center justify-center rounded-full bg-(--solus-text-primary) text-[0.6875rem] leading-3.5 font-semibold text-background">{index + 1}</span>
      {:else if step.state === "failed" || step.state === "warning"}
        <span
          class="inline-flex size-5.5 items-center justify-center rounded-full {step.state === 'failed'
            ? 'bg-(--solus-status-error-bg) text-(--destructive)'
            : 'bg-[color:color-mix(in_oklch,var(--warning)_16%,transparent)] text-(--warning)'}"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" role="img" aria-label={step.state === "failed" ? "Failed" : "Warning"}>
            <path d="M12 6v7.5M12 18v.2" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" />
          </svg>
        </span>
      {:else if step.state === "skipped"}
        <span class="inline-flex size-5.5 items-center justify-center rounded-full border-[1.5px] border-dashed border-border text-[0.6875rem] leading-3.5 font-semibold text-(--solus-text-tertiary)" role="img" aria-label="Skipped">–</span>
      {:else}
        <span class="inline-flex size-5.5 items-center justify-center rounded-full border-[1.5px] border-border text-[0.6875rem] leading-3.5 font-semibold text-(--solus-text-tertiary)">{index + 1}</span>
      {/if}
      <div class="flex min-w-0 flex-col">
        <div class="flex min-w-0 items-start gap-3">
          <span
            class="min-w-0 flex-1 leading-5.5 {step.state === 'current' || step.state === 'failed' || step.state === 'warning'
              ? 'font-semibold text-(--solus-text-primary)'
              : step.state === 'done'
                ? 'font-medium text-(--solus-text-secondary)'
                : 'font-medium text-(--solus-text-tertiary)'}">{step.title}</span
          >
          {@render trailing?.(step, index)}
        </div>
        {#if step.hint}
          <!-- A done step folds to one line; the others wrap. -->
          <span class="mt-0.5 text-xs leading-normal text-(--solus-text-tertiary) {step.state === 'done' ? 'truncate' : 'text-pretty'}">{step.hint}</span>
        {/if}
        {@render detail?.(step, index)}
      </div>
    </li>
  {/each}
</ol>
