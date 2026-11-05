// ─── Host policies (plans/030 §3, §6) ───
//
// The one model of what governs work on a host, shared by the host (which
// enforces it) and every client (which shows it). `HostPolicies` holds the MDM
// policy and each organization's policies; `forWork` gives the `WorkPolicy` of
// one organization's work. A rule answers with a value, or a denial says why
// not — never a thrown error, so the host decides how to refuse and a client
// decides how to show it.

import {
  LOCAL_POLICY_ORGANIZATION_ID,
  capabilityDeniedMessage,
  clampPermissionMode,
  isPermissionModeAbove,
  modelDeniedMessage,
  permissionCeilingMessage,
  providerDeniedMessage,
  settingManagedMessage,
  summarizePolicySet,
  type ManagedHostKey,
  type ManagedHostSettings,
  type ManagedSessionSettingKey,
  type ManagedSessionSettings,
  type PolicyRefusalCode,
  type PolicySet,
  type PolicySource,
  type ProviderLaunchPin,
  type SessionLimits,
  POLICY_PROVIDER_IDS,
} from './policy'
import type { AgentId, PermissionMode } from './types'

/** Why a policy refuses something, in the words every client shows. */
export interface PolicyRefusal {
  code: PolicyRefusalCode
  message: string
}

/** A rule's value and the policy that sets it. */
export interface ResolvedRule<Value> {
  value: Value
  source: PolicySource
}

/** A locked setting with the words that say who locks it: "Lead model is managed by Globex." */
export interface SettingLock<Value> extends ResolvedRule<Value> {
  message: string
}

/** What a run would use. */
export interface RunRequest {
  mode: PermissionMode
  provider: AgentId
  /** The final model id; null or absent when it is not known yet (Auto routing). */
  model?: string | null
}

/** Whether the policies own a provider's launch (a ceiling is set), and the pin laid over it. */
export interface LaunchPolicy {
  ownsLaunch: boolean
  pin: ProviderLaunchPin | null
  /** The policy that owns or pins the launch; null when none does. */
  source: PolicySource | null
}

type LockedSetting<K extends ManagedSessionSettingKey> = Exclude<ManagedSessionSettings[K], undefined>
type HostSetting<K extends ManagedHostKey> = NonNullable<ManagedHostSettings[K]>
type PolicyProviderId = (typeof POLICY_PROVIDER_IDS)[number]

/** Everything that governs work on one host: the MDM policy and each organization's policies. */
export class HostPolicies {
  static readonly none = new HostPolicies({ mdm: null, hostOwnerOrganizationId: null, organizations: {} })

  constructor(readonly set: PolicySet) {}

  /** What governs work of `organizationId` here (`local` or absent: personal work). */
  forWork(organizationId: string | null | undefined): WorkPolicy {
    return WorkPolicy.resolve(this.set, organizationId || LOCAL_POLICY_ORGANIZATION_ID)
  }

  /** A machine-wide key: the MDM policy's, else the host-owning organization's host policy's (§3). */
  hostSetting<K extends ManagedHostKey>(key: K): ResolvedRule<HostSetting<K>> | null {
    for (const source of this.hostSources()) {
      const value = source.document.host?.[key]
      if (value !== undefined) {
        // SAFETY: `value` is `host[key]`, checked not undefined above, and host values are never null.
        return { value: value as HostSetting<K>, source }
      }
    }
    return null
  }

  hostSettingLock<K extends ManagedHostKey>(key: K, label: string): SettingLock<HostSetting<K>> | null {
    const rule = this.hostSetting(key)
    return rule ? { ...rule, message: settingManagedMessage(label, rule.source) } : null
  }

  /** Why the person cannot change a host key, or null when it is theirs. */
  settingChangeDenial(key: ManagedHostKey, label: string): PolicyRefusal | null {
    const lock = this.hostSettingLock(key, label)
    return lock ? { code: 'SETTING_MANAGED', message: lock.message } : null
  }

  /** Why a capability a host key turns off cannot be used, or null when it can. */
  capabilityDenial(key: 'remoteAccess' | 'cloudTunnel', capability: string): PolicyRefusal | null {
    const rule = this.hostSetting(key)
    if (!rule || rule.value) return null
    return { code: key === 'remoteAccess' ? 'REMOTE_ACCESS_NOT_ALLOWED' : 'CLOUD_TUNNEL_NOT_ALLOWED', message: capabilityDeniedMessage(rule.source, capability) }
  }

