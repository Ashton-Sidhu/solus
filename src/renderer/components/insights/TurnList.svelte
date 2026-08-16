<script lang="ts">
  import { CaretRightIcon } from "phosphor-svelte";
  import { formatClock, formatCost, formatDuration, formatTokens, shortModel, singleLine } from "./lib/format";
  import {
    countByStatus,
    groupBySession,
    p95Duration,
    sortTurns,
    type TurnRow,
    type TurnSort,
    type TurnSortKey,
    type TurnStatusFilter,
  } from "./lib/turn-rows";

  /**
   * The turn listing: one row per turn, grouped by session on request.
   *
   * A latency above the visible rows' p95 is the one coloured number in the
   * table — everything else stays neutral so the outlier is the thing the eye
   * lands on. Clicking a row opens its waterfall; clicking the session id opens
   * the session instead, because those are different questions.
   */
  interface Props {
    rows: TurnRow[];
    sort: TurnSort;
    onSortChange: (sort: TurnSort) => void;
    statusFilter: TurnStatusFilter | null;
    onStatusFilterChange: (status: TurnStatusFilter | null) => void;
    grouped: boolean;
    onGroupedChange: (grouped: boolean) => void;
    selectedTraceId: string | null;
    onOpenTurn: (row: TurnRow) => void;
    onOpenSession: (sessionId: string) => void;
    /** Shown under the empty state — why nothing matched, in the user's terms. */
    emptyHint: string;
  }

  let {
    rows,
    sort,
    onSortChange,
    statusFilter,
    onStatusFilterChange,
    grouped,
    onGroupedChange,
    selectedTraceId,
    onOpenTurn,
    onOpenSession,
    emptyHint,
  }: Props = $props();

  let collapsed = $state<Record<string, boolean>>({});

  const counts = $derived(countByStatus(rows));
  const filtered = $derived(
    statusFilter ? rows.filter((row) => row.status === statusFilter) : rows,
  );
  const sorted = $derived(sortTurns(filtered, sort));
  const groups = $derived(grouped ? groupBySession(sorted) : []);
  const p95 = $derived(p95Duration(rows));

  const STATUS_FILTERS: { id: TurnStatusFilter; label: string }[] = [
    { id: "ok", label: "Succeeded" },
    { id: "error", label: "Failed" },
    { id: "interrupted", label: "Interrupted" },
  ];

  const HEADS: { key: TurnSortKey; label: string; align: "start" | "end" }[] = [
    { key: "startedAt", label: "Time", align: "start" },
    { key: "prompt", label: "Prompt", align: "start" },
    { key: "sessionId", label: "Session", align: "start" },
    { key: "model", label: "Model", align: "start" },
    { key: "durationMs", label: "Duration", align: "end" },
    { key: "costUsd", label: "Cost", align: "end" },
    { key: "tokens", label: "Tokens", align: "end" },
  ];

  const columns = $derived(
    grouped
      ? "6.5rem minmax(0,1fr) 6rem 6.5rem 5.125rem 4.375rem 4.125rem"
      : "3.875rem minmax(0,1fr) 6rem 6.5rem 5.125rem 4.375rem 4.125rem",
  );

  function toggleSort(key: TurnSortKey): void {
    onSortChange({
      key,
      dir: sort.key === key && sort.dir === "desc" ? "asc" : "desc",
    });
  }

  function rowBackground(row: TurnRow): string {
    if (row.traceId === selectedTraceId) return "var(--wash-3)";
    if (row.status === "error") return "color-mix(in oklch, var(--failure) 7%, transparent)";
    if (row.status === "interrupted") return "color-mix(in oklch, var(--warning) 8%, transparent)";
    return "transparent";
  }

  function durationColor(row: TurnRow): string {
    if (row.status === "error") return "var(--failure)";
    if (p95 != null && row.durationMs != null && row.durationMs >= p95) return "var(--warning)";
    return "var(--foreground)";
  }

  const statusLabels: Record<string, string> = {
    error: "failed",
    interrupted: "stopped",
    unknown: "open",
  };
</script>

