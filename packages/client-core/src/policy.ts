import {
  clampPermissionMode,
  isPermissionModeAbove,
  modelDeniedMessage,
  permissionCeilingMessage,
  policySourceLabel,
  providerDeniedMessage,
  resolveHostKey,
  resolveSessionLimit,
  resolveSessionSetting,
  sessionSourcesFor,
  settingManagedMessage,
  type ManagedHostKey,
  type ManagedHostSettings,
  type ManagedSessionSettingKey,
  type ManagedSessionSettings,
  type PolicySet,
  type PolicySource,
  type ResolvedRule,
  POLICY_PROVIDER_IDS,
} from '@solus/contracts/policy'
import type { AgentId, PermissionMode } from '@solus/contracts/types'

/**
 * What governs work of one organization on one host, for clients (plans/030 §7).
 * The host enforces every rule; this only shows them. It reads the summary the
 * host gives (`hostPolicy`) and uses the contract's resolution, so desktop, web,
 * and mobile show the same locks the host applies.
 */
export interface SessionPolicy {
  /** The organization the work belongs to; `local` is personal work. */
  organizationId: string
  /** The host cannot run this organization's work now: the policy is missing or too new. Null when it can. */
  refusal: { code: 'POLICY_UNAVAILABLE' | 'POLICY_UNENFORCEABLE'; message: string } | null
  /** The documents that apply, first wins. Empty when there is a refusal. */
  sources: PolicySource[]
}

export function sessionPolicy(set: PolicySet, organizationId: string): SessionPolicy {
  const result = sessionSourcesFor(set, organizationId)
  return result.ok
    ? { organizationId, refusal: null, sources: result.sources }
    : { organizationId, refusal: { code: result.code, message: result.message }, sources: [] }
}

/** A managed session setting: its locked value and the words that say who locks it. */
export interface SettingLock<Value> {
  value: Value
  source: PolicySource
  /** "Lead model is managed by Globex." */
  message: string
}

export function settingLock<K extends ManagedSessionSettingKey>(
  policy: SessionPolicy,
  key: K,
  label: string,
): SettingLock<Exclude<ManagedSessionSettings[K], undefined>> | null {
  const rule = resolveSessionSetting(policy.sources, key)
  return rule ? { value: rule.value, source: rule.source, message: settingManagedMessage(label, rule.source) } : null
}

/** The permission-mode ceiling, with the words a disabled mode shows. */
export function permissionCeiling(policy: SessionPolicy): { mode: PermissionMode; source: PolicySource; message: string } | null {
  const rule = resolveSessionLimit(policy.sources, 'maxPermissionMode')
  return rule ? { mode: rule.value, source: rule.source, message: permissionCeilingMessage(rule.source, rule.value) } : null
}

/** Why `mode` cannot be chosen, or null when it can. */
export function permissionModeDenial(policy: SessionPolicy, mode: PermissionMode): string | null {
  if (policy.refusal) return policy.refusal.message
  const ceiling = permissionCeiling(policy)
  return ceiling && isPermissionModeAbove(mode, ceiling.mode) ? ceiling.message : null
}

/** A default mode, lowered to the ceiling. A locked default wins over the person's own. */
export function clampedDefaultMode(policy: SessionPolicy, mode: PermissionMode): PermissionMode {
  const locked = resolveSessionSetting(policy.sources, 'defaultPermissionMode')
  return clampPermissionMode(locked?.value ?? mode, permissionCeiling(policy)?.mode)
}

/** Why `provider` cannot run this work, or null when it can. */
export function providerDenial(policy: SessionPolicy, provider: AgentId): string | null {
  if (policy.refusal) return policy.refusal.message
  const rule = resolveSessionLimit(policy.sources, 'providers')
  const allowed = rule?.value.allowed
  return rule && allowed && !allowed.some((id) => id === provider) ? providerDeniedMessage(rule.source, provider) : null
}

/** Why `model` of `provider` cannot run this work, or null when it can. A provider the policy does not name is not limited. */
export function modelDenial(policy: SessionPolicy, provider: AgentId, model: string): string | null {
  const denied = providerDenial(policy, provider)
  if (denied) return denied
  const rule = resolveSessionLimit(policy.sources, 'models')
  const allowed = providerEntry(rule?.value, provider)
  return rule && allowed && !allowed.includes(model) ? modelDeniedMessage(rule.source, model) : null
}

