import type {
  MetricsGapCategory,
  MetricsSpan,
  MetricsTurnTrace,
  MetricsValue,
} from '@solus/contracts/observability-types'
// Text attributes are decoded even though the contract types them, for the same
// reason the transcript panes do: they are rendered as content — a command, a
// prompt, a tool's input — and a host on an older build sending a number where
// the registry declares text must not have it printed back as what someone
// wrote. Numbers and flags are read straight off the typed attrs; a wrong
// number reads as a wrong number, not as fabricated words.
import { thoughtPreview } from '../../../lib/thought-preview'
import { formatDuration } from './format'
import { asStringOrNull } from './result-columns'
import { PROVIDER_WAIT_KIND, USER_WAIT_KIND, colorForKind, labelForKind } from './span-palette'

// One turn's span tree, laid out as a waterfall.
//
// Children record only observed intervals and may overlap (parallel or nested
// tools), so every rollup here unions intervals rather than summing durations —
// summing would report more time inside a turn than the turn itself took.
// Unattributed time comes from the server, which derives it from the root
// interval minus the union of blocking children; it is never a stored span.
//
// Pure and non-reactive.

export interface Interval {
  from: number
  to: number
}

/** Total length covered by a set of possibly overlapping intervals. */
export function unionLength(intervals: Interval[]): number {
  if (!intervals.length) return 0
  const ordered = intervals.slice().sort((a, b) => a.from - b.from)
  let covered = 0
  let start = ordered[0].from
  let end = ordered[0].to
  for (const interval of ordered.slice(1)) {
    if (interval.from > end) {
      covered += end - start
      start = interval.from
      end = interval.to
    } else if (interval.to > end) {
      end = interval.to
    }
  }
  return covered + (end - start)
}

function intervalOf(span: MetricsSpan, fallbackEnd: number): Interval {
  const to = span.endedAt ?? (span.durationMs != null ? span.startedAt + span.durationMs : fallbackEnd)
  return { from: span.startedAt, to: Math.max(span.startedAt, to) }
}

/** The part of an interval inside another; zero-length when they do not meet. */
export function clipInterval(interval: Interval, within: Interval): Interval {
  const from = Math.min(Math.max(interval.from, within.from), within.to)
  return { from, to: Math.max(from, Math.min(interval.to, within.to)) }
}

export interface WaterfallRow {
  spanId: string
  /** Nesting depth inside the trace; the root turn is 0. */
  depth: number
  kind: string
  /** What the row prints: a tool's name and a compact reading of what it did. */
  label: string
  /** The row's tooltip: the same, with the detail kept whole. */
  title: string
  color: string
  status: string
  startOffsetMs: number
  durationMs: number | null
  /** Position of the bar inside the root turn's interval, in percent. */
  left: number
  width: number
  /** Share of the root turn's duration, 0–1. Null when either is unknown. */
  share: number | null
  span: MetricsSpan | null
}

export interface TraceView {
  traceId: string
  root: MetricsSpan | null
  totalMs: number
  rows: WaterfallRow[]
  legend: KindShare[]
  toolTotals: ToolTotal[]
  /** The three longest rows below the root — what the header calls out. */
  slowest: WaterfallRow[]
  spanCount: number
  toolCallCount: number
  deniedPermissions: MetricsSpan[]
  providerWaitMs: number | null
  traceCoverage: number | null
  gapSummaries: GapSummary[]
  /** Time spent waiting on a person — permission and question dialogs, as one
   *  union. Zero when the turn never asked. */
  userWaitMs: number
  /** Time the prompt sat in the queue before the turn started. It precedes the
   *  root, so it is no share of the turn; zero when the prompt ran at once. */
  queuedMs: number
}

/** The kinds the legend folds into one "waiting on user" slice. */
const USER_WAIT_SOURCE_KINDS = new Set(['permission_wait', 'question_wait'])

/** Phases inside a tool call. Their time is the tool call's time, so the
 *  legend leaves them out rather than count it twice. */
