import {
  SECRET_SCHEMES,
  WEBHOOK_MAX_ACTIONS,
  WEBHOOK_MAX_FILTERS,
  webhookActionSchema,
  webhookVerificationSchema,
  type Webhook,
  type WebhookAction,
  type WebhookActionType,
  type WebhookCreateInput,
  type WebhookFilter,
  type WebhookUpdateInput,
  type WebhookValueSource,
  type WebhookVerification,
  type WebhookVerificationInput,
  type WebhookVerificationScheme,
} from '@solus/contracts/webhooks'

/**
 * The webhook editor's draft (docs/plans/webhooks.md §3.6, §3.7): plain text
 * fields with no defaults. An empty choice stays empty until the user picks one,
 * so a save never sends a value the user did not choose. Secrets are never read
 * back: an empty secret field on an update keeps the stored secret when the
 * scheme stays the same.
 */

export type FilterOp = WebhookFilter['op']
export type ReasoningEffort = Extract<WebhookAction, { type: 'start_session' }>['reasoningEffort']
export type AgentProvider = Extract<WebhookAction, { type: 'start_session' }>['agentProvider']

export interface ValueSourceDraft {
  kind: '' | WebhookValueSource['kind']
  name: string
  key: string
  separator: '' | ',' | ';'
}

export interface VerificationDraft {
  scheme: '' | WebhookVerificationScheme
  algorithm: string
  /** Typed by the user in this edit only; never filled from the host. */
  secret: string
  secretEncoding: '' | 'text' | 'base64'
  publicKey: string
  signedText: string
  signatureSource: ValueSourceDraft
  signatureEncoding: '' | 'hex' | 'base64'
  signaturePrefix: string
  signatureListSeparator: string
  hasTimestamp: boolean
  timestampSource: ValueSourceDraft
  timestampTolerance: string
  /** The value source of the `token` and `jwt` schemes. */
  source: ValueSourceDraft
  issuer: string
  audience: string
  jwksUrl: string
  reason: string
}

export interface FilterDraft {
  path: string
  op: '' | FilterOp
  /** One value, or for `in` several values separated by commas. */
  value: string
}

export interface ActionDraft {
  id: string
  type: '' | WebhookActionType
  enabled: boolean
  filters: FilterDraft[]
  template: string
  agentProvider: '' | AgentProvider
  modelId: string
  reasoningEffort: '' | ReasoningEffort
  cwd: string
  useWorktree: boolean
  sessionId: string
  automationId: string
}

export interface WebhookDraft {
  name: string
  project: string
  enabled: boolean
  verification: VerificationDraft
  replayKey: string
  actions: ActionDraft[]
}

export type DraftResult<T> = { ok: true; value: T } | { ok: false; error: string }

export const FILTER_OPS: readonly FilterOp[] = ['equals', 'notEquals', 'in', 'exists']
export const SCHEMES: readonly WebhookVerificationScheme[] = ['hmac', 'public_key', 'token', 'jwt', 'standard_webhooks', 'none']
export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode']
export const HMAC_ALGORITHMS = ['sha256', 'sha1', 'sha512'] as const
export const PUBLIC_KEY_ALGORITHMS = ['ed25519', 'ecdsa-p256'] as const
export const UNVERIFIED_WARNING = 'No verification. Anyone with this URL can start agent work.'

export function schemeLabel(scheme: WebhookVerificationScheme): string {
  switch (scheme) {
    case 'hmac': return 'HMAC signature'
    case 'public_key': return 'Public key signature'
    case 'token': return 'Shared token'
    case 'jwt': return 'Signed JWT'
    case 'standard_webhooks': return 'Standard Webhooks'
    case 'none': return 'This sender accepts only a URL'
  }
}

export function filterOpLabel(op: FilterOp): string {
  switch (op) {
    case 'equals': return 'equals'
    case 'notEquals': return 'does not equal'
    case 'in': return 'is one of'
    case 'exists': return 'exists'
  }
}

export function needsSecret(scheme: '' | WebhookVerificationScheme): boolean {
  return scheme !== '' && SECRET_SCHEMES.includes(scheme)
}

function emptySource(): ValueSourceDraft {
  return { kind: '', name: '', key: '', separator: '' }
}

function sourceDraft(source: WebhookValueSource): ValueSourceDraft {
  if (source.kind === 'bearer') return { ...emptySource(), kind: 'bearer' }
  if (source.kind === 'header') return { ...emptySource(), kind: 'header', name: source.name }
  return { kind: 'header_part', name: source.name, key: source.key, separator: source.separator }
}

