import {
  directoryResponseSchema,
  enrollmentTicketResponseSchema,
  hostGrantResponseSchema,
  type HostGrantResponse,
  type UplinkDirectory,
  type UplinkEnrollmentTicket,
} from '@solus/contracts/uplink'
import { createLogger } from '@solus/server/logger'

const log = createLogger('main', 'uplink-client')

/**
 * The desktop's calls to the account's `/v1` Uplink API (decision U9). Main holds
 * the session, so main makes these calls; the renderer receives parsed answers and
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
  log.info('uplink_directory_read', { hosts: parsed.data.hosts.length })
  return { directoryUrl: client.cloudOrigin, hosts: parsed.data.hosts }
}

export async function acquireHostGrant(client: CloudRequester, hostId: string): Promise<HostGrantResponse | null> {
  const response = await client.cloudRequest(`/v1/hosts/${encodeURIComponent(hostId)}/grant`, { method: 'POST' })
  if (!response?.ok) return null
  const parsed = hostGrantResponseSchema.safeParse(await response.json().catch(() => null))
  return parsed.success ? parsed.data : null
}

export async function issueEnrollmentTicket(client: CloudRequester): Promise<UplinkEnrollmentTicket | null> {
  const response = await client.cloudRequest('/v1/enrollment-tickets', { method: 'POST' })
  if (!response?.ok) return null
  const parsed = enrollmentTicketResponseSchema.safeParse(await response.json().catch(() => null))
  return parsed.success ? { ...parsed.data, directoryUrl: client.cloudOrigin } : null
}
