// ─── Managed policy (plans/030-managed-policy.md) ───
//
// One `policy.json` schema for three sources: the MDM policy of a machine, a
// cloud host policy an organization assigns to hosts, and an organization's own
// policy. A key in a policy is locked to its value; a key in no policy is the
// person's own. The host enforces every key; clients only show the locks.

import { z } from 'zod'
import { CONFIGURABLE_SOLUS_TOOL_NAMES } from './agent-tools'
import { PERSONAL_SETTING_SCHEMAS } from './settings'
import { PERMISSION_MODES, type AgentId, type PermissionMode } from './types'

export const POLICY_PROVIDER_IDS = ['claude-code', 'codex', 'opencode', 'replay'] as const satisfies readonly AgentId[]
const providerIdSchema = z.enum(POLICY_PROVIDER_IDS)

/** Narrowest first. `plan` cannot change anything, `full-access` asks for nothing. */
const PERMISSION_MODE_RANK: Record<PermissionMode, number> = {
  plan: 0,
  supervised: 1,
  'accept-edits': 2,
  auto: 3,
  'full-access': 4,
}

/** Whether `mode` lets the agent do more than `ceiling`; no ceiling allows every mode. */
export function isPermissionModeAbove(mode: PermissionMode, ceiling: PermissionMode | null | undefined): boolean {
  return ceiling != null && PERMISSION_MODE_RANK[mode] > PERMISSION_MODE_RANK[ceiling]
}

/** `mode`, lowered to `ceiling` when it is above it. */
export function clampPermissionMode(mode: PermissionMode, ceiling: PermissionMode | null | undefined): PermissionMode {
  return ceiling != null && isPermissionModeAbove(mode, ceiling) ? ceiling : mode
}

// ── Manageable keys ─────────────────────────────────────────────────────────

/** Personal settings the host reads from the request it serves, so a lock holds against any client (§4.3). */
export const MANAGED_SESSION_SETTING_KEYS = [
  'leadModel',
  'workerModel',
  'modelRouting',
  'textGenerationModel',
  'sourceControlWriterModel',
  'extraInstructions',
  'modelInstructions',
  'leadInstructions',
  'sourceControlWriting',
  'worktreeBranchNaming',
  'defaultPermissionMode',
  'agentTaskLifecyclePolicy',
  'rateLimitBehavior',
  'reviewAgent',
  'reviewModel',
  'reviewGuideInstructions',
] as const satisfies readonly (keyof typeof PERSONAL_SETTING_SCHEMAS)[]
export type ManagedSessionSettingKey = (typeof MANAGED_SESSION_SETTING_KEYS)[number]

export const managedSessionSettingsSchema = z.object({
  leadModel: PERSONAL_SETTING_SCHEMAS.leadModel,
  workerModel: PERSONAL_SETTING_SCHEMAS.workerModel,
  modelRouting: PERSONAL_SETTING_SCHEMAS.modelRouting,
  textGenerationModel: PERSONAL_SETTING_SCHEMAS.textGenerationModel,
  sourceControlWriterModel: PERSONAL_SETTING_SCHEMAS.sourceControlWriterModel,
  extraInstructions: PERSONAL_SETTING_SCHEMAS.extraInstructions,
  modelInstructions: PERSONAL_SETTING_SCHEMAS.modelInstructions,
  leadInstructions: PERSONAL_SETTING_SCHEMAS.leadInstructions,
  sourceControlWriting: PERSONAL_SETTING_SCHEMAS.sourceControlWriting,
  worktreeBranchNaming: PERSONAL_SETTING_SCHEMAS.worktreeBranchNaming,
  defaultPermissionMode: PERSONAL_SETTING_SCHEMAS.defaultPermissionMode,
  agentTaskLifecyclePolicy: PERSONAL_SETTING_SCHEMAS.agentTaskLifecyclePolicy,
  rateLimitBehavior: PERSONAL_SETTING_SCHEMAS.rateLimitBehavior,
  reviewAgent: PERSONAL_SETTING_SCHEMAS.reviewAgent,
  reviewModel: PERSONAL_SETTING_SCHEMAS.reviewModel,
  reviewGuideInstructions: PERSONAL_SETTING_SCHEMAS.reviewGuideInstructions,
} satisfies { [K in ManagedSessionSettingKey]: (typeof PERSONAL_SETTING_SCHEMAS)[K] }).partial().strict()
export type ManagedSessionSettings = z.output<typeof managedSessionSettingsSchema>

