import { mount } from 'svelte'
import './index.css'
import type { ConnectionStatus } from '@client-core/ws-transport'
import { installWsBackedSolusApi, resolveActiveServerTarget, type SolusServerTarget } from '@client-core/server-connection'
import { setTabPersistenceServerInstallationId } from './contexts/tab-persistence'
import { warmDiffWorkerPool } from './lib/diff-worker-pool'
import type { LocalConnectionInfo, NativeSolusAPI } from '../preload'

const root = document.getElementById('root')!

function ensureBootStyles(): void {
  if (document.getElementById('solus-boot-styles')) return
  const style = document.createElement('style')
  style.id = 'solus-boot-styles'
  style.textContent = `
    .solus-boot {
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #18181b;
      color: rgba(250, 250, 250, 0.92);
      font-family: "Geist", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    .solus-boot-card {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem 0.875rem;
      border-radius: 0.875rem;
      background: rgba(39, 39, 42, 0.82);
      box-shadow:
        0 0 0 1px rgba(255, 255, 255, 0.08),
        0 12px 30px rgba(0, 0, 0, 0.24);
    }
    .solus-boot-spinner {
      width: 1rem;
      height: 1rem;
      border-radius: 9999px;
      border: 0.125rem solid rgba(250, 250, 250, 0.22);
      border-top-color: rgba(250, 250, 250, 0.9);
      animation: solus-boot-spin 900ms linear infinite;
      flex: none;
    }
    .solus-boot-copy {
      display: flex;
      flex-direction: column;
      gap: 0.125rem;
      min-width: 0;
    }
    .solus-boot-title {
      font-size: 0.8125rem;
      line-height: 1.1;
      font-weight: 600;
      letter-spacing: 0;
      white-space: nowrap;
    }
    .solus-boot-detail {
      font-size: 0.6875rem;
      line-height: 1.2;
      color: rgba(250, 250, 250, 0.55);
      letter-spacing: 0;
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    @keyframes solus-boot-spin {
      to { transform: rotate(360deg); }
    }
    @media (prefers-color-scheme: light) {
      .solus-boot {
        background: #fafafa;
        color: rgba(24, 24, 27, 0.92);
      }
      .solus-boot-card {
        background: rgba(255, 255, 255, 0.92);
        box-shadow:
          0 0 0 1px rgba(0, 0, 0, 0.06),
          0 1px 2px -1px rgba(0, 0, 0, 0.06),
          0 14px 32px rgba(0, 0, 0, 0.08);
      }
      .solus-boot-spinner {
        border-color: rgba(24, 24, 27, 0.16);
        border-top-color: rgba(24, 24, 27, 0.78);
      }
      .solus-boot-detail {
        color: rgba(24, 24, 27, 0.55);
      }
    }
  `
  document.head.appendChild(style)
}

function renderBootState(title: string, detail: string): void {
  ensureBootStyles()
  const safeTitle = escapeHtml(title)
  const safeDetail = escapeHtml(detail)
  root.innerHTML = `
    <div class="solus-boot">
      <div class="solus-boot-card">
        <div class="solus-boot-spinner" aria-hidden="true"></div>
        <div class="solus-boot-copy">
          <div class="solus-boot-title">${safeTitle}</div>
          <div class="solus-boot-detail">${safeDetail}</div>
        </div>
      </div>
    </div>
  `
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function renderBootError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  renderBootState('Unable to connect', message)
}

function connectionDetail(status: ConnectionStatus, attempt: number, target: SolusServerTarget): string {
  if (status === 'connected') return 'Connected'
  if (status === 'reconnecting') return attempt > 0 ? `Retrying (${attempt})` : 'Retrying'
  if (status === 'connecting') return `Opening ${target.local ? 'local' : target.label} WebSocket`
  return `Waiting for ${target.label}`
}

function dispatchConnectionStatus(status: ConnectionStatus, attempt: number, target: SolusServerTarget): void {
  document.dispatchEvent(new CustomEvent('solus:connection-status', { detail: { status, attempt, target } }))
}

async function getLocalConnection(nativeApi: NativeSolusAPI): Promise<LocalConnectionInfo> {
  return nativeApi.getLocalConnection()
}

async function boot(): Promise<void> {
  // First paint is the static #solus-boot-shell baked into index.html (branded,
  // themed, painted before this module even evaluates), so there's nothing to
  // render here up front — it stays until the app mounts and clears #root.

  const nativeApi = window.solusNative
  if (!nativeApi) throw new Error('Native Solus bootstrap bridge is unavailable')
  const local = await getLocalConnection(nativeApi)
  const target = resolveActiveServerTarget(local)

  // The local server accepts the socket instantly, and RPC calls made before it
  // opens queue and flush automatically (see WsTransport.invoke/send) — so there
  // is nothing to wait for locally. Leave the boot shell up and mount straight
  // into the app, letting its own per-surface skeletons cover in-flight data
  // instead of gating first paint on a "Connecting" splash. Only a remote target,
  // where the WebSocket handshake is a genuine network round trip, replaces the
  // shell with the connecting splash.
  if (!target.local) renderBootState('Connecting to Solus', connectionDetail('connecting', 0, target))

  const connectionState = { local, target, status: 'connecting' as ConnectionStatus, attempt: 0 }
  ;(window as unknown as { __solusServerConnection?: typeof connectionState }).__solusServerConnection = connectionState
  setTabPersistenceServerInstallationId(target.installationId ?? target.id, { migrateLegacy: target.local })

  let appMounted = false
  const { transport } = installWsBackedSolusApi(target, nativeApi as unknown as Record<string, unknown>, {
    onStatusChange: (status, attempt) => {
      connectionState.status = status
      connectionState.attempt = attempt
      if (!appMounted && !target.local) renderBootState('Connecting to Solus', connectionDetail(status, attempt, target))
      dispatchConnectionStatus(status, attempt, target)
    },
    onAuthFailed: () => {
      if (!appMounted) renderBootError(new Error(`${target.label} rejected the saved session token`))
    },
  })

  transport.start()

  // RPC calls made before the socket opens queue and flush automatically
  // (see WsTransport.invoke/send), so mount as soon as the app bundle is
  // ready instead of blocking first paint on the WebSocket handshake.
  const { default: App } = await import('./App.svelte')
  root.innerHTML = ''
  mount(App, { target: root })
  appMounted = true

  // Warm the diff highlighter pool on idle so the first diff open of the
  // session doesn't pay the worker/WASM cold start. No-op if a diff opens first.
  warmDiffWorkerPool()
}

void boot().catch(renderBootError)
