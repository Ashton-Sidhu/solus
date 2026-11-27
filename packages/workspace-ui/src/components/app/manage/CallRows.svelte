<script lang="ts">
  import { tick, type Snippet } from "svelte";
  import { ChevronRight as OpenIcon, Sparkles as ModelIcon } from "@lucide/svelte";
  import type { AppCallTerm, AppCallView, AppWebhookView } from "@solus/contracts/apps";
  import DataTableEmptyState from "../../insights/data-table/DataTableEmptyState.svelte";
  import DataTableSortIcon from "../../insights/data-table/DataTableSortIcon.svelte";
  import { hasTextSelection } from "../../insights/data-table/table-pointer";
  import { spansMultipleDays } from "../../insights/lib/format";
  import { Button } from "../../ui/button";
  import CallSheet from "./CallSheet.svelte";
  import StateIcon from "./StateIcon.svelte";
  import { appTime } from "../lib/app-view";
  import {
    CALL_LIST_STEP,
    DEFAULT_CALL_COLUMNS,
    callChipText,
    callClockText,
    callMessage,
    callMillisText,
    callRunGroups,
    orderedCalls,
    type CallFieldName,
    type CallFixFacts,
    type CallOrder,
    type CallRunGroup,
  } from "./lib/activity";
  import { callState } from "./lib/states";

  /**
   * The call log as events (docs/plans/apps.md §9.2): one row for each call,
   * with when it started to the millisecond and a document — the operation,
   * its message, and a chip for each field of the columns. A model call has
   * the sparkle in the state slot; a failed or running call has its mark.
   * The Time and Duration heads set the order. A row opens the call in a
   * sheet over the page. The arrow keys, or j and k, move between rows, and
   * Enter opens one. The Activity section gives the log a toolbar; a run's
   * log has none.
   */
  interface Props {
    serverId: string;
    appId: string;
    /** The newest first. */
    calls: readonly AppCallView[];
    /** The webhooks of the app: a webhook caller goes by its declared name. */
    webhooks: AppWebhookView[];
    openCallId: string | null;
    onOpenRun?: (runId: string) => void;
    onAskAgent?: (call: CallFixFacts) => void;
    onFilter?: (term: AppCallTerm) => void;
    onToggleColumn?: (field: CallFieldName) => void;
    columns?: readonly CallFieldName[];
    order?: CallOrder;
    /** The rows stand under the run they belong to. */
    groupByRun?: boolean;
    /** The p95 of the calls in the query, which the sheet sets beside a call's duration. */
    p95Ms?: number | null;
    /** The version that runs now. */
    liveVersion?: number | null;
    /** The controls above the head. */
    toolbar?: Snippet;
    /** What the list shows with no row in view; the plain table message without it. */
    noRows?: Snippet;
    /** Drawn at the left of the rows on a wide pane, over them on a narrow one: the Fields list. */
    aside?: Snippet;
    /** What the log says of its rows: how many, how many failed. */
    summary?: string;
    /** The rows are an older answer, dimmed until the host answers the new query. */
    isStale?: boolean;
    /** What the log says when it has no row. */
    empty?: string;
    /** Asks the host for a larger read. Absent when the host holds no more calls than the log has. */
    onLoadMore?: () => void;
  }
  let {
    serverId,
    appId,
    calls,
    webhooks,
    openCallId = $bindable(),
    onOpenRun,
    onAskAgent,
    onFilter,
    onToggleColumn,
    columns = DEFAULT_CALL_COLUMNS,
    order = $bindable("newest"),
    groupByRun = false,
    p95Ms = null,
    liveVersion = null,
    toolbar,
    noRows,
    aside,
    summary,
    isStale = false,
    empty = "No call is in view.",
    onLoadMore,
  }: Props = $props();

  let shownCount = $state(CALL_LIST_STEP);
  let list = $state<HTMLElement | null>(null);

  const withDay = $derived(spansMultipleDays(calls.map((call) => call.startedAt)));
  const ordered = $derived(orderedCalls(calls, order));
  // An open call stays in view: a point of the chart, or j in the sheet, can open a call past the rows drawn.
  const openIndex = $derived(openCallId === null ? -1 : ordered.findIndex((call) => call.id === openCallId));
  const openCall = $derived(openIndex === -1 ? null : ordered[openIndex]);
  const shown = $derived(ordered.slice(0, Math.max(shownCount, openIndex + 1)));
  const hasHiddenRows = $derived(ordered.length > shown.length);
  const groups = $derived<CallRunGroup[]>(shown.length === 0 ? [] : groupByRun ? callRunGroups(shown) : [{ runId: null, workflow: null, calls: [...shown] }]);

  function rowOf(callId: string): HTMLElement | null {
    return list?.querySelector<HTMLElement>(`[data-call-id="${CSS.escape(callId)}"]`) ?? null;
  }

  // Escape returns the keyboard to the row the sheet was open on, in view.
  async function closeSheet() {
    const callId = openCallId;
    openCallId = null;
    if (callId === null) return;
    await tick();
    const row = rowOf(callId);
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "nearest" });
  }

  function onRowKey(event: KeyboardEvent & { currentTarget: HTMLElement }, callId: string) {
    if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openCallId = callId;
      return;
    }
    const step = event.key === "ArrowDown" || event.key === "j" ? 1 : event.key === "ArrowUp" || event.key === "k" ? -1 : 0;
    if (step === 0) return;
    const rows = [...(list?.querySelectorAll<HTMLElement>("[data-call-row]") ?? [])];
    const next = rows[rows.indexOf(event.currentTarget) + step];
    if (!next) return;
    event.preventDefault();
    next.focus();
  }

  function showMore() {
    if (hasHiddenRows) shownCount += CALL_LIST_STEP;
    else onLoadMore?.();
  }
