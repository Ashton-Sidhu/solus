<script lang="ts">
  import { CodeIcon } from "phosphor-svelte";
  import { getWorkspaceContext } from "../../contexts";
  import { diffSummaryStore } from "./diff-summary.store.svelte";

  interface Props {
    tabId: string;
    changedFiles: string[];
    onOpenDiff?: () => void;
  }
  let { tabId, changedFiles, onOpenDiff }: Props = $props();

  const session = getWorkspaceContext();

  // Counts live in git, not in the transcript, so they're fetched — but only
  // when the changed-file set actually moves.
  $effect(() => diffSummaryStore.refresh(session, tabId, changedFiles));

  const stats = $derived(diffSummaryStore.statsFor(tabId));
  // Paths always come from the session; counts join on when git has answered.
  const rows = $derived(
    changedFiles.map((path) => {
      const stat = stats.find((s) => s.path === path);
      return { path, additions: stat?.additions ?? 0, deletions: stat?.deletions ?? 0 };
    }),
  );
  const total = $derived(rows.length);
  // Never a scroller: over 8 files the card collapses to the count line plus a
  // Show all row.
  const VISIBLE = 8;
  const visible = $derived(rows.slice(0, VISIBLE));
  const overflow = $derived(Math.max(0, total - VISIBLE));
  // Totals only earn the header once the list stops showing all of itself.
  const showTotals = $derived(total > VISIBLE);
  const totalAdditions = $derived(rows.reduce((n, r) => n + r.additions, 0));
  const totalDeletions = $derived(rows.reduce((n, r) => n + r.deletions, 0));
</script>

{#if total > 0}
  <!-- The one card with no kicker and no title. -->
  <div class="diff-summary rounded-xl px-[0.8125rem] py-[0.6875rem]" data-testid="diff-summary">
    <div class="mb-[0.4375rem] flex items-center gap-2">
      <CodeIcon size={12} class="shrink-0 text-(--muted-foreground) opacity-70" />
      <span class="text-[0.71875rem] text-(--muted-foreground)">
        {total} file{total === 1 ? "" : "s"} changed
      </span>
      <span class="flex-1"></span>
      {#if showTotals}
        <span class="diff-add tabular-nums">+{totalAdditions}</span>
        <span class="diff-del tabular-nums" class:is-zero={totalDeletions === 0}>−{totalDeletions}</span>
      {/if}
    </div>

    <div class="flex flex-col gap-[0.3125rem]">
      {#each visible as row (row.path)}
        <div class="flex items-center gap-2.5">
          <!-- Truncate from the left so the filename survives. -->
          <span class="diff-path font-mono truncate">{row.path}</span>
          <span class="flex-1"></span>
          <span class="diff-add tabular-nums" class:is-zero={row.additions === 0}>+{row.additions}</span>
          <span class="diff-del tabular-nums" class:is-zero={row.deletions === 0}>−{row.deletions}</span>
        </div>
      {/each}
    </div>

    {#if overflow > 0}
      <div class="diff-overflow mt-[0.5625rem] flex items-center gap-2 pt-[0.5625rem]">
        <span class="text-[0.71875rem] text-(--muted-foreground)">{overflow} more file{overflow === 1 ? "" : "s"}</span>
        <span class="flex-1"></span>
        {#if onOpenDiff}
          <button type="button" class="diff-show-all" onclick={onOpenDiff}>Show all</button>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .diff-summary {
    max-width: 41.25rem;
    background: var(--card);
    box-shadow: var(--solus-tx-hairline);
  }

  .diff-path {
    min-width: 0;
    font-size: 0.75rem;
    /* rtl + left alignment truncates the *start* of the path, keeping the
       filename — the part that identifies the row. */
    direction: rtl;
    text-align: left;
  }

  /* The only place in the transcript where colour carries meaning rather than
     depth: a sign alone is too quiet to scan down a list. */
  .diff-add,
  .diff-del {
    flex-shrink: 0;
    font-size: 0.71875rem;
    font-variant-numeric: tabular-nums;
  }
  .diff-add {
    color: var(--chart-3);
  }
  .diff-del {
    color: var(--destructive);
  }
  .diff-add.is-zero,
  .diff-del.is-zero {
    color: inherit;
    opacity: 0.3;
  }

  .diff-overflow {
    border-top: 0.0625rem solid var(--solus-tx-rule);
  }

  .diff-show-all {
    border: none;
    background: transparent;
    padding: 0;
    color: var(--solus-text-primary);
    font-size: 0.71875rem;
    font-weight: 500;
    cursor: pointer;
  }
  .diff-show-all:hover {
    text-decoration: underline;
    text-underline-offset: 0.15625rem;
  }
</style>