/** Every organization's sessions send their Insights (`sessions.limits.insights.syncAll`). */
export function syncsAllInsights(policy: SessionPolicy): boolean {
  return resolveSessionLimit(policy.sources, 'insights')?.value.syncAll === true
}

/** A machine-wide key the MDM policy or the host-owning organization locks. */
export interface HostKeyLock<K extends ManagedHostKey> {
  value: NonNullable<ManagedHostSettings[K]>
  source: PolicySource
  /** "Remote access is managed by the MDM policy of Example Corp." */
  message: string
}

export function hostKeyLock<K extends ManagedHostKey>(set: PolicySet, key: K, label: string): HostKeyLock<K> | null {
  const rule: ResolvedRule<NonNullable<ManagedHostSettings[K]>> | null = resolveHostKey(set, key)
  return rule ? { value: rule.value, source: rule.source, message: settingManagedMessage(label, rule.source) } : null
}

/** "<Name> manages Solus updates." when updates are off; null when the person decides. */
export function updatesManagedMessage(set: PolicySet): string | null {
  const rule = resolveHostKey(set, 'updates')
  return rule?.value.mode === 'off' ? `${rule.source.document.organization.name} manages Solus updates.` : null
}

/** The lines under a managed setting, and whether the MDM policy locks it for all work. */
export interface ManagedSettingLines {
  lockedEverywhere: boolean
  lines: string[]
}

/**
 * The line under a managed setting on a page that is not one session's, for each
 * organization that locks it here: "Globex sessions use Opus (managed)". The MDM
 * policy locks the key for all work, so it gives one line and `lockedEverywhere`.
 */
export function managedSettingLines<K extends ManagedSessionSettingKey>(
  set: PolicySet,
  organizations: readonly { organizationId: string; name: string }[],
  key: K,
  describe: (value: Exclude<ManagedSessionSettings[K], undefined>) => string,
): ManagedSettingLines {
  const mdm = set.mdm ? resolveSessionSetting([set.mdm], key) : null
  if (mdm) return { lockedEverywhere: true, lines: [`All sessions on this host use ${describe(mdm.value)} (${policySourceLabel(mdm.source)}).`] }
  const lines: string[] = []
  for (const organization of organizations) {
    if (organization.organizationId === 'local') continue
    const rule = resolveSessionSetting(sessionPolicy(set, organization.organizationId).sources, key)
    if (rule) lines.push(`${organization.name} sessions use ${describe(rule.value)} (managed).`)
  }
  return { lockedEverywhere: false, lines }
}

/**
 * The launch fields a policy owns for `provider` (§6.4). Under a ceiling the host
 * drops all of the person's launch fields; otherwise only the pinned ones are
 * replaced. The summary keeps each pin's field names with its values redacted.
 */
export interface LaunchLock {
  /** Every launch field: binary, arguments, environment, and home paths. */
  all: boolean
  binaryPath: boolean
  launchArgs: boolean
  /** The pinned environment variables by name; the person's others still apply. */
  environment: string[]
  message: string
}

export function launchLock(policy: SessionPolicy, provider: AgentId): LaunchLock | null {
  const ceiling = permissionCeiling(policy)
  if (ceiling) {
    return {
      all: true,
      binaryPath: true,
      launchArgs: true,
      environment: [],
      message: `${capitalize(policySourceLabel(ceiling.source))} sets how agents start. Your launch settings do not apply.`,
    }
  }
  const rule = resolveSessionLimit(policy.sources, 'providers')
  const pin = providerEntry(rule?.value.launch, provider)
  if (!rule || !pin) return null
  return {
    all: false,
    binaryPath: pin.binaryPath !== undefined,
    launchArgs: pin.launchArgs !== undefined,
    environment: pin.environment?.map((variable) => variable.name) ?? [],
    message: `${capitalize(policySourceLabel(rule.source))} pins some launch settings of this provider.`,
  }
}

/** The entry of a by-provider record for `provider`; the record names only the providers a policy can name. */
function providerEntry<Value>(record: Partial<Record<PolicyProviderId, Value>> | undefined, provider: AgentId): Value | undefined {
  const id = POLICY_PROVIDER_IDS.find((candidate) => candidate === provider)
  return id && record ? record[id] : undefined
}

type PolicyProviderId = (typeof POLICY_PROVIDER_IDS)[number]

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
