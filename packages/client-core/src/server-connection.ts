import { installWindowSolusApi, mergeNativeOnlySolusApi } from './native-api-overlay'
import {
  dialableRoutes,
  loadServers,
  LOCAL_SERVER_ID,
  savedServerRoutes,
  upsertServer,
  type SavedServer,
  type SavedServerUplink,
} from './server-registry'
import { WsTransport, type ConnectionStatus, type GrantRefusal, type WsTransportOptions } from './ws-transport'
import { isLastingRefusal, type ResourceRefusal } from './oauth-session'
import { withBrowserCapabilities } from './ws-browser-api'
import type { HostEventSubscriber } from './host-event-subscriber'
import { asHostApi, type HostApi } from './host-api'
import type { NativeSolusAPI } from '@solus/contracts/host-api'
import { organizationIdOfSolusApiId, type HostRoute } from '@solus/contracts/uplink'
import type { ConnectionTokenResource } from '@solus/contracts/auth/clients'
import { uplinkAccountSource } from './uplink-account'
import { organizationIdFor, type UplinkAccountSource } from './uplink-session'
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
  guest?: { shareSecret: string; identity: { guestId: string; displayName: string } }
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

/** What a directory id names: an organization's Solus API (`workspace:<organizationId>`), or a host. */
export function connectionTokenResource(uplinkHostId: string): ConnectionTokenResource {
  return organizationIdOfSolusApiId(uplinkHostId) ? { kind: 'api' } : { kind: 'host', hostId: uplinkHostId }
}

/** The account plane's refusal, as the transport acts on it and logs it. */
function grantRefusalOf(refusal: ResourceRefusal | null): GrantRefusal | null {
  if (!refusal) return null
  const reason = [refusal.code, refusal.rule, refusal.description].filter(Boolean).join(': ')
  return { lasting: isLastingRefusal(refusal), reason: `${reason} (HTTP ${refusal.status})` }
}

/** A dial's access token from the account's sign-in, and why there was none when it was refused. None without an account or a resource (a guest, a paired host). */
function grantSource(account: UplinkAccountSource | null, resource: ConnectionTokenResource | null): Pick<WsTransportOptions, 'acquireGrant' | 'grantRefusal'> {
  const source: Pick<WsTransportOptions, 'acquireGrant' | 'grantRefusal'> = {}
  if (!account || !resource) return source
  source.acquireGrant = (grantOptions) => account.accessToken(resource, grantOptions)
  const refusal = account.accessTokenRefusal?.bind(account)
  if (refusal) source.grantRefusal = () => grantRefusalOf(refusal(resource))
  return source
}

export function createSolusConnection(
  target: SolusServerTarget,
  options: CreateSolusConnectionOptions = {},
): InstalledSolusConnection {
  // A host known through the directory and never paired has no long-lived
  // credential: each dial presents a five-minute access token from the account's
  // sign-in, which keeps it until a minute before its end (`OAuthSession`).
  const uplinkHostId = !target.sessionToken && target.uplink ? target.uplink.hostId : null
  const account = uplinkHostId ? uplinkAccountSource() : null
  const resource = uplinkHostId ? connectionTokenResource(uplinkHostId) : null
  // An access token lists the organizations the person reaches this host through; a
  // connection names the one it works in (ADR 0001 §6.4): the Solus API's own, or the
  // window's when the host is shared with it, else the host's first share.
  const dialOrganizationId = () => organizationIdOfSolusApiId(target.id) ?? organizationIdFor(null, target.uplink, activeOrganizationId())
  const guest = options.guest
  // A registered host dialed without the account token (paired, or a trusted network)
  // is still shown the signed-in person's token, so it keeps their delegation (ADR 0001 §6 item 5).
  const presentedHostId = !guest && !uplinkHostId && target.uplink && !organizationIdOfSolusApiId(target.uplink.hostId) ? target.uplink.hostId : null
  const presentingAccount = presentedHostId ? uplinkAccountSource() : null
  const transport = new WsTransport({
    serverUrl: target.url,
    serverId: target.id,
    sessionToken: target.sessionToken,
    ...grantSource(guest ? null : account, resource),
    dialOrganizationId: account && resource ? dialOrganizationId : undefined,
    accountToken: presentingAccount && presentedHostId ? () => presentingAccount.accessToken({ kind: 'host', hostId: presentedHostId }) : undefined,
    shareSecret: guest?.shareSecret,
    guestIdentity: guest?.identity,
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
