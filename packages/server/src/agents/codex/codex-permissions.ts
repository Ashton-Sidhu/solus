import { z } from 'zod'
import { CodexAppServerClient } from './codex-agent'
import type { CodexPendingServerRequest } from './codex-event-normalizer'
import type { PermissionResponder } from '../agent-backend'
import type { PermissionOption, QuestionItem } from '@solus/contracts/types'
import type {
  GrantedPermissionProfile,
  McpServerElicitationRequestResponse,
  PermissionsRequestApprovalParams,
  PermissionsRequestApprovalResponse,
} from './generated/v2'

const stringValueSchema = z.string()
const availableDecisionSchema = z.union([
  z.string(),
  z.object({
    accept: z.json().optional(),
    acceptForSession: z.json().optional(),
    accept_for_session: z.json().optional(),
    acceptWithExecpolicyAmendment: z.json().optional(),
    accept_with_execpolicy_amendment: z.json().optional(),
    decline: z.json().optional(),
    deny: z.json().optional(),
    cancel: z.json().optional(),
  }),
])
const networkApprovalContextSchema = z.object({
  host: z.string().min(1),
  protocol: z.string().optional(),
  port: z.union([z.string(), z.number()]).optional(),
})
const mcpVariantSchema = z.object({
  const: z.json().optional(),
  enum: z.array(z.json()).optional(),
  title: z.string().optional(),
  description: z.string().optional(),
})
const mcpPropertySchema = z.object({
  type: z.union([z.string(), z.array(z.string())]).optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  enum: z.array(z.json()).optional(),
  oneOf: z.array(mcpVariantSchema).optional(),
  anyOf: z.array(mcpVariantSchema).optional(),
})
const mcpSchemaSchema = z.object({
  properties: z.record(z.string(), mcpPropertySchema).optional(),
  required: z.array(z.string()).optional(),
})
const mcpPayloadSchema = z.object({
  mode: z.enum(['url', 'form']).optional(),
  message: z.string().optional(),
  url: z.string().optional(),
  elicitationId: z.string().optional(),
  requestedSchema: mcpSchemaSchema.optional(),
  schema: mcpSchemaSchema.optional(),
})
const questionOptionSchema = z.object({
  label: z.string().optional(),
  value: z.string().optional(),
  description: z.string().optional(),
  preview: z.string().optional(),
})
const questionSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  question: z.string().optional(),
  label: z.string().optional(),
  header: z.string().optional(),
  options: z.array(questionOptionSchema).optional(),
  multiSelect: z.boolean().optional(),
})

type McpProperty = z.infer<typeof mcpPropertySchema>
type McpAnswerValue = string | number | boolean | null
type RequestedPermissions = PermissionsRequestApprovalParams['permissions']
type CommandOrFileApprovalResponse =
  | CodexApprovalDecision
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } }
type ElicitationResponse = Omit<McpServerElicitationRequestResponse, '_meta'>
type PermissionResponse = PermissionsRequestApprovalResponse
type ApprovalResponse = CommandOrFileApprovalResponse | ElicitationResponse | PermissionResponse

