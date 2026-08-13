export {
  endSpan,
  rolloverSpans,
  startSpan,
  writeSpan,
  type CompleteSpanInput,
  type FinalizeSpanInput,
  type SpanAttributeValue,
  type SpanAttributes,
  type SpanDimensions,
  type SpanStatus,
  type StartSpanInput,
} from './facade'
export { SPAN_KINDS, SPAN_SERVICES, type SpanKind, type SpanService } from './registries'
export { SessionEmitter, type TurnDimensions, type TurnOutcome } from './session-emitter'
export { createMetricsViews, fieldsForKind, metricsSchema, viewNameForKind } from './field-registry'
export { compileQuerySpec, type CompiledQuery } from './query-compiler'
export { runCompiledSql, runGuardedSql, sqlGuardError, validateMetricsSql } from './sql-guard'
export { sessionSummary, turnTrace } from './rollups'
