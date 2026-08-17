import { mount } from 'svelte'
import '../../src/renderer/index.css'
import { TransportDisconnectedError, type ConnectionStatus, type WsTransport } from '@client-core/ws-transport'
import { createSolusConnection, savedServerTarget } from '@client-core/server-connection'
import { serverConnections } from '@client-core/server-connections'
import { setConnectionState, subscribe } from '@client-core/connection-state'
import { clearActiveServerId, getActiveServerId, loadServers, setActiveServerId, touchLastConnected, upsertServer, type SavedServer } from '@client-core/server-registry'
import { defaultDeviceLabel, pairServer } from '@client-core/pairing'
import HostlessHome from './routes/HostlessHome.svelte'
import { pairTokenFromLocation, probeServer } from './lib/connect'
import { webState } from './lib/web-state.svelte'
import { webPushState } from './lib/web-push.svelte'
import { toasts } from '@renderer/lib/toasts'
import { startScrollReveal } from '@renderer/lib/scroll-reveal'
import WebToaster from './components/WebToaster.svelte'
import { routeForPushClick, serverIdForInstallation, type PushClickPayload } from './lib/push-click'
import { isStaleBuildError, reportStaleBuild } from './lib/stale-build'
import { installWindowSolusApi } from '@client-core/native-api-overlay'
import { z } from 'zod'

const serviceWorkerMessageSchema = z.object({
  type: z.string().optional(),
  route: z.string().nullable().optional(),
  sessionId: z.string().nullable().optional(),
  installationId: z.string().nullable().optional(),
  entryKey: z.string().nullable().optional(),
})

window.addEventListener('unhandledrejection', (event) => {
  if (event.reason instanceof TransportDisconnectedError) event.preventDefault()
  else if (event.reason instanceof Error && isStaleBuildError(event.reason)) {
    event.preventDefault()
    reportStaleBuild()
  }
})

// Vite's preload helper reports a chunk it could not fetch here; without a
// listener it rethrows, and the surface that asked for the chunk stays blank.
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault()
  reportStaleBuild()
})

window.addEventListener('solus:open-server-connect', () => webState.openServerSetup())

startScrollReveal()

let pendingNotificationRoute = consumeColdNotificationRoute()

function consumeColdNotificationRoute(): string | null {
  const url = new URL(location.href)
  const payload: PushClickPayload = {
    sessionId: url.searchParams.get('notificationSessionId'),
    installationId: url.searchParams.get('notificationInstallationId'),
    route: url.searchParams.get('notificationRoute'),
  }
  if (!payload.sessionId && !payload.route) return null
  url.searchParams.delete('notificationSessionId')
  url.searchParams.delete('notificationInstallationId')
  url.searchParams.delete('notificationRoute')
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  return routeForPushClick(payload, loadServers())
}

const root = document.getElementById('root')!
mount(WebToaster, { target: root })

subscribe(({ status, attempt }) => webState.setConnectionStatus(status, attempt))

let activeTransport: WsTransport | null = null
let solusApp: ReturnType<typeof mount> | null = null
let serviceWorkerBridgeInstalled = false
let connectionGeneration = 0
let workspaceAppImport: Promise<typeof import('./App.svelte')> | null = null
let logoutListener: (() => void) | null = null

function loadWorkspaceApp(): Promise<typeof import('./App.svelte')> {
  if (!workspaceAppImport) {
    workspaceAppImport = import('./App.svelte').catch((error) => {
      workspaceAppImport = null
      throw error
    })
  }
  return workspaceAppImport
}

function installServiceWorkerMessageBridge(): void {
  if (serviceWorkerBridgeInstalled || !('serviceWorker' in navigator)) return
  serviceWorkerBridgeInstalled = true
  navigator.serviceWorker.addEventListener('message', (event) => {
    const parsed = serviceWorkerMessageSchema.safeParse(event.data)
    if (!parsed.success) return
    const data = parsed.data
    if (data?.type === 'solus:push-received') {
      const serverId = serverIdForInstallation(data.installationId, loadServers())
      if (serverId && data.entryKey) {
        window.dispatchEvent(new CustomEvent('solus:push-received', {
          detail: { serverId, entryKey: data.entryKey },
        }))
      }
      return
    }
    if (data?.type !== 'solus:notification-click') return
    const route = routeForPushClick(data, loadServers())
    if (!route) return
    window.focus()
    if (solusApp) window.dispatchEvent(new CustomEvent('solus:open-route', { detail: route }))
    else location.hash = route
  })
}

function installLogoutListener(): void {
  if (logoutListener) document.removeEventListener('solus:logout', logoutListener)
  logoutListener = () => {
    // The client is host-agnostic (dispatch-client step 4): "switch server"
    // is a catalog action inside the workspace, never a reload. The forgotten
    // preference only stops the next boot from favouring this host.
    clearActiveServerId()
    webState.openServerSetup()
  }
  document.addEventListener('solus:logout', logoutListener)
}