const httpsUrlSchema = z.string().trim().refine((value) => /^https:\/\/[^\s/]+/.test(value), 'must be an https URL')

/** Strict, unlike the host config patch: a policy value that does not decode is refused, never healed. */
const otelPolicySchema = z.object({
  enabled: z.boolean(),
  endpoint: z.string(),
  headers: z.string(),
  exportMetrics: z.boolean(),
  exportTraces: z.boolean(),
}).partial().strict()

export const managedHostSettingsSchema = z.object({
  solusTools: z.partialRecord(z.enum(CONFIGURABLE_SOLUS_TOOL_NAMES), z.boolean()),
  continueSessionsAfterHostRestart: z.boolean(),
  archivedAutomationRetentionDays: z.number().int().min(1).max(3650),
  unfiledRecordingRetentionDays: z.number().int().min(1).max(3650),
  otel: otelPolicySchema,
  /** The host's analytics and the desktop app's on this machine. */
  analyticsEnabled: z.boolean(),
  /** false: loopback only; no LAN discovery, pairing, pair links, or host introductions. */
  remoteAccess: z.boolean(),
  trustLocalNetwork: z.boolean(),
  /** false: no Solus Cloud tunnel. Registration still works. */
  cloudTunnel: z.boolean(),
  updates: z.object({
    mode: z.enum(['auto', 'off']),
    /** A generic feed the desktop app updates from instead of the Solus releases. */
    feedUrl: httpsUrlSchema.optional(),
  }).strict(),
}).partial().strict()
export type ManagedHostSettings = z.output<typeof managedHostSettingsSchema>
export type ManagedHostKey = keyof ManagedHostSettings
export const MANAGED_HOST_KEYS = Object.keys(managedHostSettingsSchema.shape) as ManagedHostKey[]

const envNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)

export const providerLaunchPinSchema = z.object({
  environment: z.array(z.object({ name: envNameSchema, value: z.string() }).strict()).optional(),
  binaryPath: z.string().trim().min(1).optional(),
  launchArgs: z.array(z.string().min(1)).max(100).optional(),
}).strict()
export type ProviderLaunchPin = z.infer<typeof providerLaunchPinSchema>

export const sessionLimitsSchema = z.object({
  maxPermissionMode: z.enum(PERMISSION_MODES).optional(),
  providers: z.object({
    allowed: z.array(providerIdSchema).nonempty().optional(),
    launch: z.partialRecord(providerIdSchema, providerLaunchPinSchema).optional(),
  }).strict().optional(),
  /** By provider: the only model ids that may run. A provider not named is not limited. */
  models: z.partialRecord(providerIdSchema, z.array(z.string().trim().min(1)).nonempty()).optional(),
  insights: z.object({ syncAll: z.boolean() }).strict().optional(),
  webhooks: z.object({ allowUnverified: z.boolean() }).strict().optional(),
}).strict()
export type SessionLimits = z.infer<typeof sessionLimitsSchema>

// ── The document ────────────────────────────────────────────────────────────

const policyDocumentShape = z.object({
  schemaVersion: z.literal(1),
  organization: z.object({ name: z.string().trim().min(1) }).strict(),
  name: z.string().trim().min(1).optional(),
  supportUrl: httpsUrlSchema.optional(),
  revision: z.number().int().nonnegative().optional(),
  host: managedHostSettingsSchema.optional(),
  sessions: z.object({
    settings: managedSessionSettingsSchema.optional(),
    limits: sessionLimitsSchema.optional(),
  }).strict().optional(),
}).strict()

/** Where a document comes from. Only an organization policy may not hold `host`. */
export type PolicyKind = 'mdm' | 'host' | 'organization'