{#snippet turnRow(row: TurnRow, indent: number)}
  <div
    class="grid cursor-pointer items-center gap-4 px-4 transition-colors hover:bg-muted"
    style="grid-template-columns:{columns};height:2.375rem;background:{rowBackground(
      row,
    )};box-shadow:inset 0 -0.5px 0 var(--hairline)"
    role="button"
    tabindex="0"
    onclick={() => onOpenTurn(row)}
    onkeydown={(event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onOpenTurn(row);
      }
    }}
  >
    <span class="text-xs tabular-nums" style="padding-left:{indent}px"
      >{formatClock(row.startedAt)}</span
    >
    <span class="flex min-w-0 items-center gap-2.5">
      <span
        class="truncate text-[0.8125rem]"
        style="font-weight:{row.traceId === selectedTraceId ? 500 : 400}"
        title={row.prompt}>{singleLine(row.prompt) || "—"}</span
      >
      {#if row.status !== "ok"}
        <span
          class="shrink-0 text-[0.625rem] font-medium uppercase"
          style="color:{row.status === 'error' ? 'var(--failure)' : 'var(--warning)'}"
          >{statusLabels[row.status] ?? row.status}</span
        >
      {/if}
    </span>
    {#if grouped}
      <span></span>
    {:else}
      <button
        type="button"
        class="cursor-pointer truncate text-left text-xs text-(--primary) transition-colors hover:underline"
        onclick={(event) => {
          event.stopPropagation();
          if (row.sessionId) onOpenSession(row.sessionId);
        }}
        disabled={!row.sessionId}>{row.sessionId ?? "—"}</button
      >
    {/if}
    <span class="truncate text-xs">{shortModel(row.model)}</span>
    <span class="text-right text-xs tabular-nums" style="color:{durationColor(row)}"
      >{formatDuration(row.durationMs)}</span
    >
    <span class="text-right text-xs tabular-nums">{formatCost(row.costUsd)}</span>
    <span class="text-right text-xs tabular-nums"
      >{formatTokens(
        row.inputTokens == null && row.outputTokens == null
          ? null
          : (row.inputTokens ?? 0) + (row.outputTokens ?? 0),
      )}</span
    >
  </div>
{/snippet}

<section
  class="flex min-h-35 flex-1 flex-col overflow-hidden rounded-xl bg-card shadow-[shadow:var(--elev-ring)]"
  aria-label={grouped ? "Sessions" : "Turns"}
>
  <header
    class="flex h-10 shrink-0 items-center gap-3 px-4 shadow-[inset_0_-0.5px_0_var(--hairline)]"
  >
    <h2 class="text-xs font-medium">{grouped ? "Sessions" : "Turns"}</h2>
    <span class="text-[0.6875rem] tabular-nums text-muted-foreground">
      {#if grouped}
        {groups.length} sessions · {sorted.length} turns
      {:else}
        {sorted.length} of {rows.length}
      {/if}
    </span>
    <span class="flex-1"></span>
    {#each STATUS_FILTERS as filter (filter.id)}
      {@const active = statusFilter === filter.id}
      <button
        type="button"
        class="flex h-5.75 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-[0.6875rem] transition-colors hover:bg-muted"
        style="box-shadow:{active ? 'none' : 'var(--elev-ring)'};background:{active
          ? 'var(--wash-3)'
          : 'transparent'};color:{active ? 'var(--foreground)' : 'var(--muted-foreground)'}"
        aria-pressed={active}
        onclick={() => onStatusFilterChange(active ? null : filter.id)}
        >{filter.label}
        <span class="text-[0.625rem] tabular-nums opacity-70">{counts[filter.id]}</span></button
      >
    {/each}
    <span class="h-4 w-px bg-[var(--hairline-strong)]"></span>
    <button
      type="button"
      class="h-5.75 cursor-pointer rounded-full px-2.5 text-[0.6875rem] transition-colors hover:bg-muted"
      style="box-shadow:{grouped ? 'none' : 'var(--elev-ring)'};background:{grouped
        ? 'var(--wash-3)'
        : 'transparent'};color:{grouped ? 'var(--foreground)' : 'var(--muted-foreground)'}"
      aria-pressed={grouped}
      onclick={() => onGroupedChange(!grouped)}>Group by session</button
    >
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto" data-sb>
    <div
      class="sticky top-0 z-10 grid h-7.5 items-center gap-4 bg-card px-4 text-[0.5938rem] font-medium uppercase shadow-[inset_0_-0.5px_0_var(--hairline-strong)]"
      style="grid-template-columns:{columns}"
    >
      {#each HEADS as head (head.key)}
        <button
          type="button"
          class="flex cursor-pointer items-center gap-1 transition-colors hover:text-foreground"
          style="justify-content:{head.align === 'end'
            ? 'flex-end'
            : 'flex-start'};color:{sort.key === head.key
            ? 'var(--foreground)'
            : 'var(--muted-foreground)'}"
          onclick={() => toggleSort(head.key)}
        >
          {grouped && head.key === "sessionId" ? "" : head.label}
          <span class="text-[0.5rem] opacity-90"
            >{sort.key === head.key ? (sort.dir === "asc" ? "▲" : "▼") : ""}</span
          >
        </button>
      {/each}
    </div>

    {#if sorted.length === 0}
      <div class="flex flex-col items-center gap-2 py-16 text-muted-foreground">
        <span class="text-xs">No turns match this query</span>
        <span class="text-[0.625rem]">{emptyHint}</span>
      </div>
    {:else if grouped}
      {#each groups as group (group.sessionId)}
        {@const open = collapsed[group.sessionId] !== true}
        <button
          type="button"
          class="grid h-8.5 w-full cursor-pointer items-center gap-4 bg-[var(--wash-1)] px-4 text-left transition-colors hover:bg-muted"
          style="grid-template-columns:{columns};box-shadow:inset 0 -0.5px 0 var(--hairline),inset 0 0.5px 0 var(--hairline)"
          aria-expanded={open}
          onclick={() =>
            (collapsed = { ...collapsed, [group.sessionId]: open })}
        >
          <span class="flex items-center gap-1.5 text-xs tabular-nums">
            <CaretRightIcon
              size={9}
              weight="bold"
              class="opacity-70 transition-transform duration-150 motion-reduce:transition-none"
              style="transform:rotate({open ? 90 : 0}deg)"
            />
            {group.turns.length}
            {group.turns.length === 1 ? "turn" : "turns"}
          </span>
          <span class="truncate text-[0.8125rem] font-medium">{singleLine(group.latestPrompt)}</span>
          <span class="truncate text-xs">{group.sessionId}</span>
          <span></span>
          <span class="text-right text-xs tabular-nums"
            >{formatDuration(group.totalDurationMs)}</span
          >
          <span class="text-right text-xs tabular-nums">{formatCost(group.totalCostUsd)}</span>
          <span></span>
        </button>
        {#if open}
          {#each group.turns as row (row.traceId)}
            {@render turnRow(row, 14)}
          {/each}
        {/if}
      {/each}
    {:else}
      {#each sorted as row (row.traceId)}
        {@render turnRow(row, 0)}
      {/each}
    {/if}
    <div class="h-3"></div>
  </div>
</section>
