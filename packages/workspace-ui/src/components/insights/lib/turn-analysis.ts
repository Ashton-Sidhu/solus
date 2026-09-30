import type {
  MetricsSessionSummary,
  MetricsSpan,
  MetricsTurnTrace,
  MetricsValue,
} from '@solus/contracts/observability-types'
import { z } from 'zod'
import { asStringOrNull } from './result-columns'
import { formatCost, formatDuration, formatPercent, formatTokens } from './format'
import { colorForKind, labelForKind } from './span-palette'
import type { StatVerdict, TurnStat } from './turn-attributes'
import type { TurnRow } from './turn-rows'
import {
  clipInterval,
  spanDetailLabel,
  unionLength,
  type Interval,
  type TraceView,
  type WaterfallRow,
} from './waterfall'

// What a turn's trace says about cost, waiting, and repetition — the readings a
// person makes when they ask "why was this slow" or "why did this cost that".
//
// Everything here is derived from the trace the host already recorded. Nothing
// is fetched, and nothing is a fact the emitter did not store: where a number is
// an estimate it is named one, and where the record cannot answer the reading
// says so instead of printing a zero.
//
// Pure and non-reactive: the panel reads these from `$derived`.

export type FindingTone = 'info' | 'warning' | 'failure'

/** What a finding is about; the card draws one icon per kind. */
export type FindingKind =
  | 'failure'
  | 'denied'
  | 'repeat'
  | 'user-wait'
  | 'cache-miss'
  | 'context-fill'
  | 'model-choice'

/** One thing worth the reader's attention, pointing at the spans it is about. */
export interface TurnFinding {
  id: string
  kind: FindingKind
  tone: FindingTone
  title: string
  detail: string
  /** The spans the finding is about; the first is where a click lands. */
  spanIds: string[]
}

// ── Cache economics ──

/**
 * The ratios a provider's list prices keep between the four token rates,
 * relative to a fresh input token. Anthropic prices every Claude model with the
 * same ratios; OpenAI's cache write is priced at the input rate. Holding the
 * ratios rather than the prices lets a turn that reports its own cost say what
 * its cache was worth without a price table that goes stale per model.
 */
const CACHE_RATE_RATIOS = {
  'claude-code': { read: 0.1, write: 1.25, output: 5 },
  codex: { read: 0.1, write: 1, output: 5 },
} as const

type RatioProvider = keyof typeof CACHE_RATE_RATIOS

function ratiosFor(provider: string | null): (typeof CACHE_RATE_RATIOS)[RatioProvider] | null {
  if (provider === 'claude-code' || provider === 'codex') return CACHE_RATE_RATIOS[provider]
  return null
}

export interface CacheEconomics {
  readTokens: number
  writeTokens: number
  freshInputTokens: number
  /** Reads over everything the model was given as input. Null when nothing was. */
  hitRate: number | null
  /** What the reads would have cost at the fresh-input rate, minus what they
   *  did cost — an estimate from the turn's own reported cost. Null when the
   *  turn reports no cost or the provider's rate ratios are unknown. */
  savedUsd: number | null
  /** The premium paid to write cache over reading the same tokens fresh. */
  writePremiumUsd: number | null
  /** What the estimate rests on, for the row's note. */
  basis: string
}

/**
 * The turn's own effective input rate, solved from its reported cost and the
 * provider's rate ratios: cost = fresh·r + read·(ratio·r) + write·(ratio·r) +
 * out·(ratio·r). One unknown, so one turn is enough.
 */
function effectiveInputRateUsd(root: MetricsSpan): number | null {
  const cost = root.attrs.costUsd ?? null
  const ratios = ratiosFor(root.provider)
  if (cost == null || cost <= 0 || !ratios) return null
  const weighted =
    (root.attrs.inputTokens ?? 0) +
    (root.attrs.cacheReadTokens ?? 0) * ratios.read +
    (root.attrs.cacheCreationTokens ?? 0) * ratios.write +
    (root.attrs.outputTokens ?? 0) * ratios.output
  return weighted > 0 ? cost / weighted : null
}

