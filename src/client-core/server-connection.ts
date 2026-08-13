import { installWindowSolusApi, mergeNativeOnlySolusApi } from './native-api-overlay'
import {
  getActiveServerId,
  loadServers,
  LOCAL_SERVER_ID,
  setActiveServerId,
  touchLastConnected,
  upsertServer,
  type SavedServer,
} from './server-registry'
import { WsTransport, type ConnectionStatus } from './ws-transport'
import type { HostEventSubscriber } from './host-event-subscriber'
import { asHostApi, type HostApi } from './host-api'
import type { NativeSolusAPI } from '../preload'

export interface LocalConnectionInfoLike {
  port: number
  token: string
  installationId: string
}

export interface SolusServerTarget {
  id: string
  label: string
  url: string
  sessionToken: string
  installationId?: string
  local: boolean
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
  if (!saved) {
    setActiveServerId(LOCAL_SERVER_ID)
    return localTarget
  }

  touchLastConnected(saved.id)
  return savedServerTarget(saved)
}

export function savedServerTarget(server: SavedServer): SolusServerTarget {
  return {
    id: server.id,
    label: server.label,
    url: server.url,
    sessionToken: server.sessionToken,
    installationId: server.installationId,
    local: false,
  }
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
  const transport = new WsTransport({
    serverUrl: target.url,
    serverId: target.id,
    sessionToken: target.sessionToken,
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
      upsertServer({
        id: target.id,
        label: target.label,
        url: target.url,
        sessionToken,
        installationId: target.installationId,
        lastConnected: Date.now(),
      })
    },
    useHostFileDialog: target.local && !!globalThis.window?.solusNative,
  })
  const api = asHostApi(transport.buildSolusApi())
  return { transport, api, events: transport.events }
}