const TOOL_PHASE_KINDS = new Set(['tool_input', 'tool_execution'])

export interface KindShare {
  kind: string
  label: string
  color: string
  ms: number
  share: number
}

export interface ToolTotal {
  tool: string
  calls: number
  ms: number
  share: number
}

export interface GapSummary {
  category: MetricsGapCategory
  label: string
  description: string
  segments: number
  ms: number
  share: number
}

const GAP_DETAILS = {
  provider_startup: {
    label: 'Before first provider event',
    description: 'After setup, before Solus received the first provider event.',
  },
  before_first_activity: {
    label: 'Before first activity',
    description: 'After the first provider event, before recorded thinking, text, or a tool call.',
  },
  between_activities: {
    label: 'Between activities',
    description: 'Between recorded thinking, response, and tool intervals.',
  },
  provider_completion: {
    label: 'Provider completion',
    description: 'After the last recorded activity, before the provider reported completion.',
  },
  turn_settlement: {
    label: 'Turn settlement',
    description: 'After provider completion, before Solus settled the turn.',
  },
  after_last_provider_event: {
    label: 'After last provider event',
    description: 'After the final provider event on a trace without a completion boundary.',
  },
  provider_wait: {
    label: 'Unrecorded',
    description: 'Time outside recorded activity; its cause is unknown.',
  },
} satisfies Record<MetricsGapCategory, { label: string; description: string }>

function summarizeGaps(trace: MetricsTurnTrace, totalMs: number): GapSummary[] {
  const totals = new Map<MetricsGapCategory, { segments: number; ms: number }>()
  for (const segment of trace.gapSegments) {
    const total = totals.get(segment.category) ?? { segments: 0, ms: 0 }
    total.segments += 1
    total.ms += segment.durationMs
    totals.set(segment.category, total)
  }
  return [...totals.entries()]
    .map(([category, total]) => ({
      category,
      ...GAP_DETAILS[category],
      ...total,
      share: total.ms / totalMs,
    }))
    .sort((a, b) => b.ms - a.ms)
}

/** Earliest persisted agent-output span relative to the turn root. This
 * backstops traces recorded before timeToFirstActivityMs was added. Setup and
 * waits are turn work, but they are not output from the agent. */
export function firstObservedActivityMs(trace: TraceView): number | null {
  const offsets = trace.rows
    .filter((row) => row.kind === 'thinking' || row.kind === 'response_stream' || row.kind === 'tool_call')
    .map((row) => row.startOffsetMs)
  return offsets.length ? Math.min(...offsets) : null
}

/** A tool call's most identifying detail: the command it ran or the file it
 *  touched. Falls back to the tool name, which the row already shows. */
export function spanDetailLabel(span: MetricsSpan): string {
  const input = asStringOrNull(span.attrs.input)
  if (input) {
    try {
      // SAFETY: only the three optional string fields below are read, and each is
      // decoded before use, so any JSON object satisfies this shape.
      const fields = JSON.parse(input) as { command?: MetricsValue; file_path?: MetricsValue; pattern?: MetricsValue }
      for (const value of [fields.command, fields.file_path, fields.pattern]) {
        const text = asStringOrNull(value)?.trim()
        if (text) return text
      }
    } catch {
      // Tool input is size-capped, so truncation can leave it unparseable.
      // The raw head is still the most useful thing to show.
      return input.slice(0, 120)
    }
  }
  return asStringOrNull(span.attrs.decision) ?? ''
}

/** A command without the `cd <dir> &&` agents put before it: the same on
 *  every line, and it hides the part that differs. */
export function withoutLeadingCd(command: string): string {
  return command.trim().replace(/^(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*)+/, '')
}

/** Longest a compact detail gets before it is cut. Past this the label column
 *  has truncated it anyway, and the cut here only decides which end survives. */
const COMPACT_DETAIL_CHARS = 60