export function emptyVerificationDraft(): VerificationDraft {
  return {
    scheme: '',
    algorithm: '',
    secret: '',
    secretEncoding: '',
    publicKey: '',
    signedText: '',
    signatureSource: emptySource(),
    signatureEncoding: '',
    signaturePrefix: '',
    signatureListSeparator: '',
    hasTimestamp: false,
    timestampSource: emptySource(),
    timestampTolerance: '',
    source: emptySource(),
    issuer: '',
    audience: '',
    jwksUrl: '',
    reason: '',
  }
}

function verificationDraft(verification: WebhookVerification): VerificationDraft {
  const draft = emptyVerificationDraft()
  draft.scheme = verification.scheme
  switch (verification.scheme) {
    case 'hmac':
    case 'public_key':
      draft.algorithm = verification.algorithm
      if (verification.scheme === 'public_key') draft.publicKey = verification.publicKey
      draft.signedText = verification.signedText
      draft.signatureSource = sourceDraft(verification.signature.source)
      draft.signatureEncoding = verification.signature.format.encoding
      draft.signaturePrefix = verification.signature.format.prefix ?? ''
      draft.signatureListSeparator = verification.signature.format.listSeparator ?? ''
      if (verification.timestamp) {
        draft.hasTimestamp = true
        draft.timestampSource = sourceDraft(verification.timestamp.source)
        draft.timestampTolerance = String(verification.timestamp.toleranceSeconds)
      }
      break
    case 'token':
      draft.source = sourceDraft(verification.source)
      break
    case 'jwt':
      draft.source = sourceDraft(verification.source)
      draft.issuer = verification.issuer
      draft.audience = verification.audience
      draft.jwksUrl = verification.jwksUrl
      break
    case 'none':
      draft.reason = verification.reason
      break
    case 'standard_webhooks':
      break
  }
  return draft
}

export function emptyActionDraft(id: string): ActionDraft {
  return {
    id,
    type: '',
    enabled: true,
    filters: [],
    template: '',
    agentProvider: '',
    modelId: '',
    reasoningEffort: '',
    cwd: '',
    useWorktree: false,
    sessionId: '',
    automationId: '',
  }
}

function filterDraft(filter: WebhookFilter): FilterDraft {
  if (filter.op === 'in') return { path: filter.path, op: 'in', value: filter.values.join(', ') }
  if (filter.op === 'exists') return { path: filter.path, op: 'exists', value: '' }
  return { path: filter.path, op: filter.op, value: filter.value }
}

function actionDraft(action: WebhookAction): ActionDraft {
  const draft = emptyActionDraft(action.id)
  draft.type = action.type
  draft.enabled = action.enabled
  draft.filters = action.filters.map(filterDraft)
  draft.template = action.template
  if (action.type === 'start_session') {
    draft.agentProvider = action.agentProvider
    draft.modelId = action.modelId ?? ''
    draft.reasoningEffort = action.reasoningEffort
    draft.cwd = action.cwd
    draft.useWorktree = action.useWorktree === true
  } else if (action.type === 'send_to_session') {
    draft.sessionId = action.sessionId
  } else {
    draft.automationId = action.automationId
  }
  return draft
}

export function newWebhookDraft(project: string | null, newActionId: string): WebhookDraft {
  return {
    name: '',
    project: project ?? '',
    enabled: true,
    verification: emptyVerificationDraft(),
    replayKey: '',
    actions: [emptyActionDraft(newActionId)],
  }
}

export function draftFromWebhook(webhook: Webhook): WebhookDraft {
  return {
    name: webhook.name,
    project: webhook.project ?? '',
    enabled: webhook.enabled,
    verification: verificationDraft(webhook.verification),
    replayKey: webhook.replayKey ?? '',
    actions: webhook.actions.map(actionDraft),
  }
}

// ─── Draft to input ───

function sourceFromDraft(draft: ValueSourceDraft, what: string): DraftResult<WebhookValueSource> {
  if (draft.kind === 'bearer') return { ok: true, value: { kind: 'bearer' } }
  if (draft.kind === '') return { ok: false, error: `Choose where the ${what} comes from.` }
  const name = draft.name.trim()
  if (!name) return { ok: false, error: `Enter the header name of the ${what}.` }
  if (draft.kind === 'header') return { ok: true, value: { kind: 'header', name } }
  const key = draft.key.trim()
  if (!key || draft.separator === '') return { ok: false, error: `Enter the part key and the separator of the ${what}.` }
  return { ok: true, value: { kind: 'header_part', name, key, separator: draft.separator } }
}

