import { LOCAL_POLICY_ORGANIZATION_ID } from '@solus/contracts/policy'
import { HostPolicies, type WorkPolicy } from '@solus/contracts/host-policies'
import { hosts } from '../hosts/hosts.svelte'
import { organizationSelection } from '../connections/organization-selection.store.svelte'

/**
 * The policy a client shows for work on one host (plans/030 §7). Work keeps the
 * organization of its record; new work takes the window's organization. Until
 * the host answers, nothing is locked: the host enforces every rule anyway.
 */
export function policiesOn(serverId: string): HostPolicies {
  return hosts.get(serverId).policies ?? HostPolicies.none
}

/** `organizationId`: the session's record organization; null or undefined for work that has not started. */
export function workPolicy(serverId: string, organizationId?: string | null): WorkPolicy {
  const policies = hosts.get(serverId).policies
  // A summary not read yet is no rule, never a refusal: the picker does not flash locked.
  if (!policies) return HostPolicies.none.forWork(LOCAL_POLICY_ORGANIZATION_ID)
  return policies.forWork(organizationId ?? organizationSelection.activeOrganizationId)
}