  /** "<Name> manages Solus updates." when a policy turns updates off; null when the person decides. */
  updatesManagedMessage(): string | null {
    const rule = this.hostSetting('updates')
    return rule?.value.mode === 'off' ? `${rule.source.document.organization.name} manages Solus updates.` : null
  }

  /** What clients may see: launch pin values and the update feed are left out. */
  summary(): HostPolicies {
    return new HostPolicies(summarizePolicySet(this.set))
  }

  private hostSources(): PolicySource[] {
    if (this.set.mdm) return [this.set.mdm]
    const owner = this.set.hostOwnerOrganizationId ? this.set.organizations[this.set.hostOwnerOrganizationId] : undefined
    return owner?.state === 'ready' && owner.hostPolicy ? [owner.hostPolicy] : []
  }
}

/**
 * What governs one organization's work on one host: the MDM policy, then the
 * organization's host policy for this host, then its organization policy — first
 * wins (§3). Work of one organization never sees another organization's policies.
 * When the host cannot know the policies (`refusal`), every run is denied and no
 * setting is locked.
 */
export class WorkPolicy {
  private constructor(
    readonly organizationId: string,
    readonly sources: readonly PolicySource[],
    readonly refusal: PolicyRefusal | null,
  ) {}

  static resolve(set: PolicySet, organizationId: string): WorkPolicy {
    const refused = (refusal: PolicyRefusal) => new WorkPolicy(organizationId, [], refusal)
    const owner = set.mdm || !set.hostOwnerOrganizationId ? null : set.organizations[set.hostOwnerOrganizationId]
    // An unreadable policy of the host-owning organization stops all work here: its `host` section cannot be applied.
    if (set.hostOwnerOrganizationId && !set.mdm) {
      if (owner?.state === 'unenforceable') return refused({ code: 'POLICY_UNENFORCEABLE', message: `This host's Solus version cannot enforce ${owner.organizationName}'s host policy. Update Solus.` })
      if (!owner || owner.state === 'unavailable') return refused({ code: 'POLICY_UNAVAILABLE', message: 'This host has not received its host policy yet. Connect to Solus Cloud and try again.' })
    }
    const sources: PolicySource[] = set.mdm ? [set.mdm] : []
    if (organizationId === LOCAL_POLICY_ORGANIZATION_ID) return new WorkPolicy(organizationId, sources, null)
    const entry = set.organizations[organizationId]
    if (!entry || entry.state === 'unavailable') return refused({ code: 'POLICY_UNAVAILABLE', message: "This host has not received this organization's policy yet. Connect to Solus Cloud and try again." })
    if (entry.state === 'unenforceable') return refused({ code: 'POLICY_UNENFORCEABLE', message: `This host's Solus version cannot enforce ${entry.organizationName}'s policy. Update Solus.` })
    if (entry.hostPolicy) sources.push(entry.hostPolicy)
    sources.push(entry.policy)
    return new WorkPolicy(organizationId, sources, null)
  }

  /** A locked setting; its value can be `null` where the setting allows it (`leadModel: null` locks "the default"). */
  setting<K extends ManagedSessionSettingKey>(key: K): ResolvedRule<LockedSetting<K>> | null {
    for (const source of this.sources) {
      const value = source.document.sessions?.settings?.[key]
      if (value !== undefined) {
        // SAFETY: `value` is `settings[key]` with `undefined` excluded above; TypeScript loses the key's narrowing through the optional chain.
        return { value: value as LockedSetting<K>, source }
      }
    }
    return null
  }

  settingLock<K extends ManagedSessionSettingKey>(key: K, label: string): SettingLock<LockedSetting<K>> | null {
    const rule = this.setting(key)
    return rule ? { ...rule, message: settingManagedMessage(label, rule.source) } : null
  }

  limit<K extends keyof SessionLimits>(key: K): ResolvedRule<NonNullable<SessionLimits[K]>> | null {
    for (const source of this.sources) {
      const value = source.document.sessions?.limits?.[key]
      if (value !== undefined) {
        // SAFETY: `value` is `limits[key]`, checked not undefined above, and limit values are never null.
        return { value: value as NonNullable<SessionLimits[K]>, source }
      }
    }
    return null
  }