function signedCheckFields(draft: VerificationDraft): DraftResult<Pick<Extract<WebhookVerification, { scheme: 'hmac' }>, 'signedText' | 'signature' | 'timestamp'>> {
  const signatureSource = sourceFromDraft(draft.signatureSource, 'signature')
  if (!signatureSource.ok) return signatureSource
  if (draft.signatureEncoding === '') return { ok: false, error: 'Choose the signature encoding.' }
  const format: Extract<WebhookVerification, { scheme: 'hmac' }>['signature']['format'] = { encoding: draft.signatureEncoding }
  if (draft.signaturePrefix) format.prefix = draft.signaturePrefix
  if (draft.signatureListSeparator) format.listSeparator = draft.signatureListSeparator
  const value: Pick<Extract<WebhookVerification, { scheme: 'hmac' }>, 'signedText' | 'signature' | 'timestamp'> = {
    signedText: draft.signedText,
    signature: { source: signatureSource.value, format },
  }
  if (draft.hasTimestamp) {
    const timestampSource = sourceFromDraft(draft.timestampSource, 'timestamp')
    if (!timestampSource.ok) return timestampSource
    const toleranceSeconds = Number(draft.timestampTolerance)
    if (!Number.isInteger(toleranceSeconds) || toleranceSeconds < 1 || toleranceSeconds > 86_400) {
      return { ok: false, error: 'Enter a timestamp tolerance from 1 to 86400 seconds.' }
    }
    value.timestamp = { source: timestampSource.value, toleranceSeconds }
  }
  return { ok: true, value }
}

function verificationCandidate(draft: VerificationDraft): DraftResult<WebhookVerification> {
  switch (draft.scheme) {
    case '': return { ok: false, error: 'Choose how Solus verifies requests.' }
    case 'hmac':
    case 'public_key': {
      const fields = signedCheckFields(draft)
      if (!fields.ok) return fields
      if (draft.scheme === 'hmac') {
        const algorithm = HMAC_ALGORITHMS.find((choice) => choice === draft.algorithm)
        return algorithm ? { ok: true, value: { scheme: 'hmac', algorithm, ...fields.value } } : { ok: false, error: 'Choose the algorithm.' }
      }
      const algorithm = PUBLIC_KEY_ALGORITHMS.find((choice) => choice === draft.algorithm)
      return algorithm
        ? { ok: true, value: { scheme: 'public_key', algorithm, publicKey: draft.publicKey.trim(), ...fields.value } }
        : { ok: false, error: 'Choose the algorithm.' }
    }
    case 'token': {
      const source = sourceFromDraft(draft.source, 'token')
      return source.ok ? { ok: true, value: { scheme: 'token', source: source.value } } : source
    }
    case 'jwt': {
      const source = sourceFromDraft(draft.source, 'token')
      if (!source.ok) return source
      return { ok: true, value: { scheme: 'jwt', source: source.value, issuer: draft.issuer.trim(), audience: draft.audience.trim(), jwksUrl: draft.jwksUrl.trim() } }
    }
    case 'standard_webhooks': return { ok: true, value: { scheme: 'standard_webhooks' } }
    case 'none': return { ok: true, value: { scheme: 'none', reason: draft.reason.trim() } }
  }
}

function verificationError(scheme: WebhookVerificationScheme): string {
  switch (scheme) {
    case 'hmac': return 'Choose the algorithm and enter the signed text.'
    case 'public_key': return 'Choose the algorithm and enter the public key and the signed text.'
    case 'jwt': return 'Enter the issuer, the audience, and a valid JWKS URL.'
    case 'none': return 'Name the sender and say why it cannot sign or send a header (10 to 500 characters).'
    default: return 'Check the verification fields.'
  }
}

/**
 * The verification to send. `storedScheme` is the saved scheme on an update, or
 * null on a create: a secret scheme needs a typed secret unless the saved one
 * has the same scheme.
 */
export function verificationFromDraft(draft: VerificationDraft, storedScheme: WebhookVerificationScheme | null): DraftResult<WebhookVerificationInput> {
  const candidate = verificationCandidate(draft)
  if (!candidate.ok) return candidate
  const parsed = webhookVerificationSchema.safeParse(candidate.value)
  if (!parsed.success) return { ok: false, error: verificationError(candidate.value.scheme) }
  if (!needsSecret(draft.scheme)) return { ok: true, value: parsed.data }
  if (!draft.secret) {
    return storedScheme === draft.scheme ? { ok: true, value: parsed.data } : { ok: false, error: 'Enter the secret.' }
  }
  const input: WebhookVerificationInput = { ...parsed.data, secret: draft.secret }
  if (draft.secretEncoding) input.secretEncoding = draft.secretEncoding
  return { ok: true, value: input }
}

