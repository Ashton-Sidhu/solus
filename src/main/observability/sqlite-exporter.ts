import { SpanStatusCode, type AttributeValue, type HrTime } from '@opentelemetry/api'
import { ExportResultCode, type ExportResult } from '@opentelemetry/core'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-node'
import { z } from 'zod'
import { createLogger } from '../logger'
import {
  SPAN_ATTRS,
  assertRegisteredSpanKind,
  assertRegisteredSpanService,
  isSpanColumnAttr,
  type SpanAttributes,
  type SpanStatus,
} from './registries'
import { writeSpan, type SpanRow } from './span-table'

// ─── metrics.db as a span exporter ───
//
// Insights is a SQL surface, not a trace viewer: `session_id`, `provider`,
// `model`, `project_root` and `origin` are real columns, `kind` selects a view,
// and every registered field resolves to a column or a path inside `attrs`. A
// tracer hands over one flat attribute bag, so the projection back onto that
// typed shape happens here — it is the only thing this sink adds over the OTLP
// copy, and the reason `field-registry.ts` never has to know a tracer exists.
//
// This exporter is registered with a `SimpleSpanProcessor`: it is the system of
// record, and a batch processor drops on queue overflow.

const log = createLogger('SqliteSpanExporter', 'sqlite-exporter.ts')

// An attribute arrives as OTel allows it — text, a scalar, or an array — and
// leaves as one of the three a column or an `attrs` value can hold. These parse
// that boundary once, rather than each reader guessing at the representation.
const spanStatusSchema = z.enum(['ok', 'error', 'interrupted', 'unknown'])
const namedValueSchema = z.string().min(1)
const columnValueSchema = z.union([
  z.string(),
  z.boolean(),
  z.number().refine(Number.isFinite),
])

/** OTel carries UNSET/OK/ERROR; Solus also records 'interrupted', which a span
 *  states for itself. The code is the fallback for a span that did not. */
function spanStatus(span: ReadableSpan): SpanStatus {
  const stated = spanStatusSchema.safeParse(span.attributes[SPAN_ATTRS.status])
  if (stated.success) return stated.data
  if (span.status.code === SpanStatusCode.ERROR) return 'error'
  if (span.status.code === SpanStatusCode.OK) return 'ok'
  return 'unknown'
}

/** A column's value: a name, an id, a status. An absent or empty one is the
 *  column's null. */
function namedAttr(span: ReadableSpan, key: string): string | undefined {
  const parsed = namedValueSchema.safeParse(span.attributes[key])
  return parsed.success ? parsed.data : undefined
}

/** Everything the exporter did not promote to a column, as `attrs` holds it:
 *  the registry's own camelCase names, untouched. */
function remainingAttrs(attributes: Record<string, AttributeValue | undefined>): SpanAttributes {
  const attrs: SpanAttributes = {}
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || isSpanColumnAttr(key)) continue
    const scalar = columnValueSchema.safeParse(value)
    // An array is the one shape OTel allows that a JSON attr value does not;
    // it is stored as its own JSON so `json_extract` can still reach into it.
    attrs[key] = scalar.success ? scalar.data : JSON.stringify(value)
  }
  return attrs
}

/**
 * A trace root is named by its trace.
 *
 * `spans` has always identified a turn by `span_id = trace_id` — the join the
 * `events` view uses to read a turn's facts off its root — while OTLP wants a
 * 16-byte span id and a 16-byte trace id. `SolusIdGenerator` gives a root span
 * the first half of its own trace id, so the two id spaces stay one derivation
 * apart and this stays a pure function of the span.
 */
function dbSpanId(traceId: string, spanId: string): string {
  return traceId.startsWith(spanId) ? traceId : spanId
}

/** Epoch milliseconds, rounded, so `duration_ms` is exactly `ended_at -
 *  started_at` for a reader who subtracts the columns. */
function epochMs(time: HrTime): number {
  return Math.round(time[0] * 1_000 + time[1] / 1e6)
}

function spanRow(span: ReadableSpan): SpanRow {
  const { traceId, spanId } = span.spanContext()
  const parentSpanId = span.parentSpanContext?.spanId
  const startedAt = epochMs(span.startTime)
  const endedAt = Math.max(startedAt, epochMs(span.endTime))
  const kind = namedAttr(span, SPAN_ATTRS.kind) ?? ''
  const service = namedAttr(span, SPAN_ATTRS.service) ?? ''
  // A span that names neither is not a row Insights can type. Solus writes both
  // on every span it starts, so this rejects a foreign span rather than storing
  // an untyped one.
  assertRegisteredSpanKind(kind)
  assertRegisteredSpanService(service)
  return {
    spanId: dbSpanId(traceId, spanId),
    parentSpanId: parentSpanId ? dbSpanId(traceId, parentSpanId) : undefined,
    traceId,
    kind,
    name: span.name,
    service,
    sessionId: namedAttr(span, SPAN_ATTRS.sessionId),
    provider: namedAttr(span, SPAN_ATTRS.provider),
    model: namedAttr(span, SPAN_ATTRS.model),
    projectRoot: namedAttr(span, SPAN_ATTRS.projectRoot),
    origin: namedAttr(span, SPAN_ATTRS.origin),
    startedAt,
    endedAt,
    status: spanStatus(span),
    attrs: remainingAttrs(span.attributes),
  }
}

/** Writes finished spans into `metrics.db`, the record Insights reads. */
export class SqliteSpanExporter implements SpanExporter {
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    for (const span of spans) {
      try {
        writeSpan(spanRow(span))
      } catch (error) {
        // One unwritable span must not cost the rest of the batch, and an
        // exporter that throws would take the ending span's caller with it.
        log.warn('span_write_failed', {
          spanId: span.spanContext().spanId,
          name: span.name,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    resultCallback({ code: ExportResultCode.SUCCESS })
  }

  /** Writes are synchronous, so there is never anything in flight to flush. */
  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}
