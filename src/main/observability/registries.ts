export const SPAN_KINDS = {
  turn: 'turn',
  setup: 'setup',
  thinking: 'thinking',
  responseStream: 'response_stream',
  toolCall: 'tool_call',
  permissionWait: 'permission_wait',
  queueWait: 'queue_wait',
  rateLimitWait: 'rate_limit_wait',
  turnSettlement: 'turn_settlement',
  backgroundTask: 'background_task',
  agentRun: 'agent_run',
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
} as const

export type SpanService = (typeof SPAN_SERVICES)[keyof typeof SPAN_SERVICES]

const registeredKinds = new Set<string>(Object.values(SPAN_KINDS))
const registeredServices = new Set<string>(Object.values(SPAN_SERVICES))

export function assertRegisteredSpanKind(kind: string): asserts kind is SpanKind {
  if (!registeredKinds.has(kind)) throw new Error(`Unregistered span kind: ${kind}`)
}

export function assertRegisteredSpanService(service: string): asserts service is SpanService {
  if (!registeredServices.has(service)) throw new Error(`Unregistered span service: ${service}`)
}
