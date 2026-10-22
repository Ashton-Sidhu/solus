import { prefetchStartupTranscript } from '@solus/workspace-ui/contexts/workspace/startup-transcript'
import { mount, unmount } from 'svelte'
import '@solus/workspace-ui/index.css'
import { TransportDisconnectedError, type ConnectionStatus, type WsTransport } from '@solus/client-core/ws-transport'
import { createSolusConnection, savedServerTarget, type SolusServerTarget } from '@solus/client-core/server-connection'
import { guestRouteUrl, loadGuestIdentity, newGuestId, resolveShareLink, saveGuestIdentity, type GuestIdentity } from '@solus/client-core/guest-link'
import { isGuestLinkResource, parseCloudShareLink, type GuestLink } from '@solus/contracts/sharing'
import { shareLinkOpening, type GuestOpening } from './lib/share-link-opening'
import { savedRunnerFor } from '@solus/client-core/session-runner'
import { guestBoot, type GuestShare } from './lib/guest-boot.svelte'
import type { ConnectionsServerInfo } from '@solus/contracts/host-api'
import { serverConnections } from '@solus/client-core/server-connections'
import { setConnectionState, subscribe } from '@solus/client-core/connection-state'
import { getActiveServerId, loadServers, markDirectoryAnswered, saveServers, setActiveServerId, touchLastConnected, upsertServer, type SavedServer } from '@solus/client-core/server-registry'
import { appPairLink, pairServer } from '@solus/client-core/pairing'
import { defaultDeviceLabel } from '@solus/client-core/device-label'
import { adoptCloudOriginIfPresent, servingOriginIsCloud } from '@solus/client-core/uplink-account'
import type { HostRoute } from '@solus/contracts/uplink'
import { startupAccountRead } from '@solus/client-core/cloud-account'
import { existingWebAccountSession, fetchAuthorize, resumeWebSignIn, webAccountSession } from '@solus/client-core/web-sign-in'
import { mergeDirectoryIntoSaved } from '@solus/client-core/uplink-session'
import { activeWorkspace, loadWorkspaces, saveDirectoryWorkspaces, workspaceTarget } from '@solus/client-core/workspace-registry'
import HostlessHome from './routes/HostlessHome.svelte'
import { pairTokenFromLocation, probeServer } from './lib/connect'
import { cloudOrigin } from './lib/cloud-origin.svelte'
import { webState } from './lib/web-state.svelte'
import { registerServiceWorker } from './lib/service-worker'
import { toasts } from '@solus/workspace-ui/lib/toasts'
import { startScrollReveal } from '@solus/workspace-ui/lib/scroll-reveal'
import WebToaster from './components/WebToaster.svelte'
import { isStaleBuildError, reportStaleBuild } from './lib/stale-build'
import { installWindowSolusApi } from '@solus/client-core/native-api-overlay'
import { createNoHostSolusApi } from '@solus/client-core/no-host-api'
import { z } from 'zod'

