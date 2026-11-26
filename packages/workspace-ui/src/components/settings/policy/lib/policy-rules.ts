import {
  MANAGED_SESSION_SETTING_KEYS,
  PERMISSION_MODE_LABELS,
  type ManagedHostSettings,
  type ManagedSessionSettingKey,
  type ManagedSessionSettings,
  type PolicyDocument,
  type PolicySet,
  type SessionLimits,
} from '@solus/contracts/policy'
import { AGENT_IDS, AGENT_LABELS } from '@solus/contracts/types'
import { HOST_KEY_LABELS } from './host-locks'

/**
 * What a policy does, in words: one rule for each key it sets, so Settings →
 * Policy shows a policy without its JSON. Launch pins and the update feed are
 * not in the summary a client gets; a pin shows as "Pinned".
 */
export interface PolicyRule {
  label: string
  value: string
}

const SESSION_SETTING_LABELS = {
  workerModel: 'Worker model',
  fallbackModel: 'Fallback model',
  modelRouting: 'Auto model routing',
  textGenerationModel: 'Text generation model',
  sourceControlWriterModel: 'Commit and pull request model',
  extraInstructions: 'Extra instructions',
  modelInstructions: 'Model instructions',
  delegationInstructions: 'Delegation instructions',
  sourceControlWriting: 'Commit and pull request writing',
  worktreeBranchNaming: 'Worktree branch naming',
  codebaseNaming: 'Codebase naming',
  defaultPermissionMode: 'Default permission mode',
  rateLimitBehavior: 'At a rate limit',
  reviewAgent: 'Review agent',
  reviewModel: 'Review model',
  reviewGuideInstructions: 'Review guide instructions',
} satisfies Record<ManagedSessionSettingKey, string>

/** One policy that governs work on this host, as Settings → Policy lists it. */
export interface AppliedPolicy {
  key: string
  title: string
  /** Where it applies, or why the host cannot apply it. */
  detail: string
  /** Null when the host cannot read the policy. */
  rules: PolicyRule[] | null
  isMdm: boolean
}

/**
 * The policies on one host, first wins (plans/030 §3): the MDM policy, then each
 * organization's host policy and its organization policy.
 */
export function appliedPolicies(set: PolicySet | undefined, organizations: readonly { organizationId: string; name: string }[]): AppliedPolicy[] {
  if (!set) return []
  const out: AppliedPolicy[] = []
  if (set.mdm) {
    out.push({
      key: 'mdm',
      title: 'MDM policy',
      detail: `From ${set.mdm.document.organization.name}. Applies to all work on this host. Change it with your MDM tool.`,
      rules: policyRules(set.mdm.document),
      isMdm: true,
    })
  }
  for (const [organizationId, entry] of Object.entries(set.organizations)) {
    if (entry.state === 'unenforceable') {
      out.push({ key: organizationId, title: `${entry.organizationName} policy`, detail: entry.reason, rules: null, isMdm: false })
      continue
    }
    if (entry.state === 'unavailable') {
      const name = organizations.find((organization) => organization.organizationId === organizationId)?.name ?? 'An organization'
      out.push({ key: organizationId, title: `${name} policy`, detail: 'This host has not received this policy yet. Its work waits until it does.', rules: null, isMdm: false })
      continue
    }
    const name = entry.policy.document.organization.name
    if (entry.hostPolicy) {
      const ownsHost = set.hostOwnerOrganizationId === organizationId && !set.mdm && entry.hostPolicy.document.host !== undefined
      out.push({
        key: `${organizationId}:host`,
        title: entry.hostPolicy.document.name ?? 'Host policy',
        detail: ownsHost
          ? `Host policy of ${name}. Its host settings apply to all work on this host; its other rules apply to ${name}'s work.`
          : `Host policy of ${name}. Applies to ${name}'s work on this host.`,
        rules: policyRules(entry.hostPolicy.document),
        isMdm: false,
      })
    }
    out.push({ key: `${organizationId}:organization`, title: `${name} policy`, detail: `Organization policy. Applies to ${name}'s work on every host.`, rules: policyRules(entry.policy.document), isMdm: false })
  }
  return out
}

/** A document read from Solus Cloud; null when this Solus version cannot decode it (`readPolicy`). */
export function storedPolicyRules(document: PolicyDocument | null): PolicyRule[] | null {
  return document ? policyRules(document) : null
}

export function policyRules(document: PolicyDocument): PolicyRule[] {
  return [...hostRules(document.host), ...settingRules(document.sessions?.settings), ...limitRules(document.sessions?.limits)]
}

function onOff(value: boolean): string {
  return value ? 'On' : 'Off'
}

function days(count: number): string {
  return count === 1 ? '1 day' : `${count} days`
}

