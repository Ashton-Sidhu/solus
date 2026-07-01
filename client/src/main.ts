import { mount, unmount } from 'svelte'
import App from './App.svelte'
import '../../src/renderer/index.css'
import ConnectFlow from './routes/ConnectFlow.svelte'
import { WsTransport, type ConnectionStatus } from './transport/ws-transport'
import { loadServers, touchLastConnected, type SavedServer } from './transport/server-registry'
import { webState } from './lib/web-state.svelte'
import { router } from './lib/router.svelte'

const root = document.getElementById('root')!

let activeTransport: WsTransport | null = null
let connectFlowApp: Record<string, any> | null = null
let solusApp: Record<string, any> | null = null

function showConnectFlow(): void {
  if (solusApp) { unmount(solusApp); solusApp = null }
  if (activeTransport) { activeTransport.destroy(); activeTransport = null }
  delete (window as any).solus

  webState.setConnectedServer(null)
  webState.setConnectionStatus('disconnected', 0)
  router.navigateToConnect()

  connectFlowApp = mount(ConnectFlow, {
    target: root,
    props: { onConnect: (server: SavedServer) => connectToServer(server) },
  })
}

function connectToServer(server: SavedServer): void {
  if (connectFlowApp) { unmount(connectFlowApp); connectFlowApp = null }

  const transport = new WsTransport({
    serverUrl: server.url,
    sessionToken: server.sessionToken,
    onStatusChange: (status: ConnectionStatus, attempt: number) => {
      webState.setConnectionStatus(status, attempt)
      document.dispatchEvent(new CustomEvent('solus:connection-status', { detail: { status, attempt } }))
    },
  })

  ;(window as any).solus = transport.buildSolusApi()
  activeTransport = transport
  transport.start()
  touchLastConnected(server.id)

  webState.setConnectedServer(server)
  router.navigateToChat()

  document.addEventListener('solus:logout', () => showConnectFlow(), { once: true })

  solusApp = mount(App, {
    target: root,
  })
}

// Boot
router.start()
const servers = loadServers()
const hash = location.hash

if (hash.startsWith('#/connect')) {
  showConnectFlow()
} else if (servers.length === 1) {
  connectToServer(servers[0])
} else if (servers.length === 0 && import.meta.env.DEV) {
  // Dev server is at our origin; connect directly — no pairing needed since requireAuth defaults to false.
  connectToServer({ id: 'local', url: window.location.origin, sessionToken: '', label: 'Local browser', lastConnected: Date.now() })
} else {
  showConnectFlow()
}
