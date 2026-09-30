import type { HostCategory, HostOrganization } from '@solus/contracts/uplink'
import type { HostOrganizationsStatus } from '@solus/contracts/organization-scope'

/**
 * The Organizations section's view model (docs/plans/organization-scope.md
 * §3.1, §6.1): what one machine's standing in each organization says, in words.
 * Pure, so the rule is tested without a host.
 */

export function hostCategoryLabel(category: HostCategory): string {
  switch (category) {
    case 'personal': return 'Personal computer'
    case 'self-hosted': return 'Self-hosted server'
    case 'managed': return 'Cloud host'
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

export function organizationRows(status: HostOrganizationsStatus): OrganizationRow[] {
  return status.organizations.map((organization: HostOrganization) => ({
    organizationId: organization.organizationId,
    name: organization.name,
    shared: organization.shared,
    // A machine attached for an organization's work always sends that organization's Insights (organization-vms §2).
    insightsManaged: organization.policy.syncAllInsights || (status.attachedAt !== null && organization.shared),
    insightsOptedIn: status.insightsOptIn.includes(organization.organizationId),
    personalHostsNotAllowed: !organization.policy.allowsPersonalHosts && status.category === 'personal',
  }))
}

/**
 * What an attached server does with new work, and what waits for delivery
 * (organization-vms §1, §5): shown above the organizations. Null on a machine that
 * is not attached, whose new work stays on it.
 */
export function attachmentSummary(status: HostOrganizationsStatus): { label: string; description: string } | null {
  if (status.attachedAt === null) return null
  const attached = status.organizations.filter((organization) => organization.shared).map((organization) => organization.name)
  return {
    label: 'Organization work',
    description: attached.length
      ? `New work on this server belongs to ${attached.join(', ')} and is saved in its Solus API. Personal work already here stays on this server.`
      : 'This server is attached for organization work but no organization is attached now, so new work cannot start. Add it to an organization again, or unlink it to use it personally.',
  }
}

/** What waits to reach each organization's Solus API, in words; null when nothing waits and nothing failed. */
export function deliverySummary(status: HostOrganizationsStatus): string | null {
  const waiting = status.delivery.filter((entry) => entry.pending > 0 || entry.failed > 0).map((entry) => {
    const name = status.organizations.find((organization) => organization.organizationId === entry.organizationId)?.name ?? entry.organizationId
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
