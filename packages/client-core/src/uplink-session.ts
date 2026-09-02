import {
  directoryResponseSchema,
  enrollmentTicketResponseSchema,
  hostGrantResponseSchema,
  type DirectoryHost,
  type HostGrantResponse,
  type UplinkDirectory,
  type UplinkEnrollmentTicket,
} from '@solus/contracts/uplink'
import { savedServerRoutes, type SavedServer } from './server-registry'

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
  }
}

/**
 * Whether `origin` is a Solus account origin serving this client (decision U8). The
 * directory answers JSON with 200 or 401 there. A Solus *host* serving this client
 * answers 200 too — its SPA fallback returns `index.html` for any route — so the
 * status alone proves nothing: only a JSON answer counts as the account origin.
 */
export async function probeCloudOrigin(origin: string, fetchImpl: typeof fetch = fetch): Promise<'signed-in' | 'signed-out' | 'not-cloud'> {
  try {
    const response = await fetchImpl(`${origin}/v1/hosts`, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.headers.get('content-type')?.includes('application/json')) return 'not-cloud'
    if (response.status === 200) return 'signed-in'
    if (response.status === 401) return 'signed-out'
    return 'not-cloud'
  } catch {
    return 'not-cloud'
  }
}

/** The registry entry a directory row becomes when this client has never paired with the host. */
export function savedServerFromDirectory(host: DirectoryHost, directoryUrl: string, now: number): SavedServer {
  const tunnel = host.routes.find((route) => route.kind === 'tunnel') ?? host.routes[0]
  return {
    id: host.installationId,
    label: host.label,
    url: tunnel?.url ?? '',
    sessionToken: '',
    installationId: host.installationId,
    os: host.os,
    lastConnected: now,
    routes: host.routes,
    uplink: { hostId: host.hostId, directoryUrl },
  }
}

/**
 * Folds the account's directory into the saved hosts (C1). Rows merge by
 * installation id: a host both paired and listed keeps its pairing and gains the
 * tunnel route; a host only listed is saved with the tunnel route alone; a saved
 * host the directory stopped listing loses its tunnel route and, if it was never
 * paired, disappears. Hosts from another directory origin are left untouched.
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
      const direct = savedServerRoutes(server).filter((route) => route.kind !== 'tunnel')
      merged.push({
        ...server,
        os: server.os ?? listed.os,
        routes: [...direct, ...listed.routes],
        uplink: { hostId: listed.hostId, directoryUrl },
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