async function connectToServer(
  server: SavedServer,
  options: { onPreMountAuthFailure?: () => void } = {},
): Promise<void> {
  const generation = ++connectionGeneration
  toasts.dismiss()

  const target = savedServerTarget(server)
  const { transport, api } = createSolusConnection(target, {
    verifyConnectedHost: () => serverConnections.verifySavedServerIdentity(target),
    onStatusChange: (status: ConnectionStatus, attempt: number) => {
      serverConnections.updateStatus(server.id, status, attempt)
      // The target names which host this status belongs to — serversStore keys
      // its per-host connection state (and the web "local" alias) off it.
      setConnectionState({ status, attempt, target })
    },
    onAuthFailed: () => {
      // Post-mount, a rejected credential is that host's blocked row — the
      // workspace stands. Pre-mount, the boot sequence moves to the next
      // catalog candidate instead of rebooting into a picker.
      if (generation === connectionGeneration && !solusApp) options.onPreMountAuthFailure?.()
    },
  })

  installWindowSolusApi(api)
  serverConnections.registerPrimary(server.id, api, transport, target)
  activeTransport = transport
  webPushState.init()
  installServiceWorkerMessageBridge()
  transport.start()
  // Every saved host is eagerly desired, not only the one this boot chose.
  serverConnections.startCatalogSupervisors()
  touchLastConnected(server.id)
  // Remember the choice so a refresh and the servers directory both resume here.
  setActiveServerId(server.id)

  webState.setConnectedServer(server)
  if (pendingNotificationRoute) {
    location.hash = pendingNotificationRoute
    pendingNotificationRoute = null
  }

  try {
    // Pairing and reconnect plumbing live in the small entry chunk; the
    // multi-megabyte shared workspace graph loads lazily behind it.
    const { default: App } = await loadWorkspaceApp()
    if (generation !== connectionGeneration || activeTransport !== transport) {
      transport.destroy()
      return
    }
    solusApp = mount(App, { target: root })
    installLogoutListener()
  } catch (error) {
    if (generation !== connectionGeneration) return
    if (error instanceof Error && isStaleBuildError(error)) reportStaleBuild()
    else toasts.error(error instanceof Error ? error.message : 'Workspace failed to load')
  }
}

/**
 * No host yet: the workspace's founding invariant is that a primary host is
 * connected before it mounts, so this path never loads it. The hostless home
 * lives in the entry chunk and hands off through activateServer(), which
 * reloads into the connect path above.
 */
function bootHostlessHome(): void {
  connectionGeneration += 1
  toasts.dismiss()
  webState.setConnectedServer(null)
  setConnectionState({ status: 'disconnected', attempt: 0 })
  mount(HostlessHome, { target: root })
}

function resolveActiveSavedServer(servers: SavedServer[]): SavedServer | null {
  try {
    const activeServerId = getActiveServerId()
    return servers.find((server) => server.id === activeServerId) ?? null
  } catch {
    return null
  }
}

// Boot

/**
 * Opening a pairing QR / link lands on this SPA at `/pair#token=…` — pair
 * against our own origin and drop straight into the workspace, no forms.
 */
async function pairFromLocation(pairToken: string): Promise<void> {
  history.replaceState({}, '', '/')
  try {
    void loadWorkspaceApp().catch(() => {})
    const { server } = await pairServer({
      url: location.origin,
      pairToken,
      deviceLabel: defaultDeviceLabel(),
    })
    upsertServer(server)
    setActiveServerId(server.id)
    await connectToServer(server)
  } catch (err) {
    bootHostlessHome()
    toasts.error(err instanceof Error ? err.message : String(err))
  }
}

/**
 * The serving origin's platform-managed catalog entry (dispatch-client step
 * 4): every Solus server serves this client, and when that server takes this
 * requester without auth (loopback, the host's own tailnet, or a trusted
 * proxy such as `tailscale serve`) it joins the catalog for this boot — one
 * host among several, auto-registered, never persisted, conferring nothing.
 */
async function servingOriginEntry(): Promise<SavedServer | null> {
  const health = await probeServer(location.origin)
  if (!health.ok || health.requireAuth !== false || !health.installationId) return null
  return {
    id: health.installationId,
    url: location.origin,
    sessionToken: '',
    installationId: health.installationId,
    label: health.name || 'This computer',
    os: health.os,
    lastConnected: Date.now(),
  }
}

/**
 * Catalog-driven boot: no winner-picking. The workspace mounts whenever the
 * catalog holds any host; the hostless home means the catalog is empty. The
 * boot connection order is a client preference (last chosen first), and a
 * candidate whose credential is rejected before mount simply yields to the
 * next — never a reload, never a forced picker.
 */
async function bootFromCatalog(): Promise<void> {
  // The workspace loads on any success — overlap the import with the probe.
  void loadWorkspaceApp().catch(() => {})
  const servers = loadServers()
  const origin = await servingOriginEntry()
  const activeServer = resolveActiveSavedServer(servers)
  const candidates: SavedServer[] = []
  if (activeServer) candidates.push(activeServer)
  candidates.push(...servers.filter((server) => server.id !== activeServer?.id))
  const originAlreadySaved = origin
    && servers.some((server) =>
      server.id === origin.id
      || (!!server.installationId && server.installationId === origin.installationId))
  if (origin && !originAlreadySaved) candidates.push(origin)

  if (candidates.length === 0) {
    bootHostlessHome()
    return
  }
  const tryCandidate = (index: number): void => {
    const candidate = candidates[index]
    if (!candidate) {
      bootHostlessHome()
      toasts.error('No saved host accepted its credential — re-pair to continue')
      return
    }
    void connectToServer(candidate, {
      onPreMountAuthFailure: () => tryCandidate(index + 1),
    })
  }
  tryCandidate(0)
}

const bootPairToken = pairTokenFromLocation(location.href)

if (bootPairToken) {
  void pairFromLocation(bootPairToken)
} else if (location.pathname === '/claim') {
  // A fresh server's claim link: the hostless home offers the serving origin;
  // the user still types the 6-digit code the server printed.
  history.replaceState({}, '', '/')
  bootHostlessHome()
} else {
  void bootFromCatalog()
}