/** The model of a locked model setting, for the allowlist check. */
function lockedModels(settings: ManagedSessionSettings | undefined): { key: string; provider: AgentId; model: string }[] {
  if (!settings) return []
  const out: { key: string; provider: AgentId; model: string }[] = []
  for (const key of ['leadModel', 'workerModel', 'textGenerationModel', 'sourceControlWriterModel'] as const) {
    const selection = settings[key]
    if (selection) out.push({ key, provider: selection.provider, model: selection.model })
  }
  return out
}

export function policyDocumentSchema(kind: PolicyKind) {
  return policyDocumentShape.superRefine((document, ctx) => {
    if (kind === 'organization' && document.host) {
      ctx.addIssue({ code: 'custom', path: ['host'], message: 'An organization policy cannot hold host settings. Put them in a host policy.' })
    }
    const settings = document.sessions?.settings
    const limits = document.sessions?.limits
    if (settings?.defaultPermissionMode && isPermissionModeAbove(settings.defaultPermissionMode, limits?.maxPermissionMode)) {
      ctx.addIssue({ code: 'custom', path: ['sessions', 'settings', 'defaultPermissionMode'], message: 'The default mode cannot be above maxPermissionMode.' })
    }
    for (const locked of lockedModels(settings)) {
      const allowed = limits?.models?.[locked.provider]
      if (allowed && !allowed.includes(locked.model)) {
        ctx.addIssue({ code: 'custom', path: ['sessions', 'settings', locked.key], message: `${locked.model} is not in sessions.limits.models.${locked.provider}.` })
      }
      if (limits?.providers?.allowed && !limits.providers.allowed.includes(locked.provider)) {
        ctx.addIssue({ code: 'custom', path: ['sessions', 'settings', locked.key], message: `${locked.provider} is not in sessions.limits.providers.allowed.` })
      }
    }
    if (document.host?.remoteAccess === false && document.host.trustLocalNetwork === true) {
      ctx.addIssue({ code: 'custom', path: ['host', 'trustLocalNetwork'], message: 'trustLocalNetwork cannot be true when remoteAccess is false.' })
    }
  })
}

export type PolicyDocument = z.output<typeof policyDocumentShape>

export type PolicyValidation = { ok: true; document: PolicyDocument } | { ok: false; issues: string[] }

/** The one validator: the host, the cloud, the editor, and `solus policy check` all call it. */
export function validatePolicyDocument(input: unknown, kind: PolicyKind): PolicyValidation {
  const parsed = policyDocumentSchema(kind).safeParse(input)
  if (parsed.success) return { ok: true, document: parsed.data }
  return { ok: false, issues: parsed.error.issues.map((issue) => `${issue.path.length ? issue.path.join('.') : '(document)'}: ${issue.message}`) }
}

/** Sorted keys and no spaces, so a fingerprint does not change with key order. */
export function canonicalPolicyJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalPolicyJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, child]) => child !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalPolicyJson(child)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** A new organization's policy: today's defaults (§4.5). */
export function organizationPolicyTemplate(name: string): PolicyDocument {
  return { schemaVersion: 1, organization: { name }, sessions: { limits: { insights: { syncAll: true }, webhooks: { allowUnverified: false } } } }
}

// ── Sources and resolution ──────────────────────────────────────────────────

export interface PolicySource {
  kind: PolicyKind
  /** Null for the MDM policy. */
  organizationId: string | null
  document: PolicyDocument
}

export type OrganizationPolicies =
  | { state: 'ready'; policy: PolicySource; hostPolicy: PolicySource | null }
  | { state: 'unenforceable'; organizationName: string; reason: string }
  | { state: 'unavailable' }

/** Everything that governs work on one host. The host holds the full set; clients get `summarizePolicySet`. */
export interface PolicySet {
  mdm: PolicySource | null
  /** The organization whose host policy holds `host` on this host; null when none. */
  hostOwnerOrganizationId: string | null
  organizations: { [organizationId: string]: OrganizationPolicies }
}

export const EMPTY_POLICY_SET: PolicySet = { mdm: null, hostOwnerOrganizationId: null, organizations: {} }

export const LOCAL_POLICY_ORGANIZATION_ID = 'local'

export type SessionSources = { ok: true; sources: PolicySource[] } | { ok: false; code: 'POLICY_UNAVAILABLE' | 'POLICY_UNENFORCEABLE'; message: string }

