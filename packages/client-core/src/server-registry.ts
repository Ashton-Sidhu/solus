/**
 * Persists the list of paired Solus servers in localStorage. Lets the user
 * connect to multiple machines and switch without re-pairing each time. Every
 * entry is a machine: the organizations' workspace services are kept apart
 * (`workspace-registry.ts`).
 */

import type { HostOperatingSystem } from '@solus/contracts/types'
import { hostCategorySchema, isSolusApiId, machineKindSchema, managedHostLifecycleSchema, type HostCategory, type MachineKind, type ManagedHostLifecycle } from '@solus/contracts/uplink'
import { hostRouteSchema, mergeRoutes, routeForUrl, routesFrom, withReadRoutes, type HostRoute } from '@solus/contracts/host-routes'
import type { ForwardedHost, SshAddResult } from '@solus/contracts/remote-machines'
import { hostIdentityKeySchema } from '@solus/contracts/host-identity'
import { z } from 'zod'
import { forwardCompatibleArray } from './forward-compat'

const KEY = 'solus.servers'
const ACTIVE_KEY = 'solus.activeServerId'

export const LOCAL_SERVER_ID = 'local'

/** The host is listed in the owner's Solus cloud directory and dialable with a grant. */
export interface SavedServerUplink {
  hostId: string
  /** The account origin whose directory named it, e.g. `https://app.solus.sh`. */
  directoryUrl: string
  /** The organizations whose members may reach the host, as the directory last
   *  said (organization-scope §3.1, R15): the ones a personal host is shared
   *  with, or the one a managed host belongs to. Absent when it is shared with none. */
  organizationIds?: string[]
  /** What kind of machine the control plane recorded at enrollment. */
  category?: HostCategory
  /** Whose machine this is, for a host shared with the account rather than linked by it. */
  ownerName?: string
  /** The account that linked a personal host, so its `host-owner` presence is one person with their account elsewhere. */
  ownerUserId?: string
  /** `managed` for a host Solus cloud provisioned for an organization (managed-hosts.md); absent is personal. */
  kind?: MachineKind
  /** Managed hosts only: what the control plane last said of the compute. Only a `ready` host is dialed. */
  managedState?: ManagedHostLifecycle
}

/**
 * A managed host whose compute the directory does not call `ready`. The client
 * does not dial it and does not send work to it. The directory names a state for
 * every managed host, so a state that is missing (or one this client does not
 * know) is not ready. A personal host never waits.
 */
export function awaitsManagedCompute(uplink: SavedServerUplink | undefined): boolean {
  return uplink?.kind === 'managed' && uplink.managedState !== 'ready'
}

/** Whether a host belongs to an organization: shared with it, or managed for it. */
export function hostInOrganization(uplink: Pick<SavedServerUplink, 'organizationIds'> | undefined, organizationId: string | null): boolean {
  return !!organizationId && !!uplink?.organizationIds?.includes(organizationId)
}

/**
 * Whether a managed host must be asked to start before a client waits for it. A
 * host that is ready, or still being set up, is only waited for: a start would run
 * a second reconcile beside the setup already running on Solus Cloud. A failed
 * host is asked again, which retries its setup.
 */
export function managedHostNeedsStart(lifecycle: ManagedHostLifecycle | undefined): boolean {
  return lifecycle === 'stopped' || lifecycle === 'stopping' || lifecycle === 'failed'
}

export interface SavedServer {
  id: string
  label: string
  /** The user typed `label` themselves rather than the client deriving it from an
   *  address or a name the host reported. Their wording then outranks the name the
   *  host advertises over the connection. */
  hasUserLabel?: boolean
  /** Long-lived session token from POST /pair. Empty for a host known only
   *  through the cloud directory: it is dialed with a short grant instead. */
  sessionToken: string
  /** Last-known installation id (so we can warn if the server identity changed). */
  installationId: string
  /** Last-known operating system reported by the host. */
  os?: HostOperatingSystem
  lastConnected: number
  /** Every way this client knows to reach the host, each with its source
   *  (docs/plans/host-routes.md D1). Change it only with `mergeRoutes`. */
  routes: HostRoute[]
  /** The host's identity key (docs/plans/host-routes.md D3), from the pairing, the
   *  SSH connection that added it, or its first connection through the tunnel. An
   *  `http:` route is dialed only after the host proves this key. */
  identityKey?: string
  uplink?: SavedServerUplink
}

/**
 * Where new work runs when nothing narrower names a machine
 * (docs/plans/workspace-and-machines.md §5.1). The primary is kept when it is a
 * machine — the desktop's own, or the machine a web page was served by. At the
 * account origin the primary is the workspace service, which runs nothing, so the
 * choice falls to the active organization's managed host, then to any machine,
 * and only among connected ones: a call sent to a machine that is not there
 * waits for as long as it stays away. Null is "no machine", never the service.
 */
