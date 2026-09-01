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
  /** The registry's own column name, so a row reads the way a query writes. */
  key: string
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

/** A measure: printed short, copied exact. A missing measure still gets a row —
 *  "this turn has no cost" is an answer, and hiding it reads as a bug. */
function measure(
  key: string,
  raw: number | null,
  printed: string,
  note?: string,
  tone: AttributeTone = 'default',
): TurnAttribute {
  return { key, value: printed, copyValue: raw == null ? '' : String(raw), note, tone }
}

function fact(
  key: string,
  value: AttributeValue,
  note?: string,
  mono = false,
  destination?: TurnAttributeDestination,
): TurnAttribute {
  const printed = text(value)
  return { key, value: printed ?? '—', copyValue: printed ?? '', note, mono, destination }
}

/**
 * The turn's attributes, grouped by the question each answers: what it cost,
 * what it was, what it ran under, and when each part of it happened.
 */
export function turnAttributes(root: MetricsSpan, view: TraceView): TurnAttributeGroup[] {
  const costUsd = root.attrs.costUsd ?? null
  const inputTokens = root.attrs.inputTokens ?? null
  const outputTokens = root.attrs.outputTokens ?? null
  const totalTokens =
    inputTokens == null && outputTokens == null ? null : (inputTokens ?? 0) + (outputTokens ?? 0)
  const denied = view.deniedPermissions.length
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
