import {
  LOCAL_POLICY_ORGANIZATION_ID,
  capabilityDeniedMessage,
  clampPermissionMode,
  isPermissionModeAbove,
  modelDeniedMessage,
  permissionCeilingMessage,
  providerDeniedMessage,
  resolveHostKey,
  resolveSessionLimit,
  resolveSessionSetting,
  sessionSourcesFor,
  settingManagedMessage,
  summarizePolicySet,
  validatePolicyDocument,
  MANAGED_SESSION_SETTING_KEYS,
  type ManagedHostKey,
  type ManagedHostSettings,
  type OrganizationPolicies,
  type PolicyRefusalCode,
  type PolicySet,
  type PolicySource,
  type ProviderLaunchPin,
  type ResolvedRule,
} from '@solus/contracts/policy'
import type { ExecutionPreferences } from '@solus/contracts/settings'
import type { AgentId, PermissionMode } from '@solus/contracts/types'
import { createLogger } from '../../logger'
import type { HostStanding } from '../organizations'
import type { MdmPolicy } from './mdm-policy'

const log = createLogger('main', 'policy-gate')

/** A policy refused work. The transport sends its code like a turn refusal's, so clients keep the draft and say why. */
export class PolicyRefusedError extends Error {
  constructor(readonly code: PolicyRefusalCode, message: string) {
    super(message)
    this.name = 'PolicyRefusedError'
  }
}

/** The review keys travel in the request's settings, not in its execution preferences. */
export interface ReviewSettings {
  reviewAgent?: AgentId | null
  reviewModel?: string | null
  reviewGuideInstructions?: string
}

const REVIEW_KEYS = ['reviewAgent', 'reviewModel', 'reviewGuideInstructions'] as const

/**
 * The one module that reads a policy document on the host (plans/030 §6.1). It
 * builds the `PolicySet` from the MDM policy and the standing, and answers every
 * enforcement point: what governs work of an organization here, its ceiling, its
 * allowed providers and models, its locked settings, and the host's locked keys.
 * Work of one organization never sees another organization's policies.
 */
export class PolicyGate {
  private cached: { standing: HostStanding | null; set: PolicySet } | null = null
  private readonly listeners = new Set<() => void>()

  constructor(private readonly deps: { mdm: MdmPolicy | null; standing: () => HostStanding | null }) {}

  /** The MDM policy this host loaded at start; null when none. */
  mdm(): MdmPolicy | null {
    return this.deps.mdm
  }

  policySet(): PolicySet {
    const standing = this.deps.standing()
    if (this.cached && this.cached.standing === standing) return this.cached.set
    const set = buildPolicySet(this.deps.mdm, standing)
    this.cached = { standing, set }
    return set
  }

  /** What clients see: no launch pins, no update feed. */
  summary(): PolicySet {
    return summarizePolicySet(this.policySet())
  }