/**
 * A detail short enough to tell rows apart in a narrow label column.
 *
 * Four rows that read "cd /Users/sidhu/solus-cloud && cat > /tmp…" are four
 * rows the reader cannot tell apart, because the part that differs was cut.
 * So a command drops the `cd <dir> &&` it was prefixed with and keeps its first
 * line; a path keeps only its last two segments. The full text stays on the
 * row's title.
 */
export function compactDetail(detail: string): string {
  let text = withoutLeadingCd(detail)
  const firstLine = text.split('\n')[0]?.trim() ?? ''
  if (firstLine) text = firstLine
  if (/^[~/][^\s]*$/.test(text)) {
    const segments = text.split('/').filter(Boolean)
    if (segments.length > 2) text = segments.slice(-2).join('/')
  }
  return text.length > COMPACT_DETAIL_CHARS ? `${text.slice(0, COMPACT_DETAIL_CHARS - 1)}…` : text
}

/** A response-stream span shorter than this is a marker, not a phase: it names
 *  where a segment ended rather than measuring anything. It stays on the events
 *  list and in the dock when deep-linked, but off the waterfall's lanes. */
export const INSTANT_STREAM_MS = 100

function isInstantStream(row: WaterfallRow): boolean {
  return (
    row.depth > 0 &&
    row.kind === 'response_stream' &&
    row.durationMs != null &&
    row.durationMs < INSTANT_STREAM_MS
  )
}

/** The kinds that are Solus's own work rather than the agent's: the dispatch it
 *  ran before the provider saw the prompt, the queue it held the prompt in, and
 *  the settlement after the provider finished. They are one group behind one
 *  toggle because they answer one question — what did Solus itself cost? */
export const SOLUS_INTERNAL_KINDS = new Set([
  'setup',
  'internal.dispatch_step',
  'queue_wait',
  'turn_settlement',
])

/**
 * The rows a reader has asked to see. Hiding a row hides everything nested
 * under it, so the depth-first list never keeps a child whose parent is gone —
 * a dispatch step orphaned onto the turn root would claim to be a top-level
 * phase of the turn, which is the one thing it is not.
 *
 * Instant response-stream markers are dropped whichever way the internals
 * toggle sits: a lane for 0ms is a lane that says nothing. The one exception is
 * the span the reader arrived on — a deep link that lands on a hidden row is a
 * broken link.
 */
export function visibleRows(
  rows: WaterfallRow[],
  showInternals: boolean,
  pinnedSpanId: string | null = null,
): WaterfallRow[] {
  const kept: WaterfallRow[] = []
  let hiddenAboveDepth: number | null = null
  for (const row of rows) {
    if (hiddenAboveDepth !== null && row.depth > hiddenAboveDepth) continue
    hiddenAboveDepth = null
    if (!showInternals && row.depth > 0 && SOLUS_INTERNAL_KINDS.has(row.kind)) {
      hiddenAboveDepth = row.depth
      continue
    }
    if (isInstantStream(row) && row.spanId !== pinnedSpanId) continue
    kept.push(row)
  }
  return kept
}

/** Whether a trace has anything the internals toggle would reveal. A turn that
 *  resumed an existing session and settled instantly has nothing, and offering
 *  a switch that changes nothing is worse than offering none. */
export function hasInternalRows(trace: TraceView): boolean {
  return trace.rows.some((row) => row.depth > 0 && SOLUS_INTERNAL_KINDS.has(row.kind))
}

type RowLabels = Pick<WaterfallRow, 'label' | 'title'>

/** The row's label and its title: the same text, with the detail compacted on
 *  the row and kept whole on the tooltip. */
