import {
  directoryResponseSchema,
  enrollmentTicketResponseSchema,
  hostGrantResponseSchema,
  managedHostStartResponseSchema,
  organizationDirectorySchema,
  type ManagedHostLifecycle,
  type DirectoryHost,
  type HostGrantResponse,
  type OrganizationDirectory,
  type UplinkDirectory,
  type HostRoute,
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
 * for one dial and never kept: the host spends it the moment it is presented.
 */

export interface UplinkAccountSource {
  /** Null when signed out or the website could not be reached. */
  listDirectory(): Promise<UplinkDirectory | null>
  acquireHostGrant(hostId: string): Promise<HostGrantResponse | null>
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
      return parsed.success ? { directoryUrl: origin, hosts: parsed.data.hosts } : null
    },
    async acquireHostGrant(hostId) {
      const response = await call(`/v1/hosts/${encodeURIComponent(hostId)}/grant`, { method: 'POST' })
      if (!response?.ok) return null
      const parsed = hostGrantResponseSchema.safeParse(await response.json().catch(() => null))
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
        directory: parsed.success ? { directoryUrl: origin, hosts: parsed.data.hosts } : null,
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
  const uplink: SavedServerUplink = { hostId: host.hostId, directoryUrl }
  if (host.organizationId) uplink.organizationId = host.organizationId
  if (host.ownerName) uplink.ownerName = host.ownerName
  if (host.ownerUserId) uplink.ownerUserId = host.ownerUserId
  if (host.kind) uplink.kind = host.kind
  if (host.managedState) uplink.managedState = host.managedState
  if (host.isActiveWorkspace) uplink.isActiveWorkspace = true
  return uplink
}

/**
 * The organization whose people the share dialog may add. The host's own answer
 * wins; the directory row fills in for the owner, whom the host admits as
 * `local-owner` and so never tells which organization the host is shared with.
 */
export function organizationIdFor(hostAnswer: string | null | undefined, saved: SavedServerUplink | undefined): string | null {
  return hostAnswer ?? saved?.organizationId ?? null
}

/** The tunnel routes of a directory row: all a cloud row may ever carry. */
function tunnelRoutes(host: DirectoryHost): HostRoute[] {
  return host.routes.filter((route) => route.kind === 'tunnel')
}

/** The registry entry a directory row becomes when this client has never paired with the host. */
export function savedServerFromDirectory(host: DirectoryHost, directoryUrl: string, now: number): SavedServer {
  const tunnel = host.routes.find((route) => route.kind === 'tunnel') ?? host.routes[0]
  // A cloud row (docs/plans/cloud-service-model.md) is the organization's
  // workspace service: its id is the directory's `workspace:<organizationId>`,
  // its label the organization's name, and the tunnel its only way in.
  if (host.kind === 'cloud') {
    return {
      id: host.hostId,
      label: host.label,
      url: tunnel?.url ?? '',
      sessionToken: '',
      installationId: host.installationId,
      lastConnected: now,
      routes: tunnelRoutes(host),
      uplink: uplinkOf(host, directoryUrl),
    }
  }
  return {
    id: host.installationId,
    label: host.label,
    url: tunnel?.url ?? '',
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
 *
 * A cloud row follows the directory alone: it is created and updated from the
 * row (name, organization, tunnel) and never keeps a pairing or a LAN route, and
 * it disappears the moment the directory stops listing it.
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
    if (listed?.kind === 'cloud') {
      byInstallation.delete(server.installationId)
      merged.push({ ...savedServerFromDirectory(listed, directoryUrl, now), lastConnected: server.lastConnected })
      continue
    }
    if (listed) {
      byInstallation.delete(server.installationId)
      const direct = savedServerRoutes(server).filter((route) => route.kind !== 'tunnel')
      merged.push({
        ...server,
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
    // A cloud row has no life outside the directory.
    if (server.uplink.kind === 'cloud') continue
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