function parsedString<Value>(value: Value): string | undefined {
  const parsed = stringValueSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export class CodexPermissionResponder implements PermissionResponder {
  private client: CodexAppServerClient
  private pending = new Map<string, CodexPendingServerRequest>()

  constructor(client: CodexAppServerClient) {
    this.client = client
  }

  add(questionId: string, req: CodexPendingServerRequest): void {
    this.pending.set(questionId, req)
  }

  getPendingInfo(questionId: string): { toolName: string; sessionId: string | null } | undefined {
    const req = this.pending.get(questionId)
    return req ? { toolName: req.method, sessionId: req.sessionId } : undefined
  }

  resolveServerRequest<RequestId>(serverRequestId: RequestId): { questionId: string; sessionId: string | null } | null {
    for (const [questionId, req] of this.pending) {
      if (req.id === serverRequestId || String(req.id) === String(serverRequestId)) {
        this.pending.delete(questionId)
        return { questionId, sessionId: req.sessionId }
      }
    }
    return null
  }

  respondToPermission(questionId: string, decision: string): boolean {
    const req = this.pending.get(questionId)
    if (!req) return false
    this.pending.delete(questionId)

    // Execute-after-approve entry (dynamicTools work-tool call): the handler
    // runs the tool and responds to the JSON-RPC request itself.
    if (req.execute) {
      void req.execute(isAllowDecision(normalizeDecision(decision)))
      return true
    }

    if (req.method === 'item/permissions/requestApproval') {
      const normalized = normalizeDecision(decision)
      this.client.respond(req.id, {
        permissions: isAllowDecision(normalized) ? grantedRequestedPermissions(req.params?.permissions) : {},
        scope: normalized === 'acceptForSession' ? 'session' : 'turn',
      })
      return true
    }

    const normalized = normalizeDecision(decision)
    this.client.respond(req.id, commandOrFileApprovalResponse(normalized, req.params))
    return true
  }

  respondToQuestion(questionId: string, answers: Record<string, string>): boolean {
    const req = this.pending.get(questionId)
    if (!req) return false
    this.pending.delete(questionId)
    if (req.method === 'mcpServer/elicitation/request') {
      this.client.respond(req.id, mcpElicitationResponse(req.params, answers))
      return true
    }
    const mapped: Record<string, { answers: string[] }> = {}
    for (const [key, value] of Object.entries(answers)) {
      mapped[key] = { answers: [value] }
    }
    this.client.respond(req.id, { answers: mapped })
    return true
  }

  clearPendingForSession(sessionId: string): void {
    for (const [questionId, req] of this.pending) {
      if (req.sessionId === sessionId) {
        this.pending.delete(questionId)
        if (req.execute) { void req.execute(false); continue }
        this.client.respond(req.id, cancellationResponse(req.method))
      }
    }
  }

  setCurrentSessionId(_sessionId: string): void {
  }
}

// ── Permission request helpers ──

export function permissionToolName(method: string, params: any): string {
  const network = networkApprovalContext(params)
  if (network) return network.port ? `Network: ${network.host}:${network.port}` : `Network: ${network.host}`
  if (method === 'item/commandExecution/requestApproval') return params.command ? `Bash: ${params.command}` : 'Bash'
  if (method === 'item/fileChange/requestApproval') return 'Edit'
  if (method === 'item/permissions/requestApproval') return 'Permissions'
  return 'Codex Tool'
}

export function permissionDescription(method: string, params: any): string | undefined {
  const network = networkApprovalContext(params)
  if (network) {
    const destination = `${network.protocol || 'network'}://${network.host}${network.port ? `:${network.port}` : ''}`
    return params.reason ? `${params.reason}\n${destination}` : `Allow managed network access to ${destination}`
  }
  if (method === 'item/fileChange/requestApproval') return params.reason || params.grantRoot || undefined
  return params.reason || params.command || undefined
}

export function permissionOptions(method: string, params: any): PermissionOption[] {
  const supportsSessionScope = method === 'item/permissions/requestApproval' || method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval'
  const available = Array.isArray(params?.availableDecisions) ? params.availableDecisions : null
  if (available?.length) {
    const seen = new Set<string>()
    const options: PermissionOption[] = []
    for (const decision of availableDecisionSchema.array().catch([]).parse(available)) {
      const rawId = availableDecisionId(decision)
      const id = normalizeDecision(rawId)
      if (seen.has(id)) continue
      seen.add(id)
      options.push({ id, label: labelForDecision(id), kind: isDenyDecision(id) ? 'deny' : 'allow' })
    }
    if (supportsSessionScope && !seen.has('acceptForSession')) {
      const denyIndex = options.findIndex((o) => isDenyDecision(o.id))
      const insertAt = denyIndex === -1 ? options.length : denyIndex
      options.splice(insertAt, 0, {
        id: 'acceptForSession',
        label: labelForDecision('acceptForSession'),
        kind: 'allow',
      })
    }
    if (method === 'item/commandExecution/requestApproval' && params?.proposedExecpolicyAmendment && !seen.has('acceptWithExecpolicyAmendment')) {
      const denyIndex = options.findIndex((o) => isDenyDecision(o.id))
      const insertAt = denyIndex === -1 ? options.length : denyIndex
      options.splice(insertAt, 0, {
        id: 'acceptWithExecpolicyAmendment',
        label: 'Allow matching commands',
        kind: 'allow',
      })
    }
    if (options.length > 0) return options
  }
  if (supportsSessionScope) {
    return [
      { id: 'accept', label: 'Allow', kind: 'allow' },
      { id: 'acceptForSession', label: 'Allow for session', kind: 'allow' },
      { id: 'decline', label: 'Deny', kind: 'deny' },
    ]
  }
  return [
    { id: 'accept', label: 'Allow', kind: 'allow' },
    { id: 'decline', label: 'Deny', kind: 'deny' },
  ]
}

export function autoApprovalResponse(method: string, params: any): ApprovalResponse {
  if (method === 'item/permissions/requestApproval') {
    return {
      permissions: grantedRequestedPermissions(params?.permissions),
      scope: 'turn',
    }
  }
  return commandOrFileApprovalResponse(autoApprovalDecision(params), params)
}

export function denialResponse(method: string): ApprovalResponse {
  if (method === 'mcpServer/elicitation/request') {
    return { action: 'decline', content: null }
  }
  if (method === 'item/permissions/requestApproval') {
    return { permissions: {}, scope: 'turn' }
  }
  return 'decline'
}

export function normalizeMcpElicitationRequest(params: any): {
  request: {
    kind: 'mcp_form' | 'mcp_url'
    message?: string
    url?: string
    serverName?: string
    canDecline: boolean
    canCancel: boolean
  }
  questions: QuestionItem[]
} | null {
  const payload = mcpElicitationPayload(params)
  const serverName = parsedString(params?.serverName)
  const message = payload?.message

  if (payload?.mode === 'url') {
    const url = payload.url
    return {
      request: {
        kind: 'mcp_url',
        message,
        url,
        serverName,
        canDecline: true,
        canCancel: true,
      },
      questions: [{
        id: '__url',
        question: message || 'Open this URL to continue.',
        header: serverName,
        options: [],
        multiSelect: false,
      }],
    }
  }

  if (payload?.mode !== 'form') return null

  const schema = payload.requestedSchema || payload.schema
  const properties = schema?.properties ?? {}
  const required = new Set(schema?.required ?? [])
  const entries = Object.entries(properties)
  const questions = entries.length > 0
    ? entries.map(([key, prop]) => {
      return {
        id: key,
        question: prop.title || prop.description || key,
        header: message,
        options: questionOptionsForSchema(prop),
        multiSelect: false,
      } satisfies QuestionItem
    })
    : [{
      id: 'input',
      question: message || 'Input',
      options: [],
      multiSelect: false,
    }]

  for (const q of questions) {
    if (q.id && required.has(q.id) && !q.question.endsWith('*')) q.question = `${q.question} *`
  }

  return {
    request: {
      kind: 'mcp_form',
      message,
      serverName,
      canDecline: true,
      canCancel: true,
    },
    questions,
  }
}

export function normalizeQuestionItems(params: any): QuestionItem[] {
  const parsed = z.array(questionSchema).safeParse(params?.questions)
  const questions = parsed.success ? parsed.data : []
  if (questions.length > 0) {
    return questions.map((q) => ({
      id: q.id || q.name,
      question: q.question || q.label || q.id || 'Input',
      header: q.header,
      options: (q.options ?? []).map((option) => ({
        label: option.label || option.value || 'Option',
        description: option.description,
        preview: option.preview,
      })),
      multiSelect: !!q.multiSelect,
    }))
  }
  return [{
    question: params?.prompt || params?.reason || 'Input',
    options: [],
    multiSelect: false,
  }]
}

// ── Internal helpers ──

type CodexApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel' | 'acceptWithExecpolicyAmendment'

function normalizeDecision(id: string): CodexApprovalDecision {
  if (['acceptForSession', 'accept_for_session', 'allow_session', 'allowForSession', 'grant_session'].includes(id)) {
    return 'acceptForSession'
  }
  if (['acceptWithExecpolicyAmendment', 'accept_with_execpolicy_amendment', 'allow_matching_commands'].includes(id)) {
    return 'acceptWithExecpolicyAmendment'
  }
  if (['cancel', 'abort'].includes(id)) return 'cancel'
  if (['decline', 'deny', 'reject', 'no'].includes(id)) return 'decline'
  return 'accept'
}

function availableDecisionId(decision: z.infer<typeof availableDecisionSchema>): string {
  const direct = parsedString(decision)
  if (direct) return direct
  return Object.keys(decision)[0] || 'accept'
}

function isAllowDecision(id: string): id is 'accept' | 'acceptForSession' | 'acceptWithExecpolicyAmendment' {
  return id === 'accept' || id === 'acceptForSession' || id === 'acceptWithExecpolicyAmendment'
}

function isDenyDecision(id: string): boolean {
  return id === 'decline' || id === 'cancel'
}

function labelForDecision(id: string): string {
  if (id === 'acceptForSession') return 'Allow for session'
  if (id === 'acceptWithExecpolicyAmendment') return 'Allow matching commands'
  if (id === 'decline') return 'Deny'
  if (id === 'cancel') return 'Cancel'
  return 'Allow'
}

function grantedRequestedPermissions(permissions: RequestedPermissions | null | undefined): GrantedPermissionProfile {
  if (!permissions) return {}
  const granted: GrantedPermissionProfile = {}
  if (permissions.network) granted.network = permissions.network
  if (permissions.fileSystem) granted.fileSystem = permissions.fileSystem
  return granted
}

function commandOrFileApprovalResponse(decision: CodexApprovalDecision, params: any): CommandOrFileApprovalResponse {
  if (decision === 'acceptWithExecpolicyAmendment') {
    return {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: execpolicyAmendment(params),
      },
    }
  }
  if (decision === 'accept' || decision === 'acceptForSession' || decision === 'cancel') {
    return decision
  }
  return 'decline'
}

