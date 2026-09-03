import '@solus/workspace-ui/index.css'
import { TransportDisconnectedError, type ConnectionStatus } from '@solus/client-core/ws-transport'
import { setConnectionState } from '@solus/client-core/connection-state'
import { installWsBackedSolusApi, localServerTarget, resolveActiveServerTarget, type SolusServerTarget } from '@solus/client-core/server-connection'
import { serverConnections } from '@solus/client-core/server-connections'
import { renderConnecting, renderFatal } from './boot-scene'
import { startScrollReveal } from '@solus/workspace-ui/lib/scroll-reveal'
import type { LocalConnectionInfo, NativeSolusAPI } from '@solus/contracts/host-api'

window.addEventListener('unhandledrejection', (event) => {
  if (event.reason instanceof TransportDisconnectedError) event.preventDefault()
})

startScrollReveal()

const root = document.getElementById('root')!

/**
 * Boot can fail before a target resolves, so the error scene needs a host name
 * that is correct at every point in the sequence — not just after the target
 * has been read.
 */
let bootTarget: SolusServerTarget | null = null

function currentRendererMode(): 'editor' | 'pill' {
  return new URLSearchParams(window.location.search).get('mode') === 'editor'
    ? 'editor'
    : 'pill'
}

function renderBootError(err: Parameters<typeof String>[0]): void {
  renderFatal(root, {
    hostLabel: bootTarget?.label ?? 'Solus',
    isLocalHost: bootTarget?.local ?? true,
    error: err,
  })
  requestAnimationFrame(() => {
    window.solusNative?.rendererReady(currentRendererMode())
  })
}

async function getLocalConnection(nativeApi: NativeSolusAPI): Promise<LocalConnectionInfo> {
  return nativeApi.getLocalConnection()
}

async function boot(): Promise<void> {
  // First paint is the static #solus-boot-shell baked into index.html (branded,
  // themed, painted before this module even evaluates), so there's nothing to
  // render here up front — it stays until the app mounts and clears #root.

  // Boot marks. The renderer is roughly two thirds of the app's startup time,
  // and these split it into the four stages that can each move independently:
  // the connection handshake, the socket, the app bundle, and the mount.
  // `scripts/measure-startup.ts` reads them back; devtools shows them inline.
  performance.mark('solus.boot.start')
  const nativeApi = window.solusNative
  if (!nativeApi) throw new Error('Native Solus bootstrap bridge is unavailable')
  const rendererMode = currentRendererMode()
  const local = await getLocalConnection(nativeApi)
  performance.mark('solus.boot.connection')
  const target = resolveActiveServerTarget(local)
  bootTarget = target
  serverConnections.registerTarget(localServerTarget(local), () => nativeApi.refreshLocalSessionToken())

  // The local server accepts the socket instantly, and RPC calls made before it
  // opens queue and flush automatically (see WsTransport.invoke/send) — so there
  // is nothing to wait for locally. Leave the boot shell up and mount straight
  // into the app, letting its own per-surface skeletons cover in-flight data
  // instead of gating first paint on a "Connecting" splash. Only a remote target,
  // where the WebSocket handshake is a genuine network round trip, grows the
  // shell into the staged connecting scene.
  const showConnecting = (status: ConnectionStatus, attempt: number) => {
    renderConnecting(root, { hostLabel: target.label, hostUrl: target.url, status, attempt })
  }
  if (!target.local) showConnecting('connecting', 0)

  setConnectionState({ status: 'connecting', attempt: 0, target })

  let appMounted = false
  const { transport, api } = installWsBackedSolusApi(target, nativeApi, {
    verifyConnectedHost: () => serverConnections.verifySavedServerIdentity(target),
    onStatusChange: (status, attempt) => {
      serverConnections.updateStatus(target.id, status, attempt)
      setConnectionState({ status, attempt, target })
      if (!appMounted && !target.local) showConnecting(status, attempt)
    },
    onAuthFailed: () => {
      if (!appMounted) renderBootError(new Error(`${target.label} rejected the saved session token`))
    },
  })
  serverConnections.registerPrimary(target.id, api, transport, target)

  transport.start()
  // Every catalog entry is eagerly desired: saved remote hosts hold live
  // supervised sockets from boot, so their rows go live instead of cached.
  serverConnections.startCatalogSupervisors()
  performance.mark('solus.boot.transport')

  // RPC calls made before the socket opens queue and flush automatically
  // (see WsTransport.invoke/send), so mount as soon as the app bundle is
  // ready instead of blocking first paint on the WebSocket handshake.
  const [{ mount }, { default: App }, editorLayoutModule] = await Promise.all([
    import('svelte'),
    import('@solus/workspace-ui/App.svelte'),
    rendererMode === 'editor'
      ? import('@solus/workspace-ui/components/layout/EditorLayout.svelte')
      : Promise.resolve(null),
  ])
  performance.mark('solus.boot.modules')
  root.innerHTML = ''
  mount(App, {
    target: root,
    props: { initialEditorLayout: editorLayoutModule?.default },
  })
  appMounted = true
  performance.mark('solus.boot.mounted')

  // Main starts the disk-heavy transcript index only after the renderer has had
  // a genuine idle window. The timeout still guarantees indexing eventually on
  // a continuously busy client.
  const notifyRendererIdle = () => nativeApi.rendererMounted(rendererMode)
  requestAnimationFrame(() => requestAnimationFrame(() => {
    // Keep the native editor window hidden through the first committed app
    // frame so its static boot shell is never surfaced. PillLayout owns its
    // readiness signal because its layout is still loaded lazily.
    if (rendererMode === 'editor') nativeApi.rendererReady(rendererMode)
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(notifyRendererIdle, { timeout: 5_000 })
    } else {
      globalThis.setTimeout(notifyRendererIdle, 1_500)
    }
  }))
}

void boot().catch(renderBootError)
