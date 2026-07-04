<script lang="ts">
  import { CaretRightIcon, CircleNotchIcon, QueueIcon } from "phosphor-svelte";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { tooltip } from "../../lib/tooltip";

  // Slim nav row pinned under the PR list. Opens the merge queue's dedicated
  // view in the main pane; carries a staged-count badge and, during a run, a
  // spinner + mini progress bar so activity is visible from anywhere on the page.
  let { active, onclick }: { active: boolean; onclick: () => void } = $props();

  const session = getWorkspaceContext();
  const queue = session.mergeQueueStore;

  const run = $derived(queue.state);
  const runActive = $derived(queue.active);
  const mergedCount = $derived(
    run?.entries.filter((e) => e.status === "merged").length ?? 0,
  );
  const settledCount = $derived(
    run?.entries.filter(
      (e) =>
        e.status === "merged" || e.status === "skipped" || e.status === "failed",
    ).length ?? 0,
  );
  const progressPct = $derived(
    run && run.entries.length > 0
      ? Math.round((settledCount / run.entries.length) * 100)
      : 0,
  );
</script>

<div class="flex shrink-0 flex-col gap-1.5 border-t border-(--solus-popover-border) p-2">
  <button
    type="button"
    class="flex w-full cursor-pointer items-center gap-2 rounded-[0.625rem] border-0 px-2.5 py-2 text-left transition-[background-color] duration-100 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] {active
      ? 'bg-(--solus-accent-light)'
      : 'bg-transparent hover:bg-(--solus-surface-hover)'}"
    {onclick}
    aria-pressed={active}
    use:tooltip={"Merge queue (⌥M)"}
  >
    <QueueIcon
      size={14}
      weight="bold"
      class="shrink-0 {active || runActive
        ? 'text-(--solus-accent)'
        : 'text-(--solus-text-tertiary)'}"
    />
    <span
      class="text-[0.75rem] font-semibold {active
        ? 'text-(--solus-accent)'
        : 'text-(--solus-text-primary)'}"
    >
      Merge queue
    </span>
    {#if run}
      {#if runActive}
        <CircleNotchIcon
          size={12}
          class="shrink-0 animate-spin text-(--solus-accent) [animation-duration:0.9s]"
        />
      {/if}
      <span class="text-[0.6875rem] tabular-nums text-(--solus-text-tertiary)">
        {mergedCount}/{run.entries.length} merged
      </span>
    {:else if queue.queued.length > 0}
      <span
        class="grid h-[1.125rem] min-w-[1.125rem] place-items-center rounded-full bg-(--solus-accent-light) px-1 text-[0.625rem] font-semibold tabular-nums text-(--solus-accent)"
      >
        {queue.queued.length}
      </span>
    {/if}
    <CaretRightIcon
      size={11}
      weight="bold"
      class="ml-auto shrink-0 text-(--solus-text-tertiary)"
    />
  </button>
  {#if runActive}
    <div class="mx-1 mb-0.5 h-1 overflow-hidden rounded-full bg-(--solus-art-raised)">
      <div
        class="h-full rounded-full bg-(--solus-accent) transition-[width] duration-300 w-(--queue-progress)"
        style="--queue-progress: {progressPct}%"
      ></div>
    </div>
  {/if}
</div>
