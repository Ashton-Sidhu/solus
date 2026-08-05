<script lang="ts">
  import { ArrowsClockwiseIcon, CircleNotchIcon } from "phosphor-svelte";
  import type { Task } from "../../../../shared/task-types";
  import { taskProviderLabel, taskRef } from "./lib/task-page";

  interface Props {
    task: Task;
    projectLabel: string;
    /** Neighbours in the Tasks page's own order, so "next" agrees with what the
     *  user saw in the list. Null when the task isn't in the current view. */
    onPrevious?: (() => void) | null;
    onNext?: (() => void) | null;
    onOpenSource?: (() => void) | null;
    onRefresh?: (() => void) | null;
    refreshing?: boolean;
    onOpenList: () => void;
    onClose: () => void;
  }

  let {
    task,
    projectLabel,
    onPrevious,
    onNext,
    onOpenSource,
    onRefresh,
    refreshing = false,
    onOpenList,
    onClose,
  }: Props = $props();

  const providerLabel = $derived(taskProviderLabel(task));

  const ICON_BTN =
    "flex size-[26px] cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--wash-2)] hover:text-foreground disabled:pointer-events-none disabled:opacity-35";
</script>

<div
  class="flex h-(--solus-chrome-row-h,2.75rem) shrink-0 items-center gap-1 pr-3.5 pl-[max(1.125rem,var(--solus-chrome-lead-inset,0px))]"
>
  <button
    type="button"
    class="flex h-7 cursor-pointer items-center gap-[7px] rounded px-[7px] text-[13px] text-muted-foreground hover:bg-[var(--wash-1)]"
    onclick={onOpenList}
  >
    <span class="size-4 shrink-0 rounded bg-[color-mix(in_oklch,var(--chart-4)_55%,transparent)]"
    ></span>
    {projectLabel}
  </button>
  <span class="px-[3px] text-[13px] opacity-30" aria-hidden="true">/</span>
  <button
    type="button"
    class="flex h-7 cursor-pointer items-center rounded px-[7px] text-[13px] text-muted-foreground hover:bg-[var(--wash-1)]"
    onclick={onOpenList}
  >
    Tasks
  </button>
  <span class="px-[3px] text-[13px] opacity-30" aria-hidden="true">/</span>
  <span class="flex h-7 items-center rounded px-[7px] font-mono text-[12.5px] tracking-[-.005em]">
    {taskRef(task)}
  </span>

  <span class="flex-1"></span>

  {#if onRefresh}
    <button
      type="button"
      class={ICON_BTN}
      onclick={onRefresh}
      disabled={refreshing}
      title="Refresh from GitHub"
      aria-label="Refresh issue from GitHub"
    >
      {#if refreshing}
        <CircleNotchIcon size={13} class="animate-spin motion-reduce:animate-none" />
      {:else}
        <ArrowsClockwiseIcon size={13} />
      {/if}
    </button>
  {/if}

  {#if onOpenSource}
    <button
      type="button"
      class="mr-2 flex h-[26px] cursor-pointer items-center gap-[7px] rounded-full px-2.5 text-[11.5px] text-muted-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_11%,transparent)] transition-colors hover:bg-[var(--wash-1)] hover:text-foreground"
      onclick={onOpenSource}
      title={`Open in ${providerLabel}`}
      aria-label={`Open task in ${providerLabel}`}
    >
      {providerLabel}
      <svg
        width="10"
        height="10"
        viewBox="0 0 14 14"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="opacity-70"
        aria-hidden="true"
      >
        <path d="M8 2h4v4M6 8l6-6M11 8.2v2.4a1.4 1.4 0 01-1.4 1.4H3.4A1.4 1.4 0 012 10.6V4.4A1.4 1.4 0 013.4 3H6" />
      </svg>
    </button>
  {:else}
    <span
      class="mr-2 flex h-[26px] items-center gap-[7px] rounded-full px-2.5 text-[11.5px] text-muted-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_11%,transparent)]"
      title="This task lives only in Solus"
    >
      <svg
        width="11"
        height="11"
        viewBox="0 0 14 14"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="opacity-70"
        aria-hidden="true"
      >
        <path d="M7 9.8v.1M7 4.2v3.2M7 12.6A5.6 5.6 0 107 1.4a5.6 5.6 0 000 11.2" />
      </svg>
      {providerLabel}
    </span>
  {/if}

  <span class="mx-1.5 h-4 w-px bg-[var(--hairline-strong)]" aria-hidden="true"></span>

  <button
    type="button"
    class={ICON_BTN}
    onclick={() => onPrevious?.()}
    disabled={!onPrevious}
    title="Previous task"
    aria-label="Previous task"
  >
    <svg
      width="13"
      height="13"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"><path d="M9 3L5 7l4 4" /></svg
    >
  </button>
  <button
    type="button"
    class={ICON_BTN}
    onclick={() => onNext?.()}
    disabled={!onNext}
    title="Next task"
    aria-label="Next task"
  >
    <svg
      width="13"
      height="13"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"><path d="M5 3l4 4-4 4" /></svg
    >
  </button>
  <button type="button" class={ICON_BTN} onclick={onClose} title="Close (Esc)" aria-label="Close">
    <svg
      width="13"
      height="13"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"><path d="M3.6 3.6l6.8 6.8M10.4 3.6l-6.8 6.8" /></svg
    >
  </button>
</div>
