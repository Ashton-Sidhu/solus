import { mount, unmount } from 'svelte'
import '../../src/renderer/index.css'
import ConnectFlow from './routes/ConnectFlow.svelte'
import { TransportDisconnectedError, type ConnectionStatus, type WsTransport } from '@client-core/ws-transport'
import { createSolusConnection, savedServerTarget } from '@client-core/server-connection'
import { serverConnections } from '@client-core/server-connections'
import { setConnectionState, subscribe } from '@client-core/connection-state'
import { clearActiveServerId, getActiveServerId, loadServers, setActiveServerId, touchLastConnected, upsertServer, type SavedServer } from '@client-core/server-registry'
import { createNoHostSolusApi } from '@client-core/no-host-api'
import { defaultDeviceLabel, pairServer } from '@client-core/pairing'
import { pairTokenFromLocation } from './lib/connect'
import { setTabPersistenceServerInstallationId } from '@renderer/contexts/workspace/tab-persistence'
import { webState } from './lib/web-state.svelte'
import { webPushState } from './lib/web-push.svelte'
import { toasts } from './lib/toast.store.svelte'
import WebToast from './components/WebToast.svelte'

window.addEventListener('unhandledrejection', (event) => {
  if (event.reason instanceof TransportDisconnectedError) event.preventDefault()
})

window.addEventListener('solus:open-server-connect', () => webState.openServerSetup())

/** One-shot boot flag: land in the host chooser instead of auto-connecting. */
const CHOOSE_HOST_KEY = 'solus.chooseHostOnBoot'

// The connect screen is app shell, not a workspace location — it exists before
// the workspace (and its router) does. It marks the address bar so a refresh
// mid-pairing lands back here; the workspace router takes the hash over from
// `bindAddressBar` once a host is chosen.
const CONNECT_HASH = '#/connect'

function markConnectScreen(): void {
  if (location.hash !== CONNECT_HASH) history.replaceState(null, '', CONNECT_HASH)
}

function leaveConnectScreen(): void {
  if (location.hash === CONNECT_HASH) history.replaceState(null, '', location.pathname + location.search)
}

const root = document.getElementById('root')!
mount(WebToast, { target: root })

subscribe(({ status, attempt }) => webState.setConnectionStatus(status, attempt))

let activeTransport: WsTransport | null = null
let connectFlowApp: Record<string, any> | null = null
let solusApp: Record<string, any> | null = null
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
    const data = event.data as { type?: string; route?: string | null } | undefined
    if (data?.type !== 'solus:notification-click' || !data.route) return
    window.focus()
    window.dispatchEvent(new CustomEvent('solus:open-route', { detail: data.route }))
  })
}

function installLogoutListener(): void {
  if (logoutListener) document.removeEventListener('solus:logout', logoutListener)
  logoutListener = () => {
    clearActiveServerId()
    // One-shot: without it the single-saved-server fallback below reconnects
    // to the host the user just left (or to a credential that was rejected).
    sessionStorage.setItem(CHOOSE_HOST_KEY, '1')
    location.reload()
  }
  document.addEventListener('solus:logout', logoutListener, { once: true })
}

function clearLogoutListener(): void {
  if (!logoutListener) return
  document.removeEventListener('solus:logout', logoutListener)
  logoutListener = null
}

function showConnectFlow(options: { initialAddress?: string } = {}): void {
  connectionGeneration += 1
  clearLogoutListener()
  toasts.dismiss()
  if (solusApp) { unmount(solusApp); solusApp = null }
  if (connectFlowApp) { unmount(connectFlowApp); connectFlowApp = null }
  if (activeTransport) { activeTransport.destroy(); activeTransport = null }
  delete (window as any).solus

  webState.setConnectedServer(null)
  setConnectionState({ status: 'disconnected', attempt: 0 })
  markConnectScreen()

  connectFlowApp = mount(ConnectFlow, {
    target: root,
    props: {
      onConnect: (server: SavedServer) => connectToServer(server),
      initialAddress: options.initialAddress,
    },
  })
}

