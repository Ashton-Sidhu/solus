import { prefetchStartupTranscript } from '@solus/workspace-ui/contexts/workspace/startup-transcript'
import { mount, unmount } from 'svelte'
import '@solus/workspace-ui/index.css'
import { TransportDisconnectedError } from '@solus/client-core/ws-transport'
import { savedServerTarget, type SolusServerTarget } from '@solus/client-core/server-connection'
import { guestRouteUrl, loadGuestIdentity, newGuestId, resolveShareLink, saveGuestIdentity, type GuestIdentity } from '@solus/client-core/guest-link'
import { isGuestLinkResource, parseCloudShareLink, type GuestLink } from '@solus/contracts/sharing'
import { shareLinkOpening, type GuestOpening } from './lib/share-link-opening'
import { addressedBootIntent, type BootIntent } from './lib/boot-intent'
import { savedRunnerFor } from '@solus/client-core/session-runner'
import { guestBoot, type GuestShare } from './lib/guest-boot.svelte'
import type { ConnectionsServerInfo } from '@solus/contracts/host-api'
import { serverConnections } from '@solus/client-core/server-connections'
import { getActiveServerId, loadServers, markDirectoryAnswered, saveServers, setActiveServerId, touchLastConnected, upsertServer } from '@solus/client-core/server-registry'
import { appPairLink, pairServer } from '@solus/client-core/pairing'
import { defaultDeviceLabel } from '@solus/client-core/device-label'
import { adoptAccountOrigin } from '@solus/client-core/uplink-account'
import { accountOriginShell } from './lib/account-origin'
import type { HostRoute } from '@solus/contracts/uplink'
import { startupAccountRead } from '@solus/client-core/cloud-account'
import { existingWebAccountSession, fetchAuthorize, keepWebSignIn, resumeWebSignIn, webAccountSession, type WebSignInDeps } from '@solus/client-core/web-sign-in'
import { mergeDirectoryIntoSaved } from '@solus/client-core/uplink-session'
import { saveDirectoryWorkspaces } from '@solus/client-core/workspace-registry'
import HostlessHome from './routes/HostlessHome.svelte'
import { pairTokenFromLocation } from './lib/connect'
import { probeServingOrigin } from './lib/add-host'
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
/** The account origin's own word that it is one, with the provider's metadata; null on a host. */
const accountShell = accountOriginShell(document)
mount(WebToaster, { target: root })

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
 * Mounts the workspace on one host: it becomes the window's primary, the new-work
 * default, and every other catalog host is held beside it. A host that refuses this
 * browser shows as a blocked row in the app, never as a boot failure.
 */
