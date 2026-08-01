import { mount, unmount } from 'svelte'
import App from './App.svelte'
import '../../src/renderer/index.css'
import ConnectFlow from './routes/ConnectFlow.svelte'
import { TransportDisconnectedError, type ConnectionStatus, type WsTransport } from '@client-core/ws-transport'
import { createSolusConnection, savedServerTarget } from '@client-core/server-connection'
import { serverConnections } from '@client-core/server-connections'
import { setConnectionState, subscribe } from '@client-core/connection-state'
import { getActiveServerId, loadServers, setActiveServerId, touchLastConnected, upsertServer, type SavedServer } from '@client-core/server-registry'
import { defaultDeviceLabel, pairServer } from '@client-core/pairing'
import { pairTokenFromLocation } from './lib/connect'
import { setTabPersistenceServerInstallationId } from '@renderer/contexts/workspace/tab-persistence'
import { webState } from './lib/web-state.svelte'
import { router } from './lib/router.svelte'
import { webPushState } from './lib/web-push.svelte'
import { toasts } from './lib/toast.store.svelte'
import WebToast from './components/WebToast.svelte'

window.addEventListener('unhandledrejection', (event) => {
  if (event.reason instanceof TransportDisconnectedError) event.preventDefault()
})

const root = document.getElementById('root')!
mount(WebToast, { target: root })

subscribe(({ status, attempt }) => webState.setConnectionStatus(status, attempt))

let activeTransport: WsTransport | null = null
let connectFlowApp: Record<string, any> | null = null
let solusApp: Record<string, any> | null = null
let serviceWorkerBridgeInstalled = false

function installServiceWorkerMessageBridge(): void {
  if (serviceWorkerBridgeInstalled || !('serviceWorker' in navigator)) return
  serviceWorkerBridgeInstalled = true
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data as { type?: string; sessionId?: string | null; kind?: string | null } | undefined
    if (data?.type !== 'solus:notification-click') return
    window.focus()
    window.dispatchEvent(new CustomEvent('solus:focus-session', {
      detail: { sessionId: data.sessionId ?? null, kind: data.kind ?? null },
    }))
  })
}

function showConnectFlow(options: { initialAddress?: string } = {}): void {
  toasts.dismiss()
  if (solusApp) { unmount(solusApp); solusApp = null }
  if (activeTransport) { activeTransport.destroy(); activeTransport = null }
  delete (window as any).solus

  webState.setConnectedServer(null)
  setConnectionState({ status: 'disconnected', attempt: 0 })
  router.navigateToConnect()

  connectFlowApp = mount(ConnectFlow, {
    target: root,
    props: {
      onConnect: (server: SavedServer) => connectToServer(server),
      initialAddress: options.initialAddress,
    },
  })
}

function connectToServer(server: SavedServer): void {
  toasts.dismiss()
  if (connectFlowApp) { unmount(connectFlowApp); connectFlowApp = null }
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
      if (!solusApp) showConnectFlow()
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
  router.navigateToChat()

  document.addEventListener('solus:logout', () => showConnectFlow(), { once: true })

  solusApp = mount(App, {
    target: root,
  })
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
router.start()

/**
 * Opening a pairing QR / link lands on this SPA at `/pair#token=…` — pair
 * against our own origin and drop straight into the workspace, no forms.
 */
async function pairFromLocation(pairToken: string): Promise<void> {
  history.replaceState({}, '', '/')
  try {
    const { server } = await pairServer({
      url: location.origin,
      pairToken,
      deviceLabel: defaultDeviceLabel(),
    })
    upsertServer(server)
    setActiveServerId(server.id)
    connectToServer(server)
  } catch (err) {
    showConnectFlow()
    toasts.error(err instanceof Error ? err.message : String(err))
  }
}

const bootPairToken = pairTokenFromLocation(location.href)
const servers = loadServers()
const activeServer = resolveActiveSavedServer(servers)
const hash = location.hash

if (bootPairToken) {
  void pairFromLocation(bootPairToken)
} else if (location.pathname === '/claim') {
  // A fresh server's claim link: the address is our own origin; the user still
  // types the 6-digit code the server printed.
  history.replaceState({}, '', '/')
  showConnectFlow({ initialAddress: location.origin })
} else if (hash.startsWith('#/connect')) {
  showConnectFlow()
} else if (activeServer) {
  connectToServer(activeServer)
} else if (servers.length === 1) {
  connectToServer(servers[0])
} else if (servers.length === 0 && import.meta.env.DEV) {
  // Dev server is at our origin; connect directly — no pairing needed since requireAuth defaults to false.
  connectToServer({ id: 'local', url: window.location.origin, sessionToken: '', label: 'Local browser', lastConnected: Date.now() })
} else {
  showConnectFlow()
}
