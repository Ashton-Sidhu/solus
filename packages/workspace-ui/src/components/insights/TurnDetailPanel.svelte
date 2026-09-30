<script lang="ts">
  import { getWorkspaceContext } from "../../contexts";
  import type { MetricsSpan, TurnFlagKind } from "@solus/contracts/observability-types";
  import {
    ArrowDown as BelowIcon,
    ArrowUp as AboveIcon,
    Check as CheckIcon,
    CircleX as FailedIcon,
    Minus as EvenIcon,
    TriangleAlert as AlertIcon,
    Download as ExportIcon,
    Ellipsis as MoreIcon,
    ListChecks as TaskIcon,
    MessageSquare as SessionIcon,
    PenLine as ComposeIcon,
    Rows3 as SessionPageIcon,
  } from "@lucide/svelte";
  import { onDestroy, tick } from "svelte";
  import { toasts } from "../../lib/toasts";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { SubPageCrumbLine } from "../ui/list-page";
  import { formatClock, formatDuration, shortId, singleLine } from "./lib/format";
  import { modelName, providerMark, providerName } from "./lib/provider";
  import { buildTraceView, hasInternalRows, SOLUS_INTERNAL_KINDS } from "./lib/waterfall";
  import { Switch } from "../ui/switch";
  import { promptsByTrace, sessionSummaryView } from "./lib/session-summary";
  import { coverageReadings, type CoverageReadingId } from "./lib/coverage-readings";
  import { statColor, turnAttributes, turnStats, type StatVerdictGlyph } from "./lib/turn-attributes";
  import {
    annotateStats,
    cacheEconomics,
    contextGrowth,
    firstFailingSpanId,
    traceExportFileName,
    traceExportJson,
    turnBaselines,
    turnFindings,
  } from "./lib/turn-analysis";
  import { turnVerification } from "./lib/turn-verification";
  import { turnStatusBadge } from "./lib/turn-status";
  import { turnTranscript } from "./lib/turn-transcript";
  import { downloadText } from "./lib/trace-export";
  import { insightsStore } from "./insights.store.svelte";
  import ProviderMark from "../ui/ProviderMark.svelte";
  import ShareButton from "../sharing/ShareButton.svelte";
  import CoverageReadingMenu from "./CoverageReadingMenu.svelte";
  import SessionSummary from "./SessionSummary.svelte";
  import TraceCoverage from "./TraceCoverage.svelte";
  import TraceWaterfall from "./TraceWaterfall.svelte";
  import TurnAttributes from "./TurnAttributes.svelte";
  import TurnDetailSkeleton from "./TurnDetailSkeleton.svelte";
  import TurnFindings from "./TurnFindings.svelte";
  import TurnFlagMenu from "./TurnFlagMenu.svelte";
  import TurnResult from "./TurnResult.svelte";
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
   *
   * The page is ordered by the question a reader opens a turn with: what
   * happened, and why did it take this long or cost this much. So the result
   * leads — what the turn changed and whether it was checked — then the
   * findings (the failure, the repeat, the wait, the cache miss), the trace,
   * and the exchange. Each thought is read on its thinking span in the trace.
   * Everything that is context rather than measurement — the session, the
   * tool ranking, the attribute list — sits in the rail beside them.
   *
   * A turn still running is read again every few seconds until its root
   * closes, so Insights doubles as a monitor of the turn in progress.
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

  /** The icon for each stat verdict; the colour carries good or bad. */
  const VERDICT_ICONS = {
    up: AboveIcon,
    down: BelowIcon,
    even: EvenIcon,
    check: CheckIcon,
    alert: AlertIcon,
    failed: FailedIcon,
  } satisfies Record<StatVerdictGlyph, typeof AboveIcon>;

  let loading = $state(true);

  $effect(() => {
    const id = traceId;
    loading = true;
    void insightsStore.loadTurnFlags();
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

  /** A running turn: its root has not closed. Re-read on a short cadence
   *  until it does, and once more after, so the settled totals land. */
  const isLive = $derived(root != null && root.endedAt == null);
  const LIVE_REFRESH_MS = 2_000;
  let liveTimer: ReturnType<typeof setInterval> | null = null;
  $effect(() => {
    const id = traceId;
    if (!isLive) return;
    liveTimer = setInterval(() => void insightsStore.reloadTrace(id), LIVE_REFRESH_MS);
    return () => {
      if (liveTimer) clearInterval(liveTimer);
      liveTimer = null;
      // The last read while live may predate the close by a beat.
      void insightsStore.reloadTrace(id).then((settled) => {
        const settledSessionId = settled?.spans.find((span) => span.sessionId)?.sessionId;
        if (settledSessionId) void insightsStore.loadSessionSummary(settledSessionId);
      });
    };
  });
  onDestroy(() => {
    if (liveTimer) clearInterval(liveTimer);
  });

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

  /** Where the waterfall opens: the span the link named, or, on a failed turn
   *  nobody deep-linked into, the span that failed — the error is what the
   *  reader came for, not the prompt. */
  const landingSpanId = $derived(
    spanId ?? (view && root?.status === "error" ? firstFailingSpanId(view) : null),
  );

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
  const task = $derived(workspace.tasksStore.peek(taskId) ?? boundTask);
  const taskTitle = $derived(
    task?.title || session?.taskTitle || String(attr(root, "taskTitle") ?? "") || null,
  );

  // A root with no end is running whatever status it was opened with.
  const statusBadge = $derived(root ? turnStatusBadge(isLive ? "unknown" : root.status) : null);

  // The readings. Every one is derived from the trace as recorded; the panel
  // only lays them out.
  const findings = $derived(root && view && trace ? turnFindings(root, view, trace, session) : []);
  const stats = $derived(
    root && view
      ? annotateStats(
          turnStats(root, view),
          turnBaselines(root, session, insightsStore.volumeRows),
          cacheEconomics(root),
          contextGrowth(root, session),
        )
      : [],
  );
  const coverage = $derived(root && view ? coverageReadings(root, view) : []);
  // Held across turns: a reader comparing turns by cost wants the next turn
  // opened on cost too. A turn that cannot answer it shows span kind.
  let coverageReadingId = $state<CoverageReadingId>("kind");
  const activeCoverage = $derived(
    coverage.find((reading) => reading.id === coverageReadingId) ?? coverage[0] ?? null,
  );
  const verification = $derived(trace ? turnVerification(trace.spans) : null);
  const turnChange = $derived(insightsStore.turnChange(traceId));
  // Git records a turn's change when the turn ends, so a running turn has none
  // to read yet; the host's announcement of the end clears the cached answer.
  const sessionRecordCtx = $derived(sessionId ? workspace.ctxForSessionRecord(sessionId) : null);
  $effect(() => {
    if (!sessionRecordCtx || isLive || !root) return;
    void insightsStore.loadTurnChange(sessionRecordCtx, traceId);
  });
  const attributeGroups = $derived(root && view ? turnAttributes(root, view) : []);
  const flag = $derived(insightsStore.turnFlags.get(traceId) ?? null);

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

  // A queue of one, or a turn the list is not showing (deep-linked, or the
  // query moved on) has nowhere to step to — offer the control only where it
  // moves, rather than leaving two arrows and a blank count.
  const canStepQueue = $derived(position > 0 && total > 1);

  function openTurn(id: string): void {
    workspace.openInsightsTurn(id);
  }

  /** Lands the waterfall on one span: the route carries it, so a finding, a
   *  thought, and an outcome line all open the same way a deep link does. */
  function openSpan(id: string): void {
    workspace.openInsightsTurn(traceId, id);
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

  /** The session id a span carries is Solus's own, so an open conversation is
   *  focused rather than opened a second time; a closed one is resumed. */
  async function revealSession(): Promise<string | null> {
    if (!sessionId || !insightsStore.serverId) return null;
    const tabId = await workspace.revealSession(sessionId, insightsStore.serverId);
    if (!tabId) toasts.error("That session is no longer on this host");
    return tabId;
  }

  /** The natural next step after spotting a waste: the same ask, in the
   *  session's own composer, ready to be rewritten and sent. The pending
   *  input is the workspace's, picked up by whichever composer takes focus —
   *  the revealed session's, since revealing it focuses it. */
  async function openPromptInComposer(): Promise<void> {
    const tabId = await revealSession();
    if (!tabId || !prompt) return;
    workspace.update({ pendingInput: prompt });
  }


  function openSessionPage(): void {
    if (sessionId) workspace.openInsightsSession(sessionId);
  }

  function exportTrace(): void {
    if (!trace || !view || !root) return;
    downloadText(traceExportFileName(traceId), traceExportJson(trace, view, root));
  }

  /** Close the menu, then act: a row that reveals a session restructures the
   *  workspace under the menu, the same order the pull request overflow uses. */
  let moreOpen = $state(false);
  async function runMenuAction(action: () => void): Promise<void> {
    moreOpen = false;
    await tick();
    action();
  }

  function setFlag(kind: TurnFlagKind, note: string): void {
    void insightsStore.setTurnFlag(traceId, kind, note).catch(() => toasts.error("Could not save the mark"));
  }

  function clearFlag(): void {
    void insightsStore.clearTurnFlag(traceId).catch(() => toasts.error("Could not clear the mark"));
  }
</script>

{#snippet turnStatus()}
  {#if statusBadge}
    <span
      class="mr-1 flex shrink-0 items-center gap-1.5 text-insights-chrome font-medium"
      style="color:{statusBadge.color}"
    >
      <statusBadge.icon class="size-3.5" aria-hidden="true" />
      {statusBadge.label}
    </span>
  {/if}
{/snippet}

<div class="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
  <!-- The sub page band every record shares. Full screen covers the page's own
       crumb line, so this band carries the whole path back and clears the
       window controls; beside the list it starts at the panel's own edge.
       Either crumb returns to the listing. -->
  <SubPageCrumbLine
    page="insights"
    onOpenPage={onClose}
    trail={[{ label: listLabel, onOpen: onClose }]}
    leaf={shortId(traceId)}
    leafTitle={traceId}
    copyText={traceId}
    copyTitle="Copy Insights ID"
    actions={turnStatus}
    stepper={canStepQueue
      ? {
          onPrevious: () => onStep(-1),
          onNext: () => onStep(1),
          itemLabel: "row",
          position,
          total,
        }
      : undefined}
    onToggleMaximize={onToggleFullScreen}
    maximized={fullScreen}
    maximizeLabel="Expand to full screen"
    restoreLabel="Back to split"
    {onClose}
    clearsWindowControls={fullScreen}
  />

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
        <span class="text-insights-chrome">No spans recorded for this trace</span>
        <span class="text-insights-chrome"
          >Metrics start at the version that instrumented them; there is no backfill.</span
        >
      </div>
    {:else}
      <div class="mx-auto flex w-full max-w-[87.5rem] flex-col gap-4 py-6 pb-16">
        <!-- The title column grows from a zero basis: sized by its prompt, a
             long one claimed the whole line and pushed the actions under it
             while a short one did not. Now the actions wrap only when the
             panel cannot hold them beside a 15rem title. -->
        <div class="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div class="flex min-w-[min(15rem,100%)] flex-[1_1_0%] flex-col gap-1.5">
            <!-- The prompt is a message, not a title: one line names the turn,
                 and the Summary card below holds the whole text. -->
            <h1
              class="m-0 max-w-[72ch] truncate text-h3 leading-[1.4] font-medium select-text"
              title={singleLine(prompt)}
            >
              {singleLine(prompt) || "This turn recorded no prompt text"}
            </h1>
            <!-- Under the name, not above it: the identity line answers "which
                 turn is this" only once the reader has the turn. The backend
                 that ran it carries its logo, so a reader comparing Claude Code
                 against Codex recognises the turn before reading the line. -->
            <span
              class="flex flex-wrap items-center gap-1.5 text-insights-chrome text-muted-foreground select-text"
            >
              {formatClock(root.startedAt)} ·
              <span
                class="inline-flex items-center gap-1 text-foreground"
                title="{providerName(root.provider) ?? 'Unknown provider'}{root.model ? ` · ${root.model}` : ''}"
              >
                <ProviderMark mark={providerMark(root.provider)} size={12} />
                {modelName(root.provider, root.model) ?? providerName(root.provider) ?? "Unknown model"}
              </span>
              · {root.origin ?? "typed"} · {formatDuration(view.totalMs)}
              <!-- The queue wait precedes the turn, so it is said here, beside
                   the turn's own length, and not as a share of it. -->
              {#if view.queuedMs > 0}
                · waited {formatDuration(view.queuedMs)} in the queue first
              {/if}
            </span>
          </div>
          <!-- Where this turn leads, and what the reader thinks of it. One
               group, so the ways out of the page — the conversation, the task,
               the session's other turns, the share, the file — are found in one
               place instead of one per card. -->
          <div class="flex shrink-0 flex-wrap items-center gap-1.5 select-none" role="group" aria-label="Open elsewhere">
            <TurnFlagMenu {flag} onSet={setFlag} onClear={clearFlag} />
            <Button
              variant="ghost"
              size="sm"
              class="h-8 gap-1.5 rounded-full px-2.5 text-insights-chrome text-muted-foreground shadow-[inset_0_0_0_0.5px_var(--hairline)] transition-[color,background-color,scale] hover:bg-[var(--wash-2)] hover:text-foreground active:scale-[0.96] pointer-coarse:h-10"
              disabled={!sessionId}
              title="Open the conversation this turn belongs to"
              onclick={() => void revealSession()}
            >
              <SessionIcon class="size-3.5" aria-hidden="true" />
              Open session
            </Button>
            <Button
              variant="ghost"
              size="sm"
              class="h-8 gap-1.5 rounded-full px-2.5 text-insights-chrome text-muted-foreground shadow-[inset_0_0_0_0.5px_var(--hairline)] transition-[color,background-color,scale] hover:bg-[var(--wash-2)] hover:text-foreground active:scale-[0.96] pointer-coarse:h-10"
              disabled={!sessionId}
              title={taskTitle ? `Open task: ${taskTitle}` : "Open the task this turn ran under"}
              onclick={() => void openSessionTask()}
            >
              <TaskIcon class="size-3.5" aria-hidden="true" />
              Open task
            </Button>
            <!-- Sharing a turn shares the session it belongs to: the share
                 dialog is the one the session band and the task page use. -->
            <ShareButton
              serverId={insightsStore.serverId}
              resource={sessionId ? { kind: "session", id: sessionId } : null}
              title={sessionName ?? taskTitle ?? singleLine(prompt)}
              class="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground shadow-[inset_0_0_0_0.5px_var(--hairline)] transition-[color,background-color,scale] hover:bg-[var(--wash-2)] hover:text-foreground active:scale-[0.96] pointer-coarse:size-10"
            />
            <DropdownMenu.Root bind:open={moreOpen}>
              <DropdownMenu.Trigger>
                {#snippet child({ props })}
                  <Button
                    {...props}
                    variant="ghost"
                    size="icon"
                    class="size-8 rounded-full text-muted-foreground shadow-[inset_0_0_0_0.5px_var(--hairline)] transition-[color,background-color,scale] hover:bg-[var(--wash-2)] hover:text-foreground active:scale-[0.96] aria-expanded:bg-[var(--wash-3)] aria-expanded:text-foreground pointer-coarse:size-10"
                    title="More actions"
                    aria-label="More actions"
                  >
                    <MoreIcon size={15} aria-hidden="true" />
                  </Button>
                {/snippet}
              </DropdownMenu.Trigger>
              <!-- Every label stays on one line: a menu row is a fixed height,
                   so a label that wraps overflows its own row. -->
              <DropdownMenu.Content
                side="bottom"
                align="end"
                sideOffset={6}
                class="w-56 max-w-[calc(100vw-2rem)] [&_.menu-row]:text-workspace-chrome"
              >
                <DropdownMenu.Item disabled={!sessionId} onSelect={() => void runMenuAction(openSessionPage)}>
                  <SessionPageIcon size={14} />
                  <span class="whitespace-nowrap">All turns in this session</span>
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  disabled={!sessionId || !prompt}
                  onSelect={() => void runMenuAction(() => void openPromptInComposer())}
                >
                  <ComposeIcon size={14} />
                  <span class="whitespace-nowrap">Edit prompt in composer</span>
                </DropdownMenu.Item>
                <DropdownMenu.Separator />
                <DropdownMenu.Item onSelect={() => void runMenuAction(exportTrace)}>
                  <ExportIcon size={14} />
                  <span class="whitespace-nowrap">Export as JSON</span>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Root>
          </div>
        </div>

        <!-- The turn's outcome in one card, every figure judged. Each tile
             carries a badge that says whether the figure is good, typical,
             or the thing to look at, and a meter against its reference: the
             median for duration, cost, and tokens (the tick), the hit rate
             for the cache, the warning line for the context. Only the badge
             and the meter carry colour. The hover holds the full comparison. -->
        {#if stats.length > 0}
          <dl
            class="m-0 grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-1 rounded-xl bg-card p-1 shadow-[shadow:var(--insights-card-shadow)]"
          >
            {#each stats as stat (stat.label)}
              {@const color = statColor(stat)}
              <div class="flex min-w-0 flex-col gap-1 rounded-lg px-3.5 py-2.5" title={stat.note}>
                <dt class="flex min-w-0 items-center justify-between gap-2 text-insights-chrome text-muted-foreground">
                  <span class="truncate">{stat.label}</span>
                  {#if stat.verdict}
                    {@const VerdictIcon = VERDICT_ICONS[stat.verdict.glyph]}
                    <span
                      class="flex size-5 shrink-0 items-center justify-center rounded-full"
                      style:color={color ?? "var(--muted-foreground)"}
                      style:background-color={color
                        ? `color-mix(in srgb, ${color} 14%, transparent)`
                        : "var(--wash-2)"}
                      role="img"
                      aria-label={stat.verdict.label}
                      title={stat.verdict.label}
                    >
                      <VerdictIcon size={12} strokeWidth={2.25} aria-hidden="true" />
                    </span>
                  {/if}
                </dt>
                <dd class="m-0 truncate text-insights-summary-heading font-medium tabular-nums text-foreground">
                  {stat.value}
                </dd>
                <dd class="relative m-0 h-1 rounded-full {stat.meter ? 'bg-[var(--wash-3)]' : ''}" aria-hidden="true">
                  {#if stat.meter}
                    <span
                      class="absolute inset-y-0 left-0 rounded-full"
                      style:width="{Math.max(stat.meter.fill * 100, 2)}%"
                      style:background-color={color ?? "var(--muted-foreground)"}
                    ></span>
                    {#if stat.meter.marker != null}
                      <span
                        class="absolute -top-0.5 -bottom-0.5 w-px bg-foreground"
                        style:left="{stat.meter.marker * 100}%"
                      ></span>
                    {/if}
                  {/if}
                </dd>
                <dd class="m-0 truncate text-insights-chrome tabular-nums text-muted-foreground">
                  {stat.detail ?? "\u00a0"}
                </dd>
              </div>
            {/each}
          </dl>
        {/if}

        <!-- What the numbers bought: the change and whether it was checked.
             Full width, because the map needs it and because it is the
             outcome of the turn, not context beside it. -->
        {#if verification && sessionRecordCtx}
          <!-- Keyed: which diffs are open belongs to one turn. -->
          {#key traceId}
            <TurnResult
              {verification}
              change={turnChange}
              {isLive}
              projectRoot={root.projectRoot}
              onOpenSpan={openSpan}
              loadRepoFiles={insightsStore.repoFileLoader(sessionRecordCtx)}
            />
          {/key}
        {/if}

        <div class="flex flex-col gap-4 @4xl:flex-row @4xl:items-start">
          <div class="flex min-w-0 flex-1 flex-col gap-4">
            <TurnFindings {findings} onOpenSpan={openSpan} />

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
                <h2 class="m-0 shrink-0 text-insights-summary font-medium">Trace</h2>
                {#if view.slowest[0]}
                  <span class="truncate text-insights-chrome text-muted-foreground"
                    >{view.slowest[0].label} is the largest span at {formatDuration(
                      view.slowest[0].durationMs,
                    )}</span
                  >
                {/if}
                <span class="flex-1"></span>
                {#if activeCoverage && coverage.length > 1}
                  <CoverageReadingMenu
                    readings={coverage}
                    active={activeCoverage}
                    onSelect={(id) => (coverageReadingId = id)}
                  />
                {/if}
                {#if offersInternals}
                  <!-- The switch reads as a statement of what is on screen, so
                       the label is the thing shown rather than an instruction. -->
                  <label class="flex shrink-0 cursor-pointer items-center gap-1.5 text-insights-chrome text-muted-foreground">
                    <Switch
                      checked={showInternals}
                      onCheckedChange={(next) => insightsStore.setShowSolusInternals(next)}
                      aria-label="Show Solus internals"
                    />
                    Solus internals
                  </label>
                {/if}
                <span class="shrink-0 text-insights-chrome tabular-nums text-muted-foreground"
                  >{formatDuration(view.totalMs)} · {view.spanCount} spans · {view.toolCallCount} tool
                  calls</span
                >
              </header>
              <!-- Coverage sits on the plot's own edge, at the plot's own
                   width: the share bar and the waterfall picture the same
                   interval, and they only read as one statement when they
                   share one. -->
              {#if activeCoverage}
                <div class="px-5 pt-3.5 pb-3 shadow-[inset_0_-0.5px_0_var(--hairline)]">
                  <TraceCoverage trace={view} reading={activeCoverage} />
                </div>
              {/if}
              <div class="px-5 pt-3 pb-4">
                <TraceWaterfall trace={view} selectedSpanId={landingSpanId} {showInternals} />
              </div>
            </section>

            <!-- The turn's own words, after the measurement of them: the ask is
                 already the title, and the answer is read once the reader knows
                 what it cost. -->
            <TurnTranscript panes={transcript} />
          </div>

          <!-- Context, not measurement: the session this turn sits in, the
               tool ranking, and the long reference list.
               Not sticky — four cards outrun a short window, and a sticky
               column taller than the screen hides its own foot until the page
               ends. -->
          <aside class="flex w-full shrink-0 flex-col gap-4 @4xl:w-[19.25rem]">
            {#if session && sessionView}
              <SessionSummary
                {session}
                view={sessionView}
                {sessionName}
                {taskTitle}
                currentTraceId={traceId}
                onOpenTurn={openTurn}
                onOpenTask={() => void openSessionTask()}
              />
            {/if}
            <TurnToolTotals totals={view.toolTotals} />
            <TurnAttributes groups={attributeGroups} onOpenTask={openTask} />
          </aside>
        </div>
      </div>
    {/if}
  </div>
</div>
