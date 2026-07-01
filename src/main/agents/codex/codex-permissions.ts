import { CodexAppServerClient } from './codex-agent'
import type { CodexPendingServerRequest } from './codex-event-normalizer'
import type { PermissionResponder } from '../agent-backend'
import type { PermissionOption, QuestionItem } from '../../../shared/types'

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

  resolveServerRequest(serverRequestId: unknown): { questionId: string; sessionId: string | null } | null {
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
    for (const d of available) {
      const rawId = typeof d === 'string' ? d : Object.keys(d)[0] || 'accept'
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

export function autoApprovalResponse(method: string, params: any): unknown {
  if (method === 'item/permissions/requestApproval') {
    return {
      permissions: grantedRequestedPermissions(params?.permissions),
      scope: 'turn',
    }
  }
  return commandOrFileApprovalResponse(autoApprovalDecision(params), params)
}

export function denialResponse(method: string): unknown {
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
  const serverName = typeof params?.serverName === 'string' ? params.serverName : undefined
  const message = typeof payload?.message === 'string' ? payload.message : undefined

  if (payload?.mode === 'url') {
    const url = typeof payload.url === 'string' ? payload.url : undefined
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

  const schema = payload.requestedSchema || payload.schema || {}
  const properties = schema && typeof schema.properties === 'object' ? schema.properties : {}
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : [])
  const entries = Object.entries(properties)
  const questions = entries.length > 0
    ? entries.map(([key, raw]) => {
      const prop = raw && typeof raw === 'object' ? raw as any : {}
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
  const questions = Array.isArray(params?.questions) ? params.questions : []
  if (questions.length > 0) {
    return questions.map((q: any) => ({
      id: q.id || q.name,
      question: q.question || q.label || q.id || 'Input',
      header: q.header,
      options: Array.isArray(q.options) ? q.options.map((o: any) => ({
        label: o.label || o.value || String(o),
        description: o.description,
        preview: o.preview,
      })) : [],
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

function grantedRequestedPermissions(permissions: any): Record<string, unknown> {
  if (!permissions || typeof permissions !== 'object') return {}
  return { ...permissions }
}

function commandOrFileApprovalResponse(decision: CodexApprovalDecision, params: any): unknown {
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

function cancellationResponse(method: string): unknown {
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
  if (Array.isArray(amendment)) return amendment.map(String)
  const nested = amendment?.execpolicy_amendment
  if (Array.isArray(nested)) return nested.map(String)
  return []
}

function autoApprovalDecision(params: any): 'accept' | 'acceptForSession' {
  const available = Array.isArray(params?.availableDecisions) ? params.availableDecisions : []
  for (const decision of available) {
    const rawId = typeof decision === 'string' ? decision : Object.keys(decision)[0] || ''
    const normalized = normalizeDecision(rawId)
    if (normalized === 'accept') return 'accept'
  }
  for (const decision of available) {
    const rawId = typeof decision === 'string' ? decision : Object.keys(decision)[0] || ''
    const normalized = normalizeDecision(rawId)
    if (normalized === 'acceptForSession') return 'acceptForSession'
  }
  return 'accept'
}

function networkApprovalContext(params: any): { host: string; protocol?: string; port?: string | number } | null {
  const ctx = params?.networkApprovalContext
  if (!ctx || typeof ctx !== 'object' || typeof ctx.host !== 'string' || !ctx.host) return null
  return {
    host: ctx.host,
    protocol: typeof ctx.protocol === 'string' ? ctx.protocol : undefined,
    port: typeof ctx.port === 'string' || typeof ctx.port === 'number' ? ctx.port : undefined,
  }
}

function mcpElicitationPayload(params: any): any {
  if (params?.request && typeof params.request === 'object') return params.request
  if (params?.elicitation && typeof params.elicitation === 'object') return params.elicitation
  return params
}

function mcpElicitationResponse(params: any, answers: Record<string, string>): unknown {
  const action = mcpAction(answers.__action)
  if (action !== 'accept') return { action, content: null }

  const payload = mcpElicitationPayload(params)
  if (payload?.mode === 'url') {
    const content = typeof payload?.elicitationId === 'string'
      ? { elicitationId: payload.elicitationId }
      : null
    return { action: 'accept', content }
  }

  const schema = payload?.requestedSchema || payload?.schema || {}
  const properties = schema && typeof schema.properties === 'object' ? schema.properties : {}
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : [])
  const content: Record<string, unknown> = {}

  for (const [key, rawValue] of Object.entries(answers)) {
    if (key === '__action') continue
    if (rawValue === '' && !required.has(key)) continue
    const prop = properties[key]
    content[key] = coerceMcpValue(rawValue, prop)
  }

  return { action: 'accept', content }
}

function mcpAction(value: string | undefined): 'accept' | 'decline' | 'cancel' {
  if (value === 'decline' || value === 'cancel') return value
  return 'accept'
}

function questionOptionsForSchema(prop: any): Array<{ label: string; description?: string; preview?: string }> {
  const enumValues = Array.isArray(prop?.enum)
    ? prop.enum
    : Array.isArray(prop?.oneOf)
      ? prop.oneOf.map((item: any) => item?.const ?? item?.enum?.[0]).filter((value: unknown) => value !== undefined)
      : Array.isArray(prop?.anyOf)
        ? prop.anyOf.map((item: any) => item?.const ?? item?.enum?.[0]).filter((value: unknown) => value !== undefined)
        : []

  if (enumValues.length > 0) {
    return enumValues.map((value: unknown) => ({
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

function optionDescriptionForSchemaValue(prop: any, value: unknown): string | undefined {
  const variants = Array.isArray(prop?.oneOf) ? prop.oneOf : Array.isArray(prop?.anyOf) ? prop.anyOf : []
  const match = variants.find((item: any) => item?.const === value || item?.enum?.[0] === value)
  return match?.title || match?.description
}

function coerceMcpValue(value: unknown, prop: any): unknown {
  const type = schemaType(prop)
  if (type === 'boolean') {
    if (value === true || value === false) return value
    const normalized = String(value).trim().toLowerCase()
    return normalized === 'true' || normalized === 'yes' || normalized === '1'
  }
  if (type === 'number' || type === 'integer') {
    const numeric = Number(value)
    return Number.isFinite(numeric) ? numeric : value
  }
  if (type === 'null') return null
  return value
}

function schemaType(prop: any): string | undefined {
  const type = prop?.type
  if (Array.isArray(type)) return type.find((item) => item !== 'null')
  return typeof type === 'string' ? type : undefined
}
