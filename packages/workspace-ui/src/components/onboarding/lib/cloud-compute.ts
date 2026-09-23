import type { SavedServerUplink } from '@solus/client-core/server-registry'
import { managedHostStateLabel } from '../../servers/lib/managed-host'

/**
 * Where a cloud account's agents can run (docs/plans/cloud-onboarding.md §3.1):
 * the organization's cloud host, the machines this account linked, and machines
 * other members shared with the organization. The workspace service is none of
 * these; callers pass `serversStore.servers`, which never lists it.
 */

export interface ComputeHost {
  id: string
  label: string
  status: string
  uplink?: SavedServerUplink
}

export interface ComputeChoices<T extends ComputeHost> {
  /** The active organization's managed host; every member sees it. */
  cloudHost: T | null
  /** Machines this account linked. Visible to others only when shared. */
  ownMachines: T[]
  /** Machines another member shared with the organization. */
  sharedMachines: T[]
}

export function computeChoices<T extends ComputeHost>(
  servers: readonly T[],
  account: { userId: string; activeOrganizationId: string | null },
): ComputeChoices<T> {
  const cloudHost = servers.find((server) =>
    server.uplink?.kind === 'managed' && server.uplink.organizationId === account.activeOrganizationId) ?? null
  const personal = servers.filter((server) => server.uplink?.kind !== 'managed' && server.uplink?.kind !== 'cloud')
  // A machine with no owner on record was paired to this browser directly: it is this person's.
  const isOwn = (server: T) => !server.uplink?.ownerUserId || server.uplink.ownerUserId === account.userId
  return {
    cloudHost,
    ownMachines: personal.filter(isOwn),
    sharedMachines: personal.filter((server) => !isOwn(server)),
  }
}

/**
 * The host the flow starts with chosen: the organization's cloud host when it has
 * one (an invitee sees it chosen), else a machine that is up — the person's own
 * first — else none, and the flow continues without a machine.
 */
export function defaultComputeHost<T extends ComputeHost>(choices: ComputeChoices<T>): T | null {
  if (choices.cloudHost) return choices.cloudHost
  const online = (server: T) => server.status === 'online'
  return choices.ownMachines.find(online) ?? choices.sharedMachines.find(online) ?? null
}

/** Whether a machine this account linked is shared with the organization. */
export function isSharedWith(server: ComputeHost, organizationId: string | null): boolean {
  return !!organizationId && server.uplink?.organizationId === organizationId
}

function reachability(server: ComputeHost): string {
  const state = managedHostStateLabel(server.uplink)
  if (state) return state
  return server.status === 'online' ? 'Ready' : 'Offline'
}

/** The detail line of the cloud host row: its state, and who can use it. */
export function cloudHostDetail(server: ComputeHost, organizationName: string): string {
  return `${reachability(server)} · Everyone in ${organizationName} can use it`
}

/** The detail line of a machine row: its state, and who can see it. */
export function machineDetail(server: ComputeHost, organization: { organizationId: string; name: string } | null, isOwn: boolean): string {
  if (!isOwn) return `${reachability(server)} · Shared by ${server.uplink?.ownerName ?? 'a member'}`
  const visibility = organization && isSharedWith(server, organization.organizationId)
    ? `Shared with ${organization.name}`
    : 'Only you can see it'
  return `${reachability(server)} · ${visibility}`
}

/**
 * What the compute stage says when Solus Cloud did not create the cloud host. The
 * `/v1` code is kept in the text, so a report names the refusal.
 */
export function createHostFailureMessage(code: string | null, message: string | null): string {
  switch (code) {
    case null:
      return 'Solus Cloud did not answer. Check your connection and try again.'
    case 'managed_hosts_not_configured':
      return 'Cloud hosts are not available for this organization yet.'
    case 'not_a_member':
    case 'organization_not_found':
      return 'You are not a member of this organization. Switch organization and try again.'
    case 'rate_limited':
      return 'Too many tries. Wait a minute and try again.'
    default:
      return `Solus Cloud did not create the host (${message ? `${code}: ${message}` : code}). Try again, or create it on the Hosts page.`
  }
}