function cancellationResponse(method: string): ApprovalResponse {
  if (method === 'mcpServer/elicitation/request') {
    return { action: 'cancel', content: null }
  }
  if (method === 'item/permissions/requestApproval') {
    return { permissions: {}, scope: 'turn' }
  }
  return 'cancel'
}

function execpolicyAmendment(params: any): string[] {
  const amendment = params?.proposedExecpolicyAmendment
  const direct = z.array(z.string()).safeParse(amendment)
  if (direct.success) return direct.data
  const nested = z.object({ execpolicy_amendment: z.array(z.string()) }).safeParse(amendment)
  if (nested.success) return nested.data.execpolicy_amendment
  return []
}

function autoApprovalDecision(params: any): 'accept' | 'acceptForSession' {
  const available = Array.isArray(params?.availableDecisions) ? params.availableDecisions : []
  for (const decision of availableDecisionSchema.array().catch([]).parse(available)) {
    const rawId = availableDecisionId(decision)
    const normalized = normalizeDecision(rawId)
    if (normalized === 'accept') return 'accept'
  }
  for (const decision of availableDecisionSchema.array().catch([]).parse(available)) {
    const rawId = availableDecisionId(decision)
    const normalized = normalizeDecision(rawId)
    if (normalized === 'acceptForSession') return 'acceptForSession'
  }
  return 'accept'
}

