<script lang="ts">
  import {
    ExternalLink as ArrowSquareOutIcon,
    LoaderCircle as CircleNotchIcon,
    Maximize2 as ArrowsOutSimpleIcon,
  } from "@lucide/svelte";
  import type { Task } from "@solus/contracts/task-types";
  import ShareButton from "../../sharing/ShareButton.svelte";
  import { taskProviderLabel, taskRef } from "./lib/task-page";
  import { syncToneColor, type TaskUpstreamState } from "./lib/task-upstream";
  import {
    SourceLogo,
    SubPageCrumbLine,
    SUB_PAGE_CHIP,
    SUB_PAGE_ICON,
    SUB_PAGE_ROUND_BTN,
  } from "../../ui/list-page";

  /**
   * The task page's head at every rung but the record one: the sub page band
   * every record shares, with the task's own chips and verbs in its action
   * slot. `TaskRecordBar` is the phone-width counterpart.
   */
  interface Props {
    task: Task;
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
    /** Replace an embedded detail panel with this task's standalone route. */
    onOpenPage?: () => void;
    /** The host the task lives on, for the Share control; null where sharing has no home (a guest shell). */
    shareServerId?: string | null;
    onOpenList: () => void;
    onClose: () => void;
  }

  let {
    task,
    upstream,
    syncing,
    onSync,
    onPrevious,
    onNext,
    onOpenSource,
    onMoveAcross,
    isLeading = true,
    onOpenPage,
    shareServerId = null,
    onOpenList,
    onClose,
  }: Props = $props();

  const providerLabel = $derived(taskProviderLabel(task));
</script>

{#snippet pillBody(state: TaskUpstreamState, tone: string)}
  {#if syncing}
    <CircleNotchIcon size={11} class="animate-spin motion-reduce:animate-none" aria-hidden="true" />
  {:else}
    <SourceLogo source={state.providerId} />
  {/if}
  <span style="color:{tone}">{syncing ? "Syncing" : state.label}</span>
  <span class="text-xs opacity-70">{state.ref}</span>
{/snippet}

{#snippet actions()}
  <!-- One pill for the whole upstream story: which system owns the ticket, the
       reference it is filed under, and whether we are level with it. Pressing
       it exchanges now instead of waiting for the engine's own debounce. -->
  {#if upstream}
    {@const tone = syncToneColor(upstream.tone)}
    {#if onSync}
      <button
        type="button"
        class="{SUB_PAGE_CHIP} mr-2 cursor-pointer transition-colors hover:bg-[var(--wash-1)] hover:text-foreground disabled:pointer-events-none @max-[42rem]:hidden"
        onclick={onSync}
        disabled={syncing}
        title="{upstream.title} · click to sync now"
        aria-label="Sync with {upstream.provider} now"
      >
        {@render pillBody(upstream, tone)}
      </button>
    {:else}
      <span class="{SUB_PAGE_CHIP} mr-2 @max-[42rem]:hidden" title={upstream.title}>
        {@render pillBody(upstream, tone)}
      </span>
    {/if}
  {:else}
    <span class="{SUB_PAGE_CHIP} mr-2 @max-[42rem]:hidden" title="This task lives only in Solus">
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

  <!-- Who may open this task, and with it every session and document under it:
       the same control the session band and the work header carry. -->
  <ShareButton
    serverId={shareServerId}
    resource={{ kind: "task", id: task.id }}
    title={task.title}
    class={SUB_PAGE_ROUND_BTN}
  />

  {#if onOpenPage}
    <button
      type="button"
      class={SUB_PAGE_ROUND_BTN}
      onclick={onOpenPage}
      title="Open task page"
      aria-label="Open task page"
    >
      <ArrowsOutSimpleIcon size={13} class={SUB_PAGE_ICON} />
    </button>
  {/if}

  {#if onOpenSource}
    <button
      type="button"
      class={SUB_PAGE_ROUND_BTN}
      onclick={onOpenSource}
      title={`Open in ${providerLabel}`}
      aria-label={`Open task in ${providerLabel}`}
    >
      <ArrowSquareOutIcon size={13} class={SUB_PAGE_ICON} />
    </button>
  {/if}
{/snippet}

<SubPageCrumbLine
  page="tasks"
  onOpenPage={onOpenList}
  leaf={taskRef(task)}
  copyText={task.id}
  copyTitle="Copy task ID"
  {actions}
  stepper={{ onPrevious: onPrevious ?? null, onNext: onNext ?? null, itemLabel: "task" }}
  {onMoveAcross}
  {isLeading}
  {onClose}
/>
