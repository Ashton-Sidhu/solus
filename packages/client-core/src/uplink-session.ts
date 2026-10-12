import {
  directoryResponseSchema,
  enrollmentTicketResponseSchema,
  managedHostStartResponseSchema,
  organizationDirectorySchema,
  type ManagedHostLifecycle,
  type DirectoryHost,
  type OrganizationDirectory,
  type UplinkDirectory,
  type UplinkEnrollmentTicket,
} from '@solus/contracts/uplink'
import type { ConnectionTokenResource } from '@solus/contracts/auth/clients'
import type { OAuthSession } from './oauth-session'
import { savedServerRoutes, type SavedServer, type SavedServerUplink } from './server-registry'

/**
 * Personal Uplink from the client's side (docs/plans/personal-uplink.md, C1/C2).
 *
 * Two things a client does on behalf of the signed-in account: read the host
 * directory and get access tokens for one host or the Solus API. Where the account
 * sign-in lives decides how: on desktop the Electron main process holds it and
 * answers over the native bridge; on the cloud-served web client the page's own
 * `OAuthSession` does (docs/adr/0001-standard-authentication.md §3.2). Neither path
 * hands the refresh token to this module.
 */

export interface UplinkAccountSource {
  /** Null when signed out or the website could not be reached. */
  listDirectory(): Promise<UplinkDirectory | null>
  /** A five-minute access token for one host or the Solus API; `fresh` after the resource refused the kept one. */
  accessToken(resource: ConnectionTokenResource, options?: { fresh?: boolean }): Promise<string | null>
  issueEnrollmentTicket(): Promise<UplinkEnrollmentTicket | null>
  /** People and teams of one organization, for the share dialog; null when not a member. */
  loadOrganizationDirectory(organizationId: string): Promise<OrganizationDirectory | null>
  /** Ask an organization's managed host to run (docs/plans/project-model.md §6);
   *  the lifecycle it is in afterwards, or null when the call was refused. */
  startManagedHost(hostId: string): Promise<ManagedHostLifecycle | null>
}

/**
 * The web client served from the account origin: its `OAuthSession` gives an
 * account-plane access token for each call, and the same origin serves `/v1`. The
 * account cookie is the website's own and is not sent. Every call names the origin
 * explicitly so a bundle served by a host (which has no `/v1`) never mistakes a 404
 * for an empty directory.
 */
export function oauthUplinkAccountSource(
  origin: string,
  session: Pick<OAuthSession, 'accessToken'>,
  fetchImpl: typeof fetch = fetch,
): UplinkAccountSource {
  const call = async (path: string, init: RequestInit = {}): Promise<Response | null> => {
    const token = await session.accessToken({ kind: 'account' })
    if (!token) return null
    try {
      return await fetchImpl(`${origin}${path}`, {
        ...init,
        credentials: 'omit',
        headers: { accept: 'application/json', authorization: `Bearer ${token}`, ...init.headers },
        signal: AbortSignal.timeout(8_000),
      })
    } catch {
      return null
    }
  }
  return {
    async listDirectory() {
      const response = await call('/v1/hosts')
      if (!response?.ok) return null
      const parsed = directoryResponseSchema.safeParse(await response.json().catch(() => null))
      return parsed.success ? { directoryUrl: origin, ...parsed.data } : null
    },
    accessToken: (resource, options) => session.accessToken(resource, options),
    async issueEnrollmentTicket() {
      const response = await call('/v1/enrollment-tickets', { method: 'POST' })
      if (!response?.ok) return null
      const parsed = enrollmentTicketResponseSchema.safeParse(await response.json().catch(() => null))
      return parsed.success ? { ...parsed.data, directoryUrl: origin } : null
    },
    async loadOrganizationDirectory(organizationId) {
      const response = await call(`/v1/orgs/${encodeURIComponent(organizationId)}/directory`)
      if (!response?.ok) return null
      const parsed = organizationDirectorySchema.safeParse(await response.json().catch(() => null))
      return parsed.success ? parsed.data : null
    },
    async startManagedHost(hostId) {
      const response = await call(`/v1/hosts/${encodeURIComponent(hostId)}/start`, { method: 'POST' })
      if (!response?.ok) return null
      const parsed = managedHostStartResponseSchema.safeParse(await response.json().catch(() => null))
      return parsed.success ? parsed.data.lifecycle : null
    },
  }
}

