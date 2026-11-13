import { randomUUID } from 'node:crypto'
import type { AppCallDetail, AppCallView, AppCaller, AppLogLine, AppMetrics, AppOperationMetrics, AppSpan } from '@solus/contracts/apps'
import { callTimingsSince, finishCall, insertCall, pruneCalls, type AppCallRecord, type AppCallTiming, type AppRecord } from '../data/apps/app-store'
import { emitAppActivity } from './app-events'
import { AppOperationError } from './app-runners'
import { startAppCallTelemetry } from './app-telemetry'
import type { StoredValue } from './app-storage'

/**
 * What the host keeps of a call (docs/plans/apps.md decision 21): its input,
 * its log lines, its trace, its time, and how it ended. Never a result and
 * never a secret. One row of the call log is one call of an operation, or one
 * execution of a workflow's function (its caller is `workflow` with no step).
 *
 * The same facts go to the host's tracer as one OpenTelemetry span for the
 * call, an event for each log line, and a child span for each thing the call
 * waited for (`app-telemetry.ts`). The row keeps the span's trace id.
 */

const MAX_INPUT_CHARACTERS = 16 * 1024
const MAX_LOG_LINES = 300
const MAX_LOG_CHARACTERS = 64 * 1024
const MAX_SPANS = 300
const PRUNE_EVERY_CALLS = 100
const DAY_MS = 24 * 60 * 60_000
const HOUR_MS = 60 * 60_000

const callCounts = new Map<string, number>()

/** One call in progress: what its runner says of it, kept until it ends. */
export interface AppCallRecording {
  id: string
  log(line: AppLogLine): void
  span(span: AppSpan): void
  /** Writes how the call ended. `result` is what it answered; only its size is kept. */
  succeeded(result: StoredValue): Promise<void>
  failed(error: Error): Promise<void>
}

/** Writes the row of a call that starts, starts its span, and answers what keeps its log lines and spans. */
export async function beginCall(call: { app: Pick<AppRecord, 'id' | 'slug' | 'organizationId'>; version: number; operation: string; operationKind: 'query' | 'mutation' | 'workflow'; caller: AppCaller; input: StoredValue; runId: string | null }): Promise<AppCallRecording> {
  const id = randomUUID()
  const appId = call.app.id
  const startedAt = Date.now()
  const text = JSON.stringify(call.input) ?? 'null'
  const telemetry = startAppCallTelemetry({
    callId: id, appId, appSlug: call.app.slug, appVersion: call.version, organizationId: call.app.organizationId,
    operation: call.operation, operationKind: call.operationKind, caller: call.caller, startedAt,
  })
  await insertCall({
    id, appId, version: call.version, operation: call.operation, caller: call.caller, startedAt,
    input: text.slice(0, MAX_INPUT_CHARACTERS), inputTruncated: text.length > MAX_INPUT_CHARACTERS, runId: call.runId,
    traceId: telemetry.traceId, spanId: telemetry.spanId,
  })
  emitAppActivity(appId, 'calls')
  const logs: AppLogLine[] = []
  const spans: AppSpan[] = []
  let logCharacters = 0
  let logsTruncated = false
  const end = async (outcome: 'ok' | 'failed', error: string | null, errorStack: string | null, resultBytes: number | null) => {
    const finishedAt = Date.now()
    telemetry.end({ endedAt: finishedAt, error: error === null ? undefined : { message: error, stack: errorStack }, resultBytes })
    await finishCall(id, { outcome, error, errorStack, resultBytes, logs, logsTruncated, spans, finishedAt })
    emitAppActivity(appId, 'calls')
    const count = (callCounts.get(appId) ?? 0) + 1
    callCounts.set(appId, count % PRUNE_EVERY_CALLS)
    if (count % PRUNE_EVERY_CALLS === 0) await pruneCalls(appId).catch(() => {})
  }
  return {
    id,
    log(line) {
      if (logs.length >= MAX_LOG_LINES || logCharacters + line.text.length > MAX_LOG_CHARACTERS) {
        logsTruncated = true
        return
      }
      logCharacters += line.text.length
      logs.push(line)
      telemetry.log(line)
    },
    span(span) {
      if (spans.length >= MAX_SPANS) return
      spans.push(span)
      telemetry.work(span)
    },
    succeeded: (result) => end('ok', null, null, Buffer.byteLength(JSON.stringify(result) ?? 'null')),
    failed: (error) => end('failed', error.message, error instanceof AppOperationError ? error.appStack : null, null),
  }
}

/** Forgets what this module counted for an app that is gone. */
export function forgetCallCounts(appId: string): void {
  callCounts.delete(appId)
}

export function callView(call: AppCallRecord): AppCallView {
  return {
    id: call.id, version: call.version, operation: call.operation, caller: call.caller, startedAt: call.startedAt, finishedAt: call.finishedAt,
    outcome: call.outcome, error: call.error, durationMs: call.finishedAt === null ? null : call.finishedAt - call.startedAt,
    logCount: call.logs.length, spanCount: call.spans.length, traceId: call.traceId, spanId: call.spanId,
  }
}

export function callDetail(call: AppCallRecord): AppCallDetail {
  return {
    ...callView(call), input: call.input, inputTruncated: call.inputTruncated, resultBytes: call.resultBytes, errorStack: call.errorStack,
    logs: call.logs, logsTruncated: call.logsTruncated, spans: call.spans, runId: call.runId,
  }
}

/** The value below which `fraction` of the sorted values are; null with no value. */
export function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] ?? null
}

/** The calls since `now - 24 h`, in numbers (§9.2). Pure, so the math is tested without a host. */
export function metricsFrom(calls: readonly AppCallTiming[], now: number): AppMetrics {
  const since = now - DAY_MS
  // The last hour ends at `now`; each hour before it is one step back.
  const firstHour = now - 24 * HOUR_MS
  const hours = Array.from({ length: 24 }, (_unused, index) => ({ start: firstHour + index * HOUR_MS, calls: 0, failed: 0 }))
  const byOperation = new Map<string, { durations: number[]; calls: number; failed: number; lastAt: number | null }>()
  const durations: number[] = []
  let failed = 0
  for (const call of calls) {
    const hour = hours[Math.min(23, Math.max(0, Math.floor((call.startedAt - firstHour) / HOUR_MS)))]
    const operation = byOperation.get(call.operation) ?? { durations: [], calls: 0, failed: 0, lastAt: null }
    byOperation.set(call.operation, operation)
    operation.calls += 1
    operation.lastAt = Math.max(operation.lastAt ?? 0, call.startedAt)
    if (hour) hour.calls += 1
    if (call.outcome === 'failed') {
      failed += 1
      operation.failed += 1
      if (hour) hour.failed += 1
    }
    if (call.finishedAt !== null) {
      durations.push(call.finishedAt - call.startedAt)
      operation.durations.push(call.finishedAt - call.startedAt)
    }
  }
  const ascending = (a: number, b: number) => a - b
  durations.sort(ascending)
  const operations = [...byOperation].map(([operation, entry]): AppOperationMetrics => {
    entry.durations.sort(ascending)
    return { operation, calls: entry.calls, failed: entry.failed, p50Ms: percentile(entry.durations, 0.5), p95Ms: percentile(entry.durations, 0.95), lastAt: entry.lastAt }
  }).sort((a, b) => b.calls - a.calls || a.operation.localeCompare(b.operation))
  return { since, calls: calls.length, failed, p50Ms: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95), hours, operations }
}

export async function appMetrics(appId: string, now = Date.now()): Promise<AppMetrics> {
  return metricsFrom(await callTimingsSince(appId, now - DAY_MS), now)
}
