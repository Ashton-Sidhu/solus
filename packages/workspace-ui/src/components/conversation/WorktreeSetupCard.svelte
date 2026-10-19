<script lang="ts">
  // Adapted from T3 Code WorktreeSetupCard.tsx (MIT, apps/mobile/UPSTREAM.md).
  import { Check, Circle, X, ChevronDown, ChevronRight } from "@lucide/svelte";
  import type { StatusCardState } from "@solus/contracts/types";
  import { setupOutputWindow } from "@solus/contracts/setup-card";
  import { SetupStepTiming, formatStepDuration } from "./lib/setup-timing.svelte";

  interface Props {
    card: StatusCardState;
    onRetry?: () => void;
    onWorkLocally?: () => void;
    onCancel?: () => void;
  }

  let { card, onRetry, onWorkLocally, onCancel }: Props = $props();

  let detailsOpen = $state(false);
  const timing = new SetupStepTiming();
  $effect(() => timing.observe(card, Date.now()));
  const canRecover = $derived(card.status === "error" && card.recovery === "worktree");
</script>

<section aria-label="Worktree setup" data-testid="status-card" class="min-w-0 text-workspace-chrome">
  <div class="border-b border-border/60 pt-1 pb-2">
    <div class="flex h-6 min-w-0 items-baseline gap-2 px-1 leading-relaxed tabular-nums">
      <span class={card.status === "error" ? "truncate text-destructive" : "truncate text-muted-foreground"}>
        {card.status === "active" ? "Setting up worktree…" : card.title}
      </span>
      {#if timing.totalMs}
        <span class="ml-auto shrink-0 text-xs text-muted-foreground">{formatStepDuration(timing.totalMs)}</span>
      {/if}
    </div>
  </div>
  <div class="pt-1.5">
    {#each card.steps as step (step.id)}
      {@const stepMs = timing.msFor(step.id)}
      <div class="flex min-h-8 items-center gap-2 px-1">
        <span class="flex w-6 shrink-0 items-center justify-center text-muted-foreground">
          {#if step.status === "done"}
            <Check size={14} />
          {:else if step.status === "active"}
            <span class="activity-spinner" aria-label="Running"></span>
          {:else if step.status === "error"}
            <X size={14} />
          {:else}
            <Circle size={14} class="opacity-40" />
          {/if}
        </span>
        <span
          class="min-w-0 flex-1 truncate"
          class:text-destructive={step.status === "error"}
          class:text-muted-foreground={step.status === "pending"}
        >
          {step.label}
        </span>
        {#if stepMs}
          <span class="text-xs text-muted-foreground tabular-nums">{formatStepDuration(stepMs)}</span>
        {/if}
      </div>
      {#if step.detail}
        <p class="mt-1 ml-8 text-xs text-muted-foreground">{step.detail}</p>
      {/if}
    {/each}
  </div>
  <div class="mt-0.5 ml-6 flex flex-wrap items-center gap-0.5 text-xs text-muted-foreground">
    <button
      type="button"
      aria-expanded={detailsOpen}
      class="flex min-h-8 items-center gap-1 rounded-md px-2 hover:bg-muted pointer-coarse:min-h-11"
      onclick={() => (detailsOpen = !detailsOpen)}
    >
      {#if detailsOpen}<ChevronDown size={12} />{:else}<ChevronRight size={12} />{/if}
      Details
    </button>
    {#if canRecover}
      {#if onWorkLocally}
        <button type="button" class="min-h-8 rounded-md px-2 hover:bg-muted pointer-coarse:min-h-11" onclick={onWorkLocally}>
          Work locally
        </button>
      {/if}
      {#if onRetry}
        <button type="button" class="min-h-8 rounded-md px-2 text-foreground hover:bg-muted pointer-coarse:min-h-11" onclick={onRetry}>
          Retry setup
        </button>
      {/if}
    {:else if card.status === "active" && onCancel}
      <button type="button" class="min-h-8 rounded-md px-2 hover:bg-muted pointer-coarse:min-h-11" onclick={onCancel}>
        Cancel
      </button>
    {/if}
  </div>
  {#if detailsOpen && card.output?.length}
    <!-- The last four lines, in a window that does not change height. -->
    <pre
      aria-label="Setup output"
      class="mt-2 mb-1 ml-8 overflow-hidden rounded-md border border-border bg-muted px-2.5 py-1.5 font-mono text-xs leading-relaxed text-muted-foreground">{#each setupOutputWindow(card.output) as line, slot (slot)}<div class="truncate whitespace-pre">{line}</div>{/each}</pre>
  {/if}
</section>
