<script lang="ts">
  import {
    ExternalLink as ArrowSquareOutIcon,
    LoaderCircle as CircleNotchIcon,
    Link as LinkIcon,
    Maximize2 as ArrowsOutSimpleIcon,
    Trash2 as TrashIcon,
  } from "@lucide/svelte";
  import type { Task } from "@solus/contracts/task-types";
  import { PROVIDER_NAMES, taskRef } from "../lib/tasks-api";
  import {
    SourceLogo,
    SubPageCrumbLine,
    SUB_PAGE_CHIP,
    SUB_PAGE_ROUND_BTN,
  } from "../../ui/list-page";

  /**
   * The task page's head at every rung but the record one: the sub page band
   * every record shares, with the task's own chips and verbs in its action
   * slot. `TaskRecordBar` is the phone-width counterpart.
   */
  interface Props {
    task: Task;
    /** A read of the task from its provider is on its way. */
    refreshing: boolean;
    /** Read the task from its provider again. */
    onRefresh: () => void;
    /** Neighbours in the Tasks page's own order, so "next" agrees with what the
     *  user saw in the list. Null when the task isn't in the current view. */
    onPrevious?: (() => void) | null;
    onNext?: (() => void) | null;
    /** Open the task on its provider. Null for a draft, which has no page there. */
    onOpenSource?: (() => void) | null;
    /** Replace an embedded detail panel with this task's standalone route. */
    onOpenPage?: () => void;
    /** Copy the task's address on its provider. Null for a draft. */
    onCopyLink?: (() => void) | null;
    /** Delete the task. Null for an issue: only a draft can be deleted. */
    onDelete?: (() => void) | null;
    onOpenList: () => void;
    onClose: () => void;
  }

  let {
    task,
    refreshing,
    onRefresh,
    onPrevious,
    onNext,
    onOpenSource,
    onOpenPage,
    onCopyLink = null,
    onDelete = null,
    onOpenList,
    onClose,
  }: Props = $props();

  const providerName = $derived(PROVIDER_NAMES[task.providerId]);
</script>

{#snippet actions()}
  <!-- One pill says which provider owns the task and the reference it has
       there. Pressing it reads the task from the provider again. -->
  <button
    type="button"
    class="{SUB_PAGE_CHIP} mr-2 cursor-pointer transition-colors hover:bg-[var(--wash-1)] hover:text-foreground disabled:pointer-events-none @max-[42rem]:hidden"
    onclick={onRefresh}
    disabled={refreshing}
    title="{task.reference ?? `${providerName} draft`} · click to read it from {providerName} again"
    aria-label="Read the task from {providerName} again"
  >
    {#if refreshing}
      <CircleNotchIcon size={11} class="animate-spin motion-reduce:animate-none" aria-hidden="true" />
    {:else}
      <SourceLogo source={task.providerId} />
    {/if}
    <span>{refreshing ? "Reading" : providerName}</span>
    <span class="text-xs opacity-70">{taskRef(task)}</span>
  </button>

  {#if onCopyLink}
    <button
      type="button"
      class={SUB_PAGE_ROUND_BTN}
      onclick={onCopyLink}
      title="Copy {providerName} link"
      aria-label="Copy the {providerName} link of this task"
      data-testid="task-copy-link"
    >
      <LinkIcon size={15} strokeWidth={1.5} />
    </button>
  {/if}

  {#if onOpenPage}
    <button
      type="button"
      class={SUB_PAGE_ROUND_BTN}
      onclick={onOpenPage}
      title="Open task page"
      aria-label="Open task page"
    >
      <ArrowsOutSimpleIcon size={15} strokeWidth={1.5} />
    </button>
  {/if}

  {#if onOpenSource}
    <button
      type="button"
      class={SUB_PAGE_ROUND_BTN}
      onclick={onOpenSource}
      title={`Open in ${providerName}`}
      aria-label={`Open task in ${providerName}`}
    >
      <ArrowSquareOutIcon size={15} strokeWidth={1.5} />
    </button>
  {/if}

  {#if onDelete}
    <button
      type="button"
      class={SUB_PAGE_ROUND_BTN}
      onclick={onDelete}
      title="Delete draft"
      aria-label="Delete this draft"
      data-testid="task-delete"
    >
      <TrashIcon size={15} strokeWidth={1.5} />
    </button>
  {/if}
{/snippet}

<SubPageCrumbLine
  page="tasks"
  onOpenPage={onOpenList}
  leaf={taskRef(task)}
  leafTitle={task.reference}
  copyText={task.reference ?? task.id}
  copyTitle={task.reference ? "Copy task reference" : "Copy task key"}
  {actions}
  stepper={{ onPrevious: onPrevious ?? null, onNext: onNext ?? null, itemLabel: "task" }}
  {onClose}
  divided={false}
/>
