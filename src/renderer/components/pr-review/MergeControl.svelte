<script lang="ts">
  import {
    CaretDownIcon,
    CheckCircleIcon,
    CircleNotchIcon,
    GitMergeIcon,
    QueueIcon,
    RobotIcon,
    SkipForwardIcon,
    WarningCircleIcon,
  } from "phosphor-svelte";
  import type { MergeMethod } from "../../../shared/types";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { toasts } from "../../contexts/toast.store.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { tooltip } from "../../lib/tooltip";
  import Dropdown from "../ui/Dropdown.svelte";
  import DropdownItem from "../ui/DropdownItem.svelte";

  // Merge action for a single PR, backed by the merge queue as a run of one —
  // same live state broadcast as a batch run. The parent decides visibility
  // (open, non-draft, non-conflicting PRs only — a conflicting PR shows
  // ResolveConflictsButton instead), so this covers idle → merging → merged.
  // If a merge started here later hits conflicts (the base advanced), we hand
  // off to a resolver session — never morphing into a second in-place UI.
  // The merge queue creates and owns its own worktree, so the action only needs
  // the PR's number/title.
  let { pr }: { pr: { number: number; title: string } } = $props();

  const session = getWorkspaceContext();
  const queue = session.mergeQueueStore;

  let method = $state<MergeMethod>("merge");
  let menuOpen = $state(false);
  let triggerEl = $state<HTMLButtonElement | null>(null);
  /** Only while the resolver session is being spawned. */
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
  const conflictSummary = $derived(
    `Merge conflicts in ${conflictCount || "some"} ${conflictCount === 1 ? "file" : "files"}.`,
  );

  async function merge() {
    try {
      await queue.startSingle(
        session.ctx,
        { number: pr.number, title: pr.title },
        method,
      );
      if (queue.error) toasts.error(queue.error);
    } catch (err) {
      toasts.error(
        `Couldn't start the merge: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function resolveWithAgent() {
    spawningResolver = true;
    try {
      // The queue already paused this PR on conflicts, so the resolver session
      // opens straight into the ready worktree (no prep delay).
      await session.startConflictResolverSession({
        number: pr.number,
        title: pr.title,
      });
    } finally {
      spawningResolver = false;
    }
    requestInputFocus();
  }

  // A merge that just failed surfaces its reason as a toast rather than a growing
  // error row in the PR header — keep the control a single, fixed height.
  let lastFailedDetail = $state<string | null>(null);
  $effect(() => {
    const detail = entry?.status === "failed" ? (entry.detail ?? null) : null;
    if (detail && detail !== lastFailedDetail) toasts.error(detail);
    lastFailedDetail = detail;
  });
</script>

{#if entry && queue.active}
  <!-- Live status while the queue is working this PR -->
  {#if entry.status === "conflicts"}
    <div class="flex h-7 items-center gap-2 whitespace-nowrap">
      <div
        class="flex min-w-0 items-center gap-1.5 text-[0.75rem] text-(--solus-text-secondary)"
      >
        <WarningCircleIcon
          size={13}
          weight="fill"
          class="shrink-0 text-(--solus-art-negative)"
        />
        <span class="truncate">{conflictSummary}</span>
      </div>
      <button
        type="button"
        class="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-[color:color-mix(in_srgb,var(--solus-art-negative)_12%,transparent)] px-3 text-[0.75rem] font-semibold text-(--solus-art-negative) transition-[background-color,scale] duration-100 hover:bg-[color:color-mix(in_srgb,var(--solus-art-negative)_18%,transparent)] active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-70"
        disabled={spawningResolver}
        onclick={() => void resolveWithAgent()}
      >
        {#if spawningResolver}
          <CircleNotchIcon
            size={13}
            class="shrink-0 animate-spin [animation-duration:0.9s]"
          />
        {:else}
          <RobotIcon size={13} weight="bold" class="shrink-0" />
        {/if}
        {spawningResolver ? "Resolving…" : "Resolve conflicts"}
      </button>
      <button
        type="button"
        class="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-transparent px-2 text-[0.75rem] font-medium text-(--solus-text-tertiary) transition-[background-color,color,scale] duration-100 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96]"
        onclick={() => void queue.skip(session.ctx)}
        use:tooltip={"Give up on this merge"}
      >
        <SkipForwardIcon size={12} weight="bold" class="shrink-0" />
        Skip
      </button>
    </div>
  {:else if entry.status === "merging"}
    <div
      class="flex h-7 items-center gap-1.5 text-[0.75rem] font-medium text-(--solus-text-secondary)"
    >
      <CircleNotchIcon
        size={13}
        class="shrink-0 animate-spin text-(--solus-accent) [animation-duration:0.9s]"
      />
      Merging…
    </div>
  {:else}
    <div
      class="flex h-7 items-center gap-1.5 text-[0.75rem] font-medium text-(--solus-text-secondary)"
    >
      <QueueIcon size={13} weight="bold" class="shrink-0 text-(--solus-accent)" />
      Queued to merge…
    </div>
  {/if}
{:else if entry?.status === "merged"}
  <div
    class="flex h-7 items-center gap-1.5 text-[0.75rem] font-medium text-(--solus-art-positive)"
  >
    <CheckCircleIcon size={13} weight="fill" class="shrink-0" />
    Merged
  </div>
{:else}
  <div
    class="flex h-7 items-stretch overflow-hidden rounded-lg bg-(--solus-accent)"
    use:tooltip={blocked ? "A merge queue run is already in progress" : null}
  >
    <button
      type="button"
      class="inline-flex min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 border-0 bg-transparent px-3 py-1.5 text-[0.75rem] font-semibold text-(--solus-on-accent,#fff) transition-[background-color,scale] duration-100 hover:bg-white/10 active:scale-[0.96] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white/60 disabled:cursor-not-allowed disabled:opacity-60"
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
      class="inline-flex cursor-pointer items-center border-0 bg-transparent px-2 text-(--solus-on-accent,#fff) transition-[background-color,scale] duration-100 hover:bg-white/10 active:scale-[0.96] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white/60 disabled:cursor-not-allowed disabled:opacity-60"
      disabled={blocked || queue.starting}
      aria-label="Merge method"
      onclick={() => (menuOpen = !menuOpen)}
    >
      <CaretDownIcon size={11} weight="bold" class="shrink-0" />
    </button>
  </div>
  <Dropdown bind:open={menuOpen} {triggerEl} align="top" anchor="right" width={220}>
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
{/if}
