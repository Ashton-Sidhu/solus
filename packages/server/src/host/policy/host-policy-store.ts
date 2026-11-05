import { HostPolicies, type PolicyRefusal } from '@solus/contracts/host-policies'
import {
  MANAGED_SESSION_SETTING_KEYS,
  validatePolicyDocument,
  type ManagedSessionSettingKey,
  type OrganizationPolicies,
  type PolicyRefusalCode,
  type PolicySet,
  type PolicySource,
} from '@solus/contracts/policy'
import { createLogger } from '../../logger'
import type { HostStanding } from '../organizations'
import type { MdmPolicy } from './mdm-policy'

const log = createLogger('main', 'host-policy-store')

/** A policy refused work. The transport sends its code like a turn refusal's, so clients keep the draft and say why. */
export class PolicyRefusedError extends Error {
  constructor(readonly code: PolicyRefusalCode, message: string) {
    super(message)
    this.name = 'PolicyRefusedError'
  }
}

/** Refuse what a policy refuses: the host's one way to turn a `PolicyRefusal` into the error the transport sends. */
export function enforce(refusal: PolicyRefusal | null): void {
  if (refusal) throw new PolicyRefusedError(refusal.code, refusal.message)
}

/** The review keys travel in the request's settings; the rest of the manageable keys are execution preferences. */
export const REVIEW_SETTING_KEYS = ['reviewAgent', 'reviewModel', 'reviewGuideInstructions'] as const satisfies readonly ManagedSessionSettingKey[]
export const EXECUTION_SETTING_KEYS: readonly ManagedSessionSettingKey[] = MANAGED_SESSION_SETTING_KEYS.filter(
  (key) => !REVIEW_SETTING_KEYS.some((reviewKey) => reviewKey === key),
)

export interface HostPolicyStoreDeps {
  /** The MDM policy this host read at start; null when none is installed. */
  mdm: MdmPolicy | null
  /** The control plane's last answer, fresh or cached. */
  standing: () => HostStanding | null
}

/**
 * The host's current policies (plans/030 §6.1): built from the MDM policy and
 * the standing, rebuilt when the standing changes. Every enforcement point asks
 * `hostPolicies()` for the rules; no other module decodes a policy document.
 */
export class HostPolicyStore {
  private cached: { standing: HostStanding | null; policies: HostPolicies } | null = null
  private readonly listeners = new Set<() => void>()

  constructor(private readonly deps: HostPolicyStoreDeps) {}

  /** The MDM policy this host loaded at start; null when none. */
  mdm(): MdmPolicy | null {
    return this.deps.mdm
  }

  current(): HostPolicies {
    const standing = this.deps.standing()
    if (this.cached?.standing === standing) return this.cached.policies
    const policies = new HostPolicies(buildPolicySet(this.deps.mdm, standing))
    this.cached = { standing, policies }
    return policies
  }

  /** The standing changed: forget the built policies and tell the listeners. */
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

let installed = new HostPolicyStore({ mdm: null, standing: () => null })

/** The boot installs the host's store; tests install their own. Until then, nothing is managed. */
export function useHostPolicyStore(store: HostPolicyStore): void {
  installed = store
}

export function hostPolicyStore(): HostPolicyStore {
  return installed
}

/** The policies that govern work on this host now. */
export function hostPolicies(): HostPolicies {
  return installed.current()
}