export function cacheEconomics(root: MetricsSpan): CacheEconomics | null {
  const readTokens = root.attrs.cacheReadTokens ?? null
  const writeTokens = root.attrs.cacheCreationTokens ?? null
  if (readTokens == null && writeTokens == null) return null
  const freshInputTokens = root.attrs.inputTokens ?? 0
  const given = freshInputTokens + (readTokens ?? 0) + (writeTokens ?? 0)
  const rate = effectiveInputRateUsd(root)
  const ratios = ratiosFor(root.provider)
  const priced = rate != null && ratios != null
  return {
    readTokens: readTokens ?? 0,
    writeTokens: writeTokens ?? 0,
    freshInputTokens,
    hitRate: given > 0 ? (readTokens ?? 0) / given : null,
    savedUsd: priced ? (readTokens ?? 0) * rate * (1 - ratios.read) : null,
    writePremiumUsd: priced ? (writeTokens ?? 0) * rate * (ratios.write - 1) : null,
    basis: priced
      ? "estimated from this turn's reported cost and the provider's list-price ratios"
      : root.attrs.costUsd == null
        ? 'no cost was reported for this turn, so the tokens are not priced'
        : 'the provider has no known price ratios, so the tokens are not priced',
  }
}

// ── Who the turn was waiting on ──

export type WaitingParty = 'model' | 'tools' | 'user' | 'provider' | 'unrecorded' | 'solus'

export interface WaitingOn {
  party: WaitingParty
  label: string
  color: string
  ms: number
  share: number
  /** What the interval is made of. */
  detail: string
}

const WAITING_PARTIES: readonly WaitingParty[] = ['model', 'tools', 'user', 'provider', 'unrecorded', 'solus']

const WAITING_LABELS = {
  model: { label: 'Model', color: 'var(--solus-art-1)' },
  tools: { label: 'Tools', color: 'var(--solus-art-4)' },
  user: { label: 'You', color: 'var(--solus-art-6)' },
  unrecorded: { label: 'Unrecorded', color: 'var(--muted-foreground)' },
  provider: { label: 'Rate limits and compaction', color: 'var(--solus-art-5)' },
  solus: { label: 'Solus', color: 'var(--solus-art-3)' },
} as const satisfies Record<WaitingParty, { label: string; color: string }>

function intervalOfRow(row: WaterfallRow): Interval {
  return { from: row.startOffsetMs, to: row.startOffsetMs + (row.durationMs ?? 0) }
}

/** Length of `a` not covered by any interval in `b`. */
function lengthOutside(a: Interval[], b: Interval[]): number {
  const covered = unionLength(a)
  const overlap = unionLength(
    a.flatMap((x) =>
      b
        .map((y) => ({ from: Math.max(x.from, y.from), to: Math.min(x.to, y.to) }))
        .filter((z) => z.to > z.from),
    ),
  )
  return Math.max(0, covered - overlap)
}

/** The kinds that are time spent waiting on a person. */
export const USER_WAIT_KINDS = new Set(['permission_wait', 'question_wait'])

/**
 * Where the turn's wall-clock went, by who was being waited on.
 *
 * The waterfall shows overlap; this answers the question the overlap hides.
 * Tools are counted only where no permission or question was pending inside
 * them, so a tool that sat behind a dialog charges the dialog to the user and
 * not to the tool. Gaps come from the server's coverage segments and are
 * kept separate from measured provider waits; they do not identify a cause.
 */
export function waitingOn(view: TraceView): WaitingOn[] {
  const rows = view.rows.filter((row) => row.depth > 0)
  // Only time inside the turn is charged: the queue wait before it is no
  // share of the turn's wall clock.
  const turn = { from: 0, to: view.totalMs }
  const of = (kinds: string[]): Interval[] =>
    rows.filter((row) => kinds.includes(row.kind)).map((row) => clipInterval(intervalOfRow(row), turn))
  const userIntervals = of([...USER_WAIT_KINDS])
  const modelIntervals = of(['thinking', 'response_stream'])
  const toolIntervals = of(['tool_call', 'agent_run', 'background_task'])

  const gapMs = (categories: string[]): number =>
    view.gapSummaries
      .filter((gap) => categories.includes(gap.category))
      .reduce((total, gap) => total + gap.ms, 0)

  const totals = {
    user: { ms: unionLength(userIntervals), detail: 'permission and question dialogs' },
    model: {
      ms: lengthOutside(modelIntervals, userIntervals),
      detail: 'thinking and streaming the answer',
    },
    tools: {
      ms: lengthOutside(toolIntervals, [...userIntervals, ...modelIntervals]),
      detail: 'tool calls, subagents, and background tasks running',
    },
    provider: {
      ms: unionLength(of(['rate_limit_wait', 'context_compaction'])),
      detail: 'recorded rate limits and compaction',
    },
    unrecorded: {
      ms: gapMs(['provider_startup', 'before_first_activity', 'between_activities', 'provider_completion', 'provider_wait']),
      detail: 'time outside recorded activity; the trace does not establish its cause',
    },
    solus: {
      ms:
        gapMs(['turn_settlement', 'after_last_provider_event']) +
        unionLength(of(['setup', 'turn_settlement'])),
      detail: 'dispatch and settlement',
    },
  } satisfies Record<WaitingParty, { ms: number; detail: string }>
  const total = Math.max(1, view.totalMs)
  return WAITING_PARTIES
    .map((party) => ({
      party,
      ...WAITING_LABELS[party],
      ms: totals[party].ms,
      share: totals[party].ms / total,
      detail: totals[party].detail,
    }))
    .filter((entry) => entry.ms > 0)
    .sort((a, b) => b.ms - a.ms)
}