function filterFromDraft(draft: FilterDraft): WebhookFilter | null {
  const path = draft.path.trim()
  if (!path || draft.op === '') return null
  if (draft.op === 'exists') return { path, op: 'exists' }
  if (draft.op === 'in') {
    const values = draft.value.split(',').map((value) => value.trim()).filter(Boolean)
    return values.length > 0 ? { path, op: 'in', values } : null
  }
  return { path, op: draft.op, value: draft.value }
}

function actionCandidate(draft: ActionDraft, filters: WebhookFilter[]): WebhookAction | null {
  const base = { id: draft.id, enabled: draft.enabled, filters, template: draft.template }
  switch (draft.type) {
    case '': return null
    case 'start_session':
      if (draft.agentProvider === '' || draft.reasoningEffort === '') return null
      return {
        ...base,
        type: 'start_session',
        agentProvider: draft.agentProvider,
        modelId: draft.modelId.trim() || null,
        reasoningEffort: draft.reasoningEffort,
        cwd: draft.cwd.trim(),
        useWorktree: draft.useWorktree,
      }
    case 'send_to_session': return { ...base, type: 'send_to_session', sessionId: draft.sessionId.trim() }
    case 'run_automation': return { ...base, type: 'run_automation', automationId: draft.automationId }
  }
}

export function actionsFromDraft(drafts: readonly ActionDraft[]): DraftResult<WebhookAction[]> {
  if (drafts.length === 0) return { ok: false, error: 'Add one action or more.' }
  if (drafts.length > WEBHOOK_MAX_ACTIONS) return { ok: false, error: `A webhook has ${WEBHOOK_MAX_ACTIONS} actions or fewer.` }
  const actions: WebhookAction[] = []
  for (const [index, draft] of drafts.entries()) {
    const label = `Action ${index + 1}`
    if (draft.filters.length > WEBHOOK_MAX_FILTERS) return { ok: false, error: `${label}: an action has ${WEBHOOK_MAX_FILTERS} filters or fewer.` }
    const filters: WebhookFilter[] = []
    for (const filter of draft.filters) {
      const parsed = filterFromDraft(filter)
      if (!parsed) return { ok: false, error: `${label}: complete each filter, or remove it.` }
      filters.push(parsed)
    }
    const candidate = actionCandidate(draft, filters)
    const parsed = candidate ? webhookActionSchema.safeParse(candidate) : null
    if (!parsed?.success) return { ok: false, error: `${label}: complete the type and its fields.` }
    actions.push(parsed.data)
  }
  return { ok: true, value: actions }
}

export function createInputFromDraft(draft: WebhookDraft): DraftResult<WebhookCreateInput> {
  const name = draft.name.trim()
  if (!name) return { ok: false, error: 'Enter a name.' }
  const verification = verificationFromDraft(draft.verification, null)
  if (!verification.ok) return verification
  const actions = actionsFromDraft(draft.actions)
  if (!actions.ok) return actions
  return {
    ok: true,
    value: {
      name,
      project: draft.project.trim() || null,
      enabled: draft.enabled,
      verification: verification.value,
      replayKey: draft.replayKey.trim() || null,
      actions: actions.value,
    },
  }
}

export function updateInputFromDraft(draft: WebhookDraft, storedScheme: WebhookVerificationScheme): DraftResult<WebhookUpdateInput> {
  const name = draft.name.trim()
  if (!name) return { ok: false, error: 'Enter a name.' }
  const verification = verificationFromDraft(draft.verification, storedScheme)
  if (!verification.ok) return verification
  const actions = actionsFromDraft(draft.actions)
  if (!actions.ok) return actions
  return {
    ok: true,
    value: {
      name,
      project: draft.project.trim() || null,
      verification: verification.value,
      replayKey: draft.replayKey.trim() || null,
      actions: actions.value,
    },
  }
}

/** Header lines as `Name: value`, one for each line, for the dry run sample. */
export function parseHeaderLines(text: string): [string, string][] {
  const headers: [string, string][] = []
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const name = line.slice(0, colon).trim()
    if (name) headers.push([name, line.slice(colon + 1).trim()])
  }
  return headers
}
