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
import { withBrowserCapabilities } from './ws-browser-api'
import type { HostEventSubscriber } from './host-event-subscriber'
import { asHostApi, type HostApi } from './host-api'
import type { NativeSolusAPI } from '@solus/contracts/host-api'
import { organizationIdOfSolusApiId, type HostAccessTokenResponse, type HostRoute } from '@solus/contracts/uplink'
import { uplinkAccountSource } from './uplink-account'
import { activeOrganizationId } from './workspace-registry'

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
export function preferredRouteUrl(
  server: Pick<SavedServer, 'url' | 'routes'>,
  clientOrigin = globalThis.location?.origin ?? '',
): string {
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
  /** A guest link (docs/plans/multiplayer-sharing.md §4.2): each dial mints a guest
   *  grant and presents the link secret with it. No account, no saved host. */
  guest?: { acquireGrant: () => Promise<string | null>; shareSecret: string }
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

/** A kept grant is replaced this long before it ends: a host closes a socket when
 *  its grant ends, so a dial on a nearly spent grant would soon drop again. */
export const GRANT_RENEW_BEFORE_END_MS = 30 * 60 * 1000

/**
 * The grants of one connection. A host accepts an access token at every ticket
 * exchange while it lives (eight hours), so a redial or a record-API session
 * reuses the kept one instead of asking the account site again. A grant is kept
 * for one organization; a window that works in another gets a new one.
 */
export function keptGrantSource(
  mint: (organizationId: string | undefined) => Promise<HostAccessTokenResponse | null>,
  organizationId: () => string | undefined,
  now: () => number = Date.now,
): (options?: { fresh?: boolean }) => Promise<string | null> {
  let kept: { organizationId: string | undefined; accessToken: string; expiresAt: number } | null = null
  let minting: { organizationId: string | undefined; grant: Promise<string | null> } | null = null
  return async (options) => {
    const wanted = organizationId()
    const held = kept
    if (!options?.fresh && held && held.organizationId === wanted && held.expiresAt - now() > GRANT_RENEW_BEFORE_END_MS) {
      return held.accessToken
    }
    // The socket dial and the record API ask at once on a cold start: one mint answers both.
    const inFlight = minting
    if (inFlight && inFlight.organizationId === wanted) return inFlight.grant
    const grant = mint(wanted).then((minted) => {
      kept = minted ? { organizationId: wanted, accessToken: minted.accessToken, expiresAt: minted.expiresAt } : null
      return minted?.accessToken ?? null
    }).finally(() => {
      if (minting?.grant === grant) minting = null
    })
    minting = { organizationId: wanted, grant }
    return grant
  }
}

export function createSolusConnection(
  target: SolusServerTarget,
  options: CreateSolusConnectionOptions = {},
): InstalledSolusConnection {
  // A host known through the directory and never paired has no long-lived
  // credential: its dials present an access token from the account, kept in
  // memory for this connection while it has life left.
  const uplinkHostId = !target.sessionToken && target.uplink ? target.uplink.hostId : null
  const account = uplinkHostId ? uplinkAccountSource() : null
  const guest = options.guest
  const transport = new WsTransport({
    serverUrl: target.url,
    serverId: target.id,
    sessionToken: target.sessionToken,
    acquireGrant: guest
      ? guest.acquireGrant
      : uplinkHostId && account
        ? keptGrantSource(
            (organizationId) => account.acquireHostAccessToken(uplinkHostId, organizationId),
            // The access token names the organization the window works in, so a host
            // shared with several admits this connection to the right one (§7). A
            // workspace service is one organization's by its id.
            () => organizationIdOfSolusApiId(target.id) ?? activeOrganizationId() ?? undefined,
          )
        : undefined,
    shareSecret: guest?.shareSecret,
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
    organizationId: activeOrganizationId,
  })
  const api = asHostApi(withBrowserCapabilities(transport.buildSolusApi(), transport, {
    useHostFileDialog: target.local && !!globalThis.window?.solusNative,
  }))
  return { transport, api, events: transport.events }
}