// ── Repeated calls ──

export interface RepeatedCall {
  tool: string
  /** The detail every member shares — the command, the file. */
  detail: string
  spanIds: string[]
  totalMs: number
}

/** Longest a single field value gets in an input summary. */
const SUMMARY_VALUE_CHARS = 32

/** A tool input's top level. Only its plain values are printed; a nested
 *  object or list has no short form. */
const toolInputFieldsSchema = z.record(z.string(), z.unknown())
const plainValueSchema = z.union([z.string(), z.number(), z.boolean()])

/**
 * A tool input with no command, path, or pattern, as `key: value` pairs. A raw
 * JSON head cut at a fixed length ends mid-string and names nothing; the pairs
 * name every field. Short values lead, because an id is the least telling
 * field and usually the longest.
 */
export function inputSummary(input: string): string {
  try {
    const fields = toolInputFieldsSchema.safeParse(JSON.parse(input)).data ?? {}
    const pairs = Object.entries(fields)
      .flatMap(([key, value]) => {
        const plain = plainValueSchema.safeParse(value)
        if (!plain.success) return []
        const text = String(plain.data).replace(/\s+/g, ' ').trim()
        return text ? [{ key, text: text.length > SUMMARY_VALUE_CHARS ? `${text.slice(0, SUMMARY_VALUE_CHARS - 1)}…` : text }] : []
      })
      .sort((a, b) => a.text.length - b.text.length)
    if (pairs.length > 0) return pairs.map((pair) => `${pair.key}: ${pair.text}`).join(' · ')
  } catch {
    // Size-capped input can be unparseable; the head below is all there is.
  }
  const head = input.replace(/\s+/g, ' ').trim()
  return head.length > 80 ? `${head.slice(0, 79)}…` : head
}

// Older Codex traces kept the empty start payload instead of the completed input.
// Missing input is not evidence that two web calls asked the same thing.
const webCallIdentitySchema = z.object({
  query: z.string().optional(),
  action: z.object({
    query: z.string().nullish(),
    queries: z.array(z.string()).nullish(),
    url: z.string().nullish(),
  }).nullish(),
})

function hasWebCallIdentity(input: string): boolean {
  try {
    const parsed = webCallIdentitySchema.safeParse(JSON.parse(input))
    if (!parsed.success) return false
    const { query, action } = parsed.data
    return [query, action?.query, action?.url, ...(action?.queries ?? [])]
      .some((value) => !!value?.trim())
  } catch {
    return false
  }
}

/** The same tool asked the same thing more than once. Whitespace inside the
 *  input is not a difference; a second `bun test` with an extra space is the
 *  retry it looks like. */
export function repeatedCalls(spans: MetricsSpan[]): RepeatedCall[] {
  const groups = new Map<string, RepeatedCall>()
  for (const span of spans) {
    if (span.kind !== 'tool_call') continue
    const input = asStringOrNull(span.attrs.input)
    if (!input || (span.name === 'WebSearch' && !hasWebCallIdentity(input))) continue
    const key = `${span.name}\u0000${input.replace(/\s+/g, ' ').trim()}`
    const group = groups.get(key) ?? {
      tool: span.name,
      detail: spanDetailLabel(span) || inputSummary(input),
      spanIds: [],
      totalMs: 0,
    }
    group.spanIds.push(span.spanId)
    group.totalMs += span.durationMs ?? 0
    groups.set(key, group)
  }
  return [...groups.values()]
    .filter((group) => group.spanIds.length > 1)
    .sort((a, b) => b.spanIds.length - a.spanIds.length || b.totalMs - a.totalMs)
}

