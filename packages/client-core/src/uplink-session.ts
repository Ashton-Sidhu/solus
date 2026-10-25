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
import { dialableRoutes, mergeRoutes, routeForUrl, withReadRoutes, type HostRoute } from '@solus/contracts/host-routes'
import type { SavedServer, SavedServerUplink } from './server-registry'

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
 * host. Its first routes are the directory's; the host and this client's own network
 * add more later (docs/plans/host-routes.md D1). A host being set up has none yet.
 */
export function savedServerFromDirectory(host: DirectoryHost, directoryUrl: string, now: number): SavedServer {
  return {
    id: host.installationId,
    label: host.label,
    sessionToken: '',
    installationId: host.installationId,
    os: host.os,
    lastConnected: now,
    routes: mergeRoutes([], host.routes, 'directory', now),
    uplink: uplinkOf(host, directoryUrl),
  }
}

/**
 * Whether this page can reach a host the directory lists. A registered host that is
 * not linked is listed with no route, and a client reaches it only on a network it
 * shares with the host. An `https:` page cannot dial an `http:` address (mixed
 * content), so there such a host is shown only when this client knows an `https:`
 * route to it. A managed host is always shown: it has no route while it is stopped,
 * and the page can start it.
 */
function isListingReachable(host: DirectoryHost, routes: readonly HostRoute[], clientOrigin: string): boolean {
  return host.kind === 'managed' || !clientOrigin.startsWith('https:') || dialableRoutes(routes, clientOrigin).length > 0
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
      // The directory's routes replace its earlier ones. Routes from the host, a pairing,
      // or this client's network stay: `chooseRoute` asks each one, so a stale address
      // costs one parallel check and never wins.
      const routes = mergeRoutes(server.routes, listed.routes, 'directory', now)
      if (!server.sessionToken && !isListingReachable(listed, routes, clientOrigin)) continue
      merged.push({
        ...server,
        // A managed host's name is the one members give it on the account site, so a
        // rename there reaches every client. A name typed here still wins (`hasUserLabel`).
        label: listed.kind === 'managed' ? listed.label : server.label,
        os: server.os ?? listed.os,
        routes,
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
    merged.push({ ...rest, routes: mergeRoutes(server.routes, [], 'directory', now) })
  }
  for (const host of byInstallation.values()) {
    const server = savedServerFromDirectory(host, directoryUrl, now)
    if (isListingReachable(host, server.routes, clientOrigin)) merged.push(server)
  }
  return merged
}

/**
 * A scan of this client's networks (docs/plans/host-routes.md D1): each saved host
 * the scan found gets the address it answered at as a `discovery` route. A host the
 * scan did not find keeps its earlier discovery route until it expires, so a laptop
 * that comes back to the network dials the host there again. Null when nothing changed.
 */
export function withDiscoveredRoutes(saved: SavedServer[], discovered: readonly DiscoveredServer[], now: number): SavedServer[] | null {
  const found = new Map(discovered.map((server) => [server.installationId, `http://${server.host}:${server.port}`]))
  let changed = false
  const next = saved.map((server) => {
    const url = found.get(server.installationId)
    const routes = url ? withReadRoutes(server.routes, [routeForUrl(url)], 'discovery', now) : null
    if (!routes) return server
    changed = true
    return { ...server, routes }
  })
  return changed ? next : null
}
