<script lang="ts">
  import {
    ArrowsInSimpleIcon,
    ArrowsOutSimpleIcon,
    CaretLeftIcon,
    CaretRightIcon,
    XIcon,
  } from "phosphor-svelte";
  import { getWorkspaceContext } from "../../contexts";
  import type { MetricsSpan } from "../../../shared/observability-types";
  import CopyButton from "../ui/CopyButton.svelte";
  import {
    formatClock,
    formatCost,
    formatDuration,
    formatPercent,
    formatTokens,
    shortId,
    singleLine,
  } from "./lib/format";
  import { buildTraceView, firstObservedActivityMs } from "./lib/waterfall";
  import { insightsStore } from "./insights.store.svelte";
  import SessionContextChart from "./SessionContextChart.svelte";
  import TraceSummary from "./TraceSummary.svelte";
  import TraceWaterfall from "./TraceWaterfall.svelte";

  /**
   * One turn's detail: the facts, where it sat in the session, its complete
   * span tree, and the attributes the emitter recorded.
   *
   * Mounted beside the list it was opened from rather than in place of it, the
   * way a pull request opens — the rows stay readable while one turn is being
   * read, and the header's stepper walks the list's own order. The panel reads
   * the trace and the session rollup through the insights store, so arriving
   * from the list, from a deep link, or from a neighbouring turn all cost the
   * same and share one cache.
   */
  interface Props {
    traceId: string;
    /** Lands the waterfall on this span's detail — an event row's drill path. */
    spanId: string | null;
    fullScreen: boolean;
    /** Absent when the surface has no room for a split in the first place. */
    onToggleFullScreen?: () => void;
    /** What the listing this turn was opened from answers with — the crumb
     *  between "Insights" and this turn, and the way back to the list. */
    listLabel: string;
    onClose: () => void;
    /** 1-based place in the list order; 0 when this turn is not in the list. */
    position: number;
    total: number;
    onStep: (delta: number) => void;
  }

  let {
    traceId,
    spanId,
    fullScreen,
    onToggleFullScreen,
    listLabel,
    onClose,
    position,
    total,
    onStep,
  }: Props = $props();

  const workspace = getWorkspaceContext();

  let loading = $state(true);

  $effect(() => {
    const id = traceId;
    loading = true;
    void insightsStore.loadTrace(id).then((trace) => {
      loading = false;
      const tracedSessionId = trace?.spans.find((span) => span.sessionId)?.sessionId;
      if (tracedSessionId) void insightsStore.loadSessionSummary(tracedSessionId);
    });
  });

  const trace = $derived(insightsStore.trace(traceId));
  const view = $derived(buildTraceView(trace));
  const root = $derived(view?.root ?? null);
  const sessionId = $derived(root?.sessionId ?? null);
  const session = $derived(sessionId ? insightsStore.sessionSummary(sessionId) : null);

  function attr(span: MetricsSpan | null, key: string): string | number | boolean | null {
    const value = span?.attrs[key];
    return value === undefined ? null : value;
  }

  function numberAttr(span: MetricsSpan | null, key: string): number | null {
    const value = attr(span, key);
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  const prompt = $derived(String(attr(root, "prompt") ?? ""));
  const costUsd = $derived(typeof attr(root, "costUsd") === "number" ? Number(attr(root, "costUsd")) : null);
  const inputTokens = $derived(
    typeof attr(root, "inputTokens") === "number" ? Number(attr(root, "inputTokens")) : null,
  );
  const outputTokens = $derived(
    typeof attr(root, "outputTokens") === "number" ? Number(attr(root, "outputTokens")) : null,
  );
  const firstActivityMs = $derived.by(() => {
    const recorded = attr(root, "timeToFirstActivityMs");
    return typeof recorded === "number" ? recorded : view ? firstObservedActivityMs(view) : null;
  });
  const firstTextMs = $derived.by(() => {
    const recorded = attr(root, "timeToFirstTextMs");
    return typeof recorded === "number" ? recorded : null;
  });

  const statusTone = $derived(
    root?.status === "error"
      ? "var(--failure)"
      : root?.status === "interrupted"
        ? "var(--warning)"
        : "var(--muted-foreground)",
  );

  const facts = $derived(
    !root || !view
      ? []
      : [
          {
            label: "Duration",
            value: formatDuration(root.durationMs),
            note:
              view.unattributedMs != null && view.traceCoverage != null
                ? `${formatPercent(view.traceCoverage)} trace coverage · ${formatDuration(view.unattributedMs)} unattributed`
                : "no trace-coverage estimate",
            tone: root.status === "error" ? "var(--failure)" : "var(--foreground)",
          },
          {
            label: "Cost",
            value: formatCost(costUsd),
            note: costUsd == null ? "provider reports none" : (root.model ?? "—"),
            tone: "var(--foreground)",
          },
          {
            label: "Tokens",
            value: formatTokens(
              inputTokens == null && outputTokens == null ? null : (inputTokens ?? 0) + (outputTokens ?? 0),
            ),
            note: `${formatTokens(inputTokens)} in · ${formatTokens(outputTokens)} out`,
            tone: "var(--foreground)",
          },
          {
            label: "Tool calls",
            value: String(view.toolCallCount),
            note:
              view.deniedPermissions.length > 0
                ? `${view.deniedPermissions.length} denied`
                : "none denied",
            tone: view.deniedPermissions.length > 0 ? "var(--warning)" : "var(--foreground)",
          },
        ],
  );

  const attributes = $derived(
    !root
      ? []
      : [
          ["trace_id", root.traceId],
          ["span_id", root.spanId],
          ["session_id", root.sessionId ?? "—"],
          ["service", root.service],
          ["provider", root.provider ?? "—"],
          ["model", root.model ?? "—"],
          ["origin", root.origin ?? "—"],
          ["prompt_source", String(attr(root, "promptSource") ?? "—")],
          ["project_root", root.projectRoot ?? "—"],
          ["task_id", String(attr(root, "taskId") ?? "—")],
          ["automation_id", String(attr(root, "automationId") ?? "—")],
          ["reasoning_effort", String(attr(root, "reasoningEffort") ?? "—")],
          ["is_resume", String(attr(root, "isResume") ?? "—")],
          ["time_to_first_provider_event", formatDuration(numberAttr(root, "timeToFirstProviderEventMs"))],
          ["time_to_first_activity", formatDuration(firstActivityMs)],
          ["time_to_first_visible_text", formatDuration(firstTextMs)],
          ["time_to_last_provider_event", formatDuration(numberAttr(root, "timeToLastProviderEventMs"))],
          ["time_to_provider_complete", formatDuration(numberAttr(root, "timeToProviderCompleteMs"))],
          ["inter_turn_idle", formatDuration(numberAttr(root, "interTurnIdleMs"))],
        ].map(([key, value]) => ({ key: String(key), value: String(value) })),
  );

  const sessionRows = $derived(
    sessionId ? insightsStore.volumeRows.filter((row) => row.sessionId === sessionId) : [],
  );

  const sessionTurns = $derived(session?.turns ?? []);
  const sessionPosition = $derived(sessionTurns.findIndex((entry) => entry.traceId === traceId));

  const contextNote = $derived(
    session
      ? `${session.turnCount} ${session.turnCount === 1 ? "turn" : "turns"} · ${formatCost(session.totalCostUsd)} · turn ${sessionPosition + 1} of ${session.turnCount}`
      : "",
  );

  // A queue of one, or a turn the list is not showing (deep-linked, or the
  // query moved on) has nowhere to step to — offer the control only where it
  // moves, rather than leaving two arrows and a blank count.
  const canStepQueue = $derived(position > 0 && total > 1);

  // The breadcrumb reads at the same size and rhythm as the task page's, so a
  // turn and a task look like the same kind of destination.
  const CRUMB_BUTTON =
    "flex h-7 shrink-0 cursor-pointer items-center rounded px-[7px] text-[0.8125rem] text-muted-foreground transition-colors hover:bg-[var(--wash-1)] hover:text-foreground";

  const roundButton =
    "flex size-[26px] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-muted-foreground transition-colors duration-150 hover:bg-[var(--wash-2)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30";

  // The rail's group and label shapes, named the way the task page names them,
  // because both rails are the same surface.
  // One card per question — the session, the identity, the time — at the rail's
  // own scale: 11px labels and metadata, 12px values.
  const RAIL_CARD =
    "flex flex-col gap-1 rounded-xl bg-card px-3 pt-2.5 pb-3 shadow-[shadow:var(--insights-card-shadow)]";
  const RAIL_LABEL = "m-0 text-[0.6875rem] font-normal text-muted-foreground uppercase";

  function openTurn(id: string): void {
    workspace.openInsightsTurn(id);
  }

  function queryThisSession(): void {
    if (!sessionId) return;
    void insightsStore.runGenerated({ kind: "session", sessionId });
    workspace.openInsights();
  }
</script>

<div class="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
  <!-- Beside the list this band starts at the panel's own edge. Covering the
       list it starts at the window's, where the macOS window controls are — so
       only full screen takes the chrome lead inset. -->
  <header
    class="workspace-titlebar flex h-(--solus-chrome-row-h,2.75rem) shrink-0 items-center gap-1 pr-3.5 {fullScreen
      ? 'pl-[max(1.625rem,var(--solus-chrome-lead-inset,0px))]'
      : 'pl-3'} text-muted-foreground shadow-[inset_0_-0.5px_0_var(--hairline)]"
  >
    <!-- Full screen covers the page's own breadcrumb, so this band carries the
         whole path back; beside the list the page keeps the "Insights" crumb
         and this one continues it. Either crumb returns to the listing. -->
    {#if fullScreen}
      <button type="button" class={CRUMB_BUTTON} onclick={onClose}>Insights</button>
      <span class="px-[3px] text-[0.8125rem] opacity-30" aria-hidden="true">/</span>
    {/if}
    <button type="button" class={CRUMB_BUTTON} onclick={onClose}>{listLabel}</button>
    <span class="px-[3px] text-[0.8125rem] opacity-30" aria-hidden="true">/</span>
    <span
      class="flex h-7 shrink-0 items-center rounded px-[7px] font-mono text-[0.8125rem] text-foreground"
      title={traceId}>{shortId(traceId)}</span
    >
    <CopyButton text={traceId} title="Copy Insights ID" iconOnly />

    <span class="flex-1"></span>

    {#if root && root.status !== "ok"}
      <span class="mr-1 shrink-0 text-[0.625rem] font-medium uppercase" style="color:{statusTone}"
        >{root.status}</span
      >
    {/if}

    {#if canStepQueue}
      <div class="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          class={roundButton}
          title="Previous row"
          aria-label="Previous row"
          onclick={() => onStep(-1)}
        >
          <CaretLeftIcon size={11} />
        </button>
        <span class="text-[0.6875rem] tabular-nums whitespace-nowrap">{position} of {total}</span>
        <button
          type="button"
          class={roundButton}
          title="Next row"
          aria-label="Next row"
          onclick={() => onStep(1)}
        >
          <CaretRightIcon size={11} />
        </button>
      </div>
    {/if}

    <!-- Seam between the queue and the pane controls. -->
    <span class="mx-1 h-[18px] w-px shrink-0 bg-[var(--hairline-strong)]" aria-hidden="true"></span>

    {#if onToggleFullScreen}
      <button
        type="button"
        class="{roundButton} {fullScreen ? 'bg-[var(--wash-2)] text-foreground' : ''}"
        title={fullScreen ? "Back to split" : "Expand to full screen"}
        aria-label={fullScreen ? "Back to split view" : "Expand to full screen"}
        aria-pressed={fullScreen}
        onclick={onToggleFullScreen}
      >
        {#if fullScreen}
          <ArrowsInSimpleIcon size={13} />
        {:else}
          <ArrowsOutSimpleIcon size={13} />
        {/if}
      </button>
    {/if}
    <button type="button" class={roundButton} title="Close (Esc)" aria-label="Close" onclick={onClose}>
      <XIcon size={12} />
    </button>
  </header>

  <!-- A container, not the viewport, decides the aside's position: beside the
       list this surface is a 660px panel on a wide screen, and the viewport
       breakpoints would read the screen. -->
  <div class="@container min-h-0 flex-1 overflow-y-auto px-6" data-sb>
    {#if loading && !view}
      <p class="py-16 text-center text-xs text-muted-foreground">Loading the turn’s spans…</p>
    {:else if !view || !root}
      <div class="flex flex-col items-center gap-2 py-16 text-muted-foreground">
        <span class="text-xs">No spans recorded for this trace</span>
        <span class="text-[0.625rem]"
          >Metrics start at the version that instrumented them; there is no backfill.</span
        >
      </div>
    {:else}
      <div class="mx-auto flex w-full max-w-[87.5rem] flex-col gap-4.5 py-6 pb-16">
        <div class="flex flex-wrap items-start justify-between gap-6">
          <div class="flex min-w-0 flex-col gap-2">
            <div class="flex flex-wrap items-center gap-2.5">
              <span class="text-[0.6875rem] text-muted-foreground"
                >{formatClock(root.startedAt)} · {root.model ?? "—"} · {root.provider ??
                  "unknown provider"} · {root.origin ?? "typed"}</span
              >
            </div>
            <!-- The prompt is a message, not a title: one line names the turn,
                 and the Prompt section below holds the whole text. -->
            <h1
              class="m-0 max-w-[72ch] truncate text-base leading-[1.4] font-medium"
              title={singleLine(prompt)}
            >
              {singleLine(prompt) || "This turn recorded no prompt text"}
            </h1>
          </div>
          <button
            type="button"
            class="h-7.5 shrink-0 cursor-pointer rounded-lg bg-card px-3 text-xs font-medium shadow-[shadow:var(--elev-ring)] transition-colors hover:bg-muted disabled:cursor-default disabled:opacity-40"
            disabled={!sessionId}
            onclick={queryThisSession}>Query this session</button
          >
        </div>

        <div
          class="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-[var(--hairline)] shadow-[shadow:var(--insights-card-shadow)] sm:grid-cols-4"
        >
          {#each facts as fact (fact.label)}
            <div class="flex flex-col gap-1.5 bg-card px-3.5 py-3">
              <span
                class="text-[0.5938rem] font-medium text-muted-foreground tracking-[0.07em] uppercase"
                >{fact.label}</span
              >
              <span
                class="text-lg font-medium tabular-nums"
                style="color:{fact.tone}">{fact.value}</span
              >
              <span class="text-[0.625rem] text-muted-foreground">{fact.note}</span>
            </div>
          {/each}
        </div>

        <div class="flex flex-col gap-4 @4xl:flex-row @4xl:items-start">
          <div class="flex min-w-0 flex-1 flex-col gap-4">
            {#if sessionId}
              <SessionContextChart
                allRows={insightsStore.volumeRows}
                {sessionRows}
                currentStartedAt={root.startedAt}
                from={insightsStore.windowFrom}
                to={insightsStore.windowTo}
                note={contextNote}
              />
            {/if}

            <section
              class="overflow-hidden rounded-xl bg-card shadow-[shadow:var(--insights-card-shadow)]"
              aria-label="Trace"
            >
              <header
                class="flex h-11.5 items-center gap-3 px-5 shadow-[inset_0_-0.5px_0_var(--hairline)]"
              >
                <h2 class="text-lg font-medium">Trace</h2>
                {#if view.slowest[0]}
                  <span class="truncate text-[0.6875rem] text-muted-foreground"
                    >{view.slowest[0].label} is the largest span at {formatDuration(
                      view.slowest[0].durationMs,
                    )}</span
                  >
                {/if}
                <span class="flex-1"></span>
                <span class="shrink-0 text-[0.6875rem] tabular-nums text-muted-foreground"
                  >{formatDuration(view.totalMs)} · {view.spanCount} spans · {view.toolCallCount} tool
                  calls</span
                >
              </header>
              <div
                class="flex h-7.5 items-center gap-5 overflow-x-auto bg-[var(--wash-1)] px-5 shadow-[inset_0_-0.5px_0_var(--hairline)]"
                data-sb
              >
                {#each view.legend as entry (entry.kind)}
                  <span class="flex shrink-0 items-center gap-1.5">
                    <span class="size-2 rounded-sm" style="background:{entry.color}"></span>
                    <span class="text-[0.625rem] whitespace-nowrap text-muted-foreground"
                      >{entry.label}</span
                    >
                    <span class="text-[0.625rem] tabular-nums"
                      >{Math.round(entry.share * 100)}%</span
                    >
                  </span>
                {/each}
              </div>
              <div class="px-5 pt-2.5 pb-4">
                <TraceWaterfall trace={view} selectedSpanId={spanId} />
              </div>
            </section>

            <section
              class="overflow-hidden rounded-xl bg-card shadow-[shadow:var(--insights-card-shadow)]"
              aria-label="Prompt"
            >
              <header
                class="flex h-9.5 items-center gap-3 px-4 shadow-[inset_0_-0.5px_0_var(--hairline)]"
              >
                <h2 class="text-xs font-medium">Prompt</h2>
                <span class="flex-1"></span>
                <span class="text-[0.6875rem] tabular-nums text-muted-foreground"
                  >{formatTokens(inputTokens)} in · {formatTokens(outputTokens)} out</span
                >
              </header>
              <div
                class="px-5 py-4 text-[0.8125rem] leading-[1.75] whitespace-pre-wrap"
              >
                {prompt || "This turn recorded no prompt text."}
              </div>
              {#if attr(root, "promptTruncated") === true}
                <p class="px-5 pb-3 text-[0.625rem] text-muted-foreground">
                  Capped at 4 KB — {String(attr(root, "promptChars") ?? "?")} characters were sent.
                </p>
              {/if}
            </section>
          </div>

          <!-- Three cards, one per question the rail answers: where this turn
               sat in its session, what it was, and where its time went. -->
          <aside
            class="flex w-full shrink-0 flex-col gap-2.5 @4xl:sticky @4xl:top-3.5 @4xl:w-[19.25rem]"
          >
            {#if session}
              <section class={RAIL_CARD} aria-label="Session">
                <div class="flex items-baseline gap-2 pl-0.5">
                  <h2 class="{RAIL_LABEL} shrink-0">Session</h2>
                  <span
                    class="min-w-0 flex-1 truncate font-mono text-[0.6875rem] text-muted-foreground opacity-70"
                    title={session.sessionId}>{session.sessionId}</span
                  >
                </div>
                <div class="flex items-baseline gap-3.5 pb-0.5 pl-0.5">
                  {#each [{ label: "Turns", value: String(session.turnCount) }, { label: "Duration", value: formatDuration(session.totalDurationMs) }, { label: "Spend", value: formatCost(session.totalCostUsd) }] as fact (fact.label)}
                    <span class="flex items-baseline gap-1.5">
                      <span class="text-[0.6875rem] text-muted-foreground">{fact.label}</span>
                      <span class="text-xs tabular-nums">{fact.value}</span>
                    </span>
                  {/each}
                </div>
                <div class="-mx-1 flex max-h-72 flex-col gap-px overflow-y-auto" data-sb>
                  {#each session.turns as summary (summary.traceId)}
                    <button
                      type="button"
                      class="flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1 text-left transition-colors hover:bg-[var(--wash-2)]"
                      style="background:{summary.traceId === traceId
                        ? 'var(--wash-2)'
                        : 'transparent'}"
                      onclick={() => openTurn(summary.traceId)}
                    >
                      <span class="flex w-full min-w-0 items-baseline gap-2">
                        <span class="shrink-0 font-mono text-[0.6875rem] text-muted-foreground"
                          >{formatClock(summary.startedAt)}</span
                        >
                        <span
                          class="truncate text-xs"
                          style="font-weight:{summary.traceId === traceId ? 500 : 400}"
                          >#{summary.turnNumber} · {summary.model ?? "—"}</span
                        >
                      </span>
                      <span class="flex items-baseline gap-2 text-[0.6875rem] tabular-nums">
                        <span
                          style="color:{summary.status === 'error'
                            ? 'var(--failure)'
                            : 'var(--muted-foreground)'}">{formatDuration(summary.durationMs)}</span
                        >
                        <span class="text-muted-foreground"
                          >{formatCost(summary.costUsd)} · {formatTokens(
                            summary.inputTokens == null && summary.outputTokens == null
                              ? null
                              : (summary.inputTokens ?? 0) + (summary.outputTokens ?? 0),
                          )}</span
                        >
                        {#if summary.status !== "ok"}
                          <span
                            class="text-[0.6875rem] font-medium uppercase"
                            style="color:{summary.status === 'error'
                              ? 'var(--failure)'
                              : 'var(--warning)'}">{summary.status}</span
                          >
                        {/if}
                      </span>
                    </button>
                  {/each}
                </div>
              </section>
            {/if}

            <section class={RAIL_CARD} aria-label="Attributes">
              <h2 class="{RAIL_LABEL} pb-0.5 pl-0.5">Attributes</h2>
              {#each attributes as attribute (attribute.key)}
                <div
                  class="-mx-1 grid h-[22px] items-center gap-3 rounded-md px-2 hover:bg-[var(--wash-1)]"
                  style="grid-template-columns:6rem minmax(0,1fr)"
                >
                  <span class="truncate text-[0.6875rem] text-muted-foreground"
                    >{attribute.key}</span
                  >
                  <span class="truncate font-mono text-[0.6875rem]" title={attribute.value}
                    >{attribute.value}</span
                  >
                </div>
              {/each}
            </section>

            <section class="{RAIL_CARD} gap-2.5" aria-label="Where the time went">
              <TraceSummary trace={view} dense />
            </section>
          </aside>
        </div>
      </div>
    {/if}
  </div>
</div>