  ceiling(): ResolvedRule<PermissionMode> | null {
    return this.limit('maxPermissionMode')
  }

  modeDenial(mode: PermissionMode): PolicyRefusal | null {
    if (this.refusal) return this.refusal
    const ceiling = this.ceiling()
    if (!ceiling || !isPermissionModeAbove(mode, ceiling.value)) return null
    return { code: 'PERMISSION_MODE_ABOVE_LIMIT', message: permissionCeilingMessage(ceiling.source, ceiling.value) }
  }

  providerDenial(provider: AgentId): PolicyRefusal | null {
    if (this.refusal) return this.refusal
    const rule = this.limit('providers')
    if (!rule?.value.allowed || rule.value.allowed.some((allowed) => allowed === provider)) return null
    return { code: 'PROVIDER_NOT_ALLOWED', message: providerDeniedMessage(rule.source, provider) }
  }

  /** A provider the policy does not name is not limited. */
  modelDenial(provider: AgentId, model: string): PolicyRefusal | null {
    const providerDenied = this.providerDenial(provider)
    if (providerDenied) return providerDenied
    const rule = this.limit('models')
    const allowed = byProvider(rule?.value, provider)
    if (!rule || !allowed || allowed.includes(model)) return null
    return { code: 'MODEL_NOT_ALLOWED', message: modelDeniedMessage(rule.source, model) }
  }

  /** Why work cannot be saved or switched to this provider (and model), or null when it can. */
  selectionDenial(provider: AgentId, model?: string | null): PolicyRefusal | null {
    return model ? this.modelDenial(provider, model) : this.providerDenial(provider)
  }

  /** Why a run cannot start, or null when it can: the policies' state, then the ceiling, the provider, and the model. */
  runDenial(run: RunRequest): PolicyRefusal | null {
    return this.modeDenial(run.mode) ?? this.selectionDenial(run.provider, run.model)
  }

  /** A default or an automatic grant, lowered to the ceiling. When the policies cannot be known it stays; the run is refused later. */
  clampMode(mode: PermissionMode): PermissionMode {
    return clampPermissionMode(mode, this.ceiling()?.value)
  }

  /** The mode new work starts in: a locked default wins over the person's, and both are lowered to the ceiling. */
  defaultMode(personal: PermissionMode): PermissionMode {
    return this.clampMode(this.setting('defaultPermissionMode')?.value ?? personal)
  }

  launch(provider: AgentId): LaunchPolicy {
    const ceiling = this.ceiling()
    for (const source of this.sources) {
      const pin = byProvider(source.document.sessions?.limits?.providers?.launch, provider)
      if (pin) return { ownsLaunch: ceiling !== null, pin, source }
    }
    return { ownsLaunch: ceiling !== null, pin: null, source: ceiling?.source ?? null }
  }

  /** `values` with the locked ones among `keys` laid over them; the person's values are never changed. */
  withLocks<Values extends object>(values: Values, keys: readonly ManagedSessionSettingKey[]): Values {
    let next: Values | null = null
    for (const key of keys) {
      const rule = this.setting(key)
      if (!rule) continue
      next ??= { ...values }
      Object.assign(next, { [key]: rule.value })
    }
    return next ?? values
  }

  /** Whether every session of the organization sends its Insights; null when no policy says. */
  syncsAllInsights(): boolean | null {
    return this.limit('insights')?.value.syncAll ?? null
  }

  /** An unverified webhook may start this work. Off unless a policy turns it on; personal work is allowed unless the MDM policy says no. */
  allowsUnverifiedWebhooks(): boolean {
    if (this.refusal) return false
    return this.limit('webhooks')?.value.allowUnverified ?? this.organizationId === LOCAL_POLICY_ORGANIZATION_ID
  }
}

/** The entry of a by-provider record for `provider`; the record names only the providers a policy can name. */
function byProvider<Value>(record: Partial<Record<PolicyProviderId, Value>> | undefined, provider: AgentId): Value | undefined {
  const id = POLICY_PROVIDER_IDS.find((candidate) => candidate === provider)
  return id && record ? record[id] : undefined
}
