<script lang="ts" generics="Step extends { title: string; hint?: string; state: 'done' | 'current' | 'next' }">
  /**
   * Steps a person follows in order, as numbered circles joined by a rail. The
   * current step has a ring; a done step has a check, and its part of the rail
   * takes the accent. The sign-in steps and the browser sign-in prompt draw it,
   * so every "do this, then that" reads the same. A caller adds a step's own
   * controls (a code field, a code to copy) with `detail`.
   */
  import type { Snippet } from "svelte";
  import { Check as CheckIcon } from "@lucide/svelte";

  let {
    steps,
    detail,
  }: {
    steps: Step[];
    /** Controls under one step's title and hint. */
    detail?: Snippet<[Step, number]>;
  } = $props();
</script>

<ol class="flex flex-col">
  {#each steps as step, index (index)}
    <li class="relative grid grid-cols-[1.25rem_1fr] items-start gap-x-3 pb-5 last:pb-0" aria-current={step.state === "current" ? "step" : undefined}>
      {#if index < steps.length - 1}
        <span
          class="absolute top-6 bottom-1 left-[calc(0.625rem-0.75px)] w-[1.5px] rounded-full {step.state === 'done' ? 'bg-(--solus-accent)' : 'bg-border'}"
          aria-hidden="true"
        ></span>
      {/if}
      <span
        class="inline-flex size-5 items-center justify-center rounded-full text-[0.6875rem] font-semibold {step.state === 'current'
          ? 'bg-(--solus-accent) text-(--solus-text-on-accent) shadow-[shadow:0_0_0_4px_color-mix(in_oklch,var(--solus-accent)_16%,transparent)]'
          : step.state === 'done'
            ? 'bg-(--solus-accent) text-(--solus-text-on-accent)'
            : 'bg-card text-(--muted-foreground) shadow-[shadow:inset_0_0_0_1.5px_var(--border)]'}"
      >
        {#if step.state === "done"}<CheckIcon size={11} strokeWidth={3} aria-label="Done" />{:else}{index + 1}{/if}
      </span>
      <div class="flex min-w-0 flex-col">
        <span class="font-medium leading-5 {step.state === 'current' ? 'text-(--solus-text-primary)' : 'text-(--muted-foreground)'}">{step.title}</span>
        {#if step.hint}
          <span class="mt-0.5 text-pretty text-xs leading-normal text-(--muted-foreground)">{step.hint}</span>
        {/if}
        {@render detail?.(step, index)}
      </div>
    </li>
  {/each}
</ol>
