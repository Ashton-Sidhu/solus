<script lang="ts">
  import {
    CaretDownIcon,
    CheckCircleIcon,
    CircleNotchIcon,
    GitMergeIcon,
    MinusIcon,
    PlayIcon,
    QueueIcon,
    SkipForwardIcon,
    WarningCircleIcon,
    XCircleIcon,
    XIcon,
  } from "phosphor-svelte";
  import type {
    MergeMethod,
    MergeOrderMode,
    MergeQueueEntry,
  } from "../../../shared/types";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { tooltip } from "../../lib/tooltip";
  import { requestInputFocus } from "../../lib/inputFocus";
  import Dropdown from "../ui/Dropdown.svelte";
  import DropdownItem from "../ui/DropdownItem.svelte";
  import {
    buildConflictResolutionPrompt,
    ENTRY_STATUS_LABELS,
  } from "./lib/merge-queue-utils";

  const session = getWorkspaceContext();
  const queue = session.mergeQueueStore;
  const prsStore = session.prsStore;

  let orderMode = $state<MergeOrderMode>("auto");
  let method = $state<MergeMethod>("merge");
  let methodMenuOpen = $state(false);
  let methodTriggerEl = $state<HTMLButtonElement | null>(null);
  /** True only while a resolution session is being spawned. The button re-enables
   *  right after — a stalled or failed agent must not lock out another attempt,
   *  and the queue auto-resumes regardless of how the merge gets concluded. */
  let spawningResolver = $state(false);

  const METHOD_OPTIONS: { value: MergeMethod; label: string }[] = [
    { value: "merge", label: "Merge commit" },
    { value: "squash", label: "Squash" },
    { value: "rebase", label: "Rebase" },
  ];
  const methodLabel = $derived(
    METHOD_OPTIONS.find((o) => o.value === method)?.label ?? "",
  );

  const run = $derived(queue.state);
  const staging = $derived(!run && queue.queued.length > 0);
  const finished = $derived(
    run?.status === "done" || run?.status === "cancelled",
  );

  const stagedItems = $derived(
    queue.queued.map((number) => ({
      number,
      title: prsStore.get(number)?.title ?? `#${number}`,
    })),
  );

  const mergedCount = $derived(
    run?.entries.filter((e) => e.status === "merged").length ?? 0,
  );

  function startRun() {
    void queue.start(session.ctx, stagedItems, orderMode, method);
  }

  async function resolveWithAgent(entry: MergeQueueEntry) {
    if (!entry.worktreePath || !entry.branch || !entry.baseRef || !run) return;
    spawningResolver = true;
    try {
      await session.startNewSessionWithPrompt(
        buildConflictResolutionPrompt(entry),
        run.repoRoot,
        {
          branch: entry.branch,
          targetBranch: entry.baseRef,
          worktreePath: entry.worktreePath,
        },
      );
    } finally {
      spawningResolver = false;
    }
    requestInputFocus();
  }

  const smallBtnClass =
    "inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-md border-0 px-2 py-1 text-[0.6875rem] font-medium transition-[background-color,color] duration-100 ease-in-out disabled:cursor-not-allowed disabled:opacity-40";
</script>