async function connectToServer(server: SavedServer): Promise<void> {
  const generation = ++connectionGeneration
  toasts.dismiss()
  setTabPersistenceServerInstallationId(server.installationId ?? server.id, {
    migrateLegacy: loadServers().length <= 1,
  })

  const target = savedServerTarget(server)
  const { transport, api } = createSolusConnection(target, {
    onStatusChange: (status: ConnectionStatus, attempt: number) => {
      serverConnections.updateStatus(server.id, status, attempt)
      // The target names which host this status belongs to — serversStore keys
      // its per-host connection state (and the web "local" alias) off it.
      setConnectionState({ status, attempt, target })
      if (status === 'connected') void webPushState.ensureSubscribedSilently()
    },
    onAuthFailed: () => {
      if (generation === connectionGeneration && !solusApp) showConnectFlow()
    },
  })

  ;(window as any).solus = api
  serverConnections.registerPrimary(server.id, api, transport, target)
  activeTransport = transport
  webPushState.init()
  installServiceWorkerMessageBridge()
  transport.start()
  touchLastConnected(server.id)
  // Remember the choice so a refresh and the servers directory both resume here.
  setActiveServerId(server.id)

  webState.setConnectedServer(server)
  leaveConnectScreen()

  try {
    // Keep the multi-megabyte workspace graph out of the unpaired connection
    // screen. Pairing and reconnect plumbing remain in the small entry chunk;
    // the shared desktop/mobile workspace loads only once a host is selected.
    const { default: App } = await loadWorkspaceApp()
    if (generation !== connectionGeneration || activeTransport !== transport) {
      transport.destroy()
      return
    }
    if (connectFlowApp) { unmount(connectFlowApp); connectFlowApp = null }
    solusApp = mount(App, { target: root })
    installLogoutListener()
  } catch (error) {
    if (generation !== connectionGeneration) return
    showConnectFlow()
    toasts.error(error instanceof Error ? error.message : 'Workspace failed to load')
  }
}

async function bootWithoutServer(): Promise<void> {
  const generation = ++connectionGeneration
  toasts.dismiss()
  window.solus = createNoHostSolusApi()
  webState.setConnectedServer(null)
  setConnectionState({ status: 'disconnected', attempt: 0 })
  leaveConnectScreen()

  try {
    const { default: App } = await loadWorkspaceApp()
    if (generation !== connectionGeneration) return
    if (connectFlowApp) { unmount(connectFlowApp); connectFlowApp = null }
    solusApp = mount(App, { target: root })
    installLogoutListener()
    webState.openServerSetup()
  } catch (error) {
    if (generation !== connectionGeneration) return
    toasts.error(error instanceof Error ? error.message : 'Workspace failed to load')
  }
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
    showConnectFlow()
    toasts.error(err instanceof Error ? err.message : String(err))
  }
}

const bootPairToken = pairTokenFromLocation(location.href)
const servers = loadServers()
const activeServer = resolveActiveSavedServer(servers)
const hash = location.hash
const chooseHostRequested = sessionStorage.getItem(CHOOSE_HOST_KEY) === '1'
sessionStorage.removeItem(CHOOSE_HOST_KEY)

if (bootPairToken) {
  void pairFromLocation(bootPairToken)
} else if (location.pathname === '/claim') {
  // A fresh server's claim link: the address is our own origin; the user still
  // types the 6-digit code the server printed.
  history.replaceState({}, '', '/')
  showConnectFlow({ initialAddress: location.origin })
} else if (hash.startsWith('#/connect')) {
  showConnectFlow()
} else if (chooseHostRequested) {
  // "Switch server" landed here on purpose — offer the host chooser instead of
  // auto-reconnecting to whatever single host happens to be saved.
  void bootWithoutServer()
} else if (activeServer) {
  void connectToServer(activeServer)
} else if (servers.length === 1) {
  void connectToServer(servers[0])
} else if (servers.length === 0 && import.meta.env.DEV) {
  // Dev server is at our origin; connect directly — no pairing needed since requireAuth defaults to false.
  void connectToServer({ id: 'local', url: window.location.origin, sessionToken: '', label: 'Local browser', lastConnected: Date.now() })
} else {
  void bootWithoutServer()
}
