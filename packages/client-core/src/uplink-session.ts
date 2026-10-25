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
import type { DiscoveredServer } from '@solus/contracts/types'
import type { ConnectionTokenResource } from '@solus/contracts/auth/clients'
import type { AccountState } from '@solus/contracts/account-types'
import type { OAuthSession, ResourceRefusal } from './oauth-session'
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
  /** An access token for one host or the Solus API; `refused` names a kept one the resource refused. */
  accessToken(resource: ConnectionTokenResource, options?: { refused?: string }): Promise<string | null>
  /** Why the last `accessToken` for this resource gave none, when the account plane refused it.
   *  Absent where the sign-in lives in another process (desktop). */
  accessTokenRefusal?(resource: ConnectionTokenResource): ResourceRefusal | null
  /** True when the account holds no sign-in: it ended (expired, revoked) or was never made. */
  isSignedOut(): boolean
  issueEnrollmentTicket(): Promise<UplinkEnrollmentTicket | null>
  /** People and teams of one organization, for the share dialog; null when not a member. */
  loadOrganizationDirectory(organizationId: string): Promise<OrganizationDirectory | null>
  /** Ask an organization's managed host to run (docs/plans/project-model.md §6);
   *  the lifecycle it is in afterwards, or null when the call was refused. */
  startManagedHost(hostId: string): Promise<ManagedHostLifecycle | null>
  /** End the registration of a host this account owns, on every device. A host the
   *  account does not list is already removed, so this is idempotent. False when refused or unanswered. */
  removeHost(hostId: string): Promise<boolean>
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
  session: Pick<OAuthSession, 'accessToken' | 'state'> & Partial<Pick<OAuthSession, 'refusal'>>,
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
    accessTokenRefusal: (resource) => session.refusal?.(resource) ?? null,
    isSignedOut: () => isSignedOutState(session.state()),
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
    async removeHost(hostId) {
      const response = await call(`/v1/hosts/${encodeURIComponent(hostId)}`, { method: 'DELETE' })
      // 404: the account does not list it, which is the state asked for.
      return response?.ok === true || response?.status === 404
    },
  }
}

/** An account with no sign-in to give tokens from. A sign-in that runs, or a state not known yet, is not signed out. */
export function isSignedOutState(state: AccountState | undefined): boolean {
  return state?.kind === 'signed-out' || state?.kind === 'invalid' || state?.kind === 'unavailable'
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
 * A registered host that is not linked is listed with no route, and a client reaches
 * it only on its local network (`withNearbyRoutes`). An `https:` page cannot dial a
 * local address (mixed content), so there it shows only linked hosts. A managed host
 * is always shown: it has no route while it is stopped, and the page can start it.
 */
function isListingReachable(host: DirectoryHost, clientOrigin: string): boolean {
  return host.kind === 'managed' || host.routes.length > 0 || !clientOrigin.startsWith('https:')
}

/**
 * Folds the account's directory into the saved hosts (C1). Rows merge by
 * installation id: a host both paired and listed keeps its pairing and gains the
 * tunnel route; a host only listed is saved with the tunnel route alone; a saved
 * host the directory stopped listing loses its tunnel route and, if it was never
 * paired, disappears. A host only listed that this page cannot reach is not saved
 * (`isListingReachable`). Hosts from another directory origin are left untouched.
 * The directory's workspace services are not hosts and never pass through here
 * (`saveDirectoryWorkspaces`).
 */
export function mergeDirectoryIntoSaved(
  saved: SavedServer[],
  directory: DirectoryHost[],
  directoryUrl: string,
  now: number,
  clientOrigin: string = globalThis.location?.origin ?? '',
): SavedServer[] {
  const byInstallation = new Map(directory.map((host) => [host.installationId, host]))
  const merged: SavedServer[] = []
  for (const server of saved) {
    const listed = byInstallation.get(server.installationId)
    if (listed) {
      byInstallation.delete(server.installationId)
      // A host never paired keeps no address of its own: a kept one outlived the route it
      // came from and, read back as a direct route, was dialed before the directory's.
      // A registered host the directory lists with no route keeps the address LAN
      // discovery found for it (`withNearbyRoutes`): it is its only way in.
      const isDirectoryOnly = !server.sessionToken
      if (isDirectoryOnly && !isListingReachable(listed, clientOrigin)) continue
      const direct = isDirectoryOnly
        ? listed.routes.length === 0 ? (server.routes ?? []).filter((route) => route.kind === 'direct') : []
        : savedServerRoutes(server).filter((route) => route.kind !== 'tunnel')
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
    if (isListingReachable(host, clientOrigin)) merged.push(savedServerFromDirectory(host, directoryUrl, now))
  }
  return merged
}

/**
 * A registered host that is not linked has no route in the directory
 * (docs/adr/0001-standard-authentication.md §2.2 rule 9): a client reaches it on its
 * local network. A LAN discovery answer whose installation id is a host known only
 * through the directory, and listed with no route, gives that host its address there
 * as a direct route. A paired host keeps the address it paired at, and a linked host
 * its tunnel. Null when nothing changed.
 */
export function withNearbyRoutes(saved: SavedServer[], discovered: readonly DiscoveredServer[]): SavedServer[] | null {
  const nearby = new Map(discovered.map((server) => [server.installationId, `http://${server.host}:${server.port}`]))
  let changed = false
  const next = saved.map((server) => {
    const url = nearby.get(server.installationId)
    const routes = server.routes ?? []
    if (!url || server.sessionToken || !server.uplink || routes.some((route) => route.kind === 'tunnel')) return server
    if (routes.length === 1 && routes[0]?.url === url) return server
    changed = true
    return { ...server, routes: [{ kind: 'direct' as const, url }] }
  })
  return changed ? next : null
}
