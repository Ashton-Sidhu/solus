<script lang="ts">
  import {
    CaretDownIcon,
    CheckCircleIcon,
    CircleNotchIcon,
    GitMergeIcon,
    QueueIcon,
    SkipForwardIcon,
    WarningCircleIcon,
  } from "phosphor-svelte";
  import type { MergeMethod } from "../../../shared/types";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { buildConflictResolutionPrompt } from "../../lib/merge-queue-utils";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { tooltip } from "../../lib/tooltip";
  import Dropdown from "../ui/Dropdown.svelte";
  import DropdownItem from "../ui/DropdownItem.svelte";

  // Merge action for a single PR, backed by the merge queue as a run of one —
  // same conflict handling (pause, resolve with an agent, resume) as a batch
  // run, and the same live state broadcast. The parent decides visibility
  // (open, non-draft PRs only); this component covers idle → merging →
  // conflicts → merged, and defers to an already-running queue.
  // Only the PR's number + title are needed — the merge queue creates and owns
  // its own worktree, so this works pre-review (from the list) too.
  let { pr }: { pr: { number: number; title: string } } = $props();

  const session = getWorkspaceContext();
  const queue = session.mergeQueueStore;

  let method = $state<MergeMethod>("merge");
  let menuOpen = $state(false);
  let triggerEl = $state<HTMLButtonElement | null>(null);
  /** Only while the resolution session is being spawned — see MergeQueuePanel. */
  let spawningResolver = $state(false);

  const METHOD_OPTIONS: {
    value: MergeMethod;
    action: string;
    label: string;
    hint: string;
  }[] = [
    {
      value: "merge",
      action: "Merge pull request",
      label: "Merge commit",
      hint: "Keep every commit, plus a merge commit.",
    },
    {
      value: "squash",
      action: "Squash and merge",
      label: "Squash",
      hint: "Combine everything into one commit.",
    },
    {
      value: "rebase",
      action: "Rebase and merge",
      label: "Rebase",
      hint: "Replay each commit onto the base branch.",
    },
  ];
  const actionLabel = $derived(
    METHOD_OPTIONS.find((o) => o.value === method)?.action ?? "",
  );

  const entry = $derived(queue.entryFor(pr.number));
  /** The running queue is busy with other PRs, so this one can't start. */
  const blocked = $derived(queue.active && !entry);
  const conflictCount = $derived(entry?.conflictFiles?.length ?? 0);

  function merge() {
    void queue.startSingle(
      session.ctx,
      { number: pr.number, title: pr.title },
      method,
    );
  }

  async function resolveWithAgent() {
    if (
      !entry?.worktreePath ||
      !entry.branch ||
      !entry.baseRef ||
      !queue.state
    )
      return;
    spawningResolver = true;
    try {
      await session.startNewSessionWithPrompt(
        buildConflictResolutionPrompt(entry),
        queue.state.repoRoot,
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

{#if entry && queue.active}
  <!-- Live status while the queue is working this PR -->
  {#if entry.status === "conflicts"}
    <div class="flex flex-col gap-2">
      <div
        class="flex items-start gap-1.5 text-[0.75rem] leading-4 text-(--solus-text-secondary)"
      >
        <WarningCircleIcon
          size={13}
          weight="fill"
          class="mt-px shrink-0 text-(--solus-art-negative)"
        />
        <p>
          Merge conflicts in {conflictCount || "some"}
          {conflictCount === 1 ? "file" : "files"}.
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          class="{smallBtnClass} bg-(--solus-accent-light) text-(--solus-accent) hover:bg-[color-mix(in_srgb,var(--solus-accent-light)_100%,var(--solus-accent)_14%)]"
          disabled={spawningResolver}
          onclick={() => void resolveWithAgent()}
        >
          <GitMergeIcon size={11} weight="bold" class="shrink-0" />
          {spawningResolver ? "Opening session…" : "Resolve with agent"}
        </button>
        <button
          type="button"
          class="{smallBtnClass} bg-transparent text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)"
          onclick={() => void queue.skip(session.ctx)}
          use:tooltip={"Give up on this merge"}
        >
          <SkipForwardIcon size={11} weight="bold" class="shrink-0" />
          Skip
        </button>
      </div>
    </div>
  {:else if entry.status === "merging"}
    <div
      class="flex items-center gap-1.5 text-[0.75rem] font-medium text-(--solus-text-secondary)"
    >
      <CircleNotchIcon
        size={13}
        class="shrink-0 animate-spin text-(--solus-accent) [animation-duration:0.9s]"
      />
      Merging…
    </div>
  {:else}
    <div
      class="flex items-center gap-1.5 text-[0.75rem] font-medium text-(--solus-text-secondary)"
    >
      <QueueIcon size={13} weight="bold" class="shrink-0 text-(--solus-accent)" />
      Queued to merge…
    </div>
  {/if}
{:else if entry?.status === "merged"}
  <div
    class="flex items-center gap-1.5 text-[0.75rem] font-medium text-(--solus-art-positive)"
  >
    <CheckCircleIcon size={13} weight="fill" class="shrink-0" />
    Merged
  </div>
{:else}
  <div class="flex flex-col gap-1.5">
    {#if entry?.status === "failed" && entry.detail}
      <p class="text-[0.6875rem] leading-4 text-(--solus-art-negative)">
        {entry.detail}
      </p>
    {/if}
    <div
      class="flex w-full items-stretch overflow-hidden rounded-lg bg-(--solus-accent)"
    >
      <button
        type="button"
        class="inline-flex min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 border-0 bg-transparent px-3 py-1.5 text-[0.75rem] font-semibold text-(--solus-on-accent,#fff) transition-[background-color] duration-100 hover:bg-white/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white/60 disabled:cursor-not-allowed disabled:opacity-60"
        disabled={blocked || queue.starting}
        onclick={merge}
      >
        <GitMergeIcon size={13} weight="bold" class="shrink-0" />
        <span class="truncate">
          {queue.starting ? "Starting…" : actionLabel}
        </span>
      </button>
      <span class="my-1 w-px shrink-0 bg-white/30" aria-hidden="true"></span>
      <button
        type="button"
        bind:this={triggerEl}
        class="inline-flex cursor-pointer items-center border-0 bg-transparent px-1.5 text-(--solus-on-accent,#fff) transition-[background-color] duration-100 hover:bg-white/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white/60 disabled:cursor-not-allowed disabled:opacity-60"
        disabled={blocked || queue.starting}
        aria-label="Merge method"
        onclick={() => (menuOpen = !menuOpen)}
      >
        <CaretDownIcon size={11} weight="bold" class="shrink-0" />
      </button>
    </div>
    <Dropdown
      bind:open={menuOpen}
      {triggerEl}
      align="top"
      anchor="right"
      width={220}
    >
      <div class="py-1" role="listbox" aria-label="Merge method">
        {#each METHOD_OPTIONS as opt (opt.value)}
          <DropdownItem
            selected={method === opt.value}
            onclick={() => {
              method = opt.value;
              menuOpen = false;
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
    {#if blocked}
      <p class="text-[0.6875rem] leading-4 text-(--solus-text-tertiary)">
        A merge queue run is already in progress.
      </p>
    {/if}
    {#if queue.error}
      <p class="text-[0.6875rem] leading-4 text-(--solus-art-negative)">
        {queue.error}
      </p>
    {/if}
  </div>
{/if}
