import { mount, unmount } from 'svelte'
import App from './App.svelte'
import '../../src/renderer/index.css'
import ConnectFlow from './routes/ConnectFlow.svelte'
import { TransportDisconnectedError, WsTransport, type ConnectionStatus } from '@client-core/ws-transport'
import { setConnectionState, subscribe } from '@client-core/connection-state'
import { getActiveServerId, loadServers, touchLastConnected, upsertServer, type SavedServer } from '@client-core/server-registry'
import { setTabPersistenceServerInstallationId } from '@renderer/contexts/tab-persistence'
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

function showConnectFlow(): void {
  toasts.dismiss()
  if (solusApp) { unmount(solusApp); solusApp = null }
  if (activeTransport) { activeTransport.destroy(); activeTransport = null }
  delete (window as any).solus

  webState.setConnectedServer(null)
  setConnectionState({ status: 'disconnected', attempt: 0 })
  router.navigateToConnect()

  connectFlowApp = mount(ConnectFlow, {
    target: root,
    props: { onConnect: (server: SavedServer) => connectToServer(server) },
  })
}

function connectToServer(server: SavedServer): void {
  toasts.dismiss()
  if (connectFlowApp) { unmount(connectFlowApp); connectFlowApp = null }
  setTabPersistenceServerInstallationId(server.installationId ?? server.id, {
    migrateLegacy: loadServers().length <= 1,
  })

  const transport = new WsTransport({
    serverUrl: server.url,
    sessionToken: server.sessionToken,
    onStatusChange: (status: ConnectionStatus, attempt: number) => {
      setConnectionState({ status, attempt })
      if (status === 'connected') void webPushState.ensureSubscribedSilently()
    },
    onSessionTokenRefreshed: (sessionToken: string) => {
      server.sessionToken = sessionToken
      upsertServer(server)
      webState.setConnectedServer(server)
    },
    onAuthFailed: () => {
      if (!solusApp) showConnectFlow()
    },
  })

  ;(window as any).solus = transport.buildSolusApi()
  activeTransport = transport
  webPushState.init()
  installServiceWorkerMessageBridge()
  transport.start()
  touchLastConnected(server.id)

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
const servers = loadServers()
const activeServer = resolveActiveSavedServer(servers)
const hash = location.hash

if (hash.startsWith('#/connect')) {
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
