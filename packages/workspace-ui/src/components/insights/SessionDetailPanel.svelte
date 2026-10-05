<script lang="ts">
  import TaskIcon from "../ui/TaskIcon.svelte";
  import { scaleBand } from "d3-scale";
  import { curveMonotoneX } from "d3-shape";
  import { Axis, Bars, Chart, Highlight, Spline, Svg, Tooltip } from "layerchart";
  import {
    MessageSquare as SessionIcon,
    Search as QueryIcon,
  } from "@lucide/svelte";
  import { getWorkspaceContext } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import { Button } from "../ui/button";
  import { SubPageCrumbLine } from "../ui/list-page";
  import CopyButton from "../ui/CopyButton.svelte";
  import { TIME_AXIS_INSET_PX, TIME_AXIS_LABEL_GAP_PX } from "./lib/chart-axis";
  import { formatCost, formatCostTick, formatDuration, formatPercent, formatTokens, shortId } from "./lib/format";
  import { sessionPageStats, sessionTurnPoints, type SessionTurnPoint } from "./lib/session-page";
  import { insightsStore } from "./insights.store.svelte";
  import { askInsights } from "./lib/ask-insights";

  /**
   * One session's page: every turn on one axis, with cost and context
   * climbing beside the duration of each.
   *
   * "Why is this session slow" is rarely answered by one turn. It is the
   * fourth turn that pushed the context to 80%, after which every turn
   * re-read it; or the two turns that each waited on a permission; or the
   * cost that climbed in one step. Those are readings of the sequence, so the
   * page draws the sequence: a bar per turn, the spend as a line over the
   * bars, and the context fill underneath on the same axis.
   *
   * The same rollup the session card reads; nothing is fetched twice.
   */
  interface Props {
    sessionId: string;
    fullScreen: boolean;
    onToggleFullScreen?: () => void;
    listLabel: string;
    onClose: () => void;
  }

  let { sessionId, fullScreen, onToggleFullScreen, listLabel, onClose }: Props = $props();

  const workspace = getWorkspaceContext();

  let loading = $state(true);
  $effect(() => {
    const id = sessionId;
    loading = true;
    void insightsStore.loadTurnFlags();
    void insightsStore.loadSessionName(id);
    void workspace.tasksStore.ensureSessionBinding(id, insightsStore.serverId ?? undefined);
    void insightsStore.loadSessionSummary(id).then(() => (loading = false));
  });

  const session = $derived(insightsStore.sessionSummary(sessionId));
  const sessionName = $derived(insightsStore.sessionName(sessionId));
  const points = $derived(session ? sessionTurnPoints(session) : []);
  const stats = $derived(session ? sessionPageStats(session, points) : null);
  const boundTask = $derived(workspace.tasksStore.taskForSession(sessionId));
  const taskId = $derived(session?.taskId ?? boundTask?.id ?? null);
  const taskTitle = $derived(
    workspace.tasksStore.peek(taskId)?.title || session?.taskTitle || boundTask?.title || null,
  );
  const title = $derived(taskTitle ?? sessionName ?? shortId(sessionId));

  // The right axis: spend, scaled onto the duration axis the way the volume
  // chart does it, so one plot carries both without a second grid.
  const durationMax = $derived(Math.max(1, ...points.map((point) => point.durationMs ?? 0)));
  const costMax = $derived(Math.max(0, ...points.map((point) => point.cumulativeCostUsd ?? 0)));
  const showCost = $derived(costMax > 0);
  const costScale = $derived(showCost ? durationMax / costMax : 1);
  const costTicks = $derived(showCost ? [0, durationMax / 2, durationMax] : []);
  const contextWindow = $derived(
    points.reduce((max, point) => Math.max(max, point.contextUsedTokens ?? 0), 0),
  );
  const showContext = $derived(contextWindow > 0);
  const FAILED_COLOR = "var(--solus-art-negative)";
  const TURN_FILL = "var(--solus-art-4)";
  const COST_STROKE = "var(--solus-art-1)";
  const CONTEXT_FILL = "var(--solus-art-5)";

  function openTurn(traceId: string): void {
    workspace.openInsightsTurn(traceId);
  }

  async function revealSession(): Promise<void> {
    if (!insightsStore.serverId) return;
    const tabId = await workspace.revealSession(sessionId, insightsStore.serverId);
    if (!tabId) toasts.error("That session is no longer on this host");
  }

  async function openTask(): Promise<void> {
    const task =
      boundTask ??
      (await workspace.tasksStore.ensureSessionBinding(sessionId, insightsStore.serverId ?? undefined));
    const destination = taskId ?? task?.id ?? null;
    if (destination) workspace.goToTask(destination, "click", "secondary");
  }

  function queryThisSession(): void {
    void askInsights({ kind: "session", sessionId }, () => workspace.openInsights());
  }