/** The documents that govern work of `organizationId` on this host, first wins (§3). */
export function sessionSourcesFor(set: PolicySet, organizationId: string): SessionSources {
  const owner = hostOwnerState(set)
  if (owner && !owner.ok) return owner
  const sources: PolicySource[] = set.mdm ? [set.mdm] : []
  if (organizationId === LOCAL_POLICY_ORGANIZATION_ID) return { ok: true, sources }
  const entry = set.organizations[organizationId]
  if (!entry || entry.state === 'unavailable') {
    return { ok: false, code: 'POLICY_UNAVAILABLE', message: "This host has not received this organization's policy yet. Connect to Solus Cloud and try again." }
  }
  if (entry.state === 'unenforceable') {
    return { ok: false, code: 'POLICY_UNENFORCEABLE', message: `This host's Solus version cannot enforce ${entry.organizationName}'s policy. Update Solus.` }
  }
  if (entry.hostPolicy) sources.push(entry.hostPolicy)
  sources.push(entry.policy)
  return { ok: true, sources }
}

/** An unreadable policy of the host-owning organization stops all work here: its `host` section cannot be applied. */
function hostOwnerState(set: PolicySet): SessionSources | null {
  if (set.mdm || !set.hostOwnerOrganizationId) return null
  const entry = set.organizations[set.hostOwnerOrganizationId]
  if (entry?.state === 'unenforceable') {
    return { ok: false, code: 'POLICY_UNENFORCEABLE', message: `This host's Solus version cannot enforce ${entry.organizationName}'s host policy. Update Solus.` }
  }
  if (!entry || entry.state === 'unavailable') {
    return { ok: false, code: 'POLICY_UNAVAILABLE', message: "This host has not received its host policy yet. Connect to Solus Cloud and try again." }
  }
  return null
}

export interface ResolvedRule<Value> {
  value: Value
  source: PolicySource
}

/** A locked setting; its value can be `null` where the setting allows it (`leadModel: null` locks "the default"). */
export function resolveSessionSetting<K extends ManagedSessionSettingKey>(sources: PolicySource[], key: K): ResolvedRule<Exclude<ManagedSessionSettings[K], undefined>> | null {
  for (const source of sources) {
    const value = source.document.sessions?.settings?.[key]
    if (value !== undefined) return { value: value as Exclude<ManagedSessionSettings[K], undefined>, source }
  }
  return null
}

export function resolveSessionLimit<K extends keyof SessionLimits>(sources: PolicySource[], key: K): ResolvedRule<NonNullable<SessionLimits[K]>> | null {
  for (const source of sources) {
    const value = source.document.sessions?.limits?.[key]
    if (value !== undefined) return { value: value as NonNullable<SessionLimits[K]>, source }
  }
  return null
}

/** Host keys: the MDM policy, then the host-owning organization's host policy (§3). */
export function resolveHostKey<K extends ManagedHostKey>(set: PolicySet, key: K): ResolvedRule<NonNullable<ManagedHostSettings[K]>> | null {
  const candidates: PolicySource[] = []
  if (set.mdm) candidates.push(set.mdm)
  else if (set.hostOwnerOrganizationId) {
    const entry = set.organizations[set.hostOwnerOrganizationId]
    if (entry?.state === 'ready' && entry.hostPolicy) candidates.push(entry.hostPolicy)
  }
  for (const source of candidates) {
    const value = source.document.host?.[key]
    if (value !== undefined) return { value: value as NonNullable<ManagedHostSettings[K]>, source }
  }
  return null
}

/** "the MDM policy of Example Corp", "Engineering laptops (Example Corp)", or "Example Corp". */
export function policySourceLabel(source: PolicySource): string {
  const organization = source.document.organization.name
  if (source.kind === 'mdm') return `the MDM policy of ${organization}`
  if (source.kind === 'host') return source.document.name ? `${source.document.name} (${organization})` : `${organization}'s host policy`
  return organization
}

// ── What clients see ────────────────────────────────────────────────────────

/** The value a client sees in place of a pinned launch field: it says the field is pinned, not what it holds. */
export const REDACTED_LAUNCH_VALUE = '(managed)'

