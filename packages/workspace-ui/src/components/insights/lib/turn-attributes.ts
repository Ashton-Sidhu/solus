// Every fact a turn carries, as one flat list of copyable rows in groups.
//
// The outcome numbers a reader watches — duration, cost, tokens, tool calls —
// are attributes here rather than a separate strip of stat cards. One value
// belongs in one place: a reader who wants the duration and a reader who wants
// the model should look at the same list, select from it, and copy from it.
//
// Pure and non-reactive: the panel reads this from `$derived` and renders it.

import type { MetricsSpan } from '@solus/contracts/observability-types'
import {
  formatCost,
  formatDuration,
  formatPercent,
  formatTokens,
} from './format'
import type { TraceView } from './waterfall'

export type AttributeTone = 'default' | 'failure' | 'warning'

export interface TurnAttributeDestination {
  name: 'task'
  taskId: string
}

export interface TurnAttribute {
  /** The registry's own column name — what a query writes, what copy hands
   *  back, and what the tooltip shows under the label. */
  key: string
  /** What the row prints for the key: the fact in words, not the column. Forty
   *  rows of `time_to_first_provider_event_ms` are a schema dump; "First
   *  provider event" is something a reader scans. */
  label: string
  /** What the surface prints. */
  value: string
  /** What the copy control puts on the clipboard — the raw value where the
   *  printed one is rounded, so a copied duration is still a number. */
  copyValue: string
  /** A second reading of the same fact: what the number is made of, or why it
   *  is missing. Never a value of its own. */
  note?: string
  tone?: AttributeTone
  /** Ids and paths read as machine text; measures and names do not. */
  mono?: boolean
  /** A recorded identity that can open its owning product surface. */
  destination?: TurnAttributeDestination
}

export interface TurnAttributeGroup {
  /** Stable across renders — the `{#each}` key and the group's heading. */
  label: string
  attributes: TurnAttribute[]
}

/** Groups a reader opens first. The rest stay behind "Show all". */
export const PRIMARY_GROUP_LABELS: readonly string[] = ['Outcome', 'Identity']

/** Whether a group is one of the two the collapsed list shows. */
export function isPrimaryGroup(group: TurnAttributeGroup): boolean {
  return PRIMARY_GROUP_LABELS.includes(group.label)
}

/** Any span attribute or promoted column, as this panel prints it. */
type AttributeValue = string | number | boolean | null

function text(value: AttributeValue): string | null {
  if (value === null) return null
  const printed = String(value)
  return printed === '' ? null : printed
}

/** The words each column is printed as. A column without an entry prints its
 *  own name with the underscores read as spaces, so a newly registered column
 *  is never blank — only less polished until it is named here. */
const ATTRIBUTE_LABELS = new Map<string, string>(Object.entries({
  duration_ms: 'Duration',
  status: 'Status',
  cost_usd: 'Cost',
  input_tokens: 'Input tokens',
  output_tokens: 'Output tokens',
  total_tokens: 'Total tokens',
  cache_read_tokens: 'Cache read tokens',
  cache_write_tokens: 'Cache write tokens',
  tool_call_count: 'Tool calls',
  permission_denial_count: 'Permissions denied',
  trace_id: 'Trace ID',
  session_id: 'Session ID',
  provider: 'Provider',
  model: 'Model',
  requested_model: 'Requested model',
  context_window: 'Context window',
  service: 'Service',
  origin: 'Origin',
  project: 'Project',
  project_root: 'Project root',
  branch: 'Branch',
  task: 'Task',
  task_id: 'Task ID',
  automation: 'Automation',
  automation_id: 'Automation ID',
  prompt_source: 'Prompt source',
  reasoning_effort: 'Reasoning effort',
  is_resume: 'Resumed session',
  has_thinking: 'Extended thinking',
  prompt_chars: 'Prompt length',
  system_prompt_chars: 'System prompt length',
  response_chars: 'Response length',
  started_at: 'Started',
  time_to_first_provider_event_ms: 'First provider event',
  time_to_first_activity_ms: 'First activity',
  time_to_first_text_ms: 'First text',
  time_to_last_provider_event_ms: 'Last provider event',
  time_to_provider_complete_ms: 'Provider complete',
  inter_turn_idle_ms: 'Idle before this turn',
  provider_wait_ms: 'Unrecorded',
}))

