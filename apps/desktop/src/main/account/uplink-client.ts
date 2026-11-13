import {
  accountResponseSchema,
  directoryResponseSchema,
  enrollmentTicketResponseSchema,
  managedHostRestartResponseSchema,
  managedHostSpecChangeResponseSchema,
  managedHostStartResponseSchema,
  managedHostStopResponseSchema,
  organizationDirectorySchema,
  type AccountResponse,
  type ManagedHostLifecycle,
  type ManagedHostSpecChangeRequest,
  type ManagedHostSpecRequest,
  type OrganizationDirectory,
  type UplinkDirectory,
  type UplinkEnrollmentTicket,
} from '@solus/contracts/uplink'
import type { CreateManagedHostOutcome } from '@solus/contracts/account-types'
import { createManagedHostBody, createManagedHostOutcome } from '@solus/client-core/cloud-account'
import { createLogger } from '@solus/server/logger'

const log = createLogger('main', 'uplink-client')

/**
 * The desktop's calls to the account's `/v1` Uplink API (decision U9). Main holds
 * the sign-in, so main makes these calls; the renderer receives parsed answers and
 * never the token. Every answer is decoded at this boundary with the shared contract
 * schemas; anything malformed reads as "no answer", the same as being signed out.
 */

export interface CloudRequester {
  readonly cloudOrigin: string
  /** Null when signed out. */
  cloudRequest(path: string, init?: RequestInit): Promise<Response | null>
}

export async function listDirectory(client: CloudRequester): Promise<UplinkDirectory | null> {
  const response = await client.cloudRequest('/v1/hosts')
  if (!response?.ok) {
    // null response = signed out or the website unreachable; a status is the website's word.
    log.info('uplink_directory_unavailable', { status: response?.status ?? null })
    return null
  }
  const parsed = directoryResponseSchema.safeParse(await response.json().catch(() => null))
  if (!parsed.success) {
    log.warn('uplink_directory_malformed', {})
    return null
  }
  const { hosts, workspaces } = parsed.data
  log.info('uplink_directory_read', { hosts: hosts.length, workspaces: workspaces.length })
  return { directoryUrl: client.cloudOrigin, hosts, workspaces }
}

/** Start the organization's managed host; the lifecycle it is in afterwards, or
 *  null when signed out, refused, or the website did not answer. */
export async function startManagedHost(client: CloudRequester, hostId: string): Promise<ManagedHostLifecycle | null> {
  const response = await client.cloudRequest(`/v1/hosts/${encodeURIComponent(hostId)}/start`, { method: 'POST' })
  if (!response?.ok) {
    log.info('managed_host_start_refused', { hostId, status: response?.status ?? null })
    return null
  }
  const parsed = managedHostStartResponseSchema.safeParse(await response.json().catch(() => null))
  return parsed.success ? parsed.data.lifecycle : null
}

/** Stop a managed host; it keeps its disk. The lifecycle afterwards, or null when refused or unanswered. */
export async function stopManagedHost(client: CloudRequester, hostId: string): Promise<ManagedHostLifecycle | null> {
  const response = await client.cloudRequest(`/v1/hosts/${encodeURIComponent(hostId)}/stop`, { method: 'POST' })
  if (!response?.ok) {
    log.info('managed_host_stop_refused', { hostId, status: response?.status ?? null })
    return null
  }
  const parsed = managedHostStopResponseSchema.safeParse(await response.json().catch(() => null))
  return parsed.success ? parsed.data.lifecycle : null
}

/** Restart a running managed host's service; the lifecycle afterwards, or null when refused or unanswered. */
export async function restartManagedHost(client: CloudRequester, hostId: string): Promise<ManagedHostLifecycle | null> {
  const response = await client.cloudRequest(`/v1/hosts/${encodeURIComponent(hostId)}/restart`, { method: 'POST' })
  if (!response?.ok) {
    log.info('managed_host_restart_refused', { hostId, status: response?.status ?? null })
    return null
  }
  const parsed = managedHostRestartResponseSchema.safeParse(await response.json().catch(() => null))
  return parsed.success ? parsed.data.lifecycle : null
}