function rowLabels(span: MetricsSpan): RowLabels {
  if (span.kind === 'tool_call' || span.kind === 'permission_wait') {
    const detail = spanDetailLabel(span)
    if (!detail) return { label: span.name, title: span.name }
    return { label: `${span.name} · ${compactDetail(detail)}`, title: `${span.name} · ${detail}` }
  }
  // A thinking span reads as what the agent thought: its first line on the
  // row, whole in the dock. Redacted reasoning keeps the plain name.
  if (span.kind === 'thinking') {
    const thought = thoughtPreview(asStringOrNull(span.attrs.thought) ?? undefined)
    if (!thought) return { label: span.name, title: span.name }
    return { label: `${span.name} · ${compactDetail(thought)}`, title: `${span.name} · ${thought}` }
  }
  if (span.kind === 'setup') return { label: 'Solus setup', title: 'Solus setup' }
  // A dispatch step is a piece of Solus's own code, so it is named the way the
  // reader will search for it: the step id verbatim — `worktree_create`, not
  // "worktree create". A prettified phrase reads well and greps for nothing.
  // The function it times stays in the span's attributes, read from the dock:
  // on the row it only spent label width the step id needs.
  return { label: span.name, title: span.name }
}

/**
 * Share by kind, unioned per kind so overlapping siblings are counted once.
 * Permission and question waits fold into one slice: the reader's question is
 * how long the turn waited on them, not which dialog it was. Provider wait,
 * a remainder the server derived rather than a measured kind, leads.
 *
 * Every interval is clipped to the turn first: a share of the turn counts only
 * time inside it. The queue wait precedes the root by design, and unclipped it
 * reads as 200% of a turn it was never part of.
 */
type TraceLegend = Pick<TraceView, 'legend' | 'userWaitMs'>

function legendFor(
  trace: MetricsTurnTrace,
  root: MetricsSpan,
  rootInterval: Interval,
  latestEnd: number,
  totalMs: number,
): TraceLegend {
  const intervalsByKind = new Map<string, Interval[]>()
  for (const span of trace.spans) {
    if (span.spanId === root.spanId || TOOL_PHASE_KINDS.has(span.kind)) continue
    const legendKind = USER_WAIT_SOURCE_KINDS.has(span.kind) ? USER_WAIT_KIND : span.kind
    const interval = clipInterval(intervalOf(span, latestEnd), rootInterval)
    const list = intervalsByKind.get(legendKind)
    if (list) list.push(interval)
    else intervalsByKind.set(legendKind, [interval])
  }
  const userWaitMs = unionLength(intervalsByKind.get(USER_WAIT_KIND) ?? [])
  const legend: KindShare[] = [...intervalsByKind.entries()]
    .map(([kind, intervals]) => {
      const ms = unionLength(intervals)
      return { kind, label: labelForKind(kind), color: colorForKind(kind), ms, share: ms / totalMs }
    })
    .filter((entry) => entry.share > 0.002)
    .sort((a, b) => b.ms - a.ms)
  if (trace.providerWaitMs != null && trace.providerWaitMs > 0) {
    legend.unshift({
      kind: PROVIDER_WAIT_KIND,
      label: labelForKind(PROVIDER_WAIT_KIND),
      color: colorForKind(PROVIDER_WAIT_KIND),
      ms: trace.providerWaitMs,
      share: trace.providerWaitMs / totalMs,
    })
  }
  return { legend, userWaitMs }
}

/**
 * Depth-first over the trace, children ordered by start time. Spans whose
 * parent is missing (a dropped or still-open parent) attach to the root rather
 * than disappearing — a partial trace is still worth reading.
 */
