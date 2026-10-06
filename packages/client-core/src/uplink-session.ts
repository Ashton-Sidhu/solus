import {
  directoryResponseSchema,
  enrollmentTicketResponseSchema,
  hostAccessTokenResponseSchema,
  managedHostStartResponseSchema,
  organizationDirectorySchema,
  type ManagedHostLifecycle,
  type DirectoryHost,
  type HostAccessTokenRequest,
  type HostAccessTokenResponse,
  type OrganizationDirectory,
  type UplinkDirectory,
  type UplinkEnrollmentTicket,
} from '@solus/contracts/uplink'
import { savedServerRoutes, type SavedServer, type SavedServerUplink } from './server-registry'

/**
 * Personal Uplink from the client's side (docs/plans/personal-uplink.md, C1/C2).
 *
 * Two things a client does on behalf of the signed-in account: read the host
 * directory and mint grants for one host. Where the account credential lives decides
 * how: on desktop the Electron main process holds it and answers over the native
 * bridge; on the cloud-served web client the account cookie rides a same-origin
 * `fetch`. Neither path ever hands the credential to this module. A grant is minted
 * for a host and may be reused until its expiry.
 */

export interface UplinkAccountSource {
  /** Null when signed out or the website could not be reached. */
  listDirectory(): Promise<UplinkDirectory | null>
  /** A grant for one host. A member of several organizations the host is shared
   *  with names the one their window works in; the owner may name nothing. */
  acquireHostAccessToken(hostId: string, organizationId?: string, options?: { fresh?: boolean }): Promise<HostAccessTokenResponse | null>
  issueEnrollmentTicket(): Promise<UplinkEnrollmentTicket | null>
  /** People and teams of one organization, for the share dialog; null when not a member. */
  loadOrganizationDirectory(organizationId: string): Promise<OrganizationDirectory | null>
  /** Ask an organization's managed host to run (docs/plans/project-model.md §6);
   *  the lifecycle it is in afterwards, or null when the call was refused. */
  startManagedHost(hostId: string): Promise<ManagedHostLifecycle | null>
}

/**
 * The web client served from the account origin: the cookie is the credential and
 * the same origin serves `/v1`. Every call names the origin explicitly so a bundle
 * served by a host (which has no `/v1`) never mistakes a 404 for an empty directory.
 */
export function cookieUplinkAccountSource(origin: string, fetchImpl: typeof fetch = fetch): UplinkAccountSource {
  const call = async (path: string, init: RequestInit = {}): Promise<Response | null> => {
    try {
      return await fetchImpl(`${origin}${path}`, {
        ...init,
        credentials: 'same-origin',
        headers: { accept: 'application/json', ...init.headers },
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
    async acquireHostAccessToken(hostId, organizationId) {
      const body: HostAccessTokenRequest = organizationId ? { organizationId } : {}
      const response = await call(`/v1/hosts/${encodeURIComponent(hostId)}/access-token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response?.ok) return null
      const parsed = hostAccessTokenResponseSchema.safeParse(await response.json().catch(() => null))
      return parsed.success ? parsed.data : null
    },
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

export interface CloudOriginProbe {
  kind: 'signed-in' | 'signed-out' | 'not-cloud'
  directory: UplinkDirectory | null
}

/**
 * Whether `origin` is a Solus account origin serving this client (decision U8). The
 * directory answers JSON with 200 or 401 there. A Solus *host* serving this client
 * answers 200 too — its SPA fallback returns `index.html` for any route — so the
 * status alone proves nothing: only a JSON answer counts as the account origin.
 * Return the validated directory too so startup can use this same response.
 */
export async function probeCloudOrigin(origin: string, fetchImpl: typeof fetch = fetch): Promise<CloudOriginProbe> {
  try {
    const response = await fetchImpl(`${origin}/v1/hosts`, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.headers.get('content-type')?.includes('application/json')) return { kind: 'not-cloud', directory: null }
    if (response.status === 200) {
      const parsed = directoryResponseSchema.safeParse(await response.json().catch(() => null))
      return {
        kind: 'signed-in',
        directory: parsed.success ? { directoryUrl: origin, ...parsed.data } : null,
      }
    }
    if (response.status === 401) return { kind: 'signed-out', directory: null }
    return { kind: 'not-cloud', directory: null }
  } catch {
    return { kind: 'not-cloud', directory: null }
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