export function chooseRunOnHost(input: {
  primaryId: string | null
  localId: string | null
  saved: readonly SavedServer[]
  activeOrganizationId: string | null
  isConnected: (serverId: string) => boolean
}): string | null {
  const { primaryId, localId, saved, activeOrganizationId, isConnected } = input
  if (primaryId && !isSolusApiId(primaryId)) return primaryId
  if (localId) return localId
  const machines = saved.filter((server) => isConnected(server.id))
  const managed = machines.find((server) => server.uplink?.kind === 'managed' && hostInOrganization(server.uplink, activeOrganizationId))
  return (managed ?? machines[0])?.id ?? null
}

/** The address this client paired the host at, if it paired it. */
export function pairedAddress(server: Pick<SavedServer, 'routes'>): string | null {
  return routesFrom(server.routes, 'pairing')[0]?.url ?? null
}

/**
 * Keeps what a connected host says about itself (docs/plans/host-routes.md D2): its
 * routes replace its earlier `host` routes, and its identity key is kept when this
 * client has none yet. The connection that carried it already passed the identity
 * check. Null when nothing changed.
 */
export function applyAdvertised(serverId: string, advertised: { routes: HostRoute[]; identityKey: string }, now = Date.now()): SavedServer | null {
  const servers = loadServers()
  const server = servers.find((candidate) => candidate.id === serverId)
  if (!server) return null
  const routes = withReadRoutes(server.routes, advertised.routes, 'host', now)
  const identityKey = server.identityKey ?? advertised.identityKey
  if (!routes && identityKey === server.identityKey) return null
  server.routes = routes ?? server.routes
  server.identityKey = identityKey
  saveServers(servers)
  return server
}

/**
 * The saved host an SSH add gives this client (docs/plans/host-routes.md D6, D7). A
 * discovered server is dialed at the address it was found at; a machine SSH alone
 * reaches is dialed through the forward its host holds. Either way the identity key
 * came over the SSH connection, so the first dial can prove the host.
 */
export function serverFromSshAdd(result: Extract<SshAddResult, { status: 'session' | 'forwarded' }>, discoveredUrl: string | null, now = Date.now()): SavedServer {
  const added = result.status === 'session'
    ? { installationId: result.installationId, label: result.label, os: result.os, identityKey: result.identityKey, routes: discoveredUrl ? mergeRoutes([], [routeForUrl(discoveredUrl)], 'pairing', now) : [] }
    : { installationId: result.host.installationId, label: result.host.label, os: result.host.os, identityKey: result.host.identityKey, routes: mergeRoutes([], [result.host.route], 'ssh', now) }
  const server: SavedServer = {
    id: added.installationId,
    label: added.label,
    routes: added.routes,
    sessionToken: result.sessionToken,
    installationId: added.installationId,
    identityKey: added.identityKey,
    lastConnected: now,
  }
  if (added.os) server.os = added.os
  return server
}

/**
 * Keeps the forwarded routes of the saved hosts the same as the forwards this
 * machine's own host holds (D7). A forward's port can change when it opens again,
 * and a host that is no longer forwarded loses its forwarded route. Only the
 * machine that holds the forwards calls this. Null when nothing changed.
 */
export function withForwardedRoutes(saved: SavedServer[], forwarded: readonly ForwardedHost[], now = Date.now()): SavedServer[] | null {
  const byInstallation = new Map(forwarded.map((host) => [host.installationId, host.route]))
  let changed = false
  const next = saved.map((server) => {
    const route = byInstallation.get(server.installationId)
    const routes = withReadRoutes(server.routes, route ? [route] : [], 'ssh', now)
    if (!routes) return server
    changed = true
    return { ...server, routes }
  })
  return changed ? next : null
}

type ServerSavedListener = (server: SavedServer) => void
type ServerRemovingListener = (server: SavedServer) => void

const serverSavedListeners = new Set<ServerSavedListener>()
const serverRemovingListeners = new Set<ServerRemovingListener>()

export function onServerSaved(listener: ServerSavedListener): () => void {
  serverSavedListeners.add(listener)
  return () => serverSavedListeners.delete(listener)
}

export function onServerRemoving(listener: ServerRemovingListener): () => void {
  serverRemovingListeners.add(listener)
  return () => serverRemovingListeners.delete(listener)
}

const directoryAnsweredListeners = new Set<() => void>()
let directoryAnswered = false