export function buildTraceView(trace: MetricsTurnTrace | null): TraceView | null {
  if (!trace || !trace.spans.length) return null
  const root =
    trace.spans.find((span) => span.kind === 'turn' && !span.parentSpanId) ??
    trace.spans.find((span) => !span.parentSpanId) ??
    null
  if (!root) return null

  // Gaps are server-derived coverage intervals, not persisted spans. Keep
  // between-activity gaps out of the waterfall so adjacent agent events stay
  // visually grouped; TraceCoverage still reports that unobserved time. Other
  // lifecycle gaps remain selectable because their position is meaningful.
  const gapSpans: MetricsSpan[] = trace.gapSegments
    .filter((gap) => gap.category !== 'between_activities')
    .map((gap, index) => ({
      spanId: `gap:${index}:${gap.startedAt}`,
      parentSpanId: root.spanId,
      traceId: trace.traceId,
      kind: PROVIDER_WAIT_KIND,
      name: GAP_DETAILS[gap.category].label,
      service: 'unobserved',
      sessionId: root.sessionId,
      provider: root.provider,
      model: root.model,
      projectRoot: root.projectRoot,
      origin: root.origin,
      startedAt: gap.startedAt,
      endedAt: gap.endedAt,
      durationMs: gap.durationMs,
      status: 'unknown',
      attrs: {
        category: gap.category,
        description: GAP_DETAILS[gap.category].description,
      },
    }))
  const displaySpans = [...trace.spans, ...gapSpans]

  const latestEnd = displaySpans.reduce(
    (max, span) => Math.max(max, span.endedAt ?? span.startedAt + (span.durationMs ?? 0)),
    root.startedAt,
  )
  const rootInterval = intervalOf(root, latestEnd)
  const totalMs = Math.max(1, rootInterval.to - rootInterval.from)

  const byParent = new Map<string, MetricsSpan[]>()
  const known = new Set(displaySpans.map((span) => span.spanId))
  for (const span of displaySpans) {
    if (span.spanId === root.spanId) continue
    const parentId = span.parentSpanId && known.has(span.parentSpanId) ? span.parentSpanId : root.spanId
    const siblings = byParent.get(parentId)
    if (siblings) siblings.push(span)
    else byParent.set(parentId, [span])
  }
  for (const siblings of byParent.values()) siblings.sort((a, b) => a.startedAt - b.startedAt)

  const rows: WaterfallRow[] = []
  const toRow = (span: MetricsSpan, depth: number): WaterfallRow => {
    const interval = intervalOf(span, latestEnd)
    const inside = clipInterval(interval, rootInterval)
    const insideMs = inside.to - inside.from
    const isOutside = interval.from < rootInterval.from || interval.to > rootInterval.to
    const duration = span.durationMs ?? (span.endedAt != null ? span.endedAt - span.startedAt : null)
    // A span reaching outside the turn — the queue wait before it — takes its
    // share from the part inside, and none at all when no part is.
    const share = duration == null ? null : isOutside ? (insideMs > 0 ? insideMs / totalMs : null) : duration / totalMs
    return {
      spanId: span.spanId,
      depth,
      kind: span.kind,
      ...rowLabels(span),
      color: colorForKind(span.kind),
      status: span.status,
      startOffsetMs: interval.from - rootInterval.from,
      durationMs: duration,
      left: ((inside.from - rootInterval.from) / totalMs) * 100,
      width: Math.max(0.6, (insideMs / totalMs) * 100),
      share,
      span,
    }
  }

  rows.push({
    ...toRow(root, 0),
    label: 'turn',
    title: 'turn',
    color: colorForKind('turn'),
  })
  const walk = (parentId: string, depth: number): void => {
    for (const child of byParent.get(parentId) ?? []) {
      rows.push(toRow(child, depth))
      walk(child.spanId, depth + 1)
    }
  }
  walk(root.spanId, 1)

  const { legend, userWaitMs } = legendFor(trace, root, rootInterval, latestEnd, totalMs)
  const queuedMs = unionLength(
    trace.spans
      .filter((span) => span.spanId !== root.spanId && span.startedAt < rootInterval.from)
      .map((span) => {
        const interval = intervalOf(span, latestEnd)
        return { from: interval.from, to: Math.min(interval.to, rootInterval.from) }
      }),
  )

  const toolSpans = trace.spans.filter((span) => span.kind === 'tool_call')
  const toolBuckets = new Map<string, { calls: number; intervals: Interval[] }>()
  for (const span of toolSpans) {
    const bucket = toolBuckets.get(span.name) ?? { calls: 0, intervals: [] }
    bucket.calls += 1
    bucket.intervals.push(intervalOf(span, latestEnd))
    toolBuckets.set(span.name, bucket)
  }
  const toolTotals: ToolTotal[] = [...toolBuckets.entries()]
    .map(([tool, bucket]) => {
      const ms = unionLength(bucket.intervals)
      return { tool, calls: bucket.calls, ms, share: ms / totalMs }
    })
    .sort((a, b) => b.ms - a.ms)

  // The time before the turn is not a span of it, so it is never "the largest".
  const slowest = rows
    .filter((row) => row.depth > 0 && row.durationMs != null && row.startOffsetMs >= 0)
    .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
    .slice(0, 3)

  return {
    traceId: trace.traceId,
    root,
    totalMs,
    rows,
    legend,
    toolTotals,
    slowest,
    spanCount: trace.spans.length,
    toolCallCount: toolSpans.length,
    deniedPermissions: trace.spans.filter(
      (span) => span.kind === 'permission_wait' && span.attrs.decision === 'denied',
    ),
    providerWaitMs: trace.providerWaitMs,
    traceCoverage: trace.providerWaitMs == null
      ? null
      : Math.max(0, Math.min(1, 1 - trace.providerWaitMs / totalMs)),
    gapSummaries: summarizeGaps(trace, totalMs),
    userWaitMs,
    queuedMs,
  }
}

