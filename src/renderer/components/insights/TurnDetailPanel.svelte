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
  import { formatClock, formatDuration, shortId, singleLine } from "./lib/format";
  import { providerMark, providerName } from "./lib/provider";
  import { buildTraceView, hasInternalRows, SOLUS_INTERNAL_KINDS } from "./lib/waterfall";
  import { Switch } from "../ui/switch";
  import { promptsByTrace, sessionSummaryView } from "./lib/session-summary";
  import { rangeHeading } from "./lib/time-range";
  import { turnAttributes } from "./lib/turn-attributes";
  import { turnTranscript } from "./lib/turn-transcript";
  import { insightsStore } from "./insights.store.svelte";
  import ProviderMark from "./ProviderMark.svelte";
  import SessionContextChart from "./SessionContextChart.svelte";
  import SessionSummary from "./SessionSummary.svelte";
  import TraceCoverage from "./TraceCoverage.svelte";
  import TraceWaterfall from "./TraceWaterfall.svelte";
  import TurnAttributes from "./TurnAttributes.svelte";
  import TurnDetailSkeleton from "./TurnDetailSkeleton.svelte";
  import TurnToolTotals from "./TurnToolTotals.svelte";
  import TurnTranscript from "./TurnTranscript.svelte";

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
      if (!tracedSessionId) return;
      void insightsStore.loadSessionSummary(tracedSessionId);
      void insightsStore.loadSessionName(tracedSessionId);
      // Metrics attrs are a snapshot and older turns may predate task-name
      // capture. Resolve the durable session binding too, so the session table
      // can still open the task the session belongs to.
      void workspace.tasksStore.ensureSessionBinding(
        tracedSessionId,
        insightsStore.serverId ?? undefined,
      );
    });
  });

  const trace = $derived(insightsStore.trace(traceId));
  const view = $derived(buildTraceView(trace));
  const root = $derived(view?.root ?? null);
  const sessionId = $derived(root?.sessionId ?? null);
  const session = $derived(sessionId ? insightsStore.sessionSummary(sessionId) : null);

  /** A deep link that points at a Solus row reveals it whatever the stored
   *  preference says — a link that lands on a span the reader cannot see is a
   *  broken link — without turning the preference on for every later turn. */
  const deepLinkedSpanKind = $derived(
    spanId ? (trace?.spans.find((span) => span.spanId === spanId)?.kind ?? null) : null,
  );
  const showInternals = $derived(
    insightsStore.showSolusInternals ||
      (deepLinkedSpanKind !== null && SOLUS_INTERNAL_KINDS.has(deepLinkedSpanKind)),
  );
  const offersInternals = $derived(view ? hasInternalRows(view) : false);

  function attr(span: MetricsSpan | null, key: string): string | number | boolean | null {
    const value = span?.attrs[key];
    return value === undefined ? null : value;
  }

  const prompt = $derived(String(attr(root, "prompt") ?? ""));
  const transcript = $derived(turnTranscript(root));
  const boundTask = $derived(workspace.tasksStore.taskForSession(sessionId));
  const taskId = $derived(
    String(attr(root, "taskId") ?? "") || session?.taskId || boundTask?.id || null,
  );
  // The telemetry title is a dispatch-time snapshot. A session-born task still
  // has its first-prompt title then and receives its generated title after the
  // opening turn. Resolve the recorded task id against the live task store so
  // Insights shows the task's current name rather than that stale prompt.
  const task = $derived((taskId ? workspace.tasksStore.taskForId(taskId) : null) ?? boundTask);
  const taskTitle = $derived(
    task?.title || session?.taskTitle || String(attr(root, "taskTitle") ?? "") || null,
  );

  const statusTone = $derived(
    root?.status === "error"
      ? "var(--failure)"
      : root?.status === "interrupted"
        ? "var(--warning)"
        : "var(--muted-foreground)",
  );

  // Duration, cost, tokens and tool calls are attributes of the turn like every
  // other fact it recorded — one list a reader can read, select, and copy from,
  // rather than a strip of stat cards holding values the list then repeats.
  const attributeGroups = $derived(root && view ? turnAttributes(root, view) : []);

  const sessionName = $derived(sessionId ? insightsStore.sessionName(sessionId) : null);

  const sessionView = $derived(
    session
      ? sessionSummaryView(
          session,
          promptsByTrace(insightsStore.volumeRows),
          traceId,
          sessionName,
        )
      : null,
  );

  const contextNote = $derived(
    session
      ? `${session.turnCount} ${session.turnCount === 1 ? "turn" : "turns"} in this session`
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

  function openTurn(id: string): void {
    workspace.openInsightsTurn(id);
  }

  function openTask(taskId: string): void {
    workspace.goToTask(taskId, "click", "secondary");
  }

  async function openSessionTask(): Promise<void> {
    if (!sessionId) return;
    const task =
      boundTask ??
      (await workspace.tasksStore.ensureSessionBinding(
        sessionId,
        insightsStore.serverId ?? undefined,
      ));
    const destinationTaskId = taskId ?? task?.id ?? null;
    if (destinationTaskId) openTask(destinationTaskId);
  }

  function queryThisSession(): void {
    if (!sessionId) return;
    workspace.openInsightsForSession(sessionId);
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
  <!-- The app sets `user-select: none` at the root, which is right for a
       keyboard-first workspace and wrong for a page whose whole purpose is
       reading recorded values. The detail body opts back in; the controls
       inside it opt out again so a drag over a row still activates it. -->
  <div class="@container min-h-0 flex-1 overflow-y-auto px-6 select-text" data-sb>
    {#if loading && !view}
      <TurnDetailSkeleton />
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
          <div class="flex min-w-0 flex-col gap-1.5">
            <!-- The prompt is a message, not a title: one line names the turn,
                 and the Summary card below holds the whole text. -->
            <h1
              class="m-0 max-w-[72ch] truncate text-base leading-[1.4] font-medium select-text"
              title={singleLine(prompt)}
            >
              {singleLine(prompt) || "This turn recorded no prompt text"}
            </h1>
            <!-- Under the name, not above it: the identity line answers "which
                 turn is this" only once the reader has the turn. The backend
                 that ran it carries its logo, so a reader comparing Claude Code
                 against Codex recognises the turn before reading the line. -->
            <span
              class="flex flex-wrap items-center gap-1.5 text-[0.6875rem] text-muted-foreground select-text"
            >
              {formatClock(root.startedAt)} · {root.model ?? "—"} ·
              <span class="inline-flex items-center gap-1">
                <ProviderMark mark={providerMark(root.provider)} size={11} />
                {providerName(root.provider) ?? "unknown provider"}
              </span>
              · {root.origin ?? "typed"} · {formatDuration(view.totalMs)}
            </span>
          </div>
          <button
            type="button"
            class="h-7.5 shrink-0 cursor-pointer rounded-lg bg-card px-3 text-xs font-medium shadow-[shadow:var(--elev-ring)] transition-colors select-none hover:bg-muted active:scale-[0.98] disabled:cursor-default disabled:opacity-40"
            disabled={!sessionId}
            onclick={queryThisSession}>Query this session</button
          >
        </div>

        <!-- Where this turn sits in the window, then the session it sits in:
             both are statements about the whole page, so both take the whole
             width before the page splits into a column and a rail. -->
        {#if sessionId}
          <SessionContextChart
            rows={insightsStore.volumeRows}
            {sessionId}
            currentTraceId={traceId}
            currentStartedAt={root.startedAt}
            from={insightsStore.windowFrom}
            to={insightsStore.windowTo}
            heading={rangeHeading(insightsStore.range, "This session")}
            note={contextNote}
          />
        {/if}

        {#if session && sessionView && view.toolTotals.length > 0}
          <!-- Session context and the turn's longest calls are the two short
               lists a reader compares before entering the detailed trace. Keep
               them beside each other when the panel has room, and stack them
               when either list would become hard to read. -->
          <div
            class="grid gap-4 @4xl:grid-cols-[minmax(0,1fr)_19.25rem] @4xl:items-stretch"
          >
            <SessionSummary
              {session}
              view={sessionView}
              {sessionName}
              {taskTitle}
              currentTraceId={traceId}
              onOpenTurn={openTurn}
              onOpenTask={() => void openSessionTask()}
            />
            <TurnToolTotals totals={view.toolTotals} />
          </div>
        {:else if session && sessionView}
          <SessionSummary
            {session}
            view={sessionView}
            {sessionName}
            {taskTitle}
            currentTraceId={traceId}
            onOpenTurn={openTurn}
            onOpenTask={() => void openSessionTask()}
          />
        {:else}
          <TurnToolTotals totals={view.toolTotals} />
        {/if}

        <div class="flex flex-col gap-4 @4xl:flex-row @4xl:items-start">
          <div class="flex min-w-0 flex-1 flex-col gap-4">
            <!-- The turn's own words lead the column. Everything below is a
                 measurement of the exchange this card holds. -->
            <TurnTranscript panes={transcript} />

            <!-- No `overflow-hidden` here: it would make this card a scroll
                 container and the waterfall's sticky detail dock would stop
                 sticking. Nothing inside paints past the radius — the header's
                 rule is an inset shadow — so the corners stay clean without it. -->
            <section
              class="rounded-xl bg-card shadow-[shadow:var(--insights-card-shadow)]"
              aria-label="Trace"
            >
              <header
                class="flex h-10 items-center gap-3 px-5 shadow-[inset_0_-0.5px_0_var(--hairline)]"
              >
                <h2 class="m-0 shrink-0 text-sm font-medium">Trace</h2>
                {#if view.slowest[0]}
                  <span class="truncate text-[0.6875rem] text-muted-foreground"
                    >{view.slowest[0].label} is the largest span at {formatDuration(
                      view.slowest[0].durationMs,
                    )}</span
                  >
                {/if}
                <span class="flex-1"></span>
                {#if offersInternals}
                  <!-- The switch reads as a statement of what is on screen, so
                       the label is the thing shown rather than an instruction. -->
                  <label class="flex shrink-0 cursor-pointer items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
                    <Switch
                      checked={showInternals}
                      onCheckedChange={(next) => insightsStore.setShowSolusInternals(next)}
                      aria-label="Show Solus internals"
                    />
                    Solus internals
                  </label>
                {/if}
                <span class="shrink-0 text-[0.6875rem] tabular-nums text-muted-foreground"
                  >{formatDuration(view.totalMs)} · {view.spanCount} spans · {view.toolCallCount} tool
                  calls</span
                >
              </header>
              <!-- Coverage sits on the plot's own edge, at the plot's own
                   width: the share bar and the waterfall picture the same
                   interval, and they only read as one statement when they
                   share one. -->
              <div class="px-5 pt-3.5 pb-3 shadow-[inset_0_-0.5px_0_var(--hairline)]">
                <TraceCoverage trace={view} />
              </div>
              <div class="px-5 pt-3 pb-4">
                <TraceWaterfall trace={view} selectedSpanId={spanId} {showInternals} />
              </div>
            </section>
          </div>

          <!-- Attributes are the long reference list the rail is for. The short
               tool ranking sits beside the equally short session card above. -->
          <aside
            class="flex w-full shrink-0 flex-col gap-2.5 @4xl:sticky @4xl:top-3.5 @4xl:w-[19.25rem]"
          >
            <TurnAttributes groups={attributeGroups} onOpenTask={openTask} />
          </aside>
        </div>
      </div>
    {/if}
  </div>
</div>