async function connectToServer(target: SolusServerTarget, intent?: BootIntent): Promise<void> {
  const generation = ++connectionGeneration
  toasts.dismiss()
  // A host this browser does not keep (the one serving this page with no auth) is known for this page only.
  if (serverConnections.presenceOf(target.id) === 'gone') serverConnections.registerTarget(target)
  const primary = serverConnections.setPrimary(target.id)
  installWindowSolusApi(primary.api)
  installServiceWorkerMessageBridge()
  // The server the page opens at is dialed before the rest of the catalog.
  const firstServerId = intent?.firstServerId ? serverConnections.resolveId(intent.firstServerId) : null
  if (firstServerId && firstServerId !== target.id) serverConnections.ensure(firstServerId)
  if (!intent?.opensResource) void prefetchStartupTranscript()
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
    if (generation !== connectionGeneration) return
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

async function adoptCloudDirectory(options: { waitsForAccount: boolean }): Promise<void> {
  // The same bundle is served at `/` by a host and by the account origin; only the
  // account origin's shell names itself (`accountOriginShell`).
  if (!accountShell) {
    cloudOrigin.kind = 'not-cloud'
    return
  }
  const { kind, directory } = await adoptAccountOrigin(location.origin)
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

async function bootFromCatalog(intent?: BootIntent): Promise<void> {
  // The workspace loads on any success — overlap the import with the probe.
  void loadWorkspaceApp().catch(() => {})
  if (intent?.opensResource) webState.openedFromLink = true
  const directory = adoptCloudDirectory({ waitsForAccount: !intent?.opensResource }).catch((error) => {
    console.warn("[solus:boot] cloud directory unavailable", error)
  })
  // The account origin is never a host; only a page a host serves asks whether it is one.
  const serving = accountShell ? null : await probeServingOrigin(location.origin)
  // A catalog this browser already keeps is dialed now, and the directory refreshes it
  // when it answers; an empty one has nothing to dial until the directory answers.
  if (serverConnections.catalogServerIds().length === 0) await directory
  else void directory.then(() => { if (solusApp) serverConnections.startCatalogSupervisors() })
  let activeId: string | null = null
  try {
    activeId = getActiveServerId()
  } catch {}
  const catalog = serverConnections.catalogServerIds()
  const firstId = catalog.find((serverId) => serverId === activeId) ?? catalog[0]
  const first = firstId ? serverConnections.ensure(firstId).target : null
  if (first) void connectToServer(first, intent)
  else if (serving?.entry && !serving.isSaved) void connectToServer(savedServerTarget(serving.entry), intent)
  else bootHostlessHome()
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
  // The runner is dialed first; hosts' tokens are exchanges made at the same time.
  void bootFromCatalog({ firstServerId: opening.runnerHostId ? savedRunnerFor(opening.runnerHostId) : null, opensResource: true })
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

/** The one host a guest's page holds: the resource's host, or the Solus API's read-only copy of it. */
const GUEST_SERVER_ID = 'guest:workspace'

/**
 * Connects the guest and mounts the shell. The host that runs the resource is dialed
 * on its routes; the Solus API's copy is one more route, dialed only when none of the
 * host's answers (`fallbackRoutes`), so the same shell opens there read only, with
 * the page saying so. Each later dial asks the host first again.
 */
async function connectGuest(link: GuestLink, opening: GuestOpening, displayName: string, onShellMounted: () => void): Promise<void> {
  if (guestBoot.phase === 'connecting') return
  if (opening.kind === 'failed') {
    guestBoot.fail(opening.reason)
    return
  }
  const mirror: HostRoute[] = opening.mirror ? [{ kind: 'direct', url: opening.mirror }] : []
  const hostUrl = guestRouteUrl(opening.host, location.origin)
  const url = hostUrl ?? mirror[0]?.url
  if (!url) {
    guestBoot.fail('Nobody can reach the computer this was shared from right now.')
    return
  }
  guestBoot.phase = 'connecting'
  guestBoot.error = null
  const identity: GuestIdentity = { guestId: loadGuestIdentity()?.guestId ?? newGuestId(), displayName }
  saveGuestIdentity(identity)
  const generation = ++connectionGeneration
  toasts.dismiss()
  const target: SolusServerTarget = {
    id: GUEST_SERVER_ID,
    label: 'Shared resource',
    url,
    sessionToken: '',
    local: false,
    routes: opening.host,
    fallbackRoutes: mirror,
    guest: { shareSecret: link.secret, guestId: identity.guestId, displayName: identity.displayName },
  }
  serverConnections.registerTarget(target)
  const connection = serverConnections.setPrimary(GUEST_SERVER_ID)
  installWindowSolusApi(connection.api)
  serverConnections.onPhaseChange((serverId, phase) => {
    if (serverId !== GUEST_SERVER_ID || generation !== connectionGeneration) return
    if (phase === 'connected') guestBoot.live = !mirror.some((route) => route.url === connection.target.url)
    // The host refused the secret: the link was turned off or regenerated.
    else if (phase === 'blocked' && serverConnections.blockedReasonFor(serverId) === 'auth') guestBoot.revoke()
    else if (phase === 'offline' && guestBoot.phase === 'connecting') guestBoot.fail('The computer this was shared from did not answer.')
  })

  try {
    const info = await serverConnections.serverInfoFor(GUEST_SERVER_ID)
    if (generation !== connectionGeneration || guestBoot.phase !== 'connecting') return
    const share = linkShare(info, link)
    if (!share) {
      guestBoot.fail('This link does not match the shared resource.')
      return
    }
    guestBoot.serverId = GUEST_SERVER_ID
    guestBoot.share = share
    guestBoot.displayName = info.displayName ?? identity.displayName
    const { default: GuestApp } = await loadGuestApp()
    if (generation !== connectionGeneration) return
    onShellMounted()
    guestBoot.phase = 'ready'
    solusApp = mount(GuestApp, { target: root, props: { serverId: GUEST_SERVER_ID, share } })
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
  if (!accountShell) return true
  const deps: WebSignInDeps = {
    session: webAccountSession(location.origin, accountShell.discovery),
    location,
    navigate: (url) => location.assign(url),
    // A guest who opened a share link has no account to sign in to.
    whenSignedOut: (returnTo) => (/^\/(w|s|t)\//.test(returnTo) ? 'stay' : 'sign-in'),
    authorize: fetchAuthorize,
  }
  const outcome = await resumeWebSignIn(deps)
  // A tab open for a long time outlives its grant: sign in again rather than redial forever.
  if (outcome !== 'redirecting') keepWebSignIn(deps, () => serverConnections.dialHostsBlockedOnSignIn())
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
    void bootFromCatalog(addressedBootIntent(location.pathname))
  }
}

void startPage()