/** Pins without their values, so an editor can lock exactly the pinned fields. */
function redactLaunchPin(pin: ProviderLaunchPin): ProviderLaunchPin {
  return {
    ...(pin.environment ? { environment: pin.environment.map((variable) => ({ name: variable.name, value: REDACTED_LAUNCH_VALUE })) } : {}),
    ...(pin.binaryPath ? { binaryPath: REDACTED_LAUNCH_VALUE } : {}),
    ...(pin.launchArgs ? { launchArgs: [REDACTED_LAUNCH_VALUE] } : {}),
  }
}

/** Launch pin values and the update feed can carry tokens; clients get the pinned field names only, and no feed. */
function summarizeDocument(document: PolicyDocument): PolicyDocument {
  const limits = document.sessions?.limits
  const launch = limits?.providers?.launch
  const redacted = launch ? Object.fromEntries(Object.entries(launch).map(([provider, pin]) => [provider, pin && redactLaunchPin(pin)])) : undefined
  const providers = limits?.providers ? { ...limits.providers, launch: redacted } : undefined
  const updates = document.host?.updates ? { mode: document.host.updates.mode } : undefined
  return {
    ...document,
    host: document.host ? { ...document.host, updates } : undefined,
    sessions: document.sessions ? { ...document.sessions, limits: limits ? { ...limits, providers } : undefined } : undefined,
  }
}

function summarizeSource(source: PolicySource): PolicySource {
  return { ...source, document: summarizeDocument(source.document) }
}

export function summarizePolicySet(set: PolicySet): PolicySet {
  const organizations: PolicySet['organizations'] = {}
  for (const [organizationId, entry] of Object.entries(set.organizations)) {
    organizations[organizationId] = entry.state === 'ready'
      ? { state: 'ready', policy: summarizeSource(entry.policy), hostPolicy: entry.hostPolicy ? summarizeSource(entry.hostPolicy) : null }
      : entry
  }
  return { mdm: set.mdm ? summarizeSource(set.mdm) : null, hostOwnerOrganizationId: set.hostOwnerOrganizationId, organizations }
}

// ── Refusals ────────────────────────────────────────────────────────────────

export const POLICY_REFUSAL_CODES = [
  'PERMISSION_MODE_ABOVE_LIMIT',
  'PROVIDER_NOT_ALLOWED',
  'MODEL_NOT_ALLOWED',
  'SETTING_MANAGED',
  'REMOTE_ACCESS_NOT_ALLOWED',
  'CLOUD_TUNNEL_NOT_ALLOWED',
  'UPDATES_MANAGED',
  'POLICY_UNAVAILABLE',
  'POLICY_UNENFORCEABLE',
] as const
export type PolicyRefusalCode = (typeof POLICY_REFUSAL_CODES)[number]

export function isPolicyRefusalCode(code: string): code is PolicyRefusalCode {
  return (POLICY_REFUSAL_CODES as readonly string[]).includes(code)
}

const MODE_LABELS: Record<PermissionMode, string> = {
  plan: 'Plan',
  supervised: 'Supervised',
  'accept-edits': 'Accept edits',
  auto: 'Auto',
  'full-access': 'Full access',
}

const PROVIDER_LABELS: Record<AgentId, string> = { 'claude-code': 'Claude', codex: 'Codex', opencode: 'OpenCode', replay: 'Replay' }

export function permissionCeilingMessage(source: PolicySource, ceiling: PermissionMode): string {
  return `${capitalize(policySourceLabel(source))} limits sessions to ${MODE_LABELS[ceiling]}.`
}

export function providerDeniedMessage(source: PolicySource, provider: AgentId): string {
  return `${capitalize(policySourceLabel(source))} does not allow ${PROVIDER_LABELS[provider]}.`
}

export function modelDeniedMessage(source: PolicySource, model: string): string {
  return `${capitalize(policySourceLabel(source))} does not allow the model ${model}.`
}

export function settingManagedMessage(setting: string, source: PolicySource): string {
  return `${setting} is managed by ${policySourceLabel(source)}.`
}

export function capabilityDeniedMessage(source: PolicySource, capability: string): string {
  return `${capitalize(policySourceLabel(source))} does not allow ${capability}.`
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
