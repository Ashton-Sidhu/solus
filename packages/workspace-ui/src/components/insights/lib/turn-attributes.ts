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

function text(value: MetricsAttrLike): string | null {
  if (value === null || value === undefined) return null
  const printed = String(value)
  return printed === '' ? null : printed
}

type MetricsAttrLike = string | number | boolean | null | undefined

function attrOf(span: MetricsSpan, key: string): MetricsAttrLike {
  const value = span.attrs[key]
  return value === undefined ? null : value
}

function numberAttr(span: MetricsSpan, key: string): number | null {
  const value = attrOf(span, key)
  return typeof value === 'number' && Number.isFinite(value) ? value : null
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
  value: MetricsAttrLike,
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
  const costUsd = numberAttr(root, 'costUsd')
  const inputTokens = numberAttr(root, 'inputTokens')
  const outputTokens = numberAttr(root, 'outputTokens')
  const totalTokens =
    inputTokens == null && outputTokens == null ? null : (inputTokens ?? 0) + (outputTokens ?? 0)
  const denied = view.deniedPermissions.length
  const taskId = text(attrOf(root, 'taskId'))
  const taskTitle = text(attrOf(root, 'taskTitle'))
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
          view.unattributedMs != null && view.traceCoverage != null
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
        measure('cache_read_tokens', numberAttr(root, 'cacheReadTokens'), formatTokens(numberAttr(root, 'cacheReadTokens'))),
        measure('cache_write_tokens', numberAttr(root, 'cacheCreationTokens'), formatTokens(numberAttr(root, 'cacheCreationTokens'))),
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
        fact('project', attrOf(root, 'projectName')),
        fact('project_root', root.projectRoot, undefined, true),
        fact('branch', attrOf(root, 'branch')),
        fact('task', taskTitle, undefined, false, taskTitle ? taskDestination : undefined),
        fact('task_id', taskId, undefined, true, taskDestination),
        fact('automation', attrOf(root, 'automationName')),
        fact('automation_id', attrOf(root, 'automationId'), undefined, true),
        fact('prompt_source', attrOf(root, 'promptSource')),
        fact('reasoning_effort', attrOf(root, 'reasoningEffort')),
        fact('is_resume', attrOf(root, 'isResume'), 'the provider continued an existing session'),
        fact('has_thinking', attrOf(root, 'hasThinking')),
        fact('prompt_chars', attrOf(root, 'promptChars')),
        fact('system_prompt_chars', attrOf(root, 'systemPromptChars')),
        fact('response_chars', attrOf(root, 'responseChars')),
      ],
    },
    {
      label: 'Timing',
      attributes: [
        measure('started_at', root.startedAt, new Date(root.startedAt).toLocaleString()),
        measure(
          'time_to_first_provider_event_ms',
          numberAttr(root, 'timeToFirstProviderEventMs'),
          formatDuration(numberAttr(root, 'timeToFirstProviderEventMs')),
        ),
        measure(
          'time_to_first_activity_ms',
          numberAttr(root, 'timeToFirstActivityMs'),
          formatDuration(numberAttr(root, 'timeToFirstActivityMs')),
          'first thinking, text, tool, or assistant message',
        ),
        measure(
          'time_to_first_text_ms',
          numberAttr(root, 'timeToFirstTextMs'),
          formatDuration(numberAttr(root, 'timeToFirstTextMs')),
          'first visible text; may follow tool calls',
        ),
        measure(
          'time_to_last_provider_event_ms',
          numberAttr(root, 'timeToLastProviderEventMs'),
          formatDuration(numberAttr(root, 'timeToLastProviderEventMs')),
        ),
        measure(
          'time_to_provider_complete_ms',
          numberAttr(root, 'timeToProviderCompleteMs'),
          formatDuration(numberAttr(root, 'timeToProviderCompleteMs')),
        ),
        measure(
          'inter_turn_idle_ms',
          numberAttr(root, 'interTurnIdleMs'),
          formatDuration(numberAttr(root, 'interTurnIdleMs')),
          'between the previous settlement and this dispatch',
        ),
        measure(
          'unattributed_ms',
          view.unattributedMs,
          formatDuration(view.unattributedMs),
          'turn time no span covers',
          view.unattributedMs != null && view.traceCoverage != null && view.traceCoverage < 0.5
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
