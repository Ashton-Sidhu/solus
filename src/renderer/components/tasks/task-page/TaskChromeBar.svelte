<script lang="ts">
  import {
    ArrowSquareOutIcon,
    CircleNotchIcon,
    FolderIcon,
  } from "phosphor-svelte";
  import type { Task } from "../../../../shared/task-types";
  import { taskProviderLabel, taskRef } from "./lib/task-page";
  import { syncToneColor, type TaskUpstreamState } from "./lib/task-upstream";
  import CopyButton from "../../ui/CopyButton.svelte";
  import PaneSwapButton from "../../ui/PaneSwapButton.svelte";
  import ProjectFavicon from "../../ui/ProjectFavicon.svelte";

  interface Props {
    task: Task;
    projectLabel: string;
    projectRoot?: string;
    /** How this task stands with the system that owns its ticket. Null for a
     *  local task, which shows that it is local instead. */
    upstream: TaskUpstreamState | null;
    syncing: boolean;
    /** Exchange with the provider now — a push and pull for a linked ticket, a
     *  re-read for a provider-owned one. Null when there is nothing to ask. */
    onSync?: (() => void) | null;
    /** Neighbours in the Tasks page's own order, so "next" agrees with what the
     *  user saw in the list. Null when the task isn't in the current view. */
    onPrevious?: (() => void) | null;
    onNext?: (() => void) | null;
    onOpenSource?: (() => void) | null;
    /** Move the task between the leading pane and the companion beside it. */
    onMoveAcross?: () => void;
    /** Which way `onMoveAcross` sends it. */
    isLeading?: boolean;
    onOpenList: () => void;
    onClose: () => void;
  }

  let {
    task,
    projectLabel,
    projectRoot,
    upstream,
    syncing,
    onSync,
    onPrevious,
    onNext,
    onOpenSource,
    onMoveAcross,
    isLeading = true,
    onOpenList,
    onClose,
  }: Props = $props();

  const providerLabel = $derived(taskProviderLabel(task));

  const ICON_BTN =
    "flex size-[26px] cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--wash-2)] hover:text-foreground disabled:pointer-events-none disabled:opacity-35";
  const PILL =
    "mr-2 flex h-[26px] items-center gap-[7px] rounded-full px-2.5 text-xs text-muted-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_11%,transparent)]";
</script>

{#snippet pillBody(state: TaskUpstreamState, tone: string)}
  {#if syncing}
    <CircleNotchIcon size={11} class="animate-spin motion-reduce:animate-none" aria-hidden="true" />
  {:else}
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
      aria-hidden="true"><path d={state.glyph} /></svg
    >
  {/if}
  <span style="color:{tone}">{syncing ? "Syncing" : state.label}</span>
  <span class="text-xs opacity-70">{state.ref}</span>
{/snippet}

<div
  class="workspace-titlebar flex h-(--solus-chrome-row-h,2.75rem) shrink-0 items-center gap-1 pr-3.5 pl-[max(1.125rem,var(--solus-chrome-lead-inset,0px))]"
>
  <button
    type="button"
    class="flex h-7 min-w-0 max-w-40 cursor-pointer items-center gap-[7px] rounded px-[7px] text-muted-foreground hover:bg-[var(--wash-1)] @max-[42rem]:hidden"
    onclick={onOpenList}
  >
    {#if projectRoot}
      <ProjectFavicon projectRoot={projectRoot} class="size-4" />
    {:else}
      <FolderIcon size={16} class="shrink-0 text-(--solus-text-tertiary)" />
    {/if}
    <span class="truncate">{projectLabel}</span>
  </button>
  <span class="px-[3px] opacity-30 @max-[42rem]:hidden" aria-hidden="true">/</span>
  <button
    type="button"
    class="flex h-7 cursor-pointer items-center rounded px-[7px] text-muted-foreground hover:bg-[var(--wash-1)]"
    onclick={onOpenList}
  >
    Tasks
  </button>
  <span class="px-[3px] opacity-30" aria-hidden="true">/</span>
  <span class="flex h-7 min-w-0 max-w-36 items-center truncate rounded px-[7px]">
    {taskRef(task)}
  </span>
  <CopyButton text={task.id} title="Copy task ID" iconOnly />

  <span class="flex-1"></span>

  <!-- One pill for the whole upstream story: which system owns the ticket, the
       reference it is filed under, and whether we are level with it. Pressing
       it exchanges now instead of waiting for the engine's own debounce. -->
  {#if upstream}
    {@const tone = syncToneColor(upstream.tone)}
    {#if onSync}
      <button
        type="button"
        class="{PILL} cursor-pointer transition-colors hover:bg-[var(--wash-1)] hover:text-foreground disabled:pointer-events-none @max-[42rem]:hidden"
        onclick={onSync}
        disabled={syncing}
        title="{upstream.title} · click to sync now"
        aria-label="Sync with {upstream.provider} now"
      >
        {@render pillBody(upstream, tone)}
      </button>
    {:else}
    <span class="{PILL} @max-[42rem]:hidden" title={upstream.title}>
        {@render pillBody(upstream, tone)}
      </span>
    {/if}
  {:else}
    <span class="{PILL} @max-[42rem]:hidden" title="This task lives only in Solus">
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

  {#if onMoveAcross}
    <PaneSwapButton
      {isLeading}
      onMove={onMoveAcross}
      iconSize={13}
      class={ICON_BTN}
    />
  {/if}

  {#if onOpenSource}
    <button
      type="button"
      class={ICON_BTN}
      onclick={onOpenSource}
      title={`Open in ${providerLabel}`}
      aria-label={`Open task in ${providerLabel}`}
    >
      <ArrowSquareOutIcon size={13} />
    </button>
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
