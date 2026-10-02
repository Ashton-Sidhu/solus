<script lang="ts">
  import type { Snippet } from "svelte";
  import type { MetricsSessionSummary, MetricsSpan, MetricsTurnTrace } from "@solus/contracts/observability-types";
  import {
    ArrowDown as BelowIcon,
    ArrowUp as AboveIcon,
    Check as CheckIcon,
    CircleX as FailedIcon,
    Minus as EvenIcon,
    TriangleAlert as AlertIcon,
  } from "@lucide/svelte";
  import { formatClock, formatDuration, singleLine } from "./lib/format";
  import { modelName, providerMark, providerName } from "./lib/provider";
  import { firstFailingSpanId, annotateStats, cacheEconomics, contextGrowth, turnFindings, type TurnBaseline } from "./lib/turn-analysis";
  import { hasInternalRows, SOLUS_INTERNAL_KINDS, type TraceView } from "./lib/waterfall";
  import { sessionSummaryView } from "./lib/session-summary";
  import { coverageReadings, type CoverageReadingId } from "./lib/coverage-readings";
  import { statColor, turnAttributes, turnStats, type StatVerdictGlyph } from "./lib/turn-attributes";
  import { turnVerification } from "./lib/turn-verification";
  import { turnTranscript } from "./lib/turn-transcript";
  import { insightsStore, type TurnChangeReading } from "./insights.store.svelte";
  import { Switch } from "../ui/switch";
  import ProviderMark from "../ui/ProviderMark.svelte";
  import CoverageReadingMenu from "./CoverageReadingMenu.svelte";
  import SessionSummary from "./SessionSummary.svelte";
  import TraceCoverage from "./TraceCoverage.svelte";
  import TraceWaterfall from "./TraceWaterfall.svelte";
  import TurnAttributes from "./TurnAttributes.svelte";
  import TurnFindings from "./TurnFindings.svelte";
  import TurnResult from "./TurnResult.svelte";
  import TurnToolTotals from "./TurnToolTotals.svelte";
  import TurnTranscript from "./TurnTranscript.svelte";

  /**
   * One turn's readings, laid out: the page under the turn panel's band.
   *
   * The Insights page draws it from the host's live answers; a shared Insights
   * report draws it from the readings captured at Share (`lib/turn-report.ts`),
   * so a person the report was shared with reads the same page. Where the
   * readings lead elsewhere — another turn, the task — the caller passes the way
   * there; a report, whose turn stayed on its computer, passes none.
   *
   * The page is ordered by the question a reader opens a turn with: what
   * happened, and why did it take this long or cost this much. So the result
   * leads — what the turn changed and whether it was checked — then the
   * findings (the failure, the repeat, the wait, the cache miss), the trace,
   * and the exchange. Everything that is context rather than measurement — the
   * session, the tool ranking, the attribute list — sits in the rail beside them.
   */
  interface Props {
    trace: MetricsTurnTrace;
    view: TraceView;
    /** The view's root turn span: a trace with none has no page to draw. */
    root: MetricsSpan;
    /** The root has not closed: git records the change when it does. */
    isLive: boolean;
    session: MetricsSessionSummary | null;
    sessionName: string | null;
    taskTitle: string | null;
    baselines: TurnBaseline[];
    /** The one-line prompt of each turn in the session, by trace id. */
    prompts: Map<string, string>;
    /** Null hides the result card: there is no project to read the change from. */
    change: TurnChangeReading | null;
    showResult: boolean;
    loadRepoFiles: (repoRoot: string) => Promise<readonly string[] | null>;
    /** The span a link named, which the waterfall lands on. */
    spanId: string | null;
    /** The verbs beside the title. */
    actions?: Snippet;
    onOpenSpan: (spanId: string) => void;
    onOpenTurn?: (traceId: string) => void;
    onOpenTask?: (taskId: string) => void;
    onOpenSessionTask?: () => void;
  }

  let {
    trace,
    view,
    root,
    isLive,
    session,
    sessionName,
    taskTitle,
    baselines,
    prompts,
    change,
    showResult,
    loadRepoFiles,
    spanId,
    actions,
    onOpenSpan,
    onOpenTurn,
    onOpenTask,
    onOpenSessionTask,
  }: Props = $props();

  /** The icon for each stat verdict; the colour carries good or bad. */
  const VERDICT_ICONS = {
    up: AboveIcon,
    down: BelowIcon,
    even: EvenIcon,
    check: CheckIcon,
    alert: AlertIcon,
    failed: FailedIcon,
  } satisfies Record<StatVerdictGlyph, typeof AboveIcon>;

  const traceId = $derived(trace.traceId);
  const prompt = $derived(String(root.attrs.prompt ?? ""));
  const transcript = $derived(turnTranscript(root));

  /** A deep link that points at a Solus row reveals it whatever the stored
   *  preference says — a link that lands on a span the reader cannot see is a
   *  broken link — without turning the preference on for every later turn. */
  const deepLinkedSpanKind = $derived(
    spanId ? (trace.spans.find((span) => span.spanId === spanId)?.kind ?? null) : null,
  );
  const showInternals = $derived(
    insightsStore.showSolusInternals ||
      (deepLinkedSpanKind !== null && SOLUS_INTERNAL_KINDS.has(deepLinkedSpanKind)),
  );
  const offersInternals = $derived(hasInternalRows(view));

  /** Where the waterfall opens: the span the link named, or, on a failed turn
   *  nobody deep-linked into, the span that failed — the error is what the
   *  reader came for, not the prompt. */
  const landingSpanId = $derived(spanId ?? (root.status === "error" ? firstFailingSpanId(view) : null));

  // The readings. Every one is derived from the trace as recorded; the page
  // only lays them out.
  const findings = $derived(turnFindings(root, view, trace, session));
  const stats = $derived(
    annotateStats(turnStats(root, view), baselines, cacheEconomics(root), contextGrowth(root, session)),
  );
  const coverage = $derived(coverageReadings(root, view));
  // Held across turns: a reader comparing turns by cost wants the next turn
  // opened on cost too. A turn that cannot answer it shows span kind.
  let coverageReadingId = $state<CoverageReadingId>("kind");
  const activeCoverage = $derived(
    coverage.find((reading) => reading.id === coverageReadingId) ?? coverage[0] ?? null,
  );
  const verification = $derived(turnVerification(trace.spans));
  const attributeGroups = $derived(turnAttributes(root, view));
  const sessionView = $derived(session ? sessionSummaryView(session, prompts, traceId, sessionName) : null);