/** The printed label for a column: its entry above, or its name read as words. */
export function attributeLabel(key: string): string {
  const named = ATTRIBUTE_LABELS.get(key)
  if (named) return named
  const words = key.replace(/_ms$/, '').replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** A measure: printed short, copied exact. A missing measure still gets a row —
 *  "this turn has no cost" is an answer, and hiding it reads as a bug. */
function measure(
  key: string,
  raw: number | null,
  printed: string,
  note?: string,
  tone: AttributeTone = 'default',
): TurnAttribute {
  return {
    key,
    label: attributeLabel(key),
    value: printed,
    copyValue: raw == null ? '' : String(raw),
    note,
    tone,
  }
}

function fact(
  key: string,
  value: AttributeValue,
  note?: string,
  mono = false,
  destination?: TurnAttributeDestination,
): TurnAttribute {
  const printed = text(value)
  return {
    key,
    label: attributeLabel(key),
    value: printed ?? '—',
    copyValue: printed ?? '',
    note,
    mono,
    destination,
  }
}

/** Whether a figure is good news, ordinary, or the thing to look at. */
export type StatVerdictKind = 'good' | 'usual' | 'bad'

/** The icon a verdict is drawn with: a figure above or below its median,
 *  one at it, a check, a warning, a failure. */
export type StatVerdictGlyph = 'up' | 'down' | 'even' | 'check' | 'alert' | 'failed'

export interface StatVerdict {
  kind: StatVerdictKind
  glyph: StatVerdictGlyph
  /** One or two words that name the verdict — the icon's tooltip and
   *  accessible name, not printed: "Slow", "Typical", "Hit". */
  label: string
}

/** A 0–1 bar under the figure, with an optional mark for its reference point:
 *  the median for a comparison, the warning line for a fill. */
export interface StatMeter {
  fill: number
  marker?: number
}

/** One of the handful of numbers a reader weighs before anything else. */
export interface TurnStat {
  label: string
  value: string
  /** The short line printed under the value: what the number is made of, or
   *  how far it sits from its baseline. */
  detail?: string
  /** What the number is made of, or what it is compared against, in full. */
  note?: string
  tone?: AttributeTone
  /** Absent when there is nothing to judge the figure against. */
  verdict?: StatVerdict
  meter?: StatMeter
}

/** The colour a stat is painted in: its verdict, with a failure over a warning. */
export function statColor(stat: TurnStat): string | null {
  if (stat.tone === 'failure') return 'var(--failure)'
  if (stat.verdict?.kind === 'bad' || stat.tone === 'warning') return 'var(--warning)'
  if (stat.verdict?.kind === 'good') return 'var(--solus-status-complete)'
  return null
}

/**
 * The turn's outcome in one glance — duration, cost, tokens, cache, tools — for
 * the line under the title. The attribute list still carries each of these as
 * a copyable row; this is the reading, not the record.
 */
export function turnStats(root: MetricsSpan, view: TraceView): TurnStat[] {
  const costUsd = root.attrs.costUsd ?? null
  const cache = cacheStat(root.attrs)

  return [
    {
      label: 'Duration',
      value: formatDuration(root.durationMs),
      detail: view.providerWaitMs == null ? undefined : `${formatDuration(view.providerWaitMs)} on the provider`,
      note: view.providerWaitMs == null ? undefined : `${formatDuration(view.providerWaitMs)} of it waiting on the provider`,
      tone: root.status === 'error' ? 'failure' : 'default',
      verdict: root.status === 'error' ? { kind: 'bad', glyph: 'failed', label: 'Failed' } : undefined,
    },
    {
      label: 'Cost',
      value: formatCost(costUsd),
      detail: costUsd == null ? 'not reported' : undefined,
      note: costUsd == null ? 'the provider reports no cost' : undefined,
    },
    tokensStat(root.attrs.inputTokens ?? null, root.attrs.outputTokens ?? null),
    ...(cache ? [cache] : []),
  ]
}

/** One total for the row; the split between input and output is its line. */
function tokensStat(inputTokens: number | null, outputTokens: number | null): TurnStat {
  if (inputTokens == null && outputTokens == null) return { label: 'Tokens', value: '—' }
  return {
    label: 'Tokens',
    value: formatTokens((inputTokens ?? 0) + (outputTokens ?? 0)),
    detail: `${formatTokens(inputTokens ?? 0)} in · ${formatTokens(outputTokens ?? 0)} out`,
  }
}

/** Below this many tokens a miss costs little either way; the warning is for
 *  the turn that carried a large context and paid for most of it again. */
const CACHE_WARNING_FLOOR_TOKENS = 10_000

/** A turn that read this much of its input from cache paid little for it. */
const CACHE_GOOD_RATE = 0.8

/** Cache hit rate: reads over everything the model was given. Absent when the
 *  provider reported no cache reads at all — a 0% that means "unmeasured" is
 *  not a rate. */
function cacheStat(attrs: MetricsSpan['attrs']): TurnStat | null {
  const cacheRead = attrs.cacheReadTokens ?? null
  if (cacheRead == null) return null
  const cacheWrite = attrs.cacheCreationTokens ?? 0
  const given = (attrs.inputTokens ?? 0) + cacheRead + cacheWrite
  if (given <= 0) return null
  const rate = cacheRead / given
  const missed = rate < 0.5 && given > CACHE_WARNING_FLOOR_TOKENS
  return {
    label: 'Cache',
    value: `${formatPercent(rate)} read`,
    detail: `${formatTokens(cacheRead)} read · ${formatTokens(cacheWrite)} written`,
    note: `${formatTokens(cacheRead)} read · ${formatTokens(cacheWrite)} written`,
    tone: missed ? 'warning' : 'default',
    verdict: missed
      ? { kind: 'bad', glyph: 'alert', label: 'Missed' }
      : rate >= CACHE_GOOD_RATE
        ? { kind: 'good', glyph: 'check', label: 'Hit' }
        : { kind: 'usual', glyph: 'even', label: 'Partial' },
    meter: { fill: rate },
  }
}

/**
 * The turn's attributes, grouped by the question each answers: what it cost,
 * what it was, what it ran under, and when each part of it happened.
 */
export function turnAttributes(root: MetricsSpan, view: TraceView): TurnAttributeGroup[] {
  const denied = view.deniedPermissions.length
  const costUsd = root.attrs.costUsd ?? null
  const inputTokens = root.attrs.inputTokens ?? null
  const outputTokens = root.attrs.outputTokens ?? null
  const totalTokens =
    inputTokens == null && outputTokens == null ? null : (inputTokens ?? 0) + (outputTokens ?? 0)
  const taskId = text(root.attrs.taskId ?? null)
  const taskTitle = text(root.attrs.taskTitle ?? null)
  const taskDestination: TurnAttributeDestination | undefined = taskId
    ? { name: 'task', taskId }
    : undefined

  const groups: TurnAttributeGroup[] = [
    {
      label: 'Outcome',
      attributes: [
        measure(
          'duration_ms',
          root.durationMs,
          formatDuration(root.durationMs),
          view.providerWaitMs != null && view.traceCoverage != null
            ? `${formatPercent(view.traceCoverage)} of it attributed to spans`
            : 'no trace-coverage estimate',
          root.status === 'error' ? 'failure' : 'default',
        ),
        fact('status', root.status, undefined),
        measure(
          'cost_usd',
          costUsd,
          formatCost(costUsd),
          costUsd == null ? 'the provider reports no cost for this turn' : undefined,
        ),
        measure('input_tokens', inputTokens, formatTokens(inputTokens)),
        measure('output_tokens', outputTokens, formatTokens(outputTokens)),
        measure(
          'total_tokens',
          totalTokens,
          formatTokens(totalTokens),
          'input plus output; not a stored column',
        ),
        measure('cache_read_tokens', root.attrs.cacheReadTokens ?? null, formatTokens(root.attrs.cacheReadTokens ?? null)),
        measure('cache_write_tokens', root.attrs.cacheCreationTokens ?? null, formatTokens(root.attrs.cacheCreationTokens ?? null)),
        measure(
          'tool_call_count',
          view.toolCallCount,
          String(view.toolCallCount),
          denied > 0 ? `${denied} permission${denied === 1 ? '' : 's'} denied` : 'none denied',
          denied > 0 ? 'warning' : 'default',
        ),
        measure('permission_denial_count', denied, String(denied), undefined, denied > 0 ? 'warning' : 'default'),
      ],
    },
    {
      label: 'Identity',
      attributes: [
        fact('trace_id', root.traceId, undefined, true),
        fact('session_id', root.sessionId, undefined, true),
        fact('provider', root.provider),
        fact('model', root.model),
        fact('requested_model', root.attrs.requestedModel ?? null, "what Solus asked the provider for; 'auto' when Solus routed the prompt"),
        fact('context_window', root.attrs.contextWindow ?? null, 'tokens the model could hold for this turn'),
        fact('service', root.service),
        fact('origin', root.origin, 'how the turn was dispatched'),
      ],
    },
    {
      label: 'Context',
      attributes: [
        fact('project', root.attrs.projectName ?? null),
        fact('project_root', root.projectRoot, undefined, true),
        fact('branch', root.attrs.branch ?? null),
        fact('task', taskTitle, undefined, false, taskTitle ? taskDestination : undefined),
        fact('task_id', taskId, undefined, true, taskDestination),
        fact('automation', root.attrs.automationName ?? null),
        fact('automation_id', root.attrs.automationId ?? null, undefined, true),
        fact('prompt_source', root.attrs.promptSource ?? null),
        fact('reasoning_effort', root.attrs.reasoningEffort ?? null),
        fact('is_resume', root.attrs.isResume ?? null, 'the provider continued an existing session'),
        fact('has_thinking', root.attrs.hasThinking ?? null),
        fact('prompt_chars', root.attrs.promptChars ?? null),
        fact('system_prompt_chars', root.attrs.systemPromptChars ?? null),
        fact('response_chars', root.attrs.responseChars ?? null),
      ],
    },
    {
      label: 'Timing',
      attributes: [
        measure('started_at', root.startedAt, new Date(root.startedAt).toLocaleString()),
        measure(
          'time_to_first_provider_event_ms',
          root.attrs.timeToFirstProviderEventMs ?? null,
          formatDuration(root.attrs.timeToFirstProviderEventMs ?? null),
        ),
        measure(
          'time_to_first_activity_ms',
          root.attrs.timeToFirstActivityMs ?? null,
          formatDuration(root.attrs.timeToFirstActivityMs ?? null),
          'first thinking, text, tool, or assistant message',
        ),
        measure(
          'time_to_first_text_ms',
          root.attrs.timeToFirstTextMs ?? null,
          formatDuration(root.attrs.timeToFirstTextMs ?? null),
          'first visible text; may follow tool calls',
        ),
        measure(
          'time_to_last_provider_event_ms',
          root.attrs.timeToLastProviderEventMs ?? null,
          formatDuration(root.attrs.timeToLastProviderEventMs ?? null),
        ),
        measure(
          'time_to_provider_complete_ms',
          root.attrs.timeToProviderCompleteMs ?? null,
          formatDuration(root.attrs.timeToProviderCompleteMs ?? null),
        ),
        measure(
          'inter_turn_idle_ms',
          root.attrs.interTurnIdleMs ?? null,
          formatDuration(root.attrs.interTurnIdleMs ?? null),
          'between the previous settlement and this dispatch',
        ),
        measure(
          'provider_wait_ms',
          view.providerWaitMs,
          formatDuration(view.providerWaitMs),
          'provider wait outside Thinking and recorded activity',
          view.providerWaitMs != null && view.traceCoverage != null && view.traceCoverage < 0.5
            ? 'warning'
            : 'default',
        ),
      ],
    },
  ]

  return groups
}

/** The whole list as `key\tvalue` lines — what "Copy all" puts on the
 *  clipboard. Tab-separated so it pastes into a sheet as two columns. */
export function attributesAsText(groups: TurnAttributeGroup[]): string {
  return groups
    .flatMap((group) => group.attributes.map((attribute) => `${attribute.key}\t${attribute.copyValue}`))
    .join('\n')
}

export function attributeCount(groups: TurnAttributeGroup[]): number {
  return groups.reduce((total, group) => total + group.attributes.length, 0)
}