/**
 * Whether `origin` is a Solus account origin serving this client (decision U8). The
 * directory answers JSON there: 401 to this probe, which sends no credential. A Solus
 * *host* serving this client answers 200 with its SPA fallback (`index.html`) for any
 * route, so only a JSON answer counts as the account origin.
 */
export async function isCloudOrigin(origin: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`${origin}/v1/hosts`, {
      credentials: 'omit',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    })
    return !!response.headers.get('content-type')?.includes('application/json') && response.status < 500
  } catch {
    return false
  }
}

/** What the registry keeps of a directory row beyond its routes. */
function uplinkOf(host: DirectoryHost, directoryUrl: string): SavedServerUplink {
  const uplink: SavedServerUplink = { hostId: host.hostId, directoryUrl, kind: host.kind, category: host.category }
  const organizationIds = host.organizationIds
  if (organizationIds.length > 0) uplink.organizationIds = [...organizationIds]
  if (host.ownerName) uplink.ownerName = host.ownerName
  if (host.ownerUserId) uplink.ownerUserId = host.ownerUserId
  if (host.managedState) uplink.managedState = host.managedState
  return uplink
}

/**
 * The organization whose people the share dialog may add. The host's own answer
 * wins; the directory row fills in for the owner, whom the host admits as
 * `local-owner` and so never tells which organization the host is shared with.
 * A host shared with several organizations belongs, for this window, to the one
 * the window works in; with no such selection its first share stands.
 */
export function organizationIdFor(
  hostAnswer: string | null | undefined,
  saved: SavedServerUplink | undefined,
  activeOrganizationId: string | null = null,
): string | null {
  if (hostAnswer) return hostAnswer
  const shared = saved?.organizationIds ?? []
  if (activeOrganizationId && shared.includes(activeOrganizationId)) return activeOrganizationId
  return shared[0] ?? null
}

/**
 * The registry entry a directory row becomes when this client has never paired with the
 * host. It saves no `url`: the directory owns the host's address, so its routes are the
 * only ones, replaced on every read. A host being set up has none yet.
 */
export function savedServerFromDirectory(host: DirectoryHost, directoryUrl: string, now: number): SavedServer {
  return {
    id: host.installationId,
    label: host.label,
    url: '',
    sessionToken: '',
    installationId: host.installationId,
    os: host.os,
    lastConnected: now,
    routes: host.routes,
    uplink: uplinkOf(host, directoryUrl),
  }
}

/**
 * Folds the account's directory into the saved hosts (C1). Rows merge by
 * installation id: a host both paired and listed keeps its pairing and gains the
 * tunnel route; a host only listed is saved with the tunnel route alone; a saved
 * host the directory stopped listing loses its tunnel route and, if it was never
 * paired, disappears. Hosts from another directory origin are left untouched.
 * The directory's workspace services are not hosts and never pass through here
 * (`saveDirectoryWorkspaces`).
 */
export function mergeDirectoryIntoSaved(
  saved: SavedServer[],
  directory: DirectoryHost[],
  directoryUrl: string,
  now: number,
): SavedServer[] {
  const byInstallation = new Map(directory.map((host) => [host.installationId, host]))
  const merged: SavedServer[] = []
  for (const server of saved) {
    const listed = byInstallation.get(server.installationId)
    if (listed) {
      byInstallation.delete(server.installationId)
      // A host never paired keeps no address of its own: a kept one outlived the route it
      // came from and, read back as a direct route, was dialed before the directory's.
      const isDirectoryOnly = !server.sessionToken
      const direct = isDirectoryOnly ? [] : savedServerRoutes(server).filter((route) => route.kind !== 'tunnel')
      merged.push({
        ...server,
        url: isDirectoryOnly ? '' : server.url,
        // A managed host's name is the one members give it on the account site, so a
        // rename there reaches every client. A name typed here still wins (`hasUserLabel`).
        label: listed.kind === 'managed' ? listed.label : server.label,
        os: server.os ?? listed.os,
        routes: [...direct, ...listed.routes],
        uplink: uplinkOf(listed, directoryUrl),
      })
      continue
    }
    if (server.uplink?.directoryUrl !== directoryUrl) {
      merged.push(server)
      continue
    }
    // Unlinked (or deleted) on the cloud side: only the tunnel goes away.
    if (!server.sessionToken) continue
    const { uplink: _dropped, ...rest } = server
    merged.push({ ...rest, routes: savedServerRoutes(server).filter((route) => route.kind !== 'tunnel') })
  }
  for (const host of byInstallation.values()) {
    merged.push(savedServerFromDirectory(host, directoryUrl, now))
  }
  return merged
}
