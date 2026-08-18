import type { NormalizedEvent, UsageData } from '../../shared/types'
import type { SpanAttributes, SpanStatus } from './registries'

export type TurnOutcome = 'completed' | 'interrupted' | 'failed'

export function capped(value: string, limit: number): { value: string; truncated: boolean } {
  if (value.length <= limit) return { value, truncated: false }
  return { value: value.slice(0, limit), truncated: true }
}

/** A dispatch step's own facts: paths, argv, branch names, ids. Each one is a
 *  short label rather than a payload, so a single generous cap keeps a stray
 *  long value — a deep path, a pasted prompt used as a branch slug — from
 *  turning a duration measurement into a content store. */
const DISPATCH_ATTR_LIMIT = 1024

export function cappedAttrs(attrs: SpanAttributes | undefined): SpanAttributes {
  if (!attrs) return {}
  const result: SpanAttributes = {}
  for (const [key, value] of Object.entries(attrs)) {
    result[key] = typeof value === 'string' ? capped(value, DISPATCH_ATTR_LIMIT).value : value
  }
  return result
}

export function spanStatusForToolOutcome(
  outcome: Extract<NormalizedEvent, { type: 'tool_call_complete' }>['outcome'],
): SpanStatus {
  if (!outcome) return 'ok'
  if (outcome.declined || outcome.error || outcome.status === 'failed' || outcome.status === 'error') return 'error'
  if (outcome.status === 'interrupted' || outcome.status === 'cancelled' || outcome.status === 'canceled') return 'interrupted'
  if (typeof outcome.exitCode === 'number' && outcome.exitCode !== 0) return 'error'
  return 'ok'
}

export function terminalOutcome(status: SpanStatus): TurnOutcome {
  if (status === 'interrupted') return 'interrupted'
  if (status === 'error') return 'failed'
  return 'completed'
}

function usageValue(usage: UsageData, key: keyof UsageData): number {
  const value = usage[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function usageDelta(current: UsageData, baseline: UsageData): UsageData {
  const keys: Array<keyof UsageData> = [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheCreationTokens',
    'reasoningTokens',
  ]
  const reset = keys.some((key) => usageValue(current, key) < usageValue(baseline, key))
  const result: UsageData = {}
  for (const key of keys) {
    const value = reset
      ? usageValue(current, key)
      : usageValue(current, key) - usageValue(baseline, key)
    if (value > 0) result[key] = value
  }
  return result
}

export function copyUsage(usage: UsageData): UsageData {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    reasoningTokens: usage.reasoningTokens,
    contextWindowTokens: usage.contextWindowTokens,
  }
}

export function setUsageAttrs(attrs: SpanAttributes, usage: UsageData): void {
  if (usage.inputTokens !== undefined) attrs.inputTokens = usage.inputTokens
  if (usage.outputTokens !== undefined) attrs.outputTokens = usage.outputTokens
  if (usage.cacheReadTokens !== undefined) attrs.cacheReadTokens = usage.cacheReadTokens
  if (usage.cacheCreationTokens !== undefined) attrs.cacheCreationTokens = usage.cacheCreationTokens
}

export function applyTaskCompleteAttrs(
  attrs: SpanAttributes,
  provider: string,
  event: Extract<NormalizedEvent, { type: 'task_complete' }>,
): void {
  if (provider !== 'codex') {
    setUsageAttrs(attrs, event.usage)
    attrs.costUsd = event.costUsd
  }
  if (event.permissionDenials) attrs.permissionDenialCount = event.permissionDenials.length
}