// ── Baselines ──

export interface TurnBaseline {
  label: string
  /** This turn's value, as printed. */
  value: string
  /** The session's median for the other turns, as printed. Null with fewer
   *  than two other turns — one neighbour is not a baseline. */
  sessionMedian: string | null
  /** The median for the same model across the window's turns, as printed. */
  modelMedian: string | null
  /** This turn over the session median; null when either is missing. */
  sessionRatio: number | null
  modelRatio: number | null
}

/** How many other turns a median needs before it is quoted as one. */
export const BASELINE_MIN_SAMPLES = 2

function median(values: number[]): number | null {
  if (values.length < BASELINE_MIN_SAMPLES) return null
  const sorted = values.slice().sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function ratio(value: number | null, base: number | null): number | null {
  return value == null || base == null || base <= 0 ? null : value / base
}

/**
 * This turn against two populations: its own session, and every turn on the
 * same model in the current window. A 54s turn is only slow beside a 20s
 * median, and the same number is read differently against each.
 */
export function turnBaselines(
  root: MetricsSpan,
  session: MetricsSessionSummary | null,
  windowRows: TurnRow[],
): TurnBaseline[] {
  const others = (session?.turns ?? []).filter((turn) => turn.traceId !== root.traceId)
  const sameModel = windowRows.filter(
    (row) => row.traceId !== root.traceId && row.model != null && row.model === root.model,
  )
  const tokensOf = (input: number | null, output: number | null): number | null =>
    input == null && output == null ? null : (input ?? 0) + (output ?? 0)
  const defined = (values: Array<number | null>): number[] =>
    values.filter((value): value is number => value != null)

  const build = (
    label: string,
    value: number | null,
    sessionValues: Array<number | null>,
    modelValues: Array<number | null>,
    print: (value: number | null) => string,
  ): TurnBaseline => {
    const sessionMedian = median(defined(sessionValues))
    const modelMedian = median(defined(modelValues))
    return {
      label,
      value: print(value),
      sessionMedian: sessionMedian == null ? null : print(sessionMedian),
      modelMedian: modelMedian == null ? null : print(modelMedian),
      sessionRatio: ratio(value, sessionMedian),
      modelRatio: ratio(value, modelMedian),
    }
  }

  return [
    build(
      'Duration',
      root.durationMs,
      others.map((turn) => turn.durationMs),
      sameModel.map((row) => row.durationMs),
      formatDuration,
    ),
    build(
      'Cost',
      root.attrs.costUsd ?? null,
      others.map((turn) => turn.costUsd),
      sameModel.map((row) => row.costUsd),
      formatCost,
    ),
    build(
      'Tokens',
      tokensOf(root.attrs.inputTokens ?? null, root.attrs.outputTokens ?? null),
      others.map((turn) => tokensOf(turn.inputTokens, turn.outputTokens)),
      sameModel.map((row) => tokensOf(row.inputTokens, row.outputTokens)),
      formatTokens,
    ),
  ]
}

// ── Errors first ──

/** The span a failed turn should open on: the first failure below the root,
 *  preferring a tool or agent — the thing that was asked and refused — over a
 *  stream that failed because of it. Null when no child failed. */
export function firstFailingSpanId(view: TraceView): string | null {
  const failed = view.rows.filter((row) => row.depth > 0 && row.status === 'error')
  if (failed.length === 0) return null
  const asked = failed.find((row) => row.kind === 'tool_call' || row.kind === 'agent_run')
  return (asked ?? failed[0]).spanId
}

// ── Model choice ──

/** Tools that read the workspace and change nothing. A turn made only of these
 *  did not need the model that is best at changing things. */
export const READ_ONLY_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'mcp__solus__browser_snapshot',
  'mcp__solus__browser_status',
  'mcp__solus__read_task',
  'mcp__solus__list_tasks',
  'mcp__solus__read_session',
  'mcp__solus__search_sessions',
])

/** A Bash command that only looks. Anything else is assumed to write. */
const READ_ONLY_COMMAND = /^\s*(cat|ls|head|tail|wc|git\s+(status|log|diff|show|branch)|rg|grep|find|which|echo|pwd|bun\s+test)\b/

