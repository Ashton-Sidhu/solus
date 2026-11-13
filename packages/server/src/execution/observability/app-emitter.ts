import { ROOT_CONTEXT, context, trace, type Context, type Span } from '@opentelemetry/api'
import type { AppSpan } from '@solus/contracts/apps'
import type { AppCallFacts, AppCallTelemetry, AppTelemetry } from '../../apps/app-telemetry'
import { LOG_EVENT_ATTRS, SPAN_KINDS, SPAN_SERVICES, type SpanAttributes, type SpanDimensions } from '../../data/insights/registries'
import { recordOtelCount, recordOtelDuration } from '../../otel'
import { endSolusSpan, startSolusSpan } from './tracer'

/**
 * App calls as OpenTelemetry spans (docs/plans/apps.md §9.4).
 *
 *   app_call  <operation>          one call of an operation
 *     └─ app_work  GET api.x.com   each thing the call waited for
 *   app_run   <workflow>           one execution of a workflow's function
 *     ├─ app_work  <step>          each step
 *     └─ app_call  <operation>     the operation a step ran
 *
 * A span states its Solus facts with the names Insights reads (`appSlug`,
 * `caller`, `work`), and what OpenTelemetry has a convention for with that
 * convention's names (`code.function.name`, `http.request.method`,
 * `server.address`, `db.system.name`, `exception.*`), so a collector's own
 * views read an app's trace with no mapping.
 *
 * A line the app logged is an event of the call's span, in the form the
 * logger's own events have. The log level `log` of `console.log` is `info`.
 */

const LOG_FILE = 'app.ts'
const LOG_TAG = 'app'
const LOG_EVENT_NAME = 'app_log'

/** The spans of the runs whose function runs now, by run id: a step's operation is a child of its run. */
const openRuns = new Map<string, Span>()

/** Epoch milliseconds as OTel reads them (see `tracer.ts`). */
function epochTime(ms: number): [number, number] {
  return [Math.floor(ms / 1_000), Math.round((ms % 1_000) * 1e6)]
}

/** The span a call hangs off: its run for a step's operation; what is active here for an agent's call; else none. */
function parentOf(facts: AppCallFacts): Context {
  if (facts.caller.kind === 'workflow' && facts.caller.step) {
    const run = openRuns.get(facts.caller.runId)
    if (run) return trace.setSpan(ROOT_CONTEXT, run)
  }
  return facts.caller.kind === 'agent' ? context.active() : ROOT_CONTEXT
}

function callAttributes(facts: AppCallFacts): SpanAttributes {
  const attrs: SpanAttributes = {
    appId: facts.appId,
    appSlug: facts.appSlug,
    appVersion: facts.appVersion,
    operationKind: facts.operationKind,
    caller: facts.caller.kind,
    callId: facts.callId,
    'code.function.name': facts.operation,
  }
  if (facts.caller.kind === 'workflow') {
    attrs.runId = facts.caller.runId
    if (facts.caller.step) attrs.step = facts.caller.step
  }
  if (facts.caller.kind === 'schedule') attrs.schedule = facts.caller.name
  if (facts.caller.kind === 'webhook') attrs.webhookId = facts.caller.webhookId
  return attrs
}

function workAttributes(facts: AppCallFacts, work: AppSpan): SpanAttributes {
  const attrs: SpanAttributes = { appSlug: facts.appSlug, work: work.kind, ...work.attributes }
  if (work.detail !== undefined) attrs.detail = work.detail
  // OpenTelemetry names why an operation failed with `error.type`; the runner gives the reason as text.
  if (!work.ok && attrs['error.type'] === undefined) attrs['error.type'] = work.detail ?? 'error'
  return attrs
}

/** The tracer's side of an app's telemetry. `boot-server.ts` installs it. */
export const otelAppTelemetry: AppTelemetry = (facts) => {
  const isRun = facts.operationKind === 'workflow'
  const dimensions: SpanDimensions = { organizationId: facts.organizationId }
  // An agent's call belongs to its session, so Insights reads it beside the turn that made it.
  if (facts.caller.kind === 'agent' && facts.caller.sessionId) dimensions.sessionId = facts.caller.sessionId
  const span = startSolusSpan({
    kind: isRun ? SPAN_KINDS.appRun : SPAN_KINDS.appCall,
    name: facts.operation,
    service: SPAN_SERVICES.apps,
    startedAt: facts.startedAt,
    attrs: callAttributes(facts),
    dimensions,
    parent: parentOf(facts),
  })
  if (isRun && facts.caller.kind === 'workflow') openRuns.set(facts.caller.runId, span)
  const within = trace.setSpan(ROOT_CONTEXT, span)
  const { traceId, spanId } = span.spanContext()
  const call: AppCallTelemetry = {
    traceId,
    spanId,
    log(line) {
      span.addEvent(LOG_EVENT_NAME, {
        message: line.text,
        [LOG_EVENT_ATTRS.marker]: true,
        [LOG_EVENT_ATTRS.level]: line.level === 'log' ? 'info' : line.level,
        [LOG_EVENT_ATTRS.tag]: LOG_TAG,
        [LOG_EVENT_ATTRS.file]: LOG_FILE,
      }, epochTime(facts.startedAt + line.atMs))
    },
    work(work) {
      const startedAt = facts.startedAt + work.startMs
      const child = startSolusSpan({
        kind: SPAN_KINDS.appWork,
        name: work.name,
        service: SPAN_SERVICES.apps,
        startedAt,
        attrs: workAttributes(facts, work),
        dimensions: { organizationId: facts.organizationId },
        parent: within,
        isClientRequest: work.kind === 'fetch',
      })
      endSolusSpan(child, { endedAt: startedAt + work.durationMs, status: work.ok ? 'ok' : 'error' })
    },
    end(end) {
      if (isRun && facts.caller.kind === 'workflow' && openRuns.get(facts.caller.runId) === span) openRuns.delete(facts.caller.runId)
      const attrs: SpanAttributes = {}
      if (end.resultBytes !== null) attrs.resultBytes = end.resultBytes
      if (end.error) {
        attrs.error = end.error.message
        attrs['error.type'] = 'AppOperationError'
        span.recordException({ name: 'AppOperationError', message: end.error.message, stack: end.error.stack ?? undefined }, epochTime(end.endedAt))
      }
      endSolusSpan(span, { endedAt: end.endedAt, status: end.error ? 'error' : 'ok', attrs })
      const measured = { app: facts.appSlug, operation: facts.operation, operation_kind: facts.operationKind, caller: facts.caller.kind, outcome: end.error ? 'failed' : 'ok' }
      recordOtelDuration('app_call_duration', end.endedAt - facts.startedAt, measured)
      recordOtelCount('app_calls_total', measured)
    },
  }
  return call
}