</script>

<section class="flex min-w-0 flex-col gap-3" aria-label="Calls" data-testid="app-calls">
  {@render toolbar?.()}

  <div class="grid min-w-0 grid-cols-1 items-start gap-x-4 gap-y-4 {aside ? '@min-[52rem]/pane:grid-cols-[12.5rem_minmax(0,1fr)]' : ''}">
  {#if aside}<div class="min-w-0">{@render aside()}</div>{/if}
  <div class="min-w-0" bind:this={list}>
    <div class="flex h-8 min-w-0 items-center gap-2 px-2 shadow-[inset_0_-0.5px_0_var(--hairline-strong)]">
      <span class="w-4 shrink-0" aria-hidden="true"></span>
      <span class="w-4 shrink-0" aria-hidden="true"></span>
      <button
        type="button"
        class="flex min-w-24 shrink-0 cursor-pointer items-center gap-1 rounded text-[10px] leading-3 font-medium tracking-[0.06em] uppercase outline-none hover:text-foreground focus-visible:text-foreground focus-visible:shadow-[0_0_0_2px_color-mix(in_oklch,var(--primary)_30%,transparent)] {order === 'slowest' ? 'text-(--solus-text-tertiary)' : 'text-(--solus-text-secondary)'}"
        aria-label={order === "oldest" ? "Time, the oldest first. Show the newest first" : "Time, the newest first. Show the oldest first"}
        onclick={() => (order = order === "newest" ? "oldest" : "newest")}
      >
        Time<DataTableSortIcon direction={order === "slowest" ? false : order === "oldest" ? "asc" : "desc"} />
      </button>
      <span class="min-w-0 flex-1 truncate text-[10px] leading-3 font-medium tracking-[0.06em] text-(--solus-text-tertiary) uppercase">Document</span>
      <button
        type="button"
        class="flex shrink-0 cursor-pointer items-center gap-1 rounded text-[10px] leading-3 font-medium tracking-[0.06em] uppercase outline-none hover:text-foreground focus-visible:text-foreground focus-visible:shadow-[0_0_0_2px_color-mix(in_oklch,var(--primary)_30%,transparent)] {order === 'slowest' ? 'text-(--solus-text-secondary)' : 'text-(--solus-text-tertiary)'}"
        aria-pressed={order === "slowest"}
        aria-label={order === "slowest" ? "The slowest first. Show the newest first" : "Show the slowest first"}
        onclick={() => (order = order === "slowest" ? "newest" : "slowest")}
      >
        Duration<DataTableSortIcon direction={order === "slowest" ? "desc" : false} />
      </button>
    </div>

    <!-- The app disables selection at the root, so the rows opt back in: a reader must be able to drag an error out of the log. -->
    <div class={["flex min-w-0 flex-col select-text motion-safe:transition-opacity", isStale && "opacity-55"]} aria-busy={isStale}>
      {#each groups as group (group.runId ?? "")}
        {#if groupByRun}
          <div class="flex h-10 min-w-0 items-center gap-3 bg-[var(--wash-1)] px-2 text-[13px] shadow-[inset_0_-0.5px_0_var(--hairline-strong)]" role="presentation">
            {#if group.runId}
              <span class="truncate font-mono text-xs text-foreground">{group.runId}</span>
              <span class="truncate text-(--solus-text-tertiary)">{group.workflow}</span>
            {:else}
              <span class="truncate text-(--solus-text-tertiary)">Not in a run</span>
            {/if}
            <span class="shrink-0 font-mono text-[11.5px] text-(--solus-text-tertiary)">{group.calls.length === 1 ? "1 call" : `${group.calls.length} calls`}</span>
            {#if group.runId && onOpenRun}
              {@const runId = group.runId}
              <Button size="xs" variant="ghost" class="ml-auto" onclick={() => onOpenRun(runId)}>Open run</Button>
            {/if}
          </div>
        {/if}
        {#each group.calls as call (call.id)}
          {@const isOpen = openCallId === call.id}
          {@const message = callMessage(call)}
          <div
            class="flex min-w-0 cursor-pointer items-start gap-2 px-2 py-2.25 outline-none transition-[background-color] focus-visible:shadow-[inset_0_0_0_1.5px_color-mix(in_oklch,var(--primary)_55%,transparent)] {isOpen
              ? 'rounded-lg bg-[var(--wash-3)]'
              : 'shadow-[inset_0_-0.5px_0_var(--hairline-strong)] hover:bg-[var(--wash-1)]'}"
            role="button"
            tabindex={0}
            aria-haspopup="dialog"
            aria-pressed={isOpen}
            aria-label="{call.operation}{message ? `, ${message}` : ''}"
            data-call-row
            data-call-id={call.id}
            data-testid="app-call-row"
            onclick={() => {
              if (!hasTextSelection()) openCallId = call.id;
            }}
            onkeydown={(event: KeyboardEvent & { currentTarget: HTMLElement }) => onRowKey(event, call.id)}
          >
            <span class="flex h-4.5 w-4 shrink-0 items-center justify-center text-(--solus-text-tertiary)" aria-hidden="true"><OpenIcon size={12} strokeWidth={2} /></span>
            <span class="flex h-4.5 w-4 shrink-0 items-center">
              {#if call.outcome !== "ok"}
                <StateIcon state={callState(call.outcome)} size={15} label={call.outcome === "failed" ? "Failed" : "Running"} />
              {:else if call.kind === "model"}
                <ModelIcon size={15} strokeWidth={1.75} class="text-(--solus-text-tertiary)" aria-label="Model call" />
              {/if}
            </span>
            <span class="min-w-24 shrink-0 font-mono text-xs leading-4.5 whitespace-nowrap text-(--solus-text-secondary)" title="{new Date(call.startedAt).toLocaleString()} · {appTime(call.startedAt)}">
              {callClockText(call.startedAt, withDay)}{callMillisText(call.startedAt)}
            </span>
            <span class="flex min-w-0 flex-1 flex-col gap-1">
              <span class="truncate text-[13px] leading-4.5 text-foreground"><span class="font-medium">{call.operation}</span>{#if message}<span class="text-(--solus-text-tertiary)"> · {message}</span>{/if}</span>
              {#if columns.length > 0}
                <span class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                  {#each columns as column (column)}
                    {@const value = callChipText(call, column)}
                    {#if value !== null}
                      <span class="flex min-w-0 items-center gap-1.25 font-mono text-[11.5px] leading-4.25">
                        <span class="shrink-0 rounded-[4px] bg-[var(--wash-3)] px-1 text-(--solus-text-tertiary)">{column}</span>
                        <span class="min-w-0 truncate text-foreground" title={value}>{value}</span>
                      </span>
                    {/if}
                  {/each}
                </span>
              {/if}
            </span>
          </div>
        {/each}
      {:else}
        {#if noRows}
          {@render noRows()}
        {:else}
          <DataTableEmptyState filtered={false} title="No calls" description={empty} />
        {/if}
      {/each}
    </div>

    {#if summary || hasHiddenRows || onLoadMore}
      <footer class="flex min-h-11 min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-2 py-1.5 text-[13px] text-(--solus-text-tertiary)">
        <span class="min-w-0 truncate tabular-nums" role="status">{summary ?? ""}</span>
        {#if hasHiddenRows || onLoadMore}
          <Button size="xs" variant="ghost" class="text-(--solus-text-tertiary) hover:text-foreground" onclick={showMore}>Show more</Button>
        {/if}
      </footer>
    {/if}
  </div>
  </div>
</section>

{#if openCall}
  <CallSheet
    {serverId}
    {appId}
    call={openCall}
    calls={ordered}
    {webhooks}
    {p95Ms}
    {liveVersion}
    {columns}
    {onOpenRun}
    {onAskAgent}
    {onFilter}
    {onToggleColumn}
    onOpenCall={(callId) => (openCallId = callId)}
    onClose={() => void closeSheet()}
  />
{/if}
