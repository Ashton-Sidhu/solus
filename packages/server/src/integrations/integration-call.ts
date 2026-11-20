import { z } from 'zod'
import type { CallToolRequest, ElicitRequest, ElicitResult } from '@modelcontextprotocol/client'
import type { Context } from '@opentelemetry/api'
import { ACCOUNT_INPUT, type Integration, type IntegrationConnection } from '@solus/contracts/integration-types'
import type { AgentToolContext, AgentToolResult } from '../execution/agents/tools/agent-tool'
import { mcpElicitResult, mcpElicitationResponse, normalizeMcpElicitationRequest } from '../execution/agents/codex/codex-permissions'
import { answerToolQuestionWith } from '../execution/sessions/input-requests'
import { SPAN_KINDS, SPAN_SERVICES, type SpanDimensions, type SpanStatus } from '../data/insights/registries'
import { startSolusSpan, w3cTraceparent } from '../execution/observability/tracer'
import type { ActiveCall, ToolArguments } from './upstream-session'

/**
 * The parts of one `tools/call` that do not need the gateway's sessions
 * (docs/plans/mcp-first-class.md §5, §13, §13.3): the request with its trace
 * context, the call's span, the account a call names, and the question a
 * server asks during the call. `IntegrationGateway.callAs` runs the call.
 */

/** Where a turn's span hangs: `SessionEmitter.turnContextOf`. */
export type TurnContextOf = (sessionId: string, toolUseId?: string) => { context: Context; dimensions: SpanDimensions } | undefined

export interface CallSpan {
  span: ReturnType<typeof startSolusSpan>
  traceparent: string
}

/**
 * The `integration_call` span of a call that a turn made (§13), under the
 * tool call's span. A call outside a turn has none and sends no trace context.
 */
export function startCallSpan(turnContextOf: TurnContextOf | null, integration: Pick<Integration, 'slug'>, tool: string, context: AgentToolContext): CallSpan | null {
  const sessionId = context.sessionId()
  const turn = sessionId ? turnContextOf?.(sessionId, context.parentToolUseId()) : undefined
  if (!turn) return null
  const span = startSolusSpan({
    kind: SPAN_KINDS.integrationCall,
    name: tool,
    service: SPAN_SERVICES.sessions,
    startedAt: Date.now(),
    attrs: { 'mcp.method.name': 'tools/call', 'gen_ai.tool.name': tool, integration: integration.slug },
    dimensions: turn.dimensions,
    parent: turn.context,
    isClientRequest: true,
  })
  return { span, traceparent: w3cTraceparent(span) }
}

/** A `tools/call` request. A call of a turn carries only `traceparent` (§13); never `tracestate` or `baggage`. */
export function callRequest(tool: string, input: ToolArguments, trace: { traceparent: string } | null): CallToolRequest['params'] {
  const request: CallToolRequest['params'] = { name: tool, arguments: input }
  if (trace) request._meta = { traceparent: trace.traceparent }
  return request
}

/** How an `integration_call` span ends: the result's outcome, a stop, or a failure with no result. */
export function callSpanStatus(ended: AgentToolResult | null, context: AgentToolContext): SpanStatus {
  if (ended) return ended.ok ? 'ok' : 'error'
  return context.abortSignal.aborted ? 'interrupted' : 'error'
}

/** What a person calls an account: the identity its server reported, else its id. */
export function accountLabel(connection: Pick<IntegrationConnection, 'label' | 'accountId'>): string {
  return connection.label ?? connection.accountId
}

/** The account Solus's input names, and the arguments the server takes. */
interface AccountCall {
  /** The account label or id the call named, or null. */
  account: string | null
  args: ToolArguments
}

export function splitAccount(input: ToolArguments): AccountCall {
  if (!input || !Object.hasOwn(input, ACCOUNT_INPUT)) return { account: null, args: input }
  const { [ACCOUNT_INPUT]: account, ...args } = input
  const named = z.string().min(1).safeParse(account)
  return { account: named.success ? named.data : null, args }
}

type ElicitationAnswers = Parameters<typeof mcpElicitationResponse>[1]

/** Asks the person behind the newest call, as Codex's elicitation does (codex-permissions.ts). */
export async function elicitFromCall(call: ActiveCall | undefined, request: ElicitRequest): Promise<ElicitResult> {
  if (!call) return { action: 'decline' }
  const params = { ...request.params, mode: request.params.mode ?? 'form', serverName: call.integrationName }
  const normalized = normalizeMcpElicitationRequest(params)
  if (!normalized) return { action: 'decline' }
  const questionId = `integration-${crypto.randomUUID()}`
  call.pauseTimeout()
  try {
    const answers = await new Promise<ElicitationAnswers | null>((resolve) => {
      const stop = answerToolQuestionWith(questionId, (answered) => { stop(); resolve(answered) })
      const signal = call.context.abortSignal
      if (signal.aborted) { stop(); resolve(null); return }
      signal.addEventListener('abort', () => { stop(); resolve(null) }, { once: true })
      call.context.emit({ type: 'question_request', questionId, questions: normalized.questions, ...normalized.request })
    })
    if (!answers) return { action: 'cancel' }
    call.context.emit({ type: 'permission_resolved', questionId })
    return mcpElicitResult(mcpElicitationResponse(params, answers))
  } finally {
    call.resumeTimeout()
  }
}
