import {
  hostKeyLock,
  managedSettingLines,
  permissionCeiling,
  sessionPolicy,
  updatesManagedMessage,
  type SessionPolicy,
} from '@solus/client-core/policy'
import {
  isPermissionModeAbove,
  LOCAL_POLICY_ORGANIZATION_ID,
  MANAGED_HOST_KEYS,
  MANAGED_SESSION_SETTING_KEYS,
  policySourceLabel,
  resolveSessionLimit,
  resolveSessionSetting,
  type ManagedHostKey,
  type ManagedHostSettings,
  type ManagedSessionSettingKey,
  type ManagedSessionSettings,
  type PolicySet,
  type PolicySource,
} from '@solus/contracts/policy'
import { MODEL_PROFILES, type AgentId, type PermissionMode } from '@solus/contracts/types'
import { PERMISSION_MODE_TEXT } from '../../conversation/lib/run-settings'

/**
 * What the native app shows of a host's policies (plans/030 §7). The host
 * enforces every rule; these only say what is locked and who locks it, with
 * the same resolution as desktop and web (`@solus/client-core/policy`).
 * Mobile shows policies and locks but does not edit or export them (O1).
 */

/** The policy of work on a host. A summary not read yet locks nothing, so a picker does not flash locked. */
export function workPolicy(set: PolicySet | null | undefined, organizationId: string | null | undefined): SessionPolicy {
  const organization = organizationId ?? LOCAL_POLICY_ORGANIZATION_ID
  return set ? sessionPolicy(set, organization) : { organizationId: organization, refusal: null, sources: [] }
}

/** The mode "Lower the mode" sets after a PERMISSION_MODE_ABOVE_LIMIT refusal; null when `current` is not above a known ceiling. */
export function loweredPermissionMode(policy: SessionPolicy, current: PermissionMode): PermissionMode | null {
  const ceiling = permissionCeiling(policy)
  return ceiling && isPermissionModeAbove(current, ceiling.mode) ? ceiling.mode : null
}

// ── Host keys ───────────────────────────────────────────────────────────────

/** How each machine-wide key reads in "<Label> is managed by <source>.", as on desktop. */
export const HOST_KEY_LABELS = {
  remoteAccess: 'Remote access',
  trustLocalNetwork: 'Local network trust',
  cloudTunnel: 'The Solus Cloud link',
  analyticsEnabled: 'Analytics',
  otel: 'OpenTelemetry export',
  archivedAutomationRetentionDays: 'Archived automation retention',
  unfiledRecordingRetentionDays: 'Unfiled recording retention',
  solusTools: 'Solus tools',
  continueSessionsAfterHostRestart: 'Continuing sessions after a restart',
  updates: 'Solus updates',
} satisfies Record<ManagedHostKey, string>

/** A host lock holds for all work on the host, so its control is always inert. Null when the person decides. */
export function hostLockMessage(set: PolicySet | null | undefined, key: ManagedHostKey): string | null {
  return set ? hostKeyLock(set, key, HOST_KEY_LABELS[key])?.message ?? null : null
}

/** Pairing follows `remoteAccess: false`: no pair codes and no pair links. */
export function pairingLockMessage(set: PolicySet | null | undefined): string | null {
  const lock = set ? hostKeyLock(set, 'remoteAccess', 'Pairing') : null
  return lock && lock.value === false ? lock.message : null
}

/** "<Name> manages Solus updates." when a policy turns updates off. */
export function updatesLockMessage(set: PolicySet | null | undefined): string | null {
  return set ? updatesManagedMessage(set) : null
}

// ── Session settings ────────────────────────────────────────────────────────

type ManagedValue<K extends ManagedSessionSettingKey> = Exclude<ManagedSessionSettings[K], undefined>

function modelName(provider: AgentId, model: string): string {
  return MODEL_PROFILES[provider]?.[model]?.label ?? model
}

const PROVIDER_NAMES = { 'claude-code': 'Claude', codex: 'Codex', opencode: 'OpenCode', replay: 'Replay' } satisfies Record<AgentId, string>

const RATE_LIMIT_BEHAVIOR = {
  ask: 'ask at a rate limit',
  queue: 'wait for the rate limit to reset',
  continue: 'stop at a rate limit',
  stop: 'stop at a rate limit',
} satisfies Record<ManagedValue<'rateLimitBehavior'>, string>

const TASK_LIFECYCLE = {
  none: 'no task status changes by agents',
  moderate: 'task status changes by agents, except done',
  autonomous: 'all task status changes by agents',
} satisfies Record<ManagedValue<'agentTaskLifecyclePolicy'>, string>

