<script lang="ts">
  import { getWorkspaceContext, sharesStore } from "../../contexts";
  import type { MetricsSpan, TurnFlagKind } from "@solus/contracts/observability-types";
  import {
    Download as ExportIcon,
    Ellipsis as MoreIcon,
    ListChecks as TaskIcon,
    MessageSquare as SessionIcon,
    PenLine as ComposeIcon,
    Rows3 as SessionPageIcon,
    Share as ShareIcon,
  } from "@lucide/svelte";
  import { onDestroy, tick } from "svelte";
  import { toasts } from "../../lib/toasts";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { SubPageCrumbLine } from "../ui/list-page";
  import { shortId } from "./lib/format";
  import { buildTraceView } from "./lib/waterfall";
  import { promptsByTrace } from "./lib/session-summary";
  import { traceExportFileName, traceExportJson, turnBaselines } from "./lib/turn-analysis";
  import { turnStatusBadge } from "./lib/turn-status";
  import {
    reportAgent,
    turnReportContent,
    turnReportSubject,
    turnReportTitle,
    type TurnReport,
  } from "./lib/turn-report";
  import { downloadText } from "./lib/trace-export";
  import { insightsStore } from "./insights.store.svelte";
  import TurnDetailSkeleton from "./TurnDetailSkeleton.svelte";
  import TurnFlagMenu from "./TurnFlagMenu.svelte";
  import TurnReadings from "./TurnReadings.svelte";

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

  function attr(span: MetricsSpan | null, key: string): string | number | boolean | null {
    const value = span?.attrs[key];
    return value === undefined ? null : value;
  }

  const prompt = $derived(String(attr(root, "prompt") ?? ""));
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

  const baselines = $derived(root ? turnBaselines(root, session, insightsStore.volumeRows) : []);
  const prompts = $derived(promptsByTrace(insightsStore.volumeRows));
  const turnChange = $derived(insightsStore.turnChange(traceId));
  // Git records a turn's change when the turn ends, so a running turn has none
  // to read yet; the host's announcement of the end clears the cached answer.
  const sessionRecordCtx = $derived(sessionId ? workspace.ctxForSessionRecord(sessionId) : null);
  $effect(() => {
    if (!sessionRecordCtx || isLive || !root) return;
    void insightsStore.loadTurnChange(sessionRecordCtx, traceId);
  });
  const flag = $derived(insightsStore.turnFlags.get(traceId) ?? null);

  const sessionName = $derived(sessionId ? insightsStore.sessionName(sessionId) : null);

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

  /** A running turn has no settled readings to report yet. */
  const canShareReport = $derived(
    !!insightsStore.serverId && !!root && !isLive && sharesStore.canShareFrom(insightsStore.serverId, "work"),
  );

  function shareReport(): void {
    const serverId = insightsStore.serverId;
    if (!serverId || !root || !trace) return;
    const capturedAt = new Date();
    const report: TurnReport = {
      version: 1,
      capturedAt: capturedAt.getTime(),
      trace,
      session,
      sessionName,
      taskTitle,
      baselines,
      prompts: Object.fromEntries(promptsByTrace(insightsStore.volumeRows.filter((row) => row.sessionId === sessionId))),
      patch: turnChange?.status === "ready" ? turnChange.patch : null,
    };
    const title = turnReportTitle({ subject: turnReportSubject({ sessionName, taskTitle, prompt }), capturedAt });
    void sharesStore.shareReport(serverId, { title, content: turnReportContent(report), agentProvider: reportAgent(root.provider) });
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

{#snippet turnActions()}
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
  <!-- Sharing a turn shares a report of it: a work captured now, which
       reads the same while this computer is off (cloud-sharing.md §4).
       The session itself is shared from its own Share. -->
  {#if canShareReport}
    <Button
      variant="ghost"
      size="icon"
      class="size-8 shrink-0 rounded-full text-muted-foreground shadow-[inset_0_0_0_0.5px_var(--hairline)] transition-[color,background-color,scale] hover:bg-[var(--wash-2)] hover:text-foreground active:scale-[0.96] pointer-coarse:size-10"
      title="Share a report of this turn"
      aria-label="Share a report of this turn"
      disabled={sharesStore.busy}
      onclick={shareReport}
    >
      <ShareIcon size={14} aria-hidden="true" />
    </Button>
  {/if}
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
    {:else if !view || !root || !trace}
      <div class="flex flex-col items-center gap-2 py-16 text-muted-foreground">
        <span class="text-insights-chrome">No spans recorded for this trace</span>
        <span class="text-insights-chrome"
          >Metrics start at the version that instrumented them; there is no backfill.</span
        >
      </div>
    {:else}
      <TurnReadings
        {trace}
        {view}
        {root}
        {isLive}
        {session}
        {sessionName}
        {taskTitle}
        {baselines}
        {prompts}
        change={turnChange}
        showResult={!!sessionRecordCtx}
        loadRepoFiles={sessionRecordCtx ? insightsStore.repoFileLoader(sessionRecordCtx) : async () => null}
        {spanId}
        actions={turnActions}
        onOpenSpan={openSpan}
        onOpenTurn={openTurn}
        onOpenTask={openTask}
        onOpenSessionTask={() => void openSessionTask()}
      />
    {/if}
  </div>
</div>
