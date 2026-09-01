export const SPAN_KINDS = {
  turn: 'turn',
  setup: 'setup',
  thinking: 'thinking',
  responseStream: 'response_stream',
  toolCall: 'tool_call',
  toolInput: 'tool_input',
  toolExecution: 'tool_execution',
  permissionWait: 'permission_wait',
  questionWait: 'question_wait',
  contextCompaction: 'context_compaction',
  queueWait: 'queue_wait',
  rateLimitWait: 'rate_limit_wait',
  turnSettlement: 'turn_settlement',
  backgroundTask: 'background_task',
  agentRun: 'agent_run',
  browserLoad: 'browser_load',
  browserCapture: 'browser_capture',
  internalDispatchStep: 'internal.dispatch_step',
  internalRpc: 'internal.rpc',
  internalIndexerSweep: 'internal.indexer_sweep',
  internalWorktreeOp: 'internal.worktree_op',
} as const

export type SpanKind = (typeof SPAN_KINDS)[keyof typeof SPAN_KINDS]

export const SPAN_SERVICES = {
  sessions: 'solus.sessions',
  textGeneration: 'solus.text-generation',
  reviewGuide: 'solus.review-guide',
  subagents: 'solus.subagents',
  automations: 'solus.automations',
  indexer: 'solus.indexer',
  rpc: 'solus.rpc',
  git: 'solus.git',
  insights: 'solus.insights',
  browser: 'solus.browser',
} as const

export type SpanService = (typeof SPAN_SERVICES)[keyof typeof SPAN_SERVICES]

/**
 * The attribute names that carry Solus's typed columns through OTel.
 *
 * A `Tracer` knows one flat attribute bag; `spans` knows kinds, services,
 * statuses and promoted dimensions. These keys are how a span states them, and
 * the SQLite exporter reads them back out into columns rather than leaving them
 * in `attrs`. They ride along to OTLP too, so a collector sees the same facts
 * Insights groups by.
 */
export const SPAN_ATTRS = {
  kind: 'solus.kind',
  service: 'solus.service',
  /** Solus's four-value status; OTel's own status has no 'interrupted'. */
  status: 'solus.status',
  sessionId: 'solus.session_id',
  provider: 'solus.provider',
  model: 'solus.model',
  projectRoot: 'solus.project_root',
  origin: 'solus.origin',
} as const

/** Metadata carried by a structured logger emission when it is attached to the
 * active span. The marker separates logger events from other OTel span events;
 * the SQLite exporter persists only events that state this contract. */
export const LOG_EVENT_ATTRS = {
  marker: 'solus.log_event',
  level: 'log.level',
  tag: 'solus.log_tag',
  file: 'code.filepath',
} as const

export function isLogEventMetadataAttr(key: string): boolean {
  return Object.values(LOG_EVENT_ATTRS).some((attribute) => attribute === key)
}

/** True for a key the exporter promotes to a column, so it must not be repeated
 *  inside the `attrs` JSON. */
export function isSpanColumnAttr(key: string): boolean {
  return key.startsWith('solus.')
}

/** How a span ended. OTel carries UNSET/OK/ERROR; a turn the user stopped is
 *  neither a success nor a fault, so Solus keeps its own four. */
export type SpanStatus = 'ok' | 'error' | 'interrupted' | 'unknown'

export type SpanAttributeValue = string | number | boolean
export type SpanAttributes = Record<string, SpanAttributeValue>

/** The facts promoted out of the attribute bag into `spans` columns, and the
 *  ones every Insights question slices by. */
export interface SpanDimensions {
  sessionId?: string
  provider?: string
  model?: string
  projectRoot?: string
  origin?: string
}

const registeredKinds = new Set<string>(Object.values(SPAN_KINDS))
const registeredServices = new Set<string>(Object.values(SPAN_SERVICES))

export function assertRegisteredSpanKind(kind: string): asserts kind is SpanKind {
  if (!registeredKinds.has(kind)) throw new Error(`Unregistered span kind: ${kind}`)
}

export function assertRegisteredSpanService(service: string): asserts service is SpanService {
  if (!registeredServices.has(service)) throw new Error(`Unregistered span service: ${service}`)
}
