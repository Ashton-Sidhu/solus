/**
 * Persists the list of paired Solus servers in localStorage. Lets the user
 * connect to multiple machines and switch without re-pairing each time. Every
 * entry is a machine: the organizations' workspace services are kept apart
 * (`workspace-registry.ts`).
 */

import type { HostOperatingSystem } from '@solus/contracts/types'
import {
  hostCategorySchema,
  hostRouteSchema,
  isSolusApiId,
  machineKindSchema,
  managedHostLifecycleSchema,
  type HostCategory,
  type HostRoute,
  type MachineKind,
  type ManagedHostLifecycle,
} from '@solus/contracts/uplink'
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
  /** Server URL as the user entered it, e.g. `http://192.168.1.42:51234`. The
   *  preferred direct route; `routes` may name more ways to reach the same host.
   *  Empty for a host known only through the cloud directory, whose routes are
   *  the directory's alone. */
  url: string
  /** Long-lived session token from POST /pair. Empty for a host known only
   *  through the cloud directory: it is dialed with a short grant instead. */
  sessionToken: string
  /** Last-known installation id (so we can warn if the server identity changed). */
  installationId: string
  /** Last-known operating system reported by the host. */
  os?: HostOperatingSystem
  lastConnected: number
  /** Every way this client knows to reach the host. Absent on entries saved
   *  before Uplink; `savedServerRoutes` derives the one route `url` names. */
  routes?: HostRoute[]
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
export function chooseDefaultMachine(input: {
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

/** The routes to dial, oldest entries included: `url` is always one of them, as a direct route. */
export function savedServerRoutes(server: Pick<SavedServer, 'url' | 'routes'>): HostRoute[] {
  const routes = server.routes ?? []
  if (!server.url || routes.some((route) => route.url === server.url)) return routes
  return [{ kind: 'direct', url: server.url }, ...routes]
}

/**
 * The routes worth dialing from this page, direct before tunnel: a host on the local
 * network is reached there and the tunnel is the fallback, never the other way round,
 * so an Uplink host stays usable when Solus cloud is down. An `https:` page cannot
 * open an `http:` route (mixed content), so those are left out there.
 */
export function dialableRoutes(routes: HostRoute[], clientOrigin: string): HostRoute[] {
  const usable = clientOrigin.startsWith('https:') ? routes.filter((route) => !route.url.startsWith('http:')) : routes
  return [...usable.filter((route) => route.kind === 'direct'), ...usable.filter((route) => route.kind === 'tunnel')]
}

/** The route to try after `currentUrl` failed: the next dialable one, round-robin. */
export function nextRouteUrl(routes: HostRoute[], currentUrl: string, clientOrigin: string): string | null {
  const dialable = dialableRoutes(routes, clientOrigin)
  if (dialable.length < 2) return null
  const index = dialable.findIndex((route) => route.url === currentUrl)
  return dialable[(index + 1) % dialable.length]?.url ?? null
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

// `id` and `url` are load-bearing (they route sockets); everything else
// degrades alone. `.passthrough()` keeps fields written by a newer client
// build intact across the load→save round trip.
const savedServerSchema = z.looseObject({
  id: z.string().min(1),
  label: z.string().catch(''),
  hasUserLabel: z.boolean().optional().catch(undefined),
  // Empty for a host known only through the directory: its routes are the directory's.
  url: z.string(),
  sessionToken: z.string().catch(''),
  installationId: z.string().min(1),
  os: z.enum(['macos', 'windows', 'linux']).optional().catch(undefined),
  lastConnected: z.number().catch(0),
  // Written by Uplink-aware builds; an older record simply has neither.
  routes: z.array(hostRouteSchema).optional().catch(undefined),
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
      const servers = decoded.data as SavedServer[]
      // Builds before the split saved each workspace service as a host. It is
      // not one, and read as a machine it would be dialed and offered as one.
      return servers.filter((server) => !isSolusApiId(server.id))
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
  const idx = servers.findIndex(s => s.id === server.id || (!!server.url && s.url === server.url))
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