{#snippet entryStatusIcon(entry: MergeQueueEntry)}
  {#if entry.status === "merging"}
    <CircleNotchIcon
      size={13}
      class="shrink-0 animate-spin text-(--solus-accent) [animation-duration:0.9s]"
    />
  {:else if entry.status === "conflicts"}
    <WarningCircleIcon size={13} weight="fill" class="shrink-0 text-(--solus-art-negative)" />
  {:else if entry.status === "merged"}
    <CheckCircleIcon size={13} weight="fill" class="shrink-0 text-(--solus-art-positive)" />
  {:else if entry.status === "skipped"}
    <MinusIcon size={13} weight="bold" class="shrink-0 text-(--solus-text-tertiary)" />
  {:else if entry.status === "failed"}
    <XCircleIcon size={13} weight="fill" class="shrink-0 text-(--solus-art-negative)" />
  {:else}
    <span class="grid size-[13px] shrink-0 place-items-center">
      <span class="size-1.5 rounded-full bg-(--solus-art-border)"></span>
    </span>
  {/if}
{/snippet}

{#if staging || run}
  <div class="shrink-0 border-t border-(--solus-popover-border)">
    <!-- Header -->
    <div class="flex items-center justify-between gap-2 px-4 pt-2.5 pb-1.5">
      <div class="flex min-w-0 items-center gap-1.5">
        <QueueIcon size={13} weight="bold" class="shrink-0 text-(--solus-accent)" />
        <span class="text-[0.75rem] font-semibold text-(--solus-text-primary)">
          Merge queue
        </span>
        {#if run}
          <span class="text-[0.6875rem] tabular-nums text-(--solus-text-tertiary)">
            {mergedCount}/{run.entries.length} merged
          </span>
        {:else}
          <span class="text-[0.6875rem] tabular-nums text-(--solus-text-tertiary)">
            {stagedItems.length} queued
          </span>
        {/if}
      </div>
      {#if run && !finished}
        <button
          type="button"
          class="{smallBtnClass} bg-transparent text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)"
          onclick={() => void queue.cancel(session.ctx)}
        >
          Cancel
        </button>
      {:else if finished}
        <div class="flex items-center gap-1">
          {#if queue.failedNumbers.length > 0}
            <button
              type="button"
              class="{smallBtnClass} bg-(--solus-accent-light) text-(--solus-accent) hover:bg-[color-mix(in_srgb,var(--solus-accent-light)_100%,var(--solus-accent)_14%)]"
              onclick={() => queue.requeueFailed()}
              use:tooltip={"Stage the failed PRs for another run"}
            >
              Re-queue {queue.failedNumbers.length} failed
            </button>
          {/if}
          <button
            type="button"
            class="{smallBtnClass} bg-transparent text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)"
            onclick={() => queue.clear()}
          >
            Clear
          </button>
        </div>
      {/if}
    </div>

    <!-- Entries -->
    <ul
      class="flex max-h-56 flex-col overflow-y-auto px-2 pb-1 [scrollbar-width:thin]"
      role="list"
      aria-label="Merge queue"
    >
      {#if run}
        {#each run.entries as entry, i (entry.number)}
          <li
            class="flex flex-col gap-1 rounded-lg px-2 py-1.5 {run.currentIndex === i && !finished
              ? 'bg-(--solus-accent-light)'
              : ''}"
          >
            <div class="flex items-center gap-2">
              {@render entryStatusIcon(entry)}
              <span class="shrink-0 text-[0.6875rem] tabular-nums text-(--solus-text-tertiary)">
                #{entry.number}
              </span>
              <span class="min-w-0 flex-1 truncate text-[0.75rem] text-(--solus-text-primary)">
                {entry.title}
              </span>
              <span class="shrink-0 text-[0.625rem] text-(--solus-text-tertiary)">
                {ENTRY_STATUS_LABELS[entry.status]}
              </span>
            </div>
            {#if entry.status === "conflicts"}
              <div class="flex items-center gap-1.5 pl-[1.3125rem]">
                <span class="min-w-0 flex-1 truncate text-[0.6875rem] text-(--solus-text-tertiary)">
                  {entry.conflictFiles?.length ?? 0} conflicted
                  {(entry.conflictFiles?.length ?? 0) === 1 ? "file" : "files"}
                </span>
                <button
                  type="button"
                  class="{smallBtnClass} bg-(--solus-accent-light) text-(--solus-accent) hover:bg-[color-mix(in_srgb,var(--solus-accent-light)_100%,var(--solus-accent)_14%)]"
                  disabled={spawningResolver}
                  onclick={() => void resolveWithAgent(entry)}
                >
                  <GitMergeIcon size={11} weight="bold" />
                  {spawningResolver ? "Opening session…" : "Resolve with agent"}
                </button>
                <button
                  type="button"
                  class="{smallBtnClass} bg-transparent text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)"
                  onclick={() => void queue.skip(session.ctx)}
                  use:tooltip={"Skip this PR and continue"}
                >
                  <SkipForwardIcon size={11} weight="bold" />
                  Skip
                </button>
              </div>
            {:else if entry.detail && (entry.status === "failed" || entry.status === "skipped")}
              <p class="pl-[1.3125rem] text-[0.6875rem] leading-snug text-(--solus-text-tertiary)">
                {entry.detail}
              </p>
            {/if}
          </li>
        {/each}
      {:else}
        {#each stagedItems as item, i (item.number)}
          <li class="group/queued flex items-center gap-2 rounded-lg px-2 py-1.5">
            <span class="w-4 shrink-0 text-right text-[0.6875rem] tabular-nums text-(--solus-text-tertiary)">
              {i + 1}
            </span>
            <span class="shrink-0 text-[0.6875rem] tabular-nums text-(--solus-text-tertiary)">
              #{item.number}
            </span>
            <span class="min-w-0 flex-1 truncate text-[0.75rem] text-(--solus-text-primary)">
              {item.title}
            </span>
            <button
              type="button"
              class="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-(--solus-text-tertiary) opacity-0 transition-[background-color,color,opacity] duration-100 group-hover/queued:opacity-100 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:opacity-100"
              onclick={() => queue.toggle(item.number)}
              aria-label="Remove from queue"
            >
              <XIcon size={12} />
            </button>
          </li>
        {/each}
      {/if}
    </ul>

    <!-- Staging controls -->
    {#if staging}
      <div class="flex items-center gap-1.5 px-4 pt-0.5 pb-3">
        <div class="flex min-w-0 gap-0.5">
          {#each [
            { value: "auto" as MergeOrderMode, label: "Auto order" },
            { value: "manual" as MergeOrderMode, label: "Queued order" },
          ] as opt (opt.value)}
            <button
              type="button"
              class="inline-flex cursor-pointer items-center whitespace-nowrap rounded-lg border-0 px-2 py-1 text-[0.6875rem] transition-[background-color,color] duration-100 ease-in-out {orderMode === opt.value
                ? 'bg-(--solus-accent-light) text-(--solus-accent)'
                : 'bg-transparent text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-secondary)'}"
              onclick={() => (orderMode = opt.value)}
              aria-pressed={orderMode === opt.value}
              use:tooltip={opt.value === "auto"
                ? "Least-conflicting PRs merge first"
                : "Merge in the order queued"}
            >
              {opt.label}
            </button>
          {/each}
        </div>
        <div class="relative ml-auto flex shrink-0 items-center">
          <button
            type="button"
            bind:this={methodTriggerEl}
            class="inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-md border border-(--solus-container-border) bg-(--solus-input-bg-soft) px-2 py-[0.1875rem] text-[0.6875rem] text-(--solus-text-secondary) outline-none transition-[border-color] duration-100 ease-in-out focus-visible:border-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]"
            aria-label="Merge method"
            onclick={() => (methodMenuOpen = !methodMenuOpen)}
          >
            <span>{methodLabel}</span>
            <CaretDownIcon size={9} class="shrink-0 text-(--solus-text-tertiary)" />
          </button>
          <Dropdown
            bind:open={methodMenuOpen}
            triggerEl={methodTriggerEl}
            align="top"
            anchor="right"
            width={136}
          >
            <div class="py-1" role="listbox" aria-label="Merge method">
              {#each METHOD_OPTIONS as opt (opt.value)}
                <DropdownItem
                  selected={method === opt.value}
                  onclick={() => {
                    method = opt.value;
                    methodMenuOpen = false;
                  }}
                >
                  {opt.label}
                </DropdownItem>
              {/each}
            </div>
          </Dropdown>
        </div>
        <button
          type="button"
          class="{smallBtnClass} shrink-0 bg-(--solus-accent-light) text-(--solus-accent) hover:bg-[color-mix(in_srgb,var(--solus-accent-light)_100%,var(--solus-accent)_14%)]"
          disabled={queue.starting}
          onclick={startRun}
        >
          <PlayIcon size={11} weight="fill" />
          {queue.starting ? "Starting…" : "Start merging"}
        </button>
      </div>
    {/if}

    {#if queue.error}
      <p class="px-4 pb-2.5 text-[0.6875rem] leading-snug text-(--solus-art-negative)">
        {queue.error}
      </p>
    {/if}
  </div>
{/if}
