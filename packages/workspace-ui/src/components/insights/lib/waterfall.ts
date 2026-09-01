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
import { asStringOrNull } from './result-columns'
import { PROVIDER_WAIT_KIND, colorForKind, labelForKind } from './span-palette'

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

export interface WaterfallRow {
  spanId: string
  /** Nesting depth inside the trace; the root turn is 0. */
  depth: number
  kind: string
  label: string
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
}

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
    label: 'Provider wait',
    description: 'Waiting for provider activity outside Thinking and recorded activity.',
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
 */
export function visibleRows(rows: WaterfallRow[], showInternals: boolean): WaterfallRow[] {
  if (showInternals) return rows
  const kept: WaterfallRow[] = []
  let hiddenAboveDepth: number | null = null
  for (const row of rows) {
    if (hiddenAboveDepth !== null && row.depth > hiddenAboveDepth) continue
    hiddenAboveDepth = null
    if (row.depth > 0 && SOLUS_INTERNAL_KINDS.has(row.kind)) {
      hiddenAboveDepth = row.depth
      continue
    }
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

function rowLabel(span: MetricsSpan): string {
  if (span.kind === 'tool_call' || span.kind === 'permission_wait') {
    const detail = spanDetailLabel(span)
    return detail ? `${span.name} · ${detail}` : span.name
  }
  if (span.kind === 'setup') return 'Solus setup'
  // A dispatch step is a piece of Solus's own code, so it is named the way the
  // reader will search for it: the step id verbatim — `worktree_create`, not
  // "worktree create" — followed by the function it times, when the step
  // recorded one. A prettified phrase reads well and greps for nothing.
  if (span.kind === 'internal.dispatch_step') {
    const fn = asStringOrNull(span.attrs.fn)
    return fn ? `${span.name} · ${fn}` : span.name
  }
  return span.name
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
    const duration = span.durationMs ?? (span.endedAt != null ? span.endedAt - span.startedAt : null)
    return {
      spanId: span.spanId,
      depth,
      kind: span.kind,
      label: rowLabel(span),
      color: colorForKind(span.kind),
      status: span.status,
      startOffsetMs: interval.from - rootInterval.from,
      durationMs: duration,
      left: ((interval.from - rootInterval.from) / totalMs) * 100,
      width: Math.max(0.6, ((interval.to - interval.from) / totalMs) * 100),
      share: duration == null ? null : duration / totalMs,
      span,
    }
  }

  rows.push({
    ...toRow(root, 0),
    label: 'turn',
    color: colorForKind('turn'),
  })
  const walk = (parentId: string, depth: number): void => {
    for (const child of byParent.get(parentId) ?? []) {
      rows.push(toRow(child, depth))
      walk(child.spanId, depth + 1)
    }
  }
  walk(root.spanId, 1)

  // Share by kind, unioned per kind so overlapping siblings are counted once.
  const intervalsByKind = new Map<string, Interval[]>()
  for (const span of trace.spans) {
    if (span.spanId === root.spanId) continue
    const list = intervalsByKind.get(span.kind)
    if (list) list.push(intervalOf(span, latestEnd))
    else intervalsByKind.set(span.kind, [intervalOf(span, latestEnd)])
  }
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

  const slowest = rows
    .filter((row) => row.depth > 0 && row.durationMs != null)
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
  }
}

/** Smallest bar the chart will draw, as a fraction of the trace. A span that
 *  took a millisecond inside a two-minute turn is still a span someone has to
 *  be able to see and click. */
export const WATERFALL_MIN_BAR_FRACTION = 0.004

/**
 * A row's `[start, end]` in trace-milliseconds — the ranged-bar accessor the
 * chart's x scale reads. An open span, or one too brief to render, still gets a
 * visible extent so it can be selected.
 */
export function barExtent(row: WaterfallRow, totalMs: number): [number, number] {
  const minimum = totalMs * WATERFALL_MIN_BAR_FRACTION
  const length = Math.max(row.durationMs ?? 0, minimum)
  const end = Math.min(row.startOffsetMs + length, totalMs)
  return [row.startOffsetMs, Math.max(end, row.startOffsetMs + minimum)]
}

export interface SpanAttribute {
  key: string
  value: string
}

/** A span's attrs as a display list. Long serialized input is shown in its own
 *  block instead, so it never squeezes the grid. */
export function spanAttributes(span: MetricsSpan): SpanAttribute[] {
  return Object.entries(span.attrs)
    .filter(([key]) => key !== 'input' && key !== 'prompt')
    .map(([key, value]) => ({
      key: key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase(),
      value: String(value),
    }))
    .sort((a, b) => a.key.localeCompare(b.key))
}

/** The payload block under a span's attrs: the tool input, or the prompt on a
 *  turn root. Null when the span carries neither. */
export function spanPayload(span: MetricsSpan): { label: string; text: string } | null {
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
  return null
}
