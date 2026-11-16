import { randomUUID } from 'node:crypto'
import type { AppModelCallRecord } from '@solus/contracts/app-models'
import type { AppCallDetail, AppCallStats, AppCallView, AppCaller, AppLogLine, AppMetrics, AppOperationMetrics, AppSpan } from '@solus/contracts/apps'
import { callTimings, callTimingsSince, finishCall, insertCall, pruneCalls, type AppCallFilter, type AppCallRecord, type AppCallTiming, type AppRecord } from '../data/apps/app-store'
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
    id, appId, version: call.version, kind: 'operation', operation: call.operation, caller: call.caller, startedAt,
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

/**
 * The row of a model call in the call log (docs/plans/app-models.md): one log
 * holds both kinds of call, so search, filters, and counts see them all. The
 * row has the id of the model call record, which keeps the prompt, the text,
 * and the result. The row keeps the prompt as its input and what the model
 * wrote as one log line, for the search; never the result.
 */
export const modelCallLog = {
  async begin(record: AppModelCallRecord, version: number): Promise<void> {
    const input = JSON.stringify({ setting: record.setting, prompt: record.prompt })
    await insertCall({
      id: record.id, appId: record.appId, version, kind: 'model', operation: record.setting, caller: record.caller, startedAt: record.createdAt,
      input: input.slice(0, MAX_INPUT_CHARACTERS), inputTruncated: input.length > MAX_INPUT_CHARACTERS,
      runId: record.caller.kind === 'workflow' ? record.caller.runId : null, traceId: null, spanId: null,
    })
    emitAppActivity(record.appId, 'calls')
  },
  async end(record: AppModelCallRecord): Promise<void> {
    const text = record.text.slice(0, MAX_LOG_CHARACTERS)
    await finishCall(record.id, {
      outcome: record.status === 'done' ? 'ok' : 'failed',
      error: record.status === 'done' ? null : (record.error ?? 'The call was cancelled.'),
      errorStack: null,
      resultBytes: record.result === null ? null : Buffer.byteLength(JSON.stringify(record.result)),
      logs: text ? [{ atMs: (record.startedAt ?? record.createdAt) - record.createdAt, level: 'info', text }] : [],
      logsTruncated: record.text.length > MAX_LOG_CHARACTERS,
      spans: [],
      finishedAt: record.endedAt ?? Date.now(),
    })
    emitAppActivity(record.appId, 'calls')
  },
}
export type ModelCallLog = typeof modelCallLog

/** Forgets what this module counted for an app that is gone. */
export function forgetCallCounts(appId: string): void {
  callCounts.delete(appId)
}

export function callView(call: AppCallRecord): AppCallView {
  return {
    id: call.id, version: call.version, kind: call.kind, operation: call.operation, caller: call.caller, startedAt: call.startedAt, finishedAt: call.finishedAt,
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

/** The bucket sizes of the Activity chart, the smallest first. */
const BUCKET_SIZES_MS = [1, 5, 15, 30, 60, 180, 360, 720, 1440, 10_080].map((minutes) => minutes * 60_000)
/** The chart never cuts its time into more buckets than this. */
const MAX_BUCKETS = 36

/**
 * The calls that pass the filters of a read, in numbers (§9.2). The time from
 * `since` to `now` (the end of the range) is cut into the smallest bucket that gives no more than
 * `MAX_BUCKETS`; the last one ends at `now`. Without `since`, the time starts
 * at the oldest call, or 24 hours back when no call passes. Pure, so the math
 * is tested without a host.
 */
export function callStatsFrom(calls: readonly AppCallTiming[], since: number | undefined, now: number): AppCallStats {
  const start = Math.min(since ?? calls[0]?.startedAt ?? now - DAY_MS, now - 60_000)
  const range = now - start
  const bucketMs = BUCKET_SIZES_MS.find((size) => Math.ceil(range / size) <= MAX_BUCKETS) ?? BUCKET_SIZES_MS[BUCKET_SIZES_MS.length - 1]
  const count = Math.ceil(range / bucketMs)
  const first = now - count * bucketMs
  const buckets = Array.from({ length: count }, (_unused, index) => ({ start: first + index * bucketMs, calls: 0, failed: 0 }))
  const durations: number[] = []
  let failed = 0
  for (const call of calls) {
    const bucket = buckets[Math.min(count - 1, Math.max(0, Math.floor((call.startedAt - first) / bucketMs)))]
    bucket.calls += 1
    if (call.outcome === 'failed') {
      failed += 1
      bucket.failed += 1
    }
    if (call.finishedAt !== null) durations.push(call.finishedAt - call.startedAt)
  }
  durations.sort((a, b) => a - b)
  return { since: start, until: now, bucketMs, calls: calls.length, failed, p50Ms: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95), buckets }
}

/** With `until`, the time ends there, as the Activity chart zoomed to a range; it never ends after `now`. */
export async function appCallStats(appId: string, filter: AppCallFilter, now = Date.now()): Promise<AppCallStats> {
  return callStatsFrom(await callTimings(appId, filter), filter.since, Math.min(filter.until ?? now, now))
}
