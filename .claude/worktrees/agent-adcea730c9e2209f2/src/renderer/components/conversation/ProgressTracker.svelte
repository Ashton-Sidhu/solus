<script lang="ts">
  import { fly } from "svelte/transition";
  import type { SessionProgress, TodoItem } from "../../../shared/types";

  // Mobile-only progress card. On desktop the progress lives inside the
  // ActionOrb action row (responsive circle/pill + inline bar); mobile has no
  // action row, so we keep the compact top card here.
  let {
    progress,
    interrupted = false,
  }: {
    progress: SessionProgress | null;
    interrupted?: boolean;
  } = $props();

  let allDone = $derived(
    progress
      ? progress.todos.every((t: TodoItem) => t.status === "completed")
      : false,
  );
  let hasInProgress = $derived(
    progress
      ? progress.todos.some((t: TodoItem) => t.status === "in_progress")
      : false,
  );

  let header = $derived.by<string | null>(() => {
    if (!progress || progress.totalSteps === 0) return null;
    const active = progress.todos.find((t) => t.status === "in_progress");
    if (active) return active.content;
    const next = progress.todos.find((t) => t.status === "pending");
    return next?.content ?? null;
  });

  function nodeStyle(status: TodoItem["status"]): string {
    if (status === "in_progress") {
      return "width:0.6875rem;height:0.6875rem;background:var(--solus-accent);";
    }
    return "width:0.625rem;height:0.625rem;background:transparent;border:0.0938rem solid var(--solus-timeline-line);";
  }
</script>

{#if progress && progress.totalSteps > 0 && !allDone}
  <div in:fly={{ y: -6, duration: 220 }} class="sticky top-0 z-5 pt-3 pb-3 px-0">
    <div
      class="progress-pill rounded-2xl relative overflow-hidden {interrupted
        ? 'progress-pill-done'
        : ''}"
    >
      <div class="px-4 py-3">
        <div class="flex items-center gap-3">
          <div class="flex-1 flex items-center gap-2.5 min-w-0">
            <div
              class="rounded-full flex-shrink-0 {hasInProgress && !interrupted
                ? 'node-pulse'
                : ''}"
              style={hasInProgress
                ? nodeStyle("in_progress")
                : nodeStyle("pending")}
            ></div>
            <div class="flex-1 min-w-0">
              {#if header}
                <span
                  class="text-[0.75rem] font-medium truncate"
                  style="color:var(--solus-text-primary);letter-spacing:-0.01em;display:block;line-height:1.3"
                  >{header}</span
                >
              {/if}
            </div>
          </div>
          <span class="step-badge tabular-nums">
            {progress.currentStep}/{progress.totalSteps}
          </span>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .progress-pill {
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--solus-container-bg) 12%, transparent) 0%,
      color-mix(in srgb, var(--solus-container-bg) 8%, transparent) 100%
    );
    backdrop-filter: blur(0.75rem) saturate(1.6);
    -webkit-backdrop-filter: blur(0.75rem) saturate(1.6);
    border: 0.0313rem solid
      color-mix(in srgb, var(--solus-container-border) 35%, transparent);
    box-shadow:
      inset 0 0.0625rem 0 0 color-mix(in srgb, white 18%, transparent),
      0 0.0625rem 0.1875rem 0 rgba(0, 0, 0, 0.05),
      0 0.25rem 0.875rem 0 rgba(0, 0, 0, 0.06),
      0 0.625rem 1.5rem 0 rgba(0, 0, 0, 0.04);
  }
  :global(.dark) .progress-pill {
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--solus-container-bg) 10%, transparent) 0%,
      color-mix(in srgb, var(--solus-container-bg) 7%, transparent) 100%
    );
    border: 0.0313rem solid rgba(255, 255, 255, 0.1);
    box-shadow:
      inset 0 0.0625rem 0 0 rgba(255, 255, 255, 0.12),
      0 0.0625rem 0.1875rem 0 rgba(0, 0, 0, 0.25),
      0 0.25rem 0.875rem 0 rgba(0, 0, 0, 0.22),
      0 0.625rem 1.5rem 0 rgba(0, 0, 0, 0.18);
  }
  .progress-pill-done {
    opacity: 0.45;
    border-color: color-mix(in srgb, var(--solus-accent) 15%, transparent);
  }

  @keyframes node-pulse {
    0% {
      box-shadow:
        0 0 0.375rem rgba(217, 119, 87, 0.5),
        0 0 0.125rem rgba(217, 119, 87, 0.6),
        0 0 0 0 rgba(217, 119, 87, 0.4);
    }
    60% {
      box-shadow:
        0 0 0.5rem rgba(217, 119, 87, 0.35),
        0 0 0.1875rem rgba(217, 119, 87, 0.45),
        0 0 0 0.4375rem rgba(217, 119, 87, 0);
    }
    100% {
      box-shadow:
        0 0 0.375rem rgba(217, 119, 87, 0.5),
        0 0 0.125rem rgba(217, 119, 87, 0.6),
        0 0 0 0 rgba(217, 119, 87, 0);
    }
  }
  .node-pulse {
    animation: node-pulse 2.2s ease-out infinite;
  }

  .step-badge {
    font-size: 0.625rem;
    font-weight: 500;
    letter-spacing: 0.04em;
    padding: 0.125rem 0.5rem;
    border-radius: 0.625rem;
    background: color-mix(in srgb, var(--solus-accent) 12%, transparent);
    color: var(--solus-accent);
    line-height: 1.4;
    flex-shrink: 0;
  }
  :global(.dark) .step-badge {
    background: color-mix(in srgb, var(--solus-accent) 15%, transparent);
  }
</style>