function networkApprovalContext(params: any): { host: string; protocol?: string; port?: string | number } | null {
  const parsed = networkApprovalContextSchema.safeParse(params?.networkApprovalContext)
  return parsed.success ? parsed.data : null
}

function mcpElicitationPayload(params: any): z.infer<typeof mcpPayloadSchema> | null {
  for (const candidate of [params?.request, params?.elicitation, params]) {
    const parsed = mcpPayloadSchema.safeParse(candidate)
    if (parsed.success) return parsed.data
  }
  return null
}

function mcpElicitationResponse(params: any, answers: Record<string, string>): ElicitationResponse {
  const action = mcpAction(answers.__action)
  if (action !== 'accept') return { action, content: null }

  const payload = mcpElicitationPayload(params)
  if (payload?.mode === 'url') {
    const content = payload?.elicitationId
      ? { elicitationId: payload.elicitationId }
      : null
    return { action: 'accept', content }
  }

  const schema = payload?.requestedSchema || payload?.schema
  const properties = schema?.properties ?? {}
  const required = new Set(schema?.required ?? [])
  const content = Object.fromEntries(Object.entries(answers).flatMap(([key, rawValue]) => {
    if (key === '__action') return []
    if (rawValue === '' && !required.has(key)) return []
    return [[key, coerceMcpValue(rawValue, properties[key])]]
  }))

  return { action: 'accept', content }
}

function mcpAction(value: string | undefined): 'accept' | 'decline' | 'cancel' {
  if (value === 'decline' || value === 'cancel') return value
  return 'accept'
}

function questionOptionsForSchema(prop: McpProperty): Array<{ label: string; description?: string; preview?: string }> {
  const variants = prop.oneOf ?? prop.anyOf ?? []
  const enumValues = prop.enum ?? variants
    .map((item) => item.const ?? item.enum?.[0])
    .filter((value) => value !== undefined)

  if (enumValues.length > 0) {
    return enumValues.map((value) => ({
      label: String(value),
      description: optionDescriptionForSchemaValue(prop, value),
    }))
  }

  if (schemaType(prop) === 'boolean') {
    return [
      { label: 'true', description: 'Yes' },
      { label: 'false', description: 'No' },
    ]
  }

  return []
}

function optionDescriptionForSchemaValue<Value>(prop: McpProperty, value: Value): string | undefined {
  const variants = prop.oneOf ?? prop.anyOf ?? []
  const match = variants.find((item) => item.const === value || item.enum?.[0] === value)
  return match?.title || match?.description
}

function coerceMcpValue(value: string, prop: McpProperty | undefined): McpAnswerValue {
  const type = schemaType(prop)
  if (type === 'boolean') {
    const normalized = value.trim().toLowerCase()
    return normalized === 'true' || normalized === 'yes' || normalized === '1'
  }
  if (type === 'number' || type === 'integer') {
    const numeric = Number(value)
    return Number.isFinite(numeric) ? numeric : value
  }
  if (type === 'null') return null
  return value
}

function schemaType(prop: McpProperty | undefined): string | undefined {
  const type = prop?.type
  if (Array.isArray(type)) return type.find((item) => item !== 'null')
  return type
}