/** Each managed setting: its name, and how its value reads in "Globex sessions use <value> (managed)." */
const SESSION_SETTINGS: { [K in ManagedSessionSettingKey]: { label: string; describe: (value: ManagedValue<K>) => string } } = {
  leadModel: { label: 'Lead model', describe: (value) => (value ? modelName(value.provider, value.model) : 'the default lead model') },
  workerModel: { label: 'Worker model', describe: (value) => (value ? modelName(value.provider, value.model) : "the lead's choice of worker model") },
  modelRouting: { label: 'Model routing', describe: () => 'a set model routing' },
  textGenerationModel: { label: 'Text generation model', describe: (value) => modelName(value.provider, value.model) },
  sourceControlWriterModel: { label: 'Commit writer model', describe: (value) => (value ? modelName(value.provider, value.model) : 'the text-generation model for commits') },
  extraInstructions: { label: 'Extra instructions', describe: () => 'set custom instructions' },
  modelInstructions: { label: 'Model instructions', describe: () => 'set model instructions' },
  leadInstructions: { label: 'Lead instructions', describe: () => 'set lead instructions' },
  sourceControlWriting: { label: 'Commit and pull request writing', describe: () => 'a set writing style for commits and pull requests' },
  worktreeBranchNaming: { label: 'Branch naming', describe: () => 'a set branch name format' },
  defaultPermissionMode: { label: 'Default mode', describe: (value) => `${PERMISSION_MODE_TEXT[value].label} by default` },
  agentTaskLifecyclePolicy: { label: 'Task status by agents', describe: (value) => TASK_LIFECYCLE[value] },
  rateLimitBehavior: { label: 'Rate limits', describe: (value) => RATE_LIMIT_BEHAVIOR[value] },
  reviewAgent: { label: 'Review agent', describe: (value) => `${PROVIDER_NAMES[value]} for reviews` },
  reviewModel: { label: 'Review model', describe: (value) => `${value} for reviews` },
  reviewGuideInstructions: { label: 'Review guide instructions', describe: () => 'set review guide instructions' },
}

export interface PolicyHostView {
  readonly hostLabel: string
  readonly set: PolicySet
}

/**
 * The lines under a managed personal setting. Personal settings follow the
 * person to every host, so mobile names the host of each lock; the control
 * stays usable, because the setting still applies on the other hosts.
 */
export function managedSettingNotes<K extends ManagedSessionSettingKey>(
  hosts: readonly PolicyHostView[],
  organizations: readonly { organizationId: string; name: string }[],
  key: K,
): string[] {
  const setting = SESSION_SETTINGS[key]
  return hosts.flatMap((host) => managedSettingLines(host.set, organizations, key, setting.describe).lines.map((line) => `${host.hostLabel}: ${line}`))
}

/** The ceiling on each host for the active organization's work: "Bob's Mac: Globex limits sessions to Supervised." */
export function permissionCeilingLines(hosts: readonly PolicyHostView[], organizationId: string | null): string[] {
  return hosts.flatMap((host) => {
    const ceiling = permissionCeiling(workPolicy(host.set, organizationId))
    return ceiling ? [`${host.hostLabel}: ${ceiling.message}`] : []
  })
}

// ── The Policy screen ───────────────────────────────────────────────────────

export interface PolicyRuleRow {
  readonly label: string
  readonly value: string
  /** "the MDM policy of Example Corp", "Engineering laptops (Example Corp)", or "Example Corp". */
  readonly source: string
}

export interface PolicySourceRow {
  readonly kind: PolicySource['kind']
  /** "MDM policy", "Host policy", or "Organization policy". */
  readonly heading: string
  /** The policy's own name, or its organization's. */
  readonly name: string
  /** Who manages it, and its revision when Solus Cloud gave one. */
  readonly detail: string
}

export interface PolicyScreenModel {
  /** The host cannot run this organization's work now; the host's own words. */
  readonly refusal: string | null
  readonly sources: readonly PolicySourceRow[]
  /** "<Organization> manages this host's settings." Null when no organization holds them. */
  readonly hostOwner: string | null
  readonly settings: readonly PolicyRuleRow[]
  readonly limits: readonly PolicyRuleRow[]
  readonly hostKeys: readonly PolicyRuleRow[]
  /** The first support link of the policies that apply. */
  readonly supportUrl: string | null
}

const SOURCE_HEADINGS = { mdm: 'MDM policy', host: 'Host policy', organization: 'Organization policy' } satisfies Record<PolicySource['kind'], string>

function sourceRow(source: PolicySource): PolicySourceRow {
  const { document } = source
  const parts = [`Managed by ${document.organization.name}`]
  if (source.kind === 'mdm') parts.push('Installed on this machine')
  if (document.revision !== undefined) parts.push(`Revision ${document.revision}`)
  return { kind: source.kind, heading: SOURCE_HEADINGS[source.kind], name: document.name ?? document.organization.name, detail: parts.join(' · ') }
}

function onOff(value: boolean): string {
  return value ? 'On' : 'Off'
}

function list(values: readonly string[]): string {
  return values.join(', ')
}

