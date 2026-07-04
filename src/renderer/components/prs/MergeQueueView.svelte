<script lang="ts">
  import {
    ArrowLeftIcon,
    CaretDownIcon,
    CaretUpIcon,
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
  import Kbd from "../ui/Kbd.svelte";
  import {
    PAGE_GHOST_BTN,
    PAGE_ICON_BTN,
    PAGE_PRIMARY_BTN,
  } from "../../lib/page-chrome";
  import {
    buildConflictResolutionPrompt,
    ENTRY_STATUS_LABELS,
  } from "../../lib/merge-queue-utils";

  // The merge queue's dedicated surface, shown in the PRs page's main pane.
  // Three states: an empty explainer, the staged list (reorder / remove /
  // order + method controls / start), and the live run timeline with conflict
  // actions and a finished summary.
  let { onClose }: { onClose: () => void } = $props();

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

  const METHOD_OPTIONS: { value: MergeMethod; label: string; hint: string }[] = [
    { value: "merge", label: "Merge commit", hint: "Keep every commit, plus a merge commit." },
    { value: "squash", label: "Squash", hint: "Combine everything into one commit." },
    { value: "rebase", label: "Rebase", hint: "Replay each commit onto the base branch." },
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
    queue.queued.map((number) => {
      const pr = prsStore.get(number);
      return {
        number,
        title: pr?.title ?? `#${number}`,
        author: pr?.author ?? "",
        additions: pr?.additions ?? 0,
        deletions: pr?.deletions ?? 0,
      };
    }),
  );

  const mergedCount = $derived(
    run?.entries.filter((e) => e.status === "merged").length ?? 0,
  );
  /** Entries the run is done with, whatever the outcome — drives the progress bar. */
  const settledCount = $derived(
    run?.entries.filter(
      (e) =>
        e.status === "merged" || e.status === "skipped" || e.status === "failed",
    ).length ?? 0,
  );
  const failedCount = $derived(
    run?.entries.filter((e) => e.status === "failed").length ?? 0,
  );
  const progressPct = $derived(
    run && run.entries.length > 0
      ? Math.round((settledCount / run.entries.length) * 100)
      : 0,
  );

  const runTitle = $derived.by(() => {
    if (!run) return "";
    if (run.status === "cancelled") return "Run cancelled";
    if (run.status === "done")
      return failedCount > 0 ? "Run finished" : "All merged";
    if (run.status === "waiting") return "Waiting on conflicts";
    return "Merging…";
  });

  function startRun() {
    void queue.start(
      session.ctx,
      stagedItems.map(({ number, title }) => ({ number, title })),
      orderMode,
      method,
    );
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
  const rowIconBtnClass =
    "inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-(--solus-text-tertiary) opacity-0 transition-[background-color,color,opacity] duration-100 group-hover/row:opacity-100 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-0";
</script>

{#snippet entryStatusIcon(entry: MergeQueueEntry)}
  {#if entry.status === "merging"}
    <CircleNotchIcon
      size={15}
      class="shrink-0 animate-spin text-(--solus-accent) [animation-duration:0.9s]"
    />
  {:else if entry.status === "conflicts"}
    <WarningCircleIcon
      size={15}
      weight="fill"
      class="shrink-0 text-(--solus-art-negative)"
    />
  {:else if entry.status === "merged"}
    <CheckCircleIcon
      size={15}
      weight="fill"
      class="shrink-0 text-(--solus-art-positive)"
    />
  {:else if entry.status === "skipped"}
    <MinusIcon size={15} weight="bold" class="shrink-0 text-(--solus-text-tertiary)" />
  {:else if entry.status === "failed"}
    <XCircleIcon
      size={15}
      weight="fill"
      class="shrink-0 text-(--solus-art-negative)"
    />
  {:else}
    <span class="grid size-[15px] shrink-0 place-items-center">
      <span class="size-1.5 rounded-full bg-(--solus-art-border)"></span>
    </span>
  {/if}
{/snippet}

<div class="flex min-w-0 flex-1 flex-col overflow-hidden">
  <!-- Header, matching the PR detail breadcrumb bar -->
  <div
    class="flex shrink-0 items-center justify-between gap-3 border-b border-(--solus-popover-border) px-4 py-2"
  >
    <div class="flex min-w-0 items-center gap-2 text-[0.8125rem]">
      <button
        type="button"
        class="{PAGE_ICON_BTN} @min-[44rem]:hidden"
        onclick={onClose}
        aria-label="Back to list"
      >
        <ArrowLeftIcon size={14} />
      </button>
      <QueueIcon size={14} weight="fill" class="shrink-0 text-(--solus-accent)" />
      <span class="font-medium text-(--solus-text-primary)">Merge queue</span>
      {#if run}
        <span class="shrink-0 text-[0.6875rem] tabular-nums text-(--solus-text-tertiary)">
          {mergedCount}/{run.entries.length} merged
        </span>
      {:else if stagedItems.length > 0}
        <span class="shrink-0 text-[0.6875rem] tabular-nums text-(--solus-text-tertiary)">
          {stagedItems.length} staged
        </span>
      {/if}
    </div>
    {#if run && !finished}
      <button
        type="button"
        class="{PAGE_GHOST_BTN} px-2 py-1"
        onclick={() => void queue.cancel(session.ctx)}
      >
        Cancel run
      </button>
    {/if}
  </div>

  <!-- Body -->
  <div class="min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]">
    <div class="mx-auto w-full max-w-[44rem] px-6 py-7">
      {#if run}
        <!-- ── Run: live timeline ── -->
        <div class="flex items-baseline justify-between gap-3">
          <h1
            class="text-[1.125rem] leading-tight font-semibold tracking-tight text-(--solus-text-primary)"
          >
            {runTitle}
          </h1>
          <p class="shrink-0 text-[0.75rem] tabular-nums text-(--solus-text-tertiary)">
            {mergedCount} of {run.entries.length} merged
          </p>
        </div>

        <div class="mt-4 h-1.5 overflow-hidden rounded-full bg-(--solus-art-raised)">
          <div
            class="h-full rounded-full bg-(--solus-accent) transition-[width] duration-300 w-(--queue-progress)"
            style="--queue-progress: {progressPct}%"
          ></div>
        </div>

        <ol
          class="mt-5 flex flex-col divide-y divide-(--solus-art-border) overflow-hidden rounded-xl border border-(--solus-art-border) bg-(--solus-art-surface)"
        >
          {#each run.entries as entry, i (entry.number)}
            <li
              class="flex flex-col gap-1.5 px-4 py-3 {run.currentIndex === i && !finished
                ? 'bg-(--solus-accent-light)'
                : ''}"
            >
              <div class="flex items-center gap-3">
                {@render entryStatusIcon(entry)}
                <div class="min-w-0 flex-1">
                  <p class="truncate text-[0.8125rem] font-medium text-(--solus-text-primary)">
                    {entry.title}
                  </p>
                  <p class="mt-0.5 text-[0.6875rem] tabular-nums text-(--solus-text-tertiary)">
                    #{entry.number}
                  </p>
                </div>
                <span
                  class="shrink-0 text-[0.6875rem] font-medium {entry.status === 'merged'
                    ? 'text-(--solus-art-positive)'
                    : entry.status === 'conflicts' || entry.status === 'failed'
                      ? 'text-(--solus-art-negative)'
                      : entry.status === 'merging'
                        ? 'text-(--solus-accent)'
                        : 'text-(--solus-text-tertiary)'}"
                >
                  {ENTRY_STATUS_LABELS[entry.status]}
                </span>
              </div>
              {#if entry.status === "conflicts"}
                <div class="flex flex-wrap items-center gap-1.5 pl-[1.6875rem]">
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
                    <GitMergeIcon size={11} weight="bold" class="shrink-0" />
                    {spawningResolver ? "Opening session…" : "Resolve with agent"}
                  </button>
                  <button
                    type="button"
                    class="{smallBtnClass} bg-transparent text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)"
                    onclick={() => void queue.skip(session.ctx)}
                    use:tooltip={"Skip this PR and continue"}
                  >
                    <SkipForwardIcon size={11} weight="bold" class="shrink-0" />
                    Skip
                  </button>
                </div>
              {:else if entry.detail && (entry.status === "failed" || entry.status === "skipped")}
                <p class="pl-[1.6875rem] text-[0.6875rem] leading-snug text-(--solus-text-tertiary)">
                  {entry.detail}
                </p>
              {/if}
            </li>
          {/each}
        </ol>

        {#if finished}
          <div class="mt-4 flex items-center gap-1.5">
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
              Clear run
            </button>
          </div>
        {/if}
      {:else if staging}
        <!-- ── Staging: reorderable list + controls ── -->
        <h1
          class="text-[1.125rem] leading-tight font-semibold tracking-tight text-(--solus-text-primary)"
        >
          {stagedItems.length} pull {stagedItems.length === 1
            ? "request"
            : "requests"} staged
        </h1>
        <p class="mt-1.5 text-[0.8125rem] leading-relaxed text-(--solus-text-tertiary)">
          PRs merge one at a time; the queue pauses on conflicts so an agent can
          resolve them.
        </p>

        <ul
          class="mt-5 flex flex-col divide-y divide-(--solus-art-border) overflow-hidden rounded-xl border border-(--solus-art-border) bg-(--solus-art-surface)"
          role="list"
          aria-label="Staged pull requests"
        >
          {#each stagedItems as item, i (item.number)}
            <li class="group/row flex items-center gap-3 px-4 py-3">
              <span
                class="grid size-6 shrink-0 place-items-center rounded-full bg-(--solus-accent-light) text-[0.6875rem] font-semibold tabular-nums text-(--solus-accent)"
              >
                {i + 1}
              </span>
              <div class="min-w-0 flex-1">
                <p class="truncate text-[0.8125rem] font-medium text-(--solus-text-primary)">
                  {item.title}
                </p>
                <p class="mt-0.5 text-[0.6875rem] tabular-nums text-(--solus-text-tertiary)">
                  #{item.number}{item.author ? ` · ${item.author}` : ""}
                </p>
              </div>
              {#if item.additions > 0 || item.deletions > 0}
                <div class="flex shrink-0 items-center gap-1 text-[0.625rem] tabular-nums">
                  <span class="text-(--solus-art-positive)">+{item.additions}</span>
                  <span class="text-(--solus-art-negative)">-{item.deletions}</span>
                </div>
              {/if}
              <div class="flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  class={rowIconBtnClass}
                  disabled={i === 0}
                  onclick={() => queue.move(item.number, -1)}
                  aria-label="Move up"
                >
                  <CaretUpIcon size={12} weight="bold" />
                </button>
                <button
                  type="button"
                  class={rowIconBtnClass}
                  disabled={i === stagedItems.length - 1}
                  onclick={() => queue.move(item.number, 1)}
                  aria-label="Move down"
                >
                  <CaretDownIcon size={12} weight="bold" />
                </button>
                <button
                  type="button"
                  class={rowIconBtnClass}
                  onclick={() => queue.toggle(item.number)}
                  aria-label="Remove from queue"
                >
                  <XIcon size={12} />
                </button>
              </div>
            </li>
          {/each}
        </ul>

        <!-- Controls -->
        <div class="mt-4 flex flex-wrap items-center gap-2">
          <!-- Segmented order toggle — same recessed-track treatment as
               <SegmentedControl>, inlined so each segment keeps its tooltip. -->
          <div
            class="flex shrink-0 items-center gap-0.5 rounded-full bg-(--solus-surface-hover) p-0.5"
            role="group"
            aria-label="Merge order"
          >
            {#each [
              { value: "auto" as MergeOrderMode, label: "Auto order" },
              { value: "manual" as MergeOrderMode, label: "Queued order" },
            ] as opt (opt.value)}
              <button
                type="button"
                class="inline-flex cursor-pointer items-center whitespace-nowrap rounded-full border-0 px-2.5 py-1 text-[0.6875rem] font-medium transition-[background-color,color] duration-100 ease-in-out focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] {orderMode === opt.value
                  ? 'bg-(--solus-input-pill-bg) text-(--solus-text-primary) shadow-[0_0.0625rem_0.1875rem_rgba(0,0,0,0.08)] ring-1 ring-black/5 dark:shadow-none dark:ring-white/10'
                  : 'bg-transparent text-(--solus-text-tertiary) hover:text-(--solus-text-secondary)'}"
                onclick={() => (orderMode = opt.value)}
                aria-pressed={orderMode === opt.value}
                use:tooltip={opt.value === "auto"
                  ? "Least-conflicting PRs merge first"
                  : "Merge in the order above"}
              >
                {opt.label}
              </button>
            {/each}
          </div>
          <div class="relative flex shrink-0 items-center">
            <button
              type="button"
              bind:this={methodTriggerEl}
              class="{PAGE_GHOST_BTN} px-2 py-1"
              aria-label="Merge method"
              aria-haspopup="listbox"
              aria-expanded={methodMenuOpen}
              onclick={() => (methodMenuOpen = !methodMenuOpen)}
            >
              <span>{methodLabel}</span>
              <CaretDownIcon size={9} class="shrink-0" />
            </button>
            <Dropdown
              bind:open={methodMenuOpen}
              triggerEl={methodTriggerEl}
              align="top"
              anchor="left"
              width={220}
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
                    <div class="flex min-w-0 flex-col gap-0.5 py-0.5">
                      <div class="text-[0.6875rem] text-(--solus-text-primary)">
                        {opt.label}
                      </div>
                      <div class="text-[0.625rem] leading-3.5 text-(--solus-text-tertiary)">
                        {opt.hint}
                      </div>
                    </div>
                  </DropdownItem>
                {/each}
              </div>
            </Dropdown>
          </div>
          <button
            type="button"
            class="{PAGE_PRIMARY_BTN} ml-auto disabled:cursor-not-allowed disabled:opacity-50"
            disabled={queue.starting}
            onclick={startRun}
          >
            <PlayIcon size={12} weight="fill" class="shrink-0" />
            {queue.starting ? "Starting…" : "Start merging"}
          </button>
        </div>

        {#if queue.error}
          <p class="mt-3 text-[0.6875rem] leading-4 text-(--solus-art-negative)">
            {queue.error}
          </p>
        {/if}
      {:else}
        <!-- ── Empty ── -->
        <div class="flex flex-col items-center gap-1 py-16 text-center">
          <QueueIcon
            size={36}
            weight="fill"
            class="mb-3 text-(--solus-text-tertiary) opacity-40"
          />
          <p class="text-[0.8125rem] font-semibold text-(--solus-text-primary)">
            No pull requests queued
          </p>
          <p class="max-w-[24rem] text-[0.75rem] leading-relaxed text-(--solus-text-tertiary)">
            Stage open pull requests with <Kbd variant="hint">⌥Q</Kbd> or the
            queue button on each row. The queue merges them one at a time and
            pauses on conflicts so an agent can resolve them.
          </p>
        </div>
      {/if}
    </div>
  </div>
</div>
