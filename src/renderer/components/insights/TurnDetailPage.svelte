<script lang="ts">
  import { CaretLeftIcon, CaretRightIcon } from "phosphor-svelte";
  import { serverConnections } from "@client-core/server-connections";
  import { getWorkspaceContext, serversStore } from "../../contexts";
  import type { MetricsSpan } from "../../../shared/observability-types";
  import type { RouteSurfaceProps } from "../ui/lib/pane-surface";
  import {
    formatClock,
    formatCost,
    formatDuration,
    formatTokens,
    shortModel,
    singleLine,
  } from "./lib/format";
  import { sessionTurnsSql } from "./lib/insights-queries";
  import { buildTraceView } from "./lib/waterfall";
  import { insightsStore } from "./insights.store.svelte";
  import SessionContextChart from "./SessionContextChart.svelte";
  import TraceSummary from "./TraceSummary.svelte";
  import TraceWaterfall from "./TraceWaterfall.svelte";

  /**
   * One turn, at full width: the facts, where it sat in the session, its
   * complete span tree, and the attributes the emitter recorded.
   *
   * The page reads the trace and the session rollup through the insights store,
   * so arriving here from the list, from a deep link, or from a neighbouring
   * turn all cost the same and share one cache.
   */
  let { params }: RouteSurfaceProps<"insightsTurn"> = $props();

  const workspace = getWorkspaceContext();
  const traceId = $derived(params.traceId);

  let loading = $state(true);

  $effect(() => {
    insightsStore.useHost(serverConnections.resolveId(serversStore.activeServerId));
  });

  $effect(() => {
    const id = traceId;
    loading = true;
    void insightsStore.loadTrace(id).then((trace) => {
      loading = false;
      const sessionId = trace?.spans.find((span) => span.sessionId)?.sessionId;
      if (sessionId) void insightsStore.loadSessionSummary(sessionId);
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

  const prompt = $derived(String(attr(root, "prompt") ?? ""));
  const costUsd = $derived(typeof attr(root, "costUsd") === "number" ? Number(attr(root, "costUsd")) : null);
  const inputTokens = $derived(
    typeof attr(root, "inputTokens") === "number" ? Number(attr(root, "inputTokens")) : null,
  );
  const outputTokens = $derived(
    typeof attr(root, "outputTokens") === "number" ? Number(attr(root, "outputTokens")) : null,
  );

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
              view.uninstrumentedMs != null
                ? `${formatDuration(view.uninstrumentedMs)} uninstrumented`
                : "no uninstrumented estimate",
            tone: root.status === "error" ? "var(--failure)" : "var(--foreground)",
          },
          {
            label: "Cost",
            value: formatCost(costUsd),
            note: costUsd == null ? "provider reports none" : shortModel(root.model),
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
          ["time_to_first_token", formatDuration(Number(attr(root, "timeToFirstTokenMs")) || null)],
          ["inter_turn_idle", formatDuration(Number(attr(root, "interTurnIdleMs")) || null)],
        ].map(([key, value]) => ({ key: String(key), value: String(value) })),
  );

  const sessionRows = $derived(
    sessionId ? insightsStore.volumeRows.filter((row) => row.sessionId === sessionId) : [],
  );

  const neighbours = $derived(session?.turns ?? []);
  const position = $derived(neighbours.findIndex((entry) => entry.traceId === traceId));
  const previousTrace = $derived(position > 0 ? neighbours[position - 1].traceId : null);
  const nextTrace = $derived(
    position >= 0 && position < neighbours.length - 1 ? neighbours[position + 1].traceId : null,
  );

  const contextNote = $derived(
    session
      ? `${session.turnCount} ${session.turnCount === 1 ? "turn" : "turns"} · ${formatCost(session.totalCostUsd)} · turn ${position + 1} of ${session.turnCount}`
      : "",
  );

  function openTurn(id: string): void {
    workspace.openInsightsTurn(id);
  }

  function queryThisSession(): void {
    if (!sessionId) return;
    insightsStore.form = "sql";
    insightsStore.sqlText = sessionTurnsSql(sessionId);
    void insightsStore.runSql(insightsStore.sqlText);
    workspace.openInsights();
  }
</script>

<div
  class="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground"
  >
  <header
    class="flex h-(--solus-chrome-row-h,2.75rem) shrink-0 items-center gap-2 pr-6 pl-[max(1.625rem,var(--solus-chrome-lead-inset,0px))] text-xs text-muted-foreground shadow-[inset_0_-0.5px_0_var(--hairline)]"
  >
    <button
      type="button"
      class="cursor-pointer rounded px-1 py-0.5 transition-colors hover:bg-[var(--wash-1)] hover:text-foreground"
      onclick={() => workspace.openInsights()}>Insights</button
    >
    <span class="opacity-45">/</span>
    <span class="truncate font-medium text-foreground">{traceId}</span>
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto px-6 xl:px-8" data-sb>
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
              <span
                class="text-[0.625rem] font-medium uppercase"
                style="color:{statusTone}">{root.status}</span
              >
              <span class="text-[0.6875rem] text-muted-foreground"
                >{formatClock(root.startedAt)} · {shortModel(root.model)} · {root.provider ??
                  "unknown provider"} · {root.origin ?? "typed"}</span
              >
            </div>
            <h1
              class="m-0 max-w-[64ch] text-2xl leading-[1.32] font-medium text-pretty"
            >
              {singleLine(prompt) || "This turn recorded no prompt text"}
            </h1>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <button
              type="button"
              class="h-7.5 cursor-pointer rounded-lg bg-card px-3 text-xs font-medium shadow-[shadow:var(--elev-ring)] transition-colors hover:bg-muted disabled:cursor-default disabled:opacity-40"
              disabled={!sessionId}
              onclick={queryThisSession}>Query this session</button
            >
            <button
              type="button"
              class="flex h-7.5 cursor-pointer items-center gap-2 rounded-lg bg-card px-3 text-xs font-medium shadow-[shadow:var(--elev-ring)] transition-colors hover:bg-muted disabled:cursor-default disabled:opacity-40"
              disabled={!previousTrace}
              onclick={() => previousTrace && openTurn(previousTrace)}
              ><CaretLeftIcon size={10} weight="bold" /> Previous turn</button
            >
            <button
              type="button"
              class="flex h-7.5 cursor-pointer items-center gap-2 rounded-lg bg-card px-3 text-xs font-medium shadow-[shadow:var(--elev-ring)] transition-colors hover:bg-muted disabled:cursor-default disabled:opacity-40"
              disabled={!nextTrace}
              onclick={() => nextTrace && openTurn(nextTrace)}
              >Next turn <CaretRightIcon size={10} weight="bold" /></button
            >
          </div>
        </div>

        <div
          class="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-[var(--hairline)] shadow-[shadow:var(--elev-ring)] sm:grid-cols-4"
        >
          {#each facts as fact (fact.label)}
            <div class="flex flex-col gap-1.5 bg-card px-3.5 py-3">
              <span
                class="text-[0.5938rem] font-medium text-muted-foreground uppercase"
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

        <div class="flex flex-col gap-4 xl:flex-row xl:items-start">
          <div class="flex min-w-0 flex-1 flex-col gap-4">
            {#if sessionId}
              <SessionContextChart
                allRows={insightsStore.volumeRows}
                {sessionRows}
                currentStartedAt={root.startedAt}
                from={insightsStore.windowTo - insightsStore.windowMs}
                to={insightsStore.windowTo}
                note={contextNote}
              />
            {/if}

            <section
              class="overflow-hidden rounded-xl bg-card shadow-[shadow:var(--elev-lift)]"
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
                <TraceWaterfall trace={view} />
              </div>
            </section>

            <section
              class="overflow-hidden rounded-xl bg-card shadow-[shadow:var(--elev-ring)]"
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

          <aside class="flex w-full shrink-0 flex-col gap-3 xl:sticky xl:top-3.5 xl:w-77">
            {#if session}
              <section
                class="overflow-hidden rounded-xl bg-popover shadow-[shadow:var(--elev-lift)]"
                aria-label="Session"
              >
                <header
                  class="flex h-9.5 items-center gap-2 px-4 shadow-[inset_0_-0.5px_0_var(--hairline)]"
                >
                  <h2 class="text-xs font-medium">Session</h2>
                  <span class="truncate text-[0.6875rem] text-muted-foreground"
                    >{session.sessionId}</span
                  >
                </header>
                <div
                  class="flex items-baseline gap-4 px-4 py-2.5 shadow-[inset_0_-0.5px_0_var(--hairline)]"
                >
                  {#each [{ label: "Turns", value: String(session.turnCount) }, { label: "Duration", value: formatDuration(session.totalDurationMs) }, { label: "Spend", value: formatCost(session.totalCostUsd) }] as fact (fact.label)}
                    <span class="flex items-baseline gap-1.5">
                      <span
                        class="text-[0.5938rem] font-medium text-muted-foreground uppercase"
                        >{fact.label}</span
                      >
                      <span class="text-xs tabular-nums">{fact.value}</span>
                    </span>
                  {/each}
                </div>
                <div class="max-h-96 overflow-y-auto" data-sb>
                  {#each session.turns as summary, index (summary.traceId)}
                    <button
                      type="button"
                      class="flex w-full cursor-pointer flex-col gap-1 px-4 py-2.5 text-left transition-colors hover:bg-muted"
                      style="background:{summary.traceId === traceId
                        ? 'var(--wash-3)'
                        : 'transparent'};box-shadow:{index
                        ? 'inset 0 0.5px 0 var(--hairline)'
                        : 'none'}"
                      onclick={() => openTurn(summary.traceId)}
                    >
                      <span class="flex w-full min-w-0 items-baseline gap-2">
                        <span class="shrink-0 text-[0.625rem] tabular-nums text-muted-foreground"
                          >{formatClock(summary.startedAt)}</span
                        >
                        <span
                          class="truncate text-xs"
                          style="font-weight:{summary.traceId === traceId ? 500 : 400}"
                          >#{summary.turnNumber} · {shortModel(summary.model)}</span
                        >
                      </span>
                      <span class="flex items-baseline gap-2 text-[0.625rem] tabular-nums">
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
                            class="text-[0.625rem] font-medium uppercase"
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

            <section
              class="overflow-hidden rounded-xl bg-popover shadow-[shadow:var(--elev-lift)]"
              aria-label="Attributes"
            >
              <header
                class="flex h-9.5 items-center gap-2 px-4 shadow-[inset_0_-0.5px_0_var(--hairline)]"
              >
                <h2 class="text-xs font-medium">Attributes</h2>
              </header>
              {#each attributes as attribute, index (attribute.key)}
                <div
                  class="grid h-7 items-baseline gap-3 px-4"
                  style="grid-template-columns:6.625rem minmax(0,1fr);box-shadow:{index
                    ? 'inset 0 0.5px 0 var(--hairline)'
                    : 'none'}"
                >
                  <span class="truncate text-[0.625rem] text-muted-foreground"
                    >{attribute.key}</span
                  >
                  <span class="truncate text-[0.6875rem]" title={attribute.value}
                    >{attribute.value}</span
                  >
                </div>
              {/each}
            </section>

            <section class="flex flex-col gap-3 rounded-xl bg-popover p-4 shadow-[shadow:var(--elev-lift)]">
              <TraceSummary trace={view} dense />
            </section>
          </aside>
        </div>
      </div>
    {/if}
  </div>
</div>