/**
 * A directory read succeeded and was merged into the saved hosts. From here a
 * reference to a host the saved list does not hold names a machine that is
 * gone (docs/plans/workspace-and-machines.md §6). A failed read never calls
 * this: until a read succeeds, an unknown host may still be listed.
 */
export function markDirectoryAnswered(): void {
  directoryAnswered = true
  for (const listener of directoryAnsweredListeners) listener()
}

export function hasDirectoryAnswered(): boolean {
  return directoryAnswered
}

export function onDirectoryAnswered(listener: () => void): () => void {
  directoryAnsweredListeners.add(listener)
  return () => directoryAnsweredListeners.delete(listener)
}

export type InstallationIdDecision = 'match' | 'mismatch'

/**
 * Whether the host on a saved address is still the one saved there. A managed host
 * is saved under its directory id, never the id its server makes at first boot, so
 * the two are not compared: the directory owns its route, and the host refuses a
 * grant minted for another host id.
 */
export function installationIdDecision(
  storedInstallationId: string,
  reportedInstallationId: string,
  uplink?: SavedServerUplink,
): InstallationIdDecision {
  if (uplink?.kind === 'managed') return 'match'
  return storedInstallationId === reportedInstallationId ? 'match' : 'mismatch'
}

// `id` and `routes` are load-bearing (they route sockets); everything else
// degrades alone. `.passthrough()` keeps fields written by a newer client
// build intact across the load→save round trip.
const savedServerSchema = z.looseObject({
  id: z.string().min(1),
  label: z.string().catch(''),
  hasUserLabel: z.boolean().optional().catch(undefined),
  sessionToken: z.string().catch(''),
  installationId: z.string().min(1),
  os: z.enum(['macos', 'windows', 'linux']).optional().catch(undefined),
  lastConnected: z.number().catch(0),
  routes: z.array(hostRouteSchema),
  identityKey: hostIdentityKeySchema.optional().catch(undefined),
  uplink: z.object({
    hostId: z.string().min(1),
    directoryUrl: z.string().min(1),
    organizationIds: z.array(z.string().min(1)).optional().catch(undefined),
    category: hostCategorySchema.optional().catch(undefined),
    ownerName: z.string().min(1).optional().catch(undefined),
    ownerUserId: z.string().min(1).optional().catch(undefined),
    kind: machineKindSchema.optional().catch(undefined),
    managedState: managedHostLifecycleSchema.optional().catch(undefined),
  }).optional().catch(undefined),
})
const savedServersSchema = forwardCompatibleArray(savedServerSchema)

export function loadServers(): SavedServer[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const decoded = savedServersSchema.safeParse(JSON.parse(raw))
    if (decoded.success) {
      // SAFETY: Every surviving element passed savedServerSchema, whose fields
      // mirror SavedServer; loose passthrough keys widen, never narrow.
      return decoded.data as SavedServer[]
    }
  } catch {}
  // An unreadable blob would be re-parsed and re-failed on every boot: delete
  // it and treat it as a miss. Records that merely fail element decode are
  // dropped from the result, not from storage.
  try {
    localStorage.removeItem(KEY)
  } catch {}
  return []
}

export function saveServers(servers: SavedServer[]): void {
  localStorage.setItem(KEY, JSON.stringify(servers))
}

export function upsertServer(server: SavedServer): void {
  const servers = loadServers()
  // A host paired again at the same address after a reinstall replaces the old record.
  const address = pairedAddress(server)
  const idx = servers.findIndex(s => s.id === server.id || (!!address && pairedAddress(s) === address))
  if (idx >= 0) servers[idx] = server
  else servers.push(server)
  saveServers(servers)
  for (const listener of serverSavedListeners) listener(server)
}

export function removeServer(id: string): void {
  const servers = loadServers()
  const server = servers.find((candidate) => candidate.id === id)
  if (server) {
    for (const listener of serverRemovingListeners) listener(server)
  }
  saveServers(servers.filter(s => s.id !== id))
  if (getActiveServerId() === id) setActiveServerId(LOCAL_SERVER_ID)
}

export function touchLastConnected(id: string): void {
  const servers = loadServers()
  const target = servers.find(s => s.id === id)
  if (target) {
    target.lastConnected = Date.now()
    saveServers(servers)
  }
}

export function stampHostOperatingSystem(id: string, os: HostOperatingSystem): void {
  const servers = loadServers()
  const target = servers.find(s => s.id === id)
  if (!target || target.os === os) return
  target.os = os
  saveServers(servers)
}

export function getActiveServerId(): string {
  return localStorage.getItem(ACTIVE_KEY) || LOCAL_SERVER_ID
}

export function setActiveServerId(id: string): void {
  localStorage.setItem(ACTIVE_KEY, id || LOCAL_SERVER_ID)
}