</script>

<div class="mx-auto flex w-full max-w-[87.5rem] flex-col gap-4 pt-2 pb-16">
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
    {#if actions}
      <div class="flex shrink-0 flex-wrap items-center gap-2 select-none" role="group" aria-label="Open elsewhere">
        {@render actions()}
      </div>
    {/if}
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
            {stat.detail ?? " "}
          </dd>
        </div>
      {/each}
    </dl>
  {/if}

  <!-- What the numbers bought: the change and whether it was checked.
       Full width, because the map needs it and because it is the
       outcome of the turn, not context beside it. -->
  {#if showResult}
    <!-- Keyed: which diffs are open belongs to one turn. -->
    {#key traceId}
      <TurnResult
        {verification}
        {change}
        {isLive}
        projectRoot={root.projectRoot}
        {onOpenSpan}
        {loadRepoFiles}
      />
    {/key}
  {/if}

  <div class="flex flex-col gap-4 @4xl:flex-row @4xl:items-start">
    <div class="flex min-w-0 flex-1 flex-col gap-4">
      <TurnFindings {findings} {onOpenSpan} />

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
          {onOpenTurn}
          onOpenTask={onOpenSessionTask}
        />
      {/if}
      <TurnToolTotals totals={view.toolTotals} />
      <TurnAttributes groups={attributeGroups} {onOpenTask} />
    </aside>
  </div>
</div>