/** Output past this is a turn that wrote something substantial — an answer, a
 *  plan — and the hint does not apply. */
export const MODEL_HINT_MAX_OUTPUT_TOKENS = 1500

/** Models where a cheaper tier exists and the hint is worth making. */
const TOP_TIER_MODEL = /opus|fable|astra|pro/i

/** The list-price ratio between the cheaper tier and the top tier — Sonnet to
 *  Opus. The estimate is a ratio because a price table goes stale per model. */
export const CHEAPER_TIER_COST_RATIO = 0.2

export interface ModelChoiceHint {
  title: string
  detail: string
  /** What the same turn would have cost at the cheaper tier's ratio. */
  estimatedUsd: number | null
}

function isReadOnlyCall(span: MetricsSpan): boolean {
  if (READ_ONLY_TOOLS.has(span.name)) return true
  if (span.name !== 'Bash') return false
  const input = asStringOrNull(span.attrs.input)
  if (!input) return false
  try {
    // SAFETY: only the optional `command` field is read, and it is decoded
    // before use, so any JSON object satisfies this shape.
    const fields = JSON.parse(input) as { command?: MetricsValue }
    const command = asStringOrNull(fields.command)
    return command != null && READ_ONLY_COMMAND.test(command)
  } catch {
    return false
  }
}

/**
 * A rule, not a model call: a top-tier model, only read-only tools, no edit, a
 * short answer. When all four hold the turn was a lookup, and a lookup is what
 * the cheaper tier is for. It never switches anything; it says what it saw.
 */
export function modelChoiceHint(root: MetricsSpan, spans: MetricsSpan[]): ModelChoiceHint | null {
  if (!root.model || !TOP_TIER_MODEL.test(root.model)) return null
  const tools = spans.filter((span) => span.kind === 'tool_call')
  if (tools.length === 0) return null
  if (spans.some((span) => span.kind === 'agent_run')) return null
  if (!tools.every(isReadOnlyCall)) return null
  const output = root.attrs.outputTokens ?? null
  if (output == null || output > MODEL_HINT_MAX_OUTPUT_TOKENS) return null
  const cost = root.attrs.costUsd ?? null
  const estimatedUsd = cost == null ? null : cost * CHEAPER_TIER_COST_RATIO
  return {
    title: `Read-only turn on ${root.model}`,
    detail:
      `${tools.length} tool ${tools.length === 1 ? 'call' : 'calls'}, none of them wrote anything, and ` +
      `${formatTokens(output)} tokens of answer. A cheaper tier typically costs about ` +
      `${Math.round(CHEAPER_TIER_COST_RATIO * 100)}% as much` +
      (estimatedUsd == null ? '.' : `: about ${formatCost(estimatedUsd)} against ${formatCost(cost)}.`),
    estimatedUsd,
  }
}

// ── Estimated cost per span ──

export interface KindCost {
  kind: string
  label: string
  color: string
  usd: number
  share: number
}

/**
 * The turn's cost spread over the spans that consumed tokens — thinking and
 * streaming — by their share of that time. Providers report tokens per turn,
 * not per message, so this is an estimate and is labelled one wherever it is
 * printed. Tool calls carry no cost of their own here: their results are input
 * to the next model call, which is where the tokens land.
 */
export function estimatedKindCosts(root: MetricsSpan, view: TraceView): KindCost[] {
  const cost = root.attrs.costUsd ?? null
  if (cost == null || cost <= 0) return []
  const byKind = new Map<string, number>()
  for (const row of view.rows) {
    if (row.depth === 0) continue
    if (row.kind !== 'thinking' && row.kind !== 'response_stream') continue
    byKind.set(row.kind, (byKind.get(row.kind) ?? 0) + (row.durationMs ?? 0))
  }
  const total = [...byKind.values()].reduce((sum, ms) => sum + ms, 0)
  if (total <= 0) return []
  return [...byKind.entries()]
    .map(([kind, ms]) => ({
      kind,
      label: labelForKind(kind),
      color: colorForKind(kind),
      usd: (cost * ms) / total,
      share: ms / total,
    }))
    .sort((a, b) => b.usd - a.usd)
}

// ── Context growth ──

export interface ContextGrowth {
  /** Tokens the context held after this turn. */
  usedTokens: number
  /** The window the turn ran in; null when the provider did not say. */
  windowTokens: number | null
  /** usedTokens over the window, 0–1. Null without a window. */
  fill: number | null
  /** The previous turn's fill in this session, when it recorded one. */
  previousUsedTokens: number | null
  deltaTokens: number | null
}