function hostKeyValue<K extends ManagedHostKey>(key: K, value: NonNullable<ManagedHostSettings[K]>): string {
  const settings = { [key]: value } as ManagedHostSettings
  if (settings.remoteAccess !== undefined) return settings.remoteAccess ? 'Allowed' : 'This machine only'
  if (settings.trustLocalNetwork !== undefined) return settings.trustLocalNetwork ? 'Trusted' : 'Pairing required'
  if (settings.cloudTunnel !== undefined) return settings.cloudTunnel ? 'Allowed' : 'Not allowed'
  if (settings.analyticsEnabled !== undefined) return onOff(settings.analyticsEnabled)
  if (settings.continueSessionsAfterHostRestart !== undefined) return onOff(settings.continueSessionsAfterHostRestart)
  if (settings.updates !== undefined) return settings.updates.mode === 'off' ? 'Managed by the organization' : 'Automatic'
  if (settings.archivedAutomationRetentionDays !== undefined) return `${settings.archivedAutomationRetentionDays} days`
  if (settings.unfiledRecordingRetentionDays !== undefined) return `${settings.unfiledRecordingRetentionDays} days`
  if (settings.otel !== undefined) return settings.otel.enabled === undefined ? 'Set' : onOff(settings.otel.enabled)
  if (settings.solusTools !== undefined) {
    const count = Object.keys(settings.solusTools).length
    return count === 1 ? '1 tool' : `${count} tools`
  }
  return 'Set'
}

function limitRows(sources: PolicySource[]): PolicyRuleRow[] {
  const rows: PolicyRuleRow[] = []
  const ceiling = resolveSessionLimit(sources, 'maxPermissionMode')
  if (ceiling) rows.push({ label: 'Highest mode', value: PERMISSION_MODE_TEXT[ceiling.value].label, source: policySourceLabel(ceiling.source) })
  const providers = resolveSessionLimit(sources, 'providers')
  if (providers?.value.allowed) rows.push({ label: 'Agents', value: list(providers.value.allowed.map((provider) => PROVIDER_NAMES[provider])), source: policySourceLabel(providers.source) })
  if (providers?.value.launch && Object.keys(providers.value.launch).length > 0) {
    rows.push({ label: 'Agent launch', value: list(Object.keys(providers.value.launch).map((provider) => PROVIDER_NAMES[provider as AgentId] ?? provider)), source: policySourceLabel(providers.source) })
  }
  const models = resolveSessionLimit(sources, 'models')
  if (models) {
    for (const [provider, allowed] of Object.entries(models.value)) {
      if (allowed) rows.push({ label: `${PROVIDER_NAMES[provider as AgentId] ?? provider} models`, value: list(allowed.map((model) => modelName(provider as AgentId, model))), source: policySourceLabel(models.source) })
    }
  }
  const insights = resolveSessionLimit(sources, 'insights')
  if (insights) rows.push({ label: 'Sync all Insights', value: onOff(insights.value.syncAll), source: policySourceLabel(insights.source) })
  const webhooks = resolveSessionLimit(sources, 'webhooks')
  if (webhooks) rows.push({ label: 'Unverified webhooks', value: webhooks.value.allowUnverified ? 'Allowed' : 'Not allowed', source: policySourceLabel(webhooks.source) })
  return rows
}

function settingRows(sources: PolicySource[]): PolicyRuleRow[] {
  return MANAGED_SESSION_SETTING_KEYS.flatMap((key) => {
    const rule = resolveSessionSetting(sources, key)
    if (!rule) return []
    const setting = SESSION_SETTINGS[key] as { label: string; describe: (value: unknown) => string }
    return [{ label: setting.label, value: setting.describe(rule.value), source: policySourceLabel(rule.source) }]
  })
}

function hostKeyRows(set: PolicySet): PolicyRuleRow[] {
  return MANAGED_HOST_KEYS.flatMap((key) => {
    const lock = hostKeyLock(set, key, HOST_KEY_LABELS[key])
    return lock ? [{ label: HOST_KEY_LABELS[key], value: hostKeyValue(key, lock.value), source: policySourceLabel(lock.source) }] : []
  })
}

/**
 * The effective policy for one organization's work on one host: the policies
 * that apply, first wins (MDM, then the organization's host policy for this
 * host, then the organization policy), and every lock with the policy that
 * sets it. `local` work sees the MDM policy only.
 */
export function policyScreenModel(set: PolicySet, organizationId: string, organizationNames: ReadonlyMap<string, string>): PolicyScreenModel {
  const policy = sessionPolicy(set, organizationId)
  // A refusal leaves no sources to apply; the MDM policy still governs the machine and is shown.
  const sources = policy.refusal ? (set.mdm ? [set.mdm] : []) : policy.sources
  const ownerId = set.mdm ? null : set.hostOwnerOrganizationId
  const ownerEntry = ownerId ? set.organizations[ownerId] : undefined
  const ownerName = ownerId
    ? organizationNames.get(ownerId) ?? (ownerEntry?.state === 'ready' ? ownerEntry.policy.document.organization.name : ownerEntry?.state === 'unenforceable' ? ownerEntry.organizationName : null) ?? 'Another organization'
    : null
  return {
    refusal: policy.refusal?.message ?? null,
    sources: sources.map(sourceRow),
    hostOwner: ownerName ? `${ownerName} manages this host's settings.` : null,
    settings: settingRows(sources),
    limits: limitRows(sources),
    hostKeys: hostKeyRows(set),
    supportUrl: sources.find((source) => source.document.supportUrl)?.document.supportUrl ?? null,
  }
}