</script>

<div class="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
  <SubPageCrumbLine
    page="insights"
    onOpenPage={onClose}
    trail={[{ label: listLabel, onOpen: onClose }]}
    leaf="Session {shortId(sessionId)}"
    leafTitle={sessionId}
    copyText={sessionId}
    copyTitle="Copy the session id"
    onToggleMaximize={onToggleFullScreen}
    maximized={fullScreen}
    maximizeLabel="Expand to full screen"
    restoreLabel="Back to split"
    {onClose}
    clearsWindowControls={fullScreen}
    divided={false}
  />

  <div class="@container min-h-0 flex-1 overflow-y-auto px-6 select-text" data-sb>
    {#if loading && !session}
      <div class="flex flex-col items-center gap-2 py-16 text-muted-foreground" role="status" aria-busy="true">
        <span class="text-insights-chrome">Reading the session…</span>
      </div>
    {:else if !session || !stats || points.length === 0}
      <div class="flex flex-col items-center gap-2 py-16 text-muted-foreground">
        <span class="text-insights-chrome">No turns recorded for this session</span>
        <span class="text-insights-chrome"
          >Metrics start at the version that instrumented them; there is no backfill.</span
        >
      </div>
    {:else}
      <div class="mx-auto flex w-full max-w-[87.5rem] flex-col gap-4 py-6 pb-16">
        <div class="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div class="flex min-w-0 flex-col gap-1.5">
            <h1 class="m-0 max-w-[72ch] truncate text-h3 leading-[1.4] font-medium select-text" title={title}>
              {title}
            </h1>
            <span class="flex flex-wrap items-center gap-1.5 text-insights-chrome text-muted-foreground select-text">
              <span class="font-mono" title={sessionId}>{shortId(sessionId)}</span>
              <CopyButton text={sessionId} title="Copy the session id" iconOnly />
              · {stats.turnCount} {stats.turnCount === 1 ? "turn" : "turns"} · {formatDuration(stats.totalDurationMs)}
            </span>
          </div>
          <div class="flex shrink-0 flex-wrap items-center gap-1.5 select-none" role="group" aria-label="Open elsewhere">
            <Button
              variant="ghost"
              size="sm"
              class="h-8 gap-1.5 rounded-full px-2.5 text-insights-chrome text-muted-foreground shadow-[inset_0_0_0_0.5px_var(--hairline)] transition-[color,background-color,scale] hover:bg-[var(--wash-2)] hover:text-foreground active:scale-[0.96] pointer-coarse:h-10"
              title="Open the conversation"
              onclick={() => void revealSession()}
            >
              <SessionIcon class="size-3.5" aria-hidden="true" />
              Open session
            </Button>
            <Button
              variant="ghost"
              size="sm"
              class="h-8 gap-1.5 rounded-full px-2.5 text-insights-chrome text-muted-foreground shadow-[inset_0_0_0_0.5px_var(--hairline)] transition-[color,background-color,scale] hover:bg-[var(--wash-2)] hover:text-foreground active:scale-[0.96] pointer-coarse:h-10"
              title={taskTitle ? `Open task: ${taskTitle}` : "Open the task this session ran under"}
              onclick={() => void openTask()}
            >
              <TaskIcon class="size-3.5" aria-hidden="true" />
              Open task
            </Button>
            <Button
              variant="ghost"
              size="sm"
              class="h-8 gap-1.5 rounded-full px-2.5 text-insights-chrome text-muted-foreground shadow-[inset_0_0_0_0.5px_var(--hairline)] transition-[color,background-color,scale] hover:bg-[var(--wash-2)] hover:text-foreground active:scale-[0.96] pointer-coarse:h-10"
              title="List every turn of this session in the console"
              onclick={queryThisSession}
            >
              <QueryIcon class="size-3.5" aria-hidden="true" />
              Query session
            </Button>
          </div>
        </div>

        <dl class="m-0 flex flex-wrap gap-x-7 gap-y-2.5">
          {#each [
            { label: "Turns", value: String(stats.turnCount), note: `${stats.failedCount} failed or interrupted`, tone: stats.failedCount > 0 ? "var(--warning)" : "var(--foreground)" },
            { label: "Duration", value: formatDuration(stats.totalDurationMs), note: stats.medianDurationMs == null ? undefined : `median turn ${formatDuration(stats.medianDurationMs)}`, tone: "var(--foreground)" },
            { label: "Cost", value: formatCost(stats.totalCostUsd), note: stats.totalCostUsd == null ? "the provider reports no cost" : undefined, tone: "var(--foreground)" },
            { label: "Tokens", value: formatTokens(stats.totalTokens), note: "input plus output, every turn", tone: "var(--foreground)" },
            { label: "Longest turn", value: stats.longest ? formatDuration(stats.longest.durationMs) : "—", note: stats.longest ? `turn ${stats.longest.turnNumber}: ${stats.longest.title}` : undefined, tone: "var(--foreground)" },
            { label: "Context now", value: stats.lastContextUsedTokens == null ? "—" : formatTokens(stats.lastContextUsedTokens), note: stats.lastContextUsedTokens == null ? "no turn recorded a context reading" : "after the last turn that recorded it", tone: "var(--foreground)" },
          ] as stat (stat.label)}
            <div class="flex min-w-0 flex-col gap-0.5" title={stat.note}>
              <dt class="text-insights-chrome text-muted-foreground">{stat.label}</dt>
              <dd class="m-0 text-insights-summary-heading font-medium tabular-nums" style="color:{stat.tone}">
                {stat.value}
              </dd>
            </div>
          {/each}
        </dl>

        <section
          class="flex flex-col gap-1.5 rounded-xl bg-card px-4 pt-2.5 pb-2 shadow-[shadow:var(--insights-card-shadow)]"
          aria-label="Turns on one axis"
        >
          <div class="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <h2 class="m-0 text-insights-summary font-medium">Every turn</h2>
            <span class="text-insights-summary text-muted-foreground">duration per turn, spend climbing over it</span>
            <span class="flex-1"></span>
            <div class="flex items-center gap-2.5 text-insights-chrome text-muted-foreground">
              <span class="flex items-center gap-1.5"><span class="h-1.5 w-3 rounded-sm" style="background:{TURN_FILL}"></span>Turn</span>
              <span class="flex items-center gap-1.5"><span class="h-1.5 w-3 rounded-sm" style="background:{FAILED_COLOR}"></span>Failed</span>
              {#if showCost}
                <span class="flex items-center gap-1.5"><span class="h-0.5 w-3 rounded-full" style="background:{COST_STROKE}"></span>Spend so far</span>
              {/if}
            </div>
          </div>

          <div class="relative h-52 w-full cursor-pointer sm:h-44 sm:[@media(min-height:1000px)]:h-52">
            {#key sessionId}
              <Chart
                data={points}
                x={(point: SessionTurnPoint) => point.turnNumber}
                xScale={scaleBand().padding(0.24)}
                y={(point: SessionTurnPoint) => point.durationMs ?? 0}
                yDomain={[0, durationMax]}
                padding={{ left: 46, bottom: TIME_AXIS_INSET_PX, right: showCost ? 46 : 12, top: 4 }}
                tooltipContext={{
                  mode: "band",
                  onclick: (_event: MouseEvent, detail: { data: SessionTurnPoint | null }) => {
                    if (detail.data) openTurn(detail.data.traceId);
                  },
                }}
              >
                <Svg>
                  <Axis
                    placement="left"
                    grid={{ class: "stroke-[var(--hairline)]" }}
                    ticks={3}
                    tickMarks={false}
                    format={(value: unknown) => formatDuration(Number(value))}
                    classes={{ tickLabel: "text-insights-summary tabular-nums fill-[var(--muted-foreground)]" }}
                  />
                  {#if showCost}
                    <Axis
                      placement="right"
                      ticks={costTicks}
                      tickMarks={false}
                      format={(value: unknown) => formatCostTick(Number(value) / costScale)}
                      classes={{ tickLabel: "text-insights-summary tabular-nums fill-[var(--muted-foreground)]" }}
                    />
                  {/if}
                  <Axis
                    placement="bottom"
                    tickMarks={false}
                    tickLength={0}
                    tickLabelProps={{ dy: TIME_AXIS_LABEL_GAP_PX }}
                    format={(value: unknown) => `#${value}`}
                    classes={{ tickLabel: "text-insights-summary tabular-nums fill-[var(--muted-foreground)]" }}
                  />
                  <Highlight area={{ class: "fill-[var(--wash-2)]" }} />
                  <Bars
                    y={(point: SessionTurnPoint) => (point.failed ? 0 : (point.durationMs ?? 0))}
                    rounded="top"
                    radius={2}
                    fill={TURN_FILL}
                  />
                  <Bars
                    y={(point: SessionTurnPoint) => (point.failed ? (point.durationMs ?? 0) : 0)}
                    rounded="top"
                    radius={2}
                    fill={FAILED_COLOR}
                  />
                  {#if showCost}
                    <Spline
                      y={(point: SessionTurnPoint) => (point.cumulativeCostUsd ?? 0) * costScale}
                      curve={curveMonotoneX}
                      stroke={COST_STROKE}
                      class="pointer-events-none fill-none stroke-[1.5]"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  {/if}
                </Svg>
                <Tooltip.Root
                  variant="none"
                  classes={{ root: "rounded-lg bg-card px-2.5 py-1.5 shadow-[shadow:var(--solus-menu-shadow)]" }}
                >
                  {#snippet children({ data }: { data: SessionTurnPoint })}
                    <div class="flex max-w-72 flex-col gap-0.5 text-insights-summary">
                      <span class="truncate font-medium">Turn {data.turnNumber} · {data.title}</span>
                      <span class="tabular-nums" style="color:{data.failed ? FAILED_COLOR : 'var(--foreground)'}"
                        >{formatDuration(data.durationMs)}{data.failed ? " · failed" : ""}</span
                      >
                      <span class="tabular-nums text-muted-foreground"
                        >{formatCost(data.costUsd)} this turn · {formatCost(data.cumulativeCostUsd)} so far</span
                      >
                      {#if data.contextUsedTokens != null}
                        <span class="tabular-nums text-muted-foreground">context {formatTokens(data.contextUsedTokens)} after</span>
                      {/if}
                    </div>
                  {/snippet}
                </Tooltip.Root>
              </Chart>
            {/key}
          </div>

          {#if showContext}
            <!-- The same axis, one more reading: where the context stood after
                 each turn. Its own strip rather than a third scale on the plot
                 above, because a fill is a fraction and the bars are durations. -->
            <div class="flex items-baseline gap-2 pt-1 text-insights-chrome text-muted-foreground">
              <span class="h-1.5 w-3 rounded-sm" style="background:{CONTEXT_FILL}"></span>
              Context after each turn
              <span class="opacity-70">· peak {formatTokens(contextWindow)}</span>
            </div>
            <div class="relative h-16 w-full">
              {#key sessionId}
                <Chart
                  data={points}
                  x={(point: SessionTurnPoint) => point.turnNumber}
                  xScale={scaleBand().padding(0.24)}
                  y={(point: SessionTurnPoint) => point.contextUsedTokens ?? 0}
                  yDomain={[0, contextWindow]}
                  padding={{ left: 46, bottom: 2, right: showCost ? 46 : 12, top: 2 }}
                >
                  <Svg>
                    <Axis
                      placement="left"
                      ticks={[0, contextWindow]}
                      tickMarks={false}
                      format={(value: unknown) => formatPercent(Number(value) / contextWindow)}
                      classes={{ tickLabel: "text-insights-summary tabular-nums fill-[var(--muted-foreground)]" }}
                    />
                    <Bars rounded="top" radius={2} fill={CONTEXT_FILL} />
                  </Svg>
                </Chart>
              {/key}
            </div>
          {/if}
        </section>

        <section
          class="overflow-hidden rounded-xl bg-card text-insights-chrome shadow-[shadow:var(--insights-card-shadow)]"
          aria-label="Turns"
        >
          <header class="flex h-10 items-center gap-2 px-5 shadow-[inset_0_-0.5px_0_var(--hairline)]">
            <h2 class="m-0 text-insights-summary font-medium">Turns</h2>
            <span class="tabular-nums text-muted-foreground">{points.length}</span>
          </header>
          <div class="flex flex-col gap-px px-2 py-2 text-insights-summary">
            {#each points as point (point.traceId)}
              {@const flag = insightsStore.turnFlags.get(point.traceId)}
              <button
                type="button"
                class="flex h-8 w-full cursor-pointer items-center gap-3 overflow-hidden rounded-md px-2 text-left transition-colors select-none hover:bg-[var(--wash-2)] focus-visible:outline-1 focus-visible:outline-offset-[-1px] focus-visible:outline-[color-mix(in_oklch,var(--primary)_45%,transparent)]"
                onclick={() => openTurn(point.traceId)}
              >
                <span class="w-5 shrink-0 text-right text-insights-chrome text-muted-foreground tabular-nums">{point.turnNumber}</span>
                <span class="min-w-0 flex-1 truncate">{point.title}</span>
                {#if flag}
                  <span
                    class="shrink-0 rounded-sm px-1 text-[0.625rem]"
                    style="background:color-mix(in oklch, var(--warning) 12%, transparent);color:var(--warning)"
                    title={flag.note || flag.kind}>{flag.kind.replace("_", " ")}</span
                  >
                {/if}
                <span class="w-14 shrink-0 text-right text-insights-chrome text-muted-foreground tabular-nums"
                  >{point.contextUsedTokens == null ? "" : formatTokens(point.contextUsedTokens)}</span
                >
                <span class="w-14 shrink-0 text-right text-insights-chrome text-muted-foreground tabular-nums">{formatCost(point.costUsd)}</span>
                <span
                  class="w-12 shrink-0 text-right text-insights-chrome tabular-nums"
                  style="color:{point.failed ? 'var(--failure)' : 'var(--foreground)'}">{formatDuration(point.durationMs)}</span
                >
              </button>
            {/each}
          </div>
        </section>
      </div>
    {/if}
  </div>
</div>