/** Smallest bar the chart will draw, as a fraction of the trace. A span that
 *  took a millisecond inside a two-minute turn is still a span someone has to
 *  be able to see and click. */
export const WATERFALL_MIN_BAR_FRACTION = 0.004

/**
 * A row's `[start, end]` in trace-milliseconds — the ranged-bar accessor the
 * chart's x scale reads. An open span, or one too brief to render, still gets a
 * visible extent so it can be selected. A span that started before the turn —
 * the queue wait — is drawn from the turn's start: the plot is the turn, and a
 * bar left of its axis paints over the label column.
 */
export function barExtent(row: WaterfallRow, totalMs: number): [number, number] {
  const minimum = totalMs * WATERFALL_MIN_BAR_FRACTION
  const start = Math.max(0, row.startOffsetMs)
  const end = Math.min(row.startOffsetMs + Math.max(row.durationMs ?? 0, minimum), totalMs)
  return [start, Math.max(end, start + minimum)]
}

/** When a span started, against the turn: `+13.4s`, or how long before the
 *  turn it began when it precedes the root. */
export function startOffsetLabel(offsetMs: number): string {
  return offsetMs < 0 ? `began ${formatDuration(-offsetMs)} before the turn` : `starts +${formatDuration(offsetMs)}`
}

export interface SpanAttribute {
  key: string
  value: string
}

/** A span's attrs as a display list. Long serialized input, a prompt, and a
 *  thought are shown in their own block instead, so they never squeeze the grid. */
export function spanAttributes(span: MetricsSpan): SpanAttribute[] {
  return Object.entries(span.attrs)
    .filter(([key]) => key !== 'input' && key !== 'prompt' && key !== 'thought')
    .map(([key, value]) => ({
      key: key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase(),
      value: String(value),
    }))
    .sort((a, b) => a.key.localeCompare(b.key))
}

/** The payload block under a span's attrs: the tool input, the prompt on a
 *  turn root, or the thought on a thinking span. Null when the span carries
 *  none of them. */
export function spanPayload(span: MetricsSpan): { label: string; text: string; isMarkdown?: boolean } | null {
  const input = asStringOrNull(span.attrs.input)
  if (input) {
    let text = input
    try {
      text = JSON.stringify(JSON.parse(input), null, 2)
    } catch {
      // Truncated input stays as it was stored.
    }
    return { label: span.attrs.inputTruncated === true ? 'Input (truncated)' : 'Input', text }
  }
  const prompt = asStringOrNull(span.attrs.prompt)
  if (prompt) {
    return { label: span.attrs.promptTruncated === true ? 'Prompt (truncated)' : 'Prompt', text: prompt }
  }
  const thought = asStringOrNull(span.attrs.thought)
  // The provider writes its reasoning as markdown, so it reads as prose.
  if (thought) return { label: 'Thought', text: thought, isMarkdown: true }
  return null
}