  /** The standing changed: forget the built set and tell the listeners. */
  standingChanged(): void {
    this.cached = null
    for (const listener of this.listeners) {
      try { listener() } catch (error) {
        log.warn('policy_listener_failed', { error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** The documents that govern work of `organizationId`, first wins. Throws when they cannot be known. */
  sources(organizationId: string | null | undefined): PolicySource[] {
    const result = sessionSourcesFor(this.policySet(), organizationId || LOCAL_POLICY_ORGANIZATION_ID)
    if (!result.ok) throw new PolicyRefusedError(result.code, result.message)
    return result.sources
  }

  /** The ceiling for work of `organizationId`, with the policy that set it. */
  ceiling(organizationId: string | null | undefined): ResolvedRule<PermissionMode> | null {
    return resolveSessionLimit(this.sources(organizationId), 'maxPermissionMode')
  }

  /** Refuse a run above the ceiling, on a provider that is not allowed, or on a model that is not allowed. */
  checkRun(organizationId: string | null | undefined, run: { mode: PermissionMode; provider: AgentId; model?: string | null }): void {
    const sources = this.sources(organizationId)
    const ceiling = resolveSessionLimit(sources, 'maxPermissionMode')
    if (ceiling && isPermissionModeAbove(run.mode, ceiling.value)) {
      throw new PolicyRefusedError('PERMISSION_MODE_ABOVE_LIMIT', `${permissionCeilingMessage(ceiling.source, ceiling.value)} Lower the mode to continue.`)
    }
    const providers = resolveSessionLimit(sources, 'providers')
    if (providers?.value.allowed && !providers.value.allowed.includes(run.provider)) {
      throw new PolicyRefusedError('PROVIDER_NOT_ALLOWED', providerDeniedMessage(providers.source, run.provider))
    }
    const models = resolveSessionLimit(sources, 'models')
    const allowedModels = models?.value[run.provider]
    if (models && allowedModels && run.model && !allowedModels.includes(run.model)) {
      throw new PolicyRefusedError('MODEL_NOT_ALLOWED', modelDeniedMessage(models.source, run.model))
    }
  }

  /** A default or an automatic grant, lowered to the ceiling. Unknown policies leave it as it is; `checkRun` refuses later. */
  clampMode(organizationId: string | null | undefined, mode: PermissionMode): PermissionMode {
    try {
      return clampPermissionMode(mode, this.ceiling(organizationId)?.value)
    } catch {
      return mode
    }
  }

  isProviderAllowed(organizationId: string | null | undefined, provider: AgentId): boolean {
    try {
      const allowed = resolveSessionLimit(this.sources(organizationId), 'providers')?.value.allowed
      return !allowed || allowed.includes(provider)
    } catch {
      return false
    }
  }

  isModelAllowed(organizationId: string | null | undefined, provider: AgentId, model: string): boolean {
    try {
      const allowed = resolveSessionLimit(this.sources(organizationId), 'models')?.value[provider]
      return !allowed || allowed.includes(model)
    } catch {
      return false
    }
  }

  /** Refuse saving or switching to a provider (and model) the policies do not allow. */
  assertProviderAllowed(organizationId: string | null | undefined, provider: AgentId, model?: string | null): void {
    const sources = this.sources(organizationId)
    const providers = resolveSessionLimit(sources, 'providers')
    if (providers?.value.allowed && !providers.value.allowed.includes(provider)) {
      throw new PolicyRefusedError('PROVIDER_NOT_ALLOWED', providerDeniedMessage(providers.source, provider))
    }
    const models = resolveSessionLimit(sources, 'models')
    const allowedModels = models?.value[provider]
    if (models && allowedModels && model && !allowedModels.includes(model)) {
      throw new PolicyRefusedError('MODEL_NOT_ALLOWED', modelDeniedMessage(models.source, model))
    }
  }

  /** The reason a provider is not allowed, for pickers; null when it is allowed. */
  providerDenial(organizationId: string | null | undefined, provider: AgentId): string | null {
    try {
      const providers = resolveSessionLimit(this.sources(organizationId), 'providers')
      return providers?.value.allowed && !providers.value.allowed.includes(provider) ? providerDeniedMessage(providers.source, provider) : null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  /** The launch pin of `provider` and whether the policy owns the whole launch config (a ceiling is set). */
  launchPolicy(organizationId: string | null | undefined, provider: AgentId): { ownsLaunch: boolean; pin: ProviderLaunchPin | null } {
    const sources = this.sources(organizationId)
    const ownsLaunch = resolveSessionLimit(sources, 'maxPermissionMode') !== null
    for (const source of sources) {
      const pin = source.document.sessions?.limits?.providers?.launch?.[provider]
      if (pin) return { ownsLaunch, pin }
    }
    return { ownsLaunch, pin: null }
  }

  /** Lay the locked session settings over what a request carries. The person's stored settings never change. */
  applyExecutionPreferences(organizationId: string | null | undefined, preferences: ExecutionPreferences): ExecutionPreferences {
    const sources = this.sources(organizationId)
    let next: ExecutionPreferences | null = null
    for (const key of MANAGED_SESSION_SETTING_KEYS) {
      if ((REVIEW_KEYS as readonly string[]).includes(key)) continue
      const rule = resolveSessionSetting(sources, key)
      if (!rule) continue
      next ??= { ...preferences }
      Object.assign(next, { [key]: rule.value })
    }
    if (next) log.debug('setting_lock_applied', { organizationId: organizationId ?? LOCAL_POLICY_ORGANIZATION_ID })
    return next ?? preferences
  }

  applyReviewSettings<Settings extends ReviewSettings>(organizationId: string | null | undefined, settings: Settings): Settings {
    const sources = this.sources(organizationId)
    let next: Settings | null = null
    for (const key of REVIEW_KEYS) {
      const rule = resolveSessionSetting(sources, key)
      if (!rule) continue
      next ??= { ...settings }
      Object.assign(next, { [key]: rule.value })
    }
    return next ?? settings
  }

  /** A host key the MDM policy or the host-owning organization locks; null when none does. */
  hostKey<K extends ManagedHostKey>(key: K): ResolvedRule<NonNullable<ManagedHostSettings[K]>> | null {
    return resolveHostKey(this.policySet(), key)
  }

  /** Refuse a change of a locked host key. */
  assertHostKeyUnlocked(key: ManagedHostKey, label: string): void {
    const rule = this.hostKey(key)
    if (rule) throw new PolicyRefusedError('SETTING_MANAGED', settingManagedMessage(label, rule.source))
  }

  /** Refuse a capability that a host key turns off (`remoteAccess`, `cloudTunnel`). */
  assertHostCapability(key: 'remoteAccess' | 'cloudTunnel', code: 'REMOTE_ACCESS_NOT_ALLOWED' | 'CLOUD_TUNNEL_NOT_ALLOWED', capability: string): void {
    const rule = this.hostKey(key)
    if (rule && rule.value === false) throw new PolicyRefusedError(code, capabilityDeniedMessage(rule.source, capability))
  }

  /** Whether every session of the organization sends its Insights; null when no policy says. */
  syncAllInsights(organizationId: string): boolean | null {
    try {
      return resolveSessionLimit(this.sources(organizationId), 'insights')?.value.syncAll ?? null
    } catch {
      return null
    }
  }

  /** An unverified webhook may start work of this organization. Off unless a policy turns it on; `local` is allowed unless the MDM policy says no. */
  allowsUnverifiedWebhooks(organizationId: string): boolean {
    try {
      const rule = resolveSessionLimit(this.sources(organizationId), 'webhooks')
      if (rule) return rule.value.allowUnverified
      return organizationId === LOCAL_POLICY_ORGANIZATION_ID
    } catch {
      return false
    }
  }
}

/** Decode each organization's documents; one that does not decode makes that organization unenforceable, not the host. */
export function buildPolicySet(mdm: MdmPolicy | null, standing: HostStanding | null): PolicySet {
  const set: PolicySet = {
    mdm: mdm ? { kind: 'mdm', organizationId: null, document: mdm.document } : null,
    hostOwnerOrganizationId: standing?.hostOwnerOrganizationId ?? null,
    organizations: {},
  }
  for (const organization of standing?.organizations ?? []) {
    set.organizations[organization.organizationId] = decodeOrganization(organization.organizationId, organization.name, organization.policy, organization.hostPolicy)
  }
  return set
}

function decodeOrganization(organizationId: string, name: string, policy: unknown, hostPolicy: { policyId: string; document: unknown } | null): OrganizationPolicies {
  const decodedPolicy = validatePolicyDocument(policy, 'organization')
  if (!decodedPolicy.ok) {
    log.warn('organization_policy_unenforceable', { organizationId, issues: decodedPolicy.issues })
    return { state: 'unenforceable', organizationName: name, reason: decodedPolicy.issues.join('; ') }
  }
  let decodedHost: PolicySource | null = null
  if (hostPolicy) {
    const result = validatePolicyDocument(hostPolicy.document, 'host')
    if (!result.ok) {
      log.warn('host_policy_unenforceable', { organizationId, policyId: hostPolicy.policyId, issues: result.issues })
      return { state: 'unenforceable', organizationName: name, reason: result.issues.join('; ') }
    }
    decodedHost = { kind: 'host', organizationId, document: result.document }
  }
  return { state: 'ready', policy: { kind: 'organization', organizationId, document: decodedPolicy.document }, hostPolicy: decodedHost }
}

let installed = new PolicyGate({ mdm: null, standing: () => null })

/** The boot installs the host's gate; tests install their own. Until then, nothing is managed. */
export function usePolicyGate(gate: PolicyGate): void {
  installed = gate
}

export function policyGate(): PolicyGate {
  return installed
}
