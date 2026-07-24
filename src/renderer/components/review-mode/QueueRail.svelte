<script lang="ts">
  import type { ReviewModeQueueRow } from "./lib/review-mode-model";
  import { reviewOutcomeLabel } from "./lib/review-mode-model";

  let {
    rows,
    remainingMinutes,
    totalMinutes,
    onSelect,
  }: {
    rows: ReviewModeQueueRow[];
    remainingMinutes: number | null;
    totalMinutes: number | null;
    onSelect: (index: number) => void;
  } = $props();
</script>

<aside class="flex min-h-0 w-64 shrink-0 flex-col border-r border-(--solus-container-border)">
  <div class="flex shrink-0 items-center justify-between gap-2 px-3 pt-3 pb-2 text-[0.6875rem] text-(--solus-text-tertiary)">
    <span class="font-semibold tracking-[0.04em] uppercase">Queue</span>
    {#if remainingMinutes !== null && totalMinutes !== null}
      <span class="tabular-nums">{remainingMinutes}m left · {totalMinutes}m total</span>
    {/if}
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
    {#each rows as row, index (row.number)}
      <button
        type="button"
        class="group relative grid min-h-14 w-full grid-cols-[1.25rem_minmax(0,1fr)] gap-2 overflow-hidden rounded-lg px-2 py-2 text-left transition-[background-color,box-shadow,opacity] duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--solus-accent-border) {row.active
          ? 'bg-(--solus-accent-light) shadow-[inset_0_0_0_1px_var(--solus-accent-border)]'
          : 'hover:bg-(--solus-surface-hover)'} {row.outcome && !row.active ? 'opacity-65 hover:opacity-100' : ''}"
        aria-current={row.active ? "true" : undefined}
        aria-label={`Review #${row.number}: ${row.title}`}
        onclick={() => onSelect(index)}
      >
        <span class="flex h-5 items-center justify-center text-[0.6875rem] text-(--solus-text-tertiary) tabular-nums">
          {#if row.outcome}
            <span
              class="size-2 rounded-full {row.outcome === 'approved'
                ? 'bg-(--solus-art-positive)'
                : row.outcome === 'changes_requested'
                  ? 'bg-(--solus-art-negative)'
                  : row.outcome === 'commented'
                    ? 'bg-(--solus-art-5)'
                    : 'bg-(--solus-text-tertiary)'}"
              title={reviewOutcomeLabel(row.outcome)}
            ></span>
          {:else}
            {row.position}
          {/if}
        </span>

        <span class="min-w-0">
          <span class="block truncate text-xs font-medium text-(--solus-text-primary)">{row.title}</span>
          <span class="mt-1 flex min-w-0 items-center gap-1.5 text-[0.625rem] text-(--solus-text-tertiary)">
            <span class="shrink-0 tabular-nums">#{row.number}</span>
            {#if row.band}
              <span
                class="shrink-0 rounded px-1.5 py-px font-medium ring-1 ring-inset {row.band === 'quick'
                  ? 'text-(--solus-art-positive) ring-[color:color-mix(in_srgb,var(--solus-art-positive)_28%,transparent)]'
                  : row.band === 'involved'
                    ? 'text-(--solus-art-negative) ring-[color:color-mix(in_srgb,var(--solus-art-negative)_24%,transparent)]'
                    : 'text-(--solus-accent) ring-(--solus-accent-border)'}"
              >
                {row.band}
              </span>
            {/if}
            {#if row.minutes !== null}
              <span class="shrink-0 tabular-nums">~{row.minutes} min</span>
            {/if}
            {#if row.unresolvedThreads !== null && row.unresolvedThreads > 0}
              <span
                class="ml-auto inline-flex min-w-4 shrink-0 items-center justify-center rounded-full bg-(--solus-status-error-bg) px-1 text-[0.5625rem] font-semibold text-(--solus-status-error) tabular-nums"
                title={`${row.unresolvedThreads} unresolved ${row.unresolvedThreads === 1 ? "thread" : "threads"}`}
              >
                {row.unresolvedThreads}
              </span>
            {/if}
          </span>

          {#if row.pending}
            <span
              class="mt-1.5 flex items-center gap-1.5 text-[0.625rem] {row.flushError ? 'text-(--solus-status-error)' : 'text-(--solus-accent)'}"
              title={row.flushError ?? undefined}
            >
              <span>{row.flushError ? "post failed" : "posting shortly…"}</span>
              {#if !row.flushError}
                <span class="ml-auto text-(--solus-text-tertiary)">undo <kbd class="font-mono">u</kbd></span>
              {/if}
            </span>
          {/if}
        </span>

        {#if row.pending}
          <span class="absolute inset-x-2 bottom-0 h-px overflow-hidden rounded-full bg-(--solus-accent-border)" aria-hidden="true">
            <span
              class="block h-full origin-left bg-(--solus-accent) transition-[width] duration-100 ease-linear"
              style={`width:${row.holdProgress * 100}%`}
            ></span>
          </span>
        {/if}
      </button>
    {/each}
  </div>
</aside>
