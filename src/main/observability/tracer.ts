import { randomBytes } from 'node:crypto'
import {
  SpanStatusCode,
  context,
  type Context,
  type HrTime,
  type Span,
  type Tracer,
} from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import {
  AlwaysOnSampler,
  BasicTracerProvider,
  SimpleSpanProcessor,
  type IdGenerator,
  type ReadableSpan,
  type Span as RecordingSpan,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-node'
import { otelResource } from '../otel-resource'
import {
  SPAN_ATTRS,
  type SpanAttributes,
  type SpanDimensions,
  type SpanKind,
  type SpanService,
  type SpanStatus,
} from './registries'
import { SqliteSpanExporter } from './sqlite-exporter'

// ─── The tracer is the span model ───
//
// One `Tracer` records every Solus span, and the sinks differ in what they
// promise:
//
//   Tracer
//     ├─ SimpleSpanProcessor → SolusSqliteSpanExporter  (the record; never drops)
//     └─ BatchSpanProcessor  → OTLPTraceExporter        (a copy; the settings toggle)
//
// The SQLite sink is synchronous on purpose. `BatchSpanProcessor` drops on
// queue overflow, which is fine for a copy an operator asked to be shipped
// somewhere and a correctness bug for the table Insights answers from.
//
// Sampling is pinned on: `metrics.db` is the record, so a sampler read from the
// environment could silently delete rows an operator is querying.

/**
 * Trace ids and span ids in OTLP's own widths, with one arrangement Solus
 * depends on: a **root span's id is the first half of its trace id**.
 *
 * `spans` names a trace root by its trace (`span_id = trace_id`, the join the
 * `events` view reads a turn's facts through), so the exporter has to recognise
 * a root — and a root's direct children have to recognise their parent — from
 * the span alone. Pairing the two ids at the moment they are minted makes that
 * a pure derivation instead of bookkeeping. `Tracer.startSpan` asks for the
 * span id first and then, only for a root, the trace id, so the pair is always
 * formed inside one synchronous call.
 */
class SolusIdGenerator implements IdGenerator {
  private lastSpanId = ''

  generateSpanId = (): string => {
    this.lastSpanId = randomBytes(8).toString('hex')
    return this.lastSpanId
  }

  generateTraceId = (): string => {
    const head = this.lastSpanId || randomBytes(8).toString('hex')
    return head + randomBytes(8).toString('hex')
  }
}

/** The record, plus whatever copy the host's settings currently ask for. The
 *  OTLP processor is swapped in and out while the app runs, so it lives behind
 *  this rather than in the provider's fixed processor list. */
class TraceSinks implements SpanProcessor {
  private otlp: SpanProcessor | null = null

  constructor(private readonly record: SpanProcessor) {}

  /** Directs the copy at a collector, or stops copying when given null.
   *  Returns the processor that was replaced, for the caller to shut down. */
  replaceOtlpProcessor(processor: SpanProcessor | null): SpanProcessor | null {
    const previous = this.otlp
    this.otlp = processor
    return previous
  }

  onStart(span: RecordingSpan, parentContext: Context): void {
    this.record.onStart(span, parentContext)
    this.otlp?.onStart(span, parentContext)
  }

  onEnd(span: ReadableSpan): void {
    this.record.onEnd(span)
    this.otlp?.onEnd(span)
  }

  async forceFlush(): Promise<void> {
    await Promise.all([this.record.forceFlush(), this.otlp?.forceFlush()])
  }

  async shutdown(): Promise<void> {
    await Promise.all([this.record.shutdown(), this.otlp?.shutdown()])
  }
}

const sinks = new TraceSinks(new SimpleSpanProcessor(new SqliteSpanExporter()))

// OTel's own async-context manager, and what makes a span started inside
// another one nest without being handed its parent. Enabled with the module
// rather than with the first span, because a scope opened before it existed
// would silently not propagate.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())

let tracer: Tracer | null = null

/** The one tracer every Solus span is started from. Built on first use: the
 *  resource names the running app, which Electron can only answer once it is. */
function solusTracer(): Tracer {
  if (!tracer) {
    tracer = new BasicTracerProvider({
      resource: otelResource(),
      idGenerator: new SolusIdGenerator(),
      sampler: new AlwaysOnSampler(),
      spanProcessors: [sinks],
    }).getTracer('solus')
  }
  return tracer
}

/** Points the OTLP copy at a processor, or stops it with null. The replaced
 *  processor is shut down so its queue is flushed before it is dropped. */
export async function replaceOtlpSpanProcessor(processor: SpanProcessor | null): Promise<void> {
  await sinks.replaceOtlpProcessor(processor)?.shutdown()
}

/** Epoch milliseconds as OTel reads them. A bare number is ambiguous to the SDK
 *  — below the process's time origin it is read as a `performance.now()`
 *  reading — and every Solus timestamp is epoch. */
function epochTime(ms: number): HrTime {
  return [Math.floor(ms / 1_000), Math.round((ms % 1_000) * 1e6)]
}

function dimensionAttributes(dimensions: SpanDimensions | undefined): SpanAttributes {
  const attributes: SpanAttributes = {}
  if (!dimensions) return attributes
  if (dimensions.sessionId) attributes[SPAN_ATTRS.sessionId] = dimensions.sessionId
  if (dimensions.provider) attributes[SPAN_ATTRS.provider] = dimensions.provider
  if (dimensions.model) attributes[SPAN_ATTRS.model] = dimensions.model
  if (dimensions.projectRoot) attributes[SPAN_ATTRS.projectRoot] = dimensions.projectRoot
  if (dimensions.origin) attributes[SPAN_ATTRS.origin] = dimensions.origin
  return attributes
}

export interface StartSolusSpanInput {
  kind: SpanKind
  name: string
  service: SpanService
  /** Epoch milliseconds. Solus decides its own start times — a clamped tool
   *  start, a provider-reported timestamp — so none of them are "now". */
  startedAt: number
  attrs?: SpanAttributes
  dimensions?: SpanDimensions
  /** The context the span hangs off. Defaults to whatever is active here. */
  parent?: Context
}

/** Starts a span carrying the Solus vocabulary the SQLite exporter projects
 *  into columns. */
export function startSolusSpan(input: StartSolusSpanInput): Span {
  return solusTracer().startSpan(
    input.name,
    {
      startTime: epochTime(input.startedAt),
      attributes: {
        [SPAN_ATTRS.kind]: input.kind,
        [SPAN_ATTRS.service]: input.service,
        ...dimensionAttributes(input.dimensions),
        ...input.attrs,
      },
    },
    input.parent ?? context.active(),
  )
}

export interface EndSolusSpanInput {
  /** Epoch milliseconds. */
  endedAt: number
  status: SpanStatus
  attrs?: SpanAttributes
  /** Dimensions the turn learned after the span started — the executed model a
   *  provider reported, the project a run resolved. */
  dimensions?: SpanDimensions
}

/** Ends a span with the status in Solus's vocabulary and OTel's at once. */
export function endSolusSpan(span: Span, input: EndSolusSpanInput): void {
  span.setAttributes({
    ...dimensionAttributes(input.dimensions),
    ...input.attrs,
    [SPAN_ATTRS.status]: input.status,
  })
  span.setStatus({
    code: input.status === 'error'
      ? SpanStatusCode.ERROR
      : input.status === 'ok'
        ? SpanStatusCode.OK
        // 'interrupted' and 'unknown' are absences rather than faults.
        : SpanStatusCode.UNSET,
  })
  span.end(epochTime(input.endedAt))
}