/** Change a managed host's packages or setup script; whether anything changed, or null when refused or unanswered. */
export async function updateManagedHostSpec(client: CloudRequester, hostId: string, change: ManagedHostSpecChangeRequest): Promise<boolean | null> {
  const response = await client.cloudRequest(`/v1/hosts/${encodeURIComponent(hostId)}/spec`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(change),
  })
  if (!response?.ok) {
    log.info('managed_host_spec_refused', { hostId, status: response?.status ?? null })
    return null
  }
  const parsed = managedHostSpecChangeResponseSchema.safeParse(await response.json().catch(() => null))
  return parsed.success ? parsed.data.changed : null
}

/**
 * Destroy a managed host's machine; its registration ends with it. The website answers
 * 404 for a host the account no longer has, which is the state asked for, so deleting
 * twice succeeds. False when signed out, refused, or unanswered.
 */
export async function deleteManagedHost(client: CloudRequester, hostId: string): Promise<boolean> {
  const response = await client.cloudRequest(`/v1/hosts/${encodeURIComponent(hostId)}/machine`, { method: 'DELETE' })
  if (!response?.ok && response?.status !== 404) {
    log.info('managed_host_delete_refused', { hostId, status: response?.status ?? null })
    return false
  }
  log.info('managed_host_deleted', { hostId, status: response.status })
  return true
}

/** Create an organization's managed host; its host id, or why Solus Cloud did not. */
export async function createManagedHost(
  client: CloudRequester,
  organizationId: string,
  options: { label?: string; spec?: ManagedHostSpecRequest },
): Promise<CreateManagedHostOutcome> {
  const response = await client.cloudRequest('/v1/hosts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(createManagedHostBody(organizationId, options)),
  })
  const outcome = await createManagedHostOutcome(response)
  log.info('managed_host_create_answered', { organizationId, ok: outcome.ok, code: outcome.ok ? null : outcome.code })
  return outcome
}

/** The signed-in account (organizations, the size catalog); null when signed out or the website did not answer. */
export async function readAccount(client: CloudRequester): Promise<AccountResponse | null> {
  const response = await client.cloudRequest('/v1/account')
  if (!response?.ok) return null
  const parsed = accountResponseSchema.safeParse(await response.json().catch(() => null))
  return parsed.success ? parsed.data : null
}

/**
 * End the registration of a host the account owns (website "Remove host"). The website
 * answers 404 for a host this account does not list, which is the state asked for, so
 * removing twice succeeds. False when signed out, refused, or unanswered.
 */
export async function removeHost(client: CloudRequester, hostId: string): Promise<boolean> {
  const response = await client.cloudRequest(`/v1/hosts/${encodeURIComponent(hostId)}`, { method: 'DELETE' })
  if (!response?.ok && response?.status !== 404) {
    log.info('host_remove_refused', { hostId, status: response?.status ?? null })
    return false
  }
  log.info('host_removed', { hostId, status: response.status })
  return true
}

/** The share dialog's people and teams; null when signed out, not a member, or the website did not answer. */
export async function loadOrganizationDirectory(client: CloudRequester, organizationId: string): Promise<OrganizationDirectory | null> {
  const response = await client.cloudRequest(`/v1/orgs/${encodeURIComponent(organizationId)}/directory`)
  if (!response?.ok) return null
  const parsed = organizationDirectorySchema.safeParse(await response.json().catch(() => null))
  return parsed.success ? parsed.data : null
}

export async function issueEnrollmentTicket(client: CloudRequester): Promise<UplinkEnrollmentTicket | null> {
  const response = await client.cloudRequest('/v1/enrollment-tickets', { method: 'POST' })
  if (!response?.ok) return null
  const parsed = enrollmentTicketResponseSchema.safeParse(await response.json().catch(() => null))
  return parsed.success ? { ...parsed.data, directoryUrl: client.cloudOrigin } : null
}