/** Past this fill the next turns pay for it: every one of them re-reads what
 *  is there, and compaction is near. */
export const CONTEXT_FILL_WARNING = 0.8

/**
 * Where the session's context stood after this turn and how far this turn
 * moved it. The turn that took the context from 40% to 80% is the one that
 * made the next three expensive, and nothing else on the page says so.
 */
export function contextGrowth(root: MetricsSpan, session: MetricsSessionSummary | null): ContextGrowth | null {
  const usedTokens = root.attrs.contextUsedTokens ?? null
  if (usedTokens == null) return null
  const windowTokens = root.attrs.contextWindow ?? null
  const turns = session?.turns ?? []
  const index = turns.findIndex((turn) => turn.traceId === root.traceId)
  const previous = index > 0 ? (turns[index - 1].contextUsedTokens ?? null) : null
  return {
    usedTokens,
    windowTokens,
    fill: windowTokens && windowTokens > 0 ? usedTokens / windowTokens : null,
    previousUsedTokens: previous,
    deltaTokens: previous == null ? null : usedTokens - previous,
  }
}

// ── The stat row, with its comparisons ──

/** A ratio past this is the number a reader came to find. */
export const BASELINE_WARNING_RATIO = 2
/** A ratio under this is clearly better than usual. */
export const BASELINE_GOOD_RATIO = 0.67
/** The comparison meter runs from zero to this many times the median, so the
 *  median mark sits a third of the way along. */
const BASELINE_METER_SPAN = 3

/** The badge words, per figure: what "below" and "above" its median mean. */
function baselineWords(label: string) {
  if (label === 'Duration') return { good: 'Fast', bad: 'Slow' }
  if (label === 'Cost') return { good: 'Cheap', bad: 'Costly' }
  if (label === 'Tokens') return { good: 'Light', bad: 'Heavy' }
  return { good: 'Low', bad: 'High' }
}

function baselineVerdict(label: string, ratio: number): StatVerdict {
  const words = baselineWords(label)
  if (ratio >= BASELINE_WARNING_RATIO) return { kind: 'bad', glyph: 'up', label: words.bad }
  if (ratio <= BASELINE_GOOD_RATIO) return { kind: 'good', glyph: 'down', label: words.good }
  return { kind: 'usual', glyph: 'even', label: 'Typical' }
}

function comparisonNote(baseline: TurnBaseline): string | undefined {
  const parts: string[] = []
  if (baseline.sessionMedian != null && baseline.sessionRatio != null) {
    parts.push(`${baseline.sessionRatio.toFixed(1)}× the session median of ${baseline.sessionMedian}`)
  }
  if (baseline.modelMedian != null && baseline.modelRatio != null) {
    parts.push(`${baseline.modelRatio.toFixed(1)}× this model's median of ${baseline.modelMedian}`)
  }
  return parts.length ? parts.join(' · ') : undefined
}

/**
 * The stat row with every number placed against something: the session's
 * median and the model's, the dollars the cache was worth, the context fill
 * this turn left behind. A 54s turn is only slow beside a 20s median.
 */
