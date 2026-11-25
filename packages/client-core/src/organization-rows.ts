import type { MachineKind } from '@solus/contracts/uplink'
import type { HostOrganizationsStatus } from '@solus/contracts/organization-scope'
import type { HostPolicies } from '@solus/contracts/host-policies'

/**
 * The Organizations section's view model (docs/plans/organization-scope.md
 * §3.1, §6.1): what one machine's standing in each organization says, in words.
 * Pure, so the rule is tested without a host.
 */

export function machineKindLabel(kind: MachineKind): string {
  switch (kind) {
    case 'personal': return 'Personal computer'
    case 'cloud': return 'Cloud host'
  }
}

export interface OrganizationRow {
  organizationId: string
  name: string
  /** "Shared with this computer" or not. */
  shared: boolean
  /** The organization's policy says every session sends its Insights: no control to offer. */
  insightsManaged: boolean
  /** With the policy off: whether this machine opted its work in. */
  insightsOptedIn: boolean
  /** The organization does not allow personal hosts, so this one cannot run for it. */
  personalHostsNotAllowed: boolean
}

/** `policies`: the host's policy summary; null until it is read, when no row is managed by it. */
export function organizationRows(status: HostOrganizationsStatus, policies: HostPolicies | null): OrganizationRow[] {
  return status.organizations.map((organization) => ({
    organizationId: organization.organizationId,
    name: organization.name,
    shared: organization.shared,
    // A cloud machine always sends its organization's Insights (organization-vms §2).
    insightsManaged: policies?.forWork(organization.organizationId).syncsAllInsights() === true || (status.kind === 'cloud' && organization.shared),
    insightsOptedIn: status.insightsOptIn.includes(organization.organizationId),
    personalHostsNotAllowed: !organization.hostRules.allowsPersonalHosts && status.kind === 'personal',
  }))
}

/** What waits to reach each organization's Solus API, in words; null when nothing waits and nothing failed. */
export function deliverySummary(status: HostOrganizationsStatus): string | null {
  const waiting = status.delivery.filter((entry) => entry.pending > 0 || entry.failed > 0).map((entry) => {
    const name = status.organizations.find((organization) => organization.organizationId === entry.organizationId)?.name ?? 'Unknown organization'
    return `${name}: ${entry.pending} waiting${entry.failed ? `, ${entry.failed} refused` : ''}`
  })
  if (!waiting.length && !status.deliveryError) return null
  return [...waiting, ...(status.deliveryError ? [`Last error: ${status.deliveryError}`] : [])].join(' · ')
}

/** The line under the organization's name: how the machine stands with it. */
export function organizationDetail(row: OrganizationRow): string {
  const parts = [row.shared ? 'Shared with this computer' : 'Not shared with this computer']
  if (row.personalHostsNotAllowed) parts.push('Personal computers: not allowed')
  return parts.join(' · ')
}

/** The Insights row's words: managed by the policy, or this machine's own choice. */
export function insightsDetail(row: OrganizationRow): string {
  if (row.insightsManaged) return 'Sync all Insights: On — managed by the organization'
  return row.insightsOptedIn
    ? 'Sync all Insights: Off — this computer sends its Insights for this organization'
    : 'Sync all Insights: Off'
}