const serviceWorkerMessageSchema = z.object({
  type: z.string().optional(),
  route: z.string().nullable().optional(),
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
  const route = url.searchParams.get('notificationRoute')
  if (!route) return null
  url.searchParams.delete('notificationRoute')
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  return route
}

const root = document.getElementById('root')!
mount(WebToaster, { target: root })

subscribe(({ status, attempt }) => webState.setConnectionStatus(status, attempt))

let activeTransport: WsTransport | null = null
let solusApp: ReturnType<typeof mount> | null = null
let serviceWorkerBridgeInstalled = false
let connectionGeneration = 0
let workspaceAppImport: Promise<typeof import('./App.svelte')> | null = null

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
  registerServiceWorker()
  navigator.serviceWorker.addEventListener('message', (event) => {
    const parsed = serviceWorkerMessageSchema.safeParse(event.data)
    if (!parsed.success) return
    const { type, route } = parsed.data
    if (type !== 'solus:notification-click' || !route) return
    window.focus()
    if (solusApp) window.dispatchEvent(new CustomEvent('solus:open-route', { detail: route }))
    else history.replaceState(null, '', route.replace(/^#/, ''))
  })
}

/**
 * How this page load came to be: from a share link that opens a resource as a member
 * (docs/plans/instant-share-open.md), the host that runs it is dialed before every
 * other, and nothing is read for the tab the last visit ended on.
 */
interface BootIntent {
  /** The account host id of the machine that runs the linked resource; null when none does. */
  linkRunnerHostId: string | null
}

async function connectToServer(
  target: SolusServerTarget,
  options: { onPreMountAuthFailure?: () => void; link?: BootIntent } = {},
): Promise<void> {
  const generation = ++connectionGeneration
  toasts.dismiss()

  const { transport, api } = createSolusConnection(target, {
    verifyConnectedHost: () => serverConnections.verifySavedServerIdentity(target),
    onStatusChange: (status: ConnectionStatus, attempt: number) => {
      serverConnections.updateStatus(target.id, status, attempt)
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
  serverConnections.registerPrimary(target.id, api, transport, target)
  activeTransport = transport
  installServiceWorkerMessageBridge()
  transport.start()
  if (options.link) {
    const runnerId = options.link.linkRunnerHostId ? savedRunnerFor(options.link.linkRunnerHostId) : null
    if (runnerId) serverConnections.ensure(runnerId)
  } else {
    void prefetchStartupTranscript()
  }
  // Every saved host is eagerly desired, not only the one this boot chose.
  serverConnections.startCatalogSupervisors()
  touchLastConnected(target.id)
  // Remember the choice so a refresh and the servers directory both resume here.
  setActiveServerId(target.id)

  if (pendingNotificationRoute) {
    history.replaceState(null, '', pendingNotificationRoute.replace(/^#/, ''))
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

installWindowSolusApi(createNoHostSolusApi())

/**
 * A phone that scanned a pairing code with its camera may have the Solus app:
 * it chooses which one pairs, since the code works once. Anything else pairs
 * this browser at once, as before.
 */
function offerAppOrPair(pairToken: string): void {
  if (!matchMedia('(pointer: coarse)').matches) {
    void pairFromLocation(pairToken)
    return
  }
  const appLink = appPairLink(location.href)
  history.replaceState({}, '', '/')
  void import('./routes/PairInApp.svelte').then(({ default: PairInApp }) => {
    const page = mount(PairInApp, {
      target: root,
      props: {
        appLink,
        onContinue: () => {
          void unmount(page)
          void pairFromLocation(pairToken)
        },
      },
    })
  })
}

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
    await connectToServer(savedServerTarget(server))
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

async function adoptCloudDirectory(options: { waitsForAccount: boolean }): Promise<void> {
  // The same bundle is served at `/` by a host and by the account origin; only the
  // probe tells them apart. A host answers `/v1/hosts` with its SPA fallback, which
  // the probe reads as `not-cloud`.
  const { kind, directory } = await adoptCloudOriginIfPresent(location.origin)
  cloudOrigin.kind = kind
  // Whether cloud onboarding is due is known before the workspace mounts, so the
  // draft composer never paints under it. Bounded: a slow answer falls back to the
  // App's opaque cover rather than holding the boot. A share link opens its resource,
  // not the composer, and waits for nothing.
  const accountRead = options.waitsForAccount ? startupAccountRead() : null
  if (accountRead) await Promise.race([accountRead, new Promise((resolve) => setTimeout(resolve, 2_000))])
  if (!directory) return
  saveServers(mergeDirectoryIntoSaved(loadServers(), directory.hosts, directory.directoryUrl, Date.now()))
  saveDirectoryWorkspaces(directory.workspaces, directory.directoryUrl)
  markDirectoryAnswered()
}

async function bootFromCatalog(link?: BootIntent): Promise<void> {
  // The workspace loads on any success — overlap the import with the probe.
  void loadWorkspaceApp().catch(() => {})
  // Two probes of the serving origin, independent of each other: one asks whether
  // it is the account origin, the other whether it is a host.
  const [, origin] = await Promise.all([
    adoptCloudDirectory({ waitsForAccount: !link }).catch((error) => {
      console.warn("[solus:boot] cloud directory unavailable", error)
    }),
    servingOriginEntry(),
  ])
  const servers = loadServers()
  // The window's record home may be a machine or, at the account origin, the
  // active organization's workspace service. The service is not a saved host,
  // so it joins the candidates from the workspace registry.
  const workspaces = loadWorkspaces()
  const active = activeWorkspace(workspaces)
  const targets = [
    ...servers.map(savedServerTarget),
    ...[...(active ? [active] : []), ...workspaces.filter((workspace) => workspace !== active)].map(workspaceTarget),
  ]
  let activeId: string | null = null
  try {
    activeId = getActiveServerId()
  } catch {}
  const candidates: SolusServerTarget[] = [
    ...targets.filter((target) => target.id === activeId),
    ...targets.filter((target) => target.id !== activeId),
  ]
  const originAlreadySaved = origin
    && servers.some((server) =>
      server.id === origin.id
      || (!!server.installationId && server.installationId === origin.installationId))
  if (origin && !originAlreadySaved) candidates.push(savedServerTarget(origin))

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
      link,
    })
  }
  tryCandidate(0)
}

// ── Share links ───────────────────────────────────────────────────────────────
// Cloud resource paths keep the secret in the fragment, so no server log or
// sign-in redirect ever holds it (docs/plans/instant-share-open.md).

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

/**
 * A share link boots once, as its resolve answers. A signed-in page sends its Solus
 * API token with the resolve, so a member goes straight to the resource in the whole
 * app; anyone else goes to the guest landing.
 */
async function openShareLink(link: GuestLink): Promise<void> {
  const account = existingWebAccountSession()
  const state = account?.state()
  const signedIn = account && state?.kind === 'signed-in' ? { account, name: state.identity.name || state.identity.email, userId: state.identity.sub } : null
  // Nothing loads before the resolve: the app's code is hundreds of requests, and a
  // browser that fetches a few at a time sends the resolve only after all of them.
  const token = signedIn ? await signedIn.account.accessToken({ kind: 'api' }) : null
  const opening = shareLinkOpening(await resolveShareLink(location.origin, link.secret, token), link, location.origin)
  if (opening.kind !== 'member') {
    void bootGuest(link, opening, signedIn)
    return
  }
  history.replaceState(null, '', opening.address)
  webState.openedFromLink = true
  // The account's tokens are minted one at a time: the runner's goes first, so its
  // socket is not queued behind every other host this account can reach. The app's
  // code loads while it is minted (`bootFromCatalog`).
  if (opening.runnerHostId && signedIn) void signedIn.account.accessToken({ kind: 'host', hostId: opening.runnerHostId })
  void bootFromCatalog({ linkRunnerHostId: opening.runnerHostId })
}

async function bootGuest(link: GuestLink, opening: GuestOpening, signedIn: { name: string; userId: string } | null): Promise<void> {
  guestBoot.link = link
  guestBoot.displayName = loadGuestIdentity()?.displayName ?? ''
  // A visitor signed in to Solus is not asked who they are: the page's sign-in names them.
  guestBoot.signedInAs = signedIn?.name ?? null
  guestBoot.accountUserId = signedIn?.userId ?? null
  if (opening.kind === 'failed') guestBoot.fail(opening.reason)
  else void loadGuestApp().catch(() => {})
  const { default: GuestLanding } = await import('./routes/GuestLanding.svelte')
  const landing = mount(GuestLanding, {
    target: root,
    props: { onContinue: (displayName: string) => void connectGuest(link, opening, displayName, () => void unmount(landing)) },
  })
  if (signedIn && opening.kind === 'guest') void connectGuest(link, opening, signedIn.name, () => void unmount(landing))
}

/** Where a guest connects: the host that runs the resource (live), or the Solus API's copy of it (read only). */
interface GuestPlace {
  url: string
  routes: HostRoute[]
  live: boolean
}

/** How many failed dials in a row end a live visit and move it to the mirror. */
const HOST_DIALS_BEFORE_MIRROR = 3
/** How long the first answer from the host may take before the mirror is tried. */
const HOST_ANSWER_TIMEOUT_MS = 8_000

async function connectGuest(link: GuestLink, opening: GuestOpening, displayName: string, onShellMounted: () => void): Promise<void> {
  if (guestBoot.phase === 'connecting') return
  if (opening.kind === 'failed') {
    guestBoot.fail(opening.reason)
    return
  }
  guestBoot.phase = 'connecting'
  guestBoot.error = null
  const identity: GuestIdentity = { guestId: loadGuestIdentity()?.guestId ?? newGuestId(), displayName }
  saveGuestIdentity(identity)
  const hostUrl = guestRouteUrl(opening.host, location.origin)
  const mirror: GuestPlace | null = opening.mirror ? { url: opening.mirror, routes: [{ kind: 'direct', url: opening.mirror }], live: false } : null
  const first: GuestPlace | null = hostUrl ? { url: hostUrl, routes: opening.host, live: true } : mirror
  if (!first) {
    guestBoot.fail('Nobody can reach the computer this was shared from right now.')
    return
  }
  await openGuestPlace(link, identity, first, first.live ? mirror : null, onShellMounted)
}

/**
 * Connects the guest at one place and mounts the shell. A live place that does not
 * answer, at first or later, gives way to `fallback` once: the same shell, on the
 * mirror, read only, with the page saying so.
 */
async function openGuestPlace(link: GuestLink, identity: GuestIdentity, place: GuestPlace, fallback: GuestPlace | null, onShellMounted: () => void): Promise<void> {
  const serverId = 'guest:workspace'
  const target: SolusServerTarget = { id: serverId, label: 'Shared resource', url: place.url, sessionToken: '', local: false, routes: place.routes }
  const generation = ++connectionGeneration
  toasts.dismiss()
  let fellBack = false
  const fallBack = (): void => {
    if (fellBack || !fallback || generation !== connectionGeneration) return
    fellBack = true
    transport.destroy()
    void openGuestPlace(link, identity, fallback, null, onShellMounted)
  }
  const { transport, api } = createSolusConnection(target, {
    guest: { shareSecret: link.secret, identity },
    onStatusChange: (status: ConnectionStatus, attempt: number) => {
      serverConnections.updateStatus(serverId, status, attempt)
      setConnectionState({ status, attempt, target })
      if (status === 'disconnected' && attempt >= HOST_DIALS_BEFORE_MIRROR) fallBack()
    },
    // The host refused the secret: the link was turned off or regenerated.
    onAuthFailed: () => guestBoot.revoke(),
  })
  installWindowSolusApi(api)
  serverConnections.registerPrimary(serverId, api, transport, target)
  activeTransport = transport
  transport.start()

  try {
    const answered = await Promise.race([
      serverConnections.serverInfoFor(serverId),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), HOST_ANSWER_TIMEOUT_MS)),
    ])
    if (generation !== connectionGeneration) return
    if (!answered) {
      if (fallback) { fallBack(); return }
      guestBoot.fail('The computer this was shared from did not answer.')
      return
    }
    const info = answered
    const share = linkShare(info, link)
    if (!share) {
      guestBoot.fail('This link does not match the shared resource.')
      return
    }
    guestBoot.serverId = serverId
    guestBoot.live = place.live
    guestBoot.share = share
    guestBoot.displayName = info.displayName ?? identity.displayName
    if (guestBoot.phase === 'ready') return
    const { default: GuestApp } = await loadGuestApp()
    if (generation !== connectionGeneration) return
    onShellMounted()
    guestBoot.phase = 'ready'
    solusApp = mount(GuestApp, { target: root, props: { serverId, share } })
  } catch (error) {
    if (generation !== connectionGeneration || guestBoot.revoked) return
    if (error instanceof Error && isStaleBuildError(error)) reportStaleBuild()
    else guestBoot.fail(error instanceof Error ? error.message : 'The computer this was shared from did not answer')
  }
}

/** The share the host admitted this guest to, when it is the one the link names. */
function linkShare(info: ConnectionsServerInfo, link: GuestLink): GuestShare | null {
  const resource = info.share?.resource
  if (info.principal !== 'guest' || !info.share || !resource || !isGuestLinkResource(resource)) return null
  return resource.kind === link.resource.kind && resource.id === link.resource.id ? { resource, role: info.share.role } : null
}

/**
 * On the account origin, the page's own sign-in comes first
 * (docs/adr/0001-standard-authentication.md §2.2 rule 1): a sign-in the tab holds is
 * kept, or one is made silently with one fetch and no page load. False when the page
 * is leaving for the website's sign-in. Any other origin is in local mode.
 */
async function resumeAccountSignIn(): Promise<boolean> {
  if (!(await servingOriginIsCloud(location.origin))) return true
  const outcome = await resumeWebSignIn({
    session: webAccountSession(location.origin),
    location,
    navigate: (url) => location.assign(url),
    // A guest who opened a share link has no account to sign in to.
    whenSignedOut: (returnTo) => (/^\/(w|s|t)\//.test(returnTo) ? 'stay' : 'sign-in'),
    authorize: fetchAuthorize,
  })
  return outcome !== 'redirecting'
}

async function startPage(): Promise<void> {
  const bootPairToken = pairTokenFromLocation(location.href)
  if (bootPairToken) {
    offerAppOrPair(bootPairToken)
    return
  }
  if (!(await resumeAccountSignIn())) return
  // Only the account origin mints guest links; on a host the same path is a link
  // nobody minted, and the grant request below says so.
  const bootShareLink = parseCloudShareLink(location.pathname, location.hash)
  if (bootShareLink) {
    void openShareLink(bootShareLink)
  } else if (/^\/(w|s)\//.test(location.pathname)) {
    void import('./routes/GuestLanding.svelte').then(({ default: GuestLanding }) => {
      guestBoot.fail('This link is incomplete. Ask the sharer to copy it again.')
      mount(GuestLanding, { target: root, props: { onContinue: () => {} } })
    })
  } else {
    void bootFromCatalog()
  }
}

void startPage()
