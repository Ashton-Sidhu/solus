import { prefetchStartupTranscript } from '@solus/workspace-ui/contexts/workspace/startup-transcript'
import { mount, unmount } from 'svelte'
import '@solus/workspace-ui/index.css'
import { TransportDisconnectedError, type ConnectionStatus, type WsTransport } from '@solus/client-core/ws-transport'
import { createSolusConnection, savedServerTarget, type SolusServerTarget } from '@solus/client-core/server-connection'
import { guestRouteUrl, loadGuestIdentity, mintGuestGrant, newGuestId, saveGuestIdentity, type GuestIdentity } from '@solus/client-core/guest-link'
import { parseCloudShareLink, type GuestLink } from '@solus/contracts/sharing'
import { guestBoot } from './lib/guest-boot.svelte'
import { serverConnections } from '@solus/client-core/server-connections'
import { setConnectionState, subscribe } from '@solus/client-core/connection-state'
import { clearActiveServerId, getActiveServerId, loadServers, markDirectoryAnswered, saveServers, setActiveServerId, touchLastConnected, upsertServer, type SavedServer } from '@solus/client-core/server-registry'
import { defaultDeviceLabel, pairServer } from '@solus/client-core/pairing'
import { adoptCloudOriginIfPresent } from '@solus/client-core/uplink-account'
import { startupAccountRead } from '@solus/client-core/cloud-account'
import { mergeDirectoryIntoSaved } from '@solus/client-core/uplink-session'
import HostlessHome from './routes/HostlessHome.svelte'
import { pairTokenFromLocation, probeServer } from './lib/connect'
import { cloudOrigin } from './lib/cloud-origin.svelte'
import { webState } from './lib/web-state.svelte'
import { webPushState } from './lib/web-push.svelte'
import { toasts } from '@solus/workspace-ui/lib/toasts'
import { startScrollReveal } from '@solus/workspace-ui/lib/scroll-reveal'
import WebToaster from './components/WebToaster.svelte'
import { routeForPushClick, serverIdForInstallation, type PushClickPayload } from './lib/push-click'
import { isStaleBuildError, reportStaleBuild } from './lib/stale-build'
import { installWindowSolusApi } from '@solus/client-core/native-api-overlay'
import { createNoHostSolusApi } from '@solus/client-core/no-host-api'
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
  void prefetchStartupTranscript()
  // Every saved host is eagerly desired, not only the one this boot chose.
  serverConnections.startCatalogSupervisors()
  touchLastConnected(server.id)
  // Remember the choice so a refresh and the servers directory both resume here.
  setActiveServerId(server.id)

  if (pendingNotificationRoute) {
    location.hash = pendingNotificationRoute
    pendingNotificationRoute = null
  }

  try {
    // Pairing and reconnect plumbing live in the small entry chunk; the
    // multi-megabyte shared workspace graph loads lazily behind it.
    // Saved tabs provide the loading state while history arrives in the background.
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

function bootHostlessHome(): void {
  connectionGeneration += 1
  toasts.dismiss()
  activeTransport?.destroy()
  activeTransport = null
  webState.hasConnected = false
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

installWindowSolusApi(createNoHostSolusApi())

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

async function adoptCloudDirectory(): Promise<void> {
  // The same bundle is served at `/` by a host and by the account origin; only the
  // probe tells them apart. A host answers `/v1/hosts` with its SPA fallback, which
  // the probe reads as `not-cloud`.
  const { kind, directory } = await adoptCloudOriginIfPresent(location.origin)
  cloudOrigin.kind = kind
  // Whether cloud onboarding is due is known before the workspace mounts, so the
  // draft composer never paints under it. Bounded: a slow answer falls back to the
  // App's opaque cover rather than holding the boot.
  const accountRead = startupAccountRead()
  if (accountRead) await Promise.race([accountRead, new Promise((resolve) => setTimeout(resolve, 2_000))])
  if (!directory) return
  saveServers(mergeDirectoryIntoSaved(loadServers(), directory.hosts, directory.directoryUrl, Date.now()))
  markDirectoryAnswered()
}

async function bootFromCatalog(): Promise<void> {
  // The workspace loads on any success — overlap the import with the probe.
  void loadWorkspaceApp().catch(() => {})
  // Two probes of the serving origin, independent of each other: one asks whether
  // it is the account origin, the other whether it is a host.
  const [, origin] = await Promise.all([
    adoptCloudDirectory().catch((error) => {
      console.warn("[solus:boot] cloud directory unavailable", error)
    }),
    servingOriginEntry(),
  ])
  const servers = loadServers()
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

// ── Guest links ───────────────────────────────────────────────────────────────
// Cloud resource paths keep the secret in the fragment. Only the workspace
// service resolves it; the account server never receives the secret.

let guestAppImport: Promise<typeof import('./GuestApp.svelte')> | null = null

function loadGuestApp(): Promise<typeof import('./GuestApp.svelte')> {
  if (!guestAppImport) {
    guestAppImport = import('./GuestApp.svelte').catch((error) => {
      guestAppImport = null
      throw error
    })
  }
  return guestAppImport
}

async function bootGuest(link: GuestLink): Promise<void> {
  guestBoot.link = link
  guestBoot.displayName = loadGuestIdentity()?.displayName ?? ''
  const { default: GuestLanding } = await import('./routes/GuestLanding.svelte')
  const landing = mount(GuestLanding, {
    target: root,
    props: { onContinue: (displayName: string) => void connectGuest(link, displayName, () => void unmount(landing)) },
  })
}

async function connectGuest(link: GuestLink, displayName: string, onShellMounted: () => void): Promise<void> {
  if (guestBoot.phase === 'connecting') return
  guestBoot.phase = 'connecting'
  guestBoot.error = null
  const identity: GuestIdentity = { guestId: loadGuestIdentity()?.guestId ?? newGuestId(), displayName }
  saveGuestIdentity(identity)
  void loadGuestApp().catch(() => {})

  const first = await mintGuestGrant(location.origin, identity)
  if (!first) {
    guestBoot.fail('Solus cloud could not open this link. Try again.')
    return
  }
  const url = guestRouteUrl(first.routes, location.origin)
  if (!url) {
    guestBoot.fail('The cloud workspace has no route this page can reach.')
    return
  }
  const serverId = 'guest:workspace'
  const target: SolusServerTarget = { id: serverId, label: 'Shared cloud resource', url, sessionToken: '', local: false, routes: first.routes }
  // The grant just minted opens the first dial; every later dial mints its own.
  let unspentGrant: string | null = first.grant
  const generation = ++connectionGeneration
  toasts.dismiss()
  const { transport, api } = createSolusConnection(target, {
    guest: {
      shareSecret: link.secret,
      acquireGrant: async () => {
        if (unspentGrant) {
          const grant = unspentGrant
          unspentGrant = null
          return grant
        }
        return (await mintGuestGrant(location.origin, identity))?.grant ?? null
      },
    },
    onStatusChange: (status: ConnectionStatus, attempt: number) => {
      serverConnections.updateStatus(serverId, status, attempt)
      setConnectionState({ status, attempt, target })
    },
    // The host refused a fresh grant with this secret: the link is gone.
    onAuthFailed: () => guestBoot.revoke(),
  })
  installWindowSolusApi(api)
  serverConnections.registerPrimary(serverId, api, transport, target)
  activeTransport = transport
  transport.start()

  try {
    const info = await api.connectionsGetServerInfo()
    if (generation !== connectionGeneration) return
    if (info.principal !== 'guest' || !info.share || info.share.resource.kind !== link.resource.kind || info.share.resource.id !== link.resource.id) {
      guestBoot.fail('This link does not match the shared resource.')
      return
    }
    guestBoot.serverId = serverId
    guestBoot.accountUserId = info.userId ?? null
    guestBoot.share = info.share
    guestBoot.displayName = info.displayName ?? displayName
    const { default: GuestApp } = await loadGuestApp()
    if (generation !== connectionGeneration) return
    onShellMounted()
    guestBoot.phase = 'ready'
    solusApp = mount(GuestApp, { target: root, props: { serverId, share: info.share, displayName: guestBoot.displayName } })
  } catch (error) {
    if (generation !== connectionGeneration || guestBoot.revoked) return
    if (error instanceof Error && isStaleBuildError(error)) reportStaleBuild()
    else guestBoot.fail(error instanceof Error ? error.message : 'The cloud workspace did not answer')
  }
}

const bootPairToken = pairTokenFromLocation(location.href)
// Only the account origin mints guest links; on a host the same path is a link
// nobody minted, and the grant request below says so.
const bootGuestLink = parseCloudShareLink(location.pathname, location.hash)

if (bootPairToken) {
  void pairFromLocation(bootPairToken)
} else if (bootGuestLink) {
  void bootGuest(bootGuestLink)
} else if (/^\/(w|s|t)\//.test(location.pathname)) {
  void import('./routes/GuestLanding.svelte').then(({ default: GuestLanding }) => {
    guestBoot.fail('This link is incomplete. Ask the sharer to copy it again.')
    mount(GuestLanding, { target: root, props: { onContinue: () => {} } })
  })
} else {
  void bootFromCatalog()
}
