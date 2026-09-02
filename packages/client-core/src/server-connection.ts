import { installWindowSolusApi, mergeNativeOnlySolusApi } from './native-api-overlay'
import {
  dialableRoutes,
  getActiveServerId,
  loadServers,
  LOCAL_SERVER_ID,
  savedServerRoutes,
  setActiveServerId,
  touchLastConnected,
  upsertServer,
  type SavedServer,
  type SavedServerUplink,
} from './server-registry'
import { WsTransport, type ConnectionStatus } from './ws-transport'
import type { HostEventSubscriber } from './host-event-subscriber'
import { asHostApi, type HostApi } from './host-api'
import type { NativeSolusAPI } from '@solus/contracts/host-api'
import type { HostRoute } from '@solus/contracts/uplink'
import { uplinkAccountSource } from './uplink-account'

export interface LocalConnectionInfoLike {
  port: number
  token: string
  installationId: string
}

export interface SolusServerTarget {
  id: string
  label: string
  /** The route currently dialed. */
  url: string
  sessionToken: string
  installationId?: string
  local: boolean
  /** Every route known for the host; `url` is the one chosen from them. */
  routes?: HostRoute[]
  /** Present when the host is dialable with a grant from the owner's account. */
  uplink?: SavedServerUplink
}

/** The route a saved host is dialed on first: direct before tunnel, from this page's origin. */
export function preferredRouteUrl(server: Pick<SavedServer, 'url' | 'routes'>, clientOrigin: string): string {
  const [first] = dialableRoutes(savedServerRoutes(server), clientOrigin)
  return first?.url ?? server.url
}

export interface InstalledSolusConnection {
  transport: WsTransport
  api: HostApi
  events: HostEventSubscriber
}

export interface CreateSolusConnectionOptions {
  onStatusChange?: (status: ConnectionStatus, attempt: number) => void
  onAuthFailed?: () => void
  verifyConnectedHost?: () => Promise<boolean>
  refreshLocalSessionToken?: () => Promise<string>
}

export type InstallSolusConnectionOptions = Omit<CreateSolusConnectionOptions, 'refreshLocalSessionToken'>

export function localServerTarget(local: LocalConnectionInfoLike): SolusServerTarget {
  return {
    id: LOCAL_SERVER_ID,
    label: 'This Mac',
    url: `http://127.0.0.1:${local.port}`,
    sessionToken: local.token,
    installationId: local.installationId,
    local: true,
  }
}

export function resolveActiveServerTarget(local: LocalConnectionInfoLike): SolusServerTarget {
  const localTarget = localServerTarget(local)
  const activeId = getActiveServerId()
  if (activeId === LOCAL_SERVER_ID) return localTarget

  const saved = loadServers().find((server) => server.id === activeId)
  if (!saved || saved.installationId === local.installationId) {
    setActiveServerId(LOCAL_SERVER_ID)
    return localTarget
  }

  touchLastConnected(saved.id)
  return savedServerTarget(saved)
}

export function savedServerTarget(server: SavedServer): SolusServerTarget {
  const clientOrigin = globalThis.location?.origin ?? ''
  const target: SolusServerTarget = {
    id: server.id,
    label: server.label,
    url: preferredRouteUrl(server, clientOrigin),
    sessionToken: server.sessionToken,
    installationId: server.installationId,
    local: false,
    routes: savedServerRoutes(server),
  }
  if (server.uplink) target.uplink = server.uplink
  return target
}

export function installWsBackedSolusApi(
  target: SolusServerTarget,
  nativeApi: NativeSolusAPI,
  options: InstallSolusConnectionOptions = {},
): InstalledSolusConnection {
  const refreshLocalSessionToken = nativeApi.refreshLocalSessionToken

  const connection = createSolusConnection(target, {
    ...options,
    refreshLocalSessionToken,
  })
  const mergedApi = mergeNativeOnlySolusApi(
    connection.api,
    nativeApi,
  )
  const api = asHostApi(mergedApi)
  installWindowSolusApi(mergedApi)
  return { transport: connection.transport, api, events: connection.events }
}

export function createSolusConnection(
  target: SolusServerTarget,
  options: CreateSolusConnectionOptions = {},
): InstalledSolusConnection {
  // A host known through the directory and never paired has no long-lived
  // credential: every dial mints its own ≤10-minute grant, which the host spends
  // on the spot, so there is nothing to keep or replay.
  const uplinkHostId = !target.sessionToken && target.uplink ? target.uplink.hostId : null
  const account = uplinkHostId ? uplinkAccountSource() : null
  const transport = new WsTransport({
    serverUrl: target.url,
    serverId: target.id,
    sessionToken: target.sessionToken,
    acquireGrant: uplinkHostId && account
      ? async () => (await account.acquireHostGrant(uplinkHostId))?.grant ?? null
      : undefined,
    onStatusChange: options.onStatusChange,
    onAuthFailed: options.onAuthFailed,
    verifyConnectedHost: options.verifyConnectedHost,
    // The local target's page origin (dev server / file://) is always
    // cross-origin from the loopback server, so the HTTP refresh fallback
    // would depend on CORS. Refresh over IPC instead, matching how the
    // token was obtained at boot.
    refreshToken: target.local && options.refreshLocalSessionToken
      ? async () => {
          const sessionToken = await options.refreshLocalSessionToken!()
          return sessionToken ? { result: 'refreshed', sessionToken } : { result: 'unavailable' }
        }
      : undefined,
    onSessionTokenRefreshed: (sessionToken) => {
      if (target.local) return
      const saved = loadServers().find((server) => server.id === target.id)
      upsertServer({
        ...(saved ?? { url: target.url, os: undefined, routes: target.routes }),
        id: target.id,
        label: target.label,
        url: saved?.url ?? target.url,
        sessionToken,
        installationId: target.installationId ?? saved?.installationId ?? '',
        lastConnected: Date.now(),
      })
    },
    useHostFileDialog: target.local && !!globalThis.window?.solusNative,
  })
  const api = asHostApi(transport.buildSolusApi())
  return { transport, api, events: transport.events }
}
