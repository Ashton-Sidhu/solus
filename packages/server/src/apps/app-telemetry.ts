import type { AppCaller, AppLogLine, AppSpan } from '@solus/contracts/apps'

/**
 * An app's telemetry as OpenTelemetry (docs/plans/apps.md §9.4). Apps is an
 * emitter, not an owner, as the browser domain is (`browser/browser-emitter.ts`):
 * it says what a call did, and the host's one tracer decides where that goes:
 * `metrics.db` always, and a collector when the owner turned export on.
 *
 * The tracer is installed, not imported: it reaches `metrics.db`, and the apps
 * domain must run on a host, or in a test, that has no tracer.
 */

/** What one call or one execution of a workflow's function is, for its span. */
export interface AppCallFacts {
  /** The id of the row in the app's call log. */
  callId: string
  appId: string
  appSlug: string
  appVersion: number
  organizationId: string
  /** The operation, or the workflow for an execution of its function. */
  operation: string
  operationKind: 'query' | 'mutation' | 'workflow'
  caller: AppCaller
  startedAt: number
}

/** How a call ended. */
export interface AppCallEnd {
  endedAt: number
  /** The failure; absent for a call that succeeded. */
  error?: { message: string; stack: string | null }
  resultBytes: number | null
}

/** The span of one call in progress. */
export interface AppCallTelemetry {
  /** The W3C trace id and span id of the call; null on a host with no tracer. */
  traceId: string | null
  spanId: string | null
  /** One line the app's code logged: an event of the call's span. */
  log(line: AppLogLine): void
  /** One thing the call waited for: a child span, with the times the runner measured. */
  work(span: AppSpan): void
  end(end: AppCallEnd): void
}

export type AppTelemetry = (facts: AppCallFacts) => AppCallTelemetry

const NO_TELEMETRY: AppCallTelemetry = { traceId: null, spanId: null, log: () => {}, work: () => {}, end: () => {} }

let telemetry: AppTelemetry | null = null

/** Installed once at boot, by the process that has the tracer. */
export function setAppTelemetry(next: AppTelemetry | null): void {
  telemetry = next
}

/** Starts the span of one call. A tracer that fails must not fail the call. */
export function startAppCallTelemetry(facts: AppCallFacts): AppCallTelemetry {
  if (!telemetry) return NO_TELEMETRY
  try {
    return telemetry(facts)
  } catch {
    return NO_TELEMETRY
  }
}
