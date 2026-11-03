import { EMPTY_POLICY_SET, LOCAL_POLICY_ORGANIZATION_ID, type PolicySet } from '@solus/contracts/policy'
import { sessionPolicy, type SessionPolicy } from '@solus/client-core/policy'
import { hosts } from '../hosts/hosts.svelte'
import { organizationSelection } from '../connections/organization-selection.store.svelte'

/**
 * The policy a client shows for work on one host (plans/030 §7). Work keeps the
 * organization of its record; new work takes the window's organization. Until
 * the host answers, nothing is locked: the host enforces every rule anyway.
 */
export function policySetOn(serverId: string): PolicySet {
  return hosts.get(serverId).policySet ?? EMPTY_POLICY_SET
}

/** `organizationId`: the session's record organization; null or undefined for work that has not started. */
export function workPolicy(serverId: string, organizationId?: string | null): SessionPolicy {
  const organization = organizationId ?? organizationSelection.activeOrganizationId ?? LOCAL_POLICY_ORGANIZATION_ID
  const set = hosts.get(serverId).policySet
  // A summary not read yet is no rule, never a refusal: the picker does not flash locked.
  return set ? sessionPolicy(set, organization) : { organizationId: organization, refusal: null, sources: [] }
}
