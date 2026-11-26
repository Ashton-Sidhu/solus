<script lang="ts">
  /**
   * One step of the onboarding timeline (docs/plans/one-page-onboarding.md
   * decision 1): the 22 px marker column with its 1 px line, and the step's
   * text. An open step shows its body; a done step folds to one line with
   * Edit or Change; a next or waiting step is dimmed.
   */
  import type { Snippet } from "svelte";
  import { LoaderCircle as SpinnerIcon } from "@lucide/svelte";
  import type { TimelineEntry } from "./lib/onboarding-model";
  import type { StepCopy } from "./lib/step-copy";

  interface Props {
    entry: TimelineEntry;
    copy: Pick<StepCopy, "title" | "detail" | "editLabel">;
    isFirst: boolean;
    isLast: boolean;
    onedit?: () => void;
    body?: Snippet;
  }

  let { entry, copy, isFirst, isLast, onedit, body }: Props = $props();
</script>

<li
  class="flex gap-4.5"
  class:pt-7={isFirst}
  aria-current={entry.status === "open" ? "step" : undefined}
>
  <div class="flex w-5.5 shrink-0 flex-col items-center gap-1.5" aria-hidden="true">
    {#if entry.marker === "spinner"}
      <span class="flex size-5.5 shrink-0 items-center justify-center text-(--solus-text-tertiary)">
        <SpinnerIcon size={22} strokeWidth={1.5} class="animate-spin motion-reduce:animate-none" />
      </span>
    {:else if entry.marker === "check"}
      <span class="flex size-5.5 shrink-0 items-center justify-center rounded-full bg-(--solus-status-live-bg)">
        <svg width="11" height="11" viewBox="0 0 24 24">
          <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="var(--solus-status-live)" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </span>
    {:else if entry.status === "open"}
      <span class="flex size-5.5 shrink-0 items-center justify-center rounded-full bg-(--solus-text-primary) text-[11px] leading-3.5 font-semibold text-background">{entry.number}</span>
    {:else}
      <span class="flex size-5.5 shrink-0 items-center justify-center rounded-full border-[1.5px] border-border text-[11px] leading-3.5 font-semibold text-(--solus-text-tertiary)">{entry.number}</span>
    {/if}
    {#if !isLast}<span class="w-px flex-1 bg-(--hairline)"></span>{/if}
  </div>

  {#if entry.status === "open"}
    <div class="flex min-w-0 flex-1 flex-col" class:pb-6.5={!isLast} class:pb-7={isLast}>
      <div class="flex flex-col gap-0.5 pb-2.5">
        <h2 class="m-0 text-[15px] leading-5.5 font-semibold text-(--solus-text-primary)">{copy.title}</h2>
        <p class="m-0 text-[13px] leading-4.5 text-(--solus-text-tertiary)">{copy.detail}</p>
      </div>
      {@render body?.()}
    </div>
  {:else if entry.status === "done"}
    <div class="flex min-w-0 flex-1 items-start gap-3.5" class:pb-5.5={!isLast} class:pb-7={isLast}>
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <h2 class="m-0 text-[15px] leading-5.5 font-medium text-(--solus-text-secondary)">{copy.title}</h2>
        <p class="m-0 truncate text-[13px] leading-4.5 text-(--solus-text-tertiary)">{copy.detail}</p>
      </div>
      {#if onedit}
        <button
          type="button"
          class="shrink-0 rounded-sm text-[13px] leading-5.5 font-medium text-(--solus-text-tertiary) hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-ring"
          aria-label="{copy.editLabel} {copy.title}"
          onclick={onedit}
        >
          {copy.editLabel}
        </button>
      {/if}
    </div>
  {:else}
    <div class="flex min-w-0 flex-1 flex-col gap-0.5" class:pb-5.5={!isLast} class:pb-7={isLast}>
      <h2 class="m-0 text-[15px] leading-5.5 font-medium text-(--solus-text-tertiary)">{copy.title}</h2>
      <p class="m-0 text-[13px] leading-4.5 text-(--solus-text-tertiary)">{copy.detail}</p>
    </div>
  {/if}
</li>