function hostRules(host: ManagedHostSettings | undefined): PolicyRule[] {
  if (!host) return []
  const rules: PolicyRule[] = []
  const add = (key: keyof ManagedHostSettings, value: string) => rules.push({ label: HOST_KEY_LABELS[key], value })
  if (host.remoteAccess !== undefined) add('remoteAccess', remoteAccessText(host.remoteAccess))
  if (host.trustLocalNetwork !== undefined) add('trustLocalNetwork', onOff(host.trustLocalNetwork))
  if (host.cloudTunnel !== undefined) add('cloudTunnel', onOff(host.cloudTunnel))
  if (host.previewTunnelEnabled !== undefined) add('previewTunnelEnabled', onOff(host.previewTunnelEnabled))
  if (host.analyticsEnabled !== undefined) add('analyticsEnabled', onOff(host.analyticsEnabled))
  if (host.otel) add('otel', host.otel.enabled === undefined ? 'Set' : onOff(host.otel.enabled))
  if (host.solusTools) add('solusTools', solusToolsText(host.solusTools))
  if (host.continueSessionsAfterHostRestart !== undefined) add('continueSessionsAfterHostRestart', onOff(host.continueSessionsAfterHostRestart))
  if (host.archivedAutomationRetentionDays !== undefined) add('archivedAutomationRetentionDays', days(host.archivedAutomationRetentionDays))
  if (host.unfiledRecordingRetentionDays !== undefined) add('unfiledRecordingRetentionDays', days(host.unfiledRecordingRetentionDays))
  if (host.updates) add('updates', host.updates.mode === 'auto' ? 'Automatic' : 'Off')
  return rules
}

function remoteAccessText(value: NonNullable<ManagedHostSettings['remoteAccess']>): string {
  if (value === true) return 'On'
  if (value === false || value === 'off') return 'Off'
  return value === 'private' ? 'Private networks only' : 'Any network'
}

function solusToolsText(tools: NonNullable<ManagedHostSettings['solusTools']>): string {
  const values = Object.values(tools)
  const on = values.filter((value) => value === true).length
  const off = values.length - on
  return [on ? `${on} on` : null, off ? `${off} off` : null].filter(Boolean).join(', ') || 'Set'
}

type SettingValue<K extends ManagedSessionSettingKey> = Exclude<ManagedSessionSettings[K], undefined>

/** How each locked setting reads. */
type SettingTextFormatters = { [K in ManagedSessionSettingKey]: (value: SettingValue<K>) => string }

const SETTING_TEXT: SettingTextFormatters = {
  workerModel: (value) => value?.model ?? 'Default',
  fallbackModel: (value) => value?.model ?? 'None',
  modelRouting: () => 'Set',
  textGenerationModel: (value) => value.model,
  sourceControlWriterModel: (value) => value?.model ?? 'Same as text generation',
  extraInstructions: quoted,
  modelInstructions: (value) => (Object.keys(value).length === 1 ? '1 model' : `${Object.keys(value).length} models`),
  delegationInstructions: quoted,
  sourceControlWriting: (value) => words(value.mode),
  worktreeBranchNaming: () => 'Set',
  codebaseNaming: () => 'Set',
  defaultPermissionMode: (value) => PERMISSION_MODE_LABELS[value],
  rateLimitBehavior: words,
  reviewAgent: (value) => AGENT_LABELS[value],
  reviewModel: (value) => value,
  reviewGuideInstructions: quoted,
}

function settingRules(settings: ManagedSessionSettings | undefined): PolicyRule[] {
  if (!settings) return []
  return MANAGED_SESSION_SETTING_KEYS.flatMap((key) => {
    const value = settingText(settings, key)
    return value === null ? [] : [{ label: SESSION_SETTING_LABELS[key], value }]
  })
}

/** The text of one locked setting; null when the policy does not set it. */
function settingText<K extends ManagedSessionSettingKey>(settings: ManagedSessionSettings, key: K): string | null {
  const value = settings[key]
  if (value === undefined) return null
  // SAFETY: `value` is `settings[key]` with `undefined` excluded above; TypeScript does not narrow an indexed generic.
  return SETTING_TEXT[key](value as SettingValue<K>)
}

/** Free text, cut short: the rule names it, the editor shows all of it. */
function quoted(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return 'Empty'
  return trimmed.length > 48 ? `“${trimmed.slice(0, 47)}…”` : `“${trimmed}”`
}

/** `repo_conventions` → "Repo conventions". */
function words(value: string): string {
  const spaced = value.replace(/[_-]/g, ' ')
  return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`
}

function limitRules(limits: SessionLimits | undefined): PolicyRule[] {
  if (!limits) return []
  const rules: PolicyRule[] = []
  if (limits.maxPermissionMode) rules.push({ label: 'Highest permission mode', value: PERMISSION_MODE_LABELS[limits.maxPermissionMode] })
  if (limits.providers?.allowed) rules.push({ label: 'Allowed agents', value: limits.providers.allowed.map((provider) => AGENT_LABELS[provider]).join(', ') })
  for (const provider of AGENT_IDS) {
    const models = limits.models?.[provider]
    if (models) rules.push({ label: `Allowed ${AGENT_LABELS[provider]} models`, value: models.join(', ') })
  }
  for (const provider of AGENT_IDS) {
    if (limits.providers?.launch?.[provider]) rules.push({ label: `${AGENT_LABELS[provider]} launch settings`, value: 'Pinned' })
  }
  if (limits.sessionCloudSync !== undefined) rules.push({ label: 'Cloud copy of sessions', value: onOff(limits.sessionCloudSync) })
  if (limits.insights) rules.push({ label: 'Send all Insights', value: onOff(limits.insights.syncAll) })
  if (limits.webhooks) rules.push({ label: 'Unverified webhooks', value: limits.webhooks.allowUnverified ? 'Allowed' : 'Not allowed' })
  return rules
}
