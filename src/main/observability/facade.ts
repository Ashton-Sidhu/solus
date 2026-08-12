import { randomUUID } from 'node:crypto'
import { getMetricsDb } from './metrics-db'
import {
  assertRegisteredSpanKind,
  assertRegisteredSpanService,
  type SpanKind,
  type SpanService,
} from './registries'

export type SpanStatus = 'ok' | 'error' | 'interrupted' | 'unknown'
export type SpanAttributeValue = string | number | boolean
export type SpanAttributes = Record<string, SpanAttributeValue>

export interface SpanDimensions {
  sessionId?: string
  provider?: string
  model?: string
  projectRoot?: string
  origin?: string
}

export interface StartSpanInput extends SpanDimensions {
  spanId?: string
  parentSpanId?: string
  traceId?: string
  kind: SpanKind
  name: string
  service: SpanService
  startedAt?: number
  attrs?: SpanAttributes
}

export interface FinalizeSpanInput {
  endedAt?: number
  status?: SpanStatus
  attrs?: SpanAttributes
}

export interface CompleteSpanInput extends StartSpanInput {
  endedAt: number
  durationMs?: number
  status: SpanStatus
}

const spanStatuses = new Set<SpanStatus>(['ok', 'error', 'interrupted', 'unknown'])

function assertTimestamp(value: number, field: string): void {
  if (!Number.isFinite(value)) throw new Error(`Span ${field} must be a finite number.`)
}

function assertSpanAttributes(attrs: SpanAttributes | undefined): void {
  if (!attrs) return
  for (const [key, value] of Object.entries(attrs)) {
    if (!key) throw new Error('Span attrs keys cannot be empty.')
    if (typeof value !== 'string' && typeof value !== 'boolean' && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error(`Span attr ${key} must be a string, finite number, or boolean.`)
    }
  }
}

function assertSpanInput(input: StartSpanInput): void {
  assertRegisteredSpanKind(input.kind)
  assertRegisteredSpanService(input.service)
  if (!input.name.trim()) throw new Error('Span name cannot be empty.')
  assertSpanAttributes(input.attrs)
}

function assertStatus(status: SpanStatus): void {
  if (!spanStatuses.has(status)) throw new Error(`Invalid span status: ${status}`)
}

/** Starts a span and returns its id. Finalize it with endSpan. */
export function startSpan(input: StartSpanInput): string {
  assertSpanInput(input)

  const spanId = input.spanId ?? randomUUID()
  const startedAt = input.startedAt ?? Date.now()
  assertTimestamp(startedAt, 'startedAt')
  const traceId = input.traceId ?? spanId

  getMetricsDb().prepare(`
    INSERT INTO spans (
      span_id, parent_span_id, trace_id, kind, name, service,
      session_id, provider, model, project_root, origin,
      started_at, status, attrs
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    spanId,
    input.parentSpanId ?? null,
    traceId,
    input.kind,
    input.name,
    input.service,
    input.sessionId ?? null,
    input.provider ?? null,
    input.model ?? null,
    input.projectRoot ?? null,
    input.origin ?? null,
    startedAt,
    'unknown',
    JSON.stringify(input.attrs ?? {}),
  )

  return spanId
}

/** Finalizes a started span and merges new attrs with its existing attrs. */
export function endSpan(spanId: string, input: FinalizeSpanInput = {}): void {
  const endedAt = input.endedAt ?? Date.now()
  const status = input.status ?? 'unknown'
  assertTimestamp(endedAt, 'endedAt')
  assertStatus(status)
  assertSpanAttributes(input.attrs)

  const row = getMetricsDb().prepare('SELECT started_at, attrs FROM spans WHERE span_id = ?').get(spanId) as
    | { started_at: number; attrs: string }
    | undefined
  if (!row) throw new Error(`Unknown span: ${spanId}`)
  if (endedAt < row.started_at) throw new Error('Span endedAt cannot be before startedAt.')

  const attrs = { ...(JSON.parse(row.attrs) as SpanAttributes), ...input.attrs }
  getMetricsDb().prepare(`
    UPDATE spans
    SET ended_at = ?, duration_ms = ?, status = ?, attrs = ?
    WHERE span_id = ?
  `).run(endedAt, endedAt - row.started_at, status, JSON.stringify(attrs), spanId)
}

/** Writes a span that is already complete. */
export function writeSpan(input: CompleteSpanInput): string {
  assertSpanInput(input)
  assertTimestamp(input.endedAt, 'endedAt')
  assertStatus(input.status)

  const spanId = input.spanId ?? randomUUID()
  const startedAt = input.startedAt ?? Date.now()
  assertTimestamp(startedAt, 'startedAt')
  if (input.endedAt < startedAt) throw new Error('Span endedAt cannot be before startedAt.')

  const durationMs = input.durationMs ?? input.endedAt - startedAt
  assertTimestamp(durationMs, 'durationMs')

  getMetricsDb().prepare(`
    INSERT INTO spans (
      span_id, parent_span_id, trace_id, kind, name, service,
      session_id, provider, model, project_root, origin,
      started_at, ended_at, duration_ms, status, attrs
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    spanId,
    input.parentSpanId ?? null,
    input.traceId ?? spanId,
    input.kind,
    input.name,
    input.service,
    input.sessionId ?? null,
    input.provider ?? null,
    input.model ?? null,
    input.projectRoot ?? null,
    input.origin ?? null,
    startedAt,
    input.endedAt,
    durationMs,
    input.status,
    JSON.stringify(input.attrs ?? {}),
  )

  return spanId
}

/** Removes spans that began before the rollover cutoff. */
export function rolloverSpans(cutoff: number): number {
  assertTimestamp(cutoff, 'rollover cutoff')
  return getMetricsDb().prepare('DELETE FROM spans WHERE started_at < ?').run(cutoff).changes
}