export function annotateStats(
  stats: TurnStat[],
  baselines: TurnBaseline[],
  cache: CacheEconomics | null,
  context: ContextGrowth | null,
): TurnStat[] {
  const annotated = stats.map((stat) => {
    const baseline = baselines.find((entry) => entry.label === stat.label)
    if (baseline) {
      const note = comparisonNote(baseline)
      const ratio = baseline.sessionRatio ?? baseline.modelRatio
      if (ratio == null) return stat
      const slow = ratio >= BASELINE_WARNING_RATIO
      // The comparison is the visible line: it is what says whether the
      // figure is good. What the figure is made of moves to the tooltip.
      const median = baseline.sessionRatio != null ? 'session' : 'model'
      return {
        ...stat,
        detail: `${ratio.toFixed(1)}× ${median} median`,
        note: [stat.detail, note ?? stat.note].filter(Boolean).join(' · '),
        tone: stat.tone === 'failure' ? stat.tone : slow ? 'warning' : stat.tone,
        verdict: stat.tone === 'failure' ? stat.verdict : baselineVerdict(stat.label, ratio),
        meter: { fill: Math.min(ratio / BASELINE_METER_SPAN, 1), marker: 1 / BASELINE_METER_SPAN },
      }
    }
    if (stat.label === 'Cache' && cache?.savedUsd != null) {
      return {
        ...stat,
        detail: `saved about ${formatCost(cache.savedUsd)}`,
        note: `${stat.note ?? ''}${stat.note ? ' · ' : ''}saved about ${formatCost(cache.savedUsd)} against fresh input`,
      }
    }
    return stat
  })
  if (context) {
    const fill = context.fill
    const delta =
      context.deltaTokens == null
        ? 'first turn with a reading'
        : `${context.deltaTokens >= 0 ? '+' : '−'}${formatTokens(Math.abs(context.deltaTokens))} since the previous turn`
    annotated.push({
      label: 'Context',
      value: fill == null ? `${formatTokens(context.usedTokens)} used` : `${formatPercent(fill)} full`,
      detail:
        context.deltaTokens == null
          ? undefined
          : `${context.deltaTokens >= 0 ? '+' : '−'}${formatTokens(Math.abs(context.deltaTokens))} this turn`,
      note: `${formatTokens(context.usedTokens)} of ${context.windowTokens == null ? 'an unknown window' : formatTokens(context.windowTokens)} · ${delta}`,
      tone: fill != null && fill >= CONTEXT_FILL_WARNING ? 'warning' : 'default',
      verdict:
        fill == null
          ? undefined
          : fill >= CONTEXT_FILL_WARNING
            ? { kind: 'bad', glyph: 'alert', label: 'Nearly full' }
            : { kind: 'usual', glyph: 'even', label: 'Room left' },
      meter: fill == null ? undefined : { fill: Math.min(fill, 1), marker: CONTEXT_FILL_WARNING },
    })
  }
  return annotated
}

// ── Subagents ──

export interface SubagentRollup {
  /** Spans nested under the run, the run itself excluded. */
  spanCount: number
  toolCallCount: number
  /** Union of the nested spans' intervals. */
  activeMs: number
  errorCount: number
}

/** What an agent run holds, for its dock: the provider reports tokens per
 *  turn, so a subagent has no cost of its own to show, but it has a shape. */
export function subagentRollup(view: TraceView, spanId: string): SubagentRollup | null {
  const index = view.rows.findIndex((row) => row.spanId === spanId)
  if (index === -1 || view.rows[index].kind !== 'agent_run') return null
  const depth = view.rows[index].depth
  const nested: WaterfallRow[] = []
  for (const row of view.rows.slice(index + 1)) {
    if (row.depth <= depth) break
    nested.push(row)
  }
  return {
    spanCount: nested.length,
    toolCallCount: nested.filter((row) => row.kind === 'tool_call').length,
    activeMs: unionLength(nested.map(intervalOfRow)),
    errorCount: nested.filter((row) => row.status === 'error').length,
  }
}

// ── Findings ──

function failureFinding(root: MetricsSpan, view: TraceView): TurnFinding | null {
  const failing = firstFailingSpanId(view)
  if (root.status !== 'error' || !failing) return null
  const row = view.rows.find((candidate) => candidate.spanId === failing)
  const error = asStringOrNull(row?.span?.attrs.error)
  return {
    id: 'failure',
    kind: 'failure',
    tone: 'failure',
    title: `Failed at ${row?.label ?? 'a span'}`,
    detail: error ?? 'The span ended in error and recorded no message.',
    spanIds: [failing],
  }
}

function deniedFinding(view: TraceView): TurnFinding | null {
  const denied = view.deniedPermissions
  if (denied.length === 0) return null
  return {
    id: 'denied',
    kind: 'denied',
    tone: 'warning',
    title: `${denied.length} permission${denied.length === 1 ? '' : 's'} denied`,
    detail: denied
      .map((span) => `${span.name}${spanDetailLabel(span) ? ` · ${spanDetailLabel(span)}` : ''}`)
      .join(', '),
    spanIds: denied.map((span) => span.spanId),
  }
}

function repeatFindings(trace: MetricsTurnTrace): TurnFinding[] {
  return repeatedCalls(trace.spans).map((repeat) => ({
    id: `repeat:${repeat.spanIds[0]}`,
    kind: 'repeat',
    tone: 'warning',
    title: `${repeat.tool} ran the same call ${repeat.spanIds.length} times`,
    detail: `${repeat.detail} · ${formatDuration(repeat.totalMs)} in total`,
    spanIds: repeat.spanIds,
  }))
}

/** Recorded waits on a person worth a line. Gaps stay in trace coverage. */
const USER_WAIT_FINDING_SHARE = 0.2

function waitFindings(view: TraceView): TurnFinding[] {
  const findings: TurnFinding[] = []
  const waits = waitingOn(view)
  const user = waits.find((entry) => entry.party === 'user')
  if (user && user.share >= USER_WAIT_FINDING_SHARE) {
    findings.push({
      id: 'user-wait',
      kind: 'user-wait',
      tone: 'info',
      title: `${formatPercent(user.share)} of the turn waited on you`,
      detail: `${formatDuration(user.ms)} in ${user.detail}.`,
      spanIds: view.rows.filter((row) => USER_WAIT_KINDS.has(row.kind)).map((row) => row.spanId),
    })
  }
  return findings
}

function cacheFinding(root: MetricsSpan, sessionPosition: number): TurnFinding | null {
  const cache = cacheEconomics(root)
  if (!cache || cache.writeTokens === 0 || cache.readTokens > 0 || sessionPosition <= 1) return null
  const why = 'A cache written mid-session and not read back usually means the prompt prefix changed.'
  return {
    id: 'cache-miss',
    kind: 'cache-miss',
    tone: 'warning',
    title: `Wrote ${formatTokens(cache.writeTokens)} cache tokens and read none`,
    detail:
      cache.writePremiumUsd != null
        ? `The write premium was about ${formatCost(cache.writePremiumUsd)}. ${why}`
        : why,
    spanIds: [],
  }
}

function contextFinding(root: MetricsSpan, session: MetricsSessionSummary | null): TurnFinding | null {
  const context = contextGrowth(root, session)
  if (!context || context.fill == null || context.fill < CONTEXT_FILL_WARNING) return null
  return {
    id: 'context-fill',
    kind: 'context-fill',
    tone: 'warning',
    title: `Context ${formatPercent(context.fill)} full after this turn`,
    detail: `${formatTokens(context.usedTokens)} of ${formatTokens(context.windowTokens ?? 0)}. Every later turn re-reads this, and compaction is near.`,
    spanIds: [],
  }
}

/** What the reader should look at first, in the order they should look. */
export function turnFindings(
  root: MetricsSpan,
  view: TraceView,
  trace: MetricsTurnTrace,
  session: MetricsSessionSummary | null,
): TurnFinding[] {
  const sessionPosition = (session?.turns.findIndex((turn) => turn.traceId === root.traceId) ?? -1) + 1
  const hint = modelChoiceHint(root, trace.spans)
  return [
    failureFinding(root, view),
    deniedFinding(view),
    ...repeatFindings(trace),
    ...waitFindings(view),
    cacheFinding(root, sessionPosition),
    contextFinding(root, session),
    hint ? { id: 'model-choice', kind: 'model-choice' as const, tone: 'info' as const, title: hint.title, detail: hint.detail, spanIds: [] } : null,
  ].filter((finding): finding is TurnFinding => finding !== null)
}

// ── Export and links ──

/** The trace as one JSON document: what the host recorded, plus the readings
 *  above, so a trace handed to someone carries its own analysis. */
export function traceExportJson(trace: MetricsTurnTrace, view: TraceView, root: MetricsSpan): string {
  return JSON.stringify(
    {
      traceId: trace.traceId,
      exportedAt: new Date().toISOString(),
      turn: {
        startedAt: root.startedAt,
        durationMs: root.durationMs,
        status: root.status,
        provider: root.provider,
        model: root.model,
        attrs: root.attrs,
      },
      summary: {
        totalMs: view.totalMs,
        spanCount: view.spanCount,
        toolCallCount: view.toolCallCount,
        providerWaitMs: view.providerWaitMs,
        legend: view.legend.map(({ kind, ms, share }) => ({ kind, ms, share })),
        waitingOn: waitingOn(view).map(({ party, ms, share }) => ({ party, ms, share })),
        repeatedCalls: repeatedCalls(trace.spans),
        cache: cacheEconomics(root),
      },
      spans: trace.spans,
      gapSegments: trace.gapSegments,
      logEvents: trace.logEvents,
    },
    null,
    2,
  )
}

/** The file a trace export is saved as. */
export function traceExportFileName(traceId: string): string {
  return `solus-trace-${traceId.slice(0, 8)}.json`
}
