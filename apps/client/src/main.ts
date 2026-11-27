import { prefetchStartupTranscript } from '@solus/workspace-ui/contexts/workspace/startup-transcript'
import { mount, unmount } from 'svelte'
import '@solus/workspace-ui/index.css'
import { TransportDisconnectedError } from '@solus/client-core/ws-transport'
import { guestRouteUrl, loadGuestIdentity, newGuestId, resolveShareLink, saveGuestIdentity, type GuestIdentity } from '@solus/client-core/guest-link'
import { isGuestLinkResource, parseCloudShareLink, type GuestLink } from '@solus/contracts/sharing'
import { shareLinkOpening, type GuestOpening } from './lib/share-link-opening'
import { accountSettingsDestination } from '@solus/contracts/account-web'
import { addressedBootIntent, type BootIntent } from './lib/boot-intent'
import { knownRunnerFor } from '@solus/client-core/session-runner'
import { guestBoot, type GuestShare } from './lib/guest-boot.svelte'
import type { ConnectionsServerInfo } from '@solus/contracts/host-api'
import { serverConnections } from '@solus/client-core/server-connections'
import { getActiveServerId, setActiveServerId } from '@solus/client-core/known-host'
import { hostCatalog } from '@solus/client-core/host-catalog'
import { hostListSourceFor } from '@solus/client-core/host-list-source'
import { accountDocumentCall, webAccountDocumentSend, type AccountDocumentCall } from '@solus/client-core/account-documents'
import { cloudAccount, configureCloudAccount, startupAccountRead, webCloudAccount } from '@solus/client-core/cloud-account'
import { skipsOnboarding } from '@solus/workspace-ui/components/onboarding/lib/skip-onboarding'
import { appPairLink, pairServer } from '@solus/client-core/pairing'
import { defaultDeviceLabel } from '@solus/client-core/device-label'
import { adoptAccountOrigin } from '@solus/client-core/uplink-account'
import { accountOriginShell } from './lib/account-origin'
import type { HostRoute } from '@solus/contracts/host-routes'
import { MAX_WEB_TOKEN_HOSTS } from '@solus/contracts/uplink'
import { WEB_SIGN_OUT_CHANNEL, WebTokenSession } from '@solus/client-core/web-token-session'
import { pairTokenFromLocation, pairHostFromLocation, probeServer } from './lib/connect'
import { probeServingOrigin } from './lib/add-host'
import { cloudOrigin } from './lib/cloud-origin.svelte'
import { webState } from './lib/web-state.svelte'
import { registerServiceWorker } from './lib/service-worker'
import { toasts } from '@solus/workspace-ui/lib/toasts'
import { startScrollReveal } from '@solus/workspace-ui/lib/scroll-reveal'
import WebToaster from './components/WebToaster.svelte'
import { isStaleBuildError, reportStaleBuild } from './lib/stale-build'
import { stylesheetsApplied } from './lib/page-styles'
import { BOOT_SPLASH_ID } from '@solus/workspace-ui/lib/boot-splash'
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
    revealPage()
    reportStaleBuild()
  }
})

// Vite's preload helper reports a chunk it could not fetch here; without a
// listener it rethrows, and the surface that asked for the chunk stays blank.
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault()
  revealPage()
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
/** The account origin's own word that it is one, with who is signed in; null on a host. */
const accountShell = accountOriginShell(document)
/** A share link's page: a person signed out there stays, as a guest. */
const isSharePath = (pathname: string) => /^\/(w|s|t)\//.test(pathname)
/**
 * The page's sign-in on the account origin (docs/plans/web-session-tokens.md): the
 * shell says who is signed in, and the account origin signs this page's tokens from its
 * website session. Null on a host, and for a guest with no session.
 */
const webSession = accountShell?.signedIn
  ? new WebTokenSession({
    origin: location.origin,
    identity: accountShell.signedIn.identity,
    signedInAt: accountShell.signedIn.signedInAt,
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    // The website session ended (a sign-out in this or another tab, the Devices page, expiry):
    // sign in again and come back here. A guest on a share link stays.
    onSignedOut: () => {
      const returnTo = `${location.pathname}${location.search}${location.hash}`
      if (!isSharePath(returnTo)) location.assign(`/sign-in?next=${encodeURIComponent(returnTo)}`)
    },
    channel: new BroadcastChannel(WEB_SIGN_OUT_CHANNEL),
  })
  : null
// The first host ready to answer: the load benchmark and field timing read this.
const stopHostReadyMark = serverConnections.onReadinessChange((_serverId, readiness) => {
  if (readiness !== 'ready') return
  performance.mark('solus:host-ready')
  stopHostReadyMark()
})
mount(WebToaster, { target: root })

/**
 * The page's stylesheet does not hold the first paint, so the boot splash paints
 * with the HTML (scripts/vite-boot-splash.ts). Every surface waits for it to apply
 * before it mounts, so none paints with no styles.
 */
const pageStyled = stylesheetsApplied(document)

/** The boot splash shows until a surface takes its place. */
function removeBootSplash(): void {
  document.getElementById(BOOT_SPLASH_ID)?.remove()
}

/** No surface mounts: the splash goes, so it does not cover the toast that says why. */
function revealPage(): void {
  void pageStyled.then(removeBootSplash)
}

let solusApp: ReturnType<typeof mount> | null = null
let serviceWorkerBridgeInstalled = false
let connectionGeneration = 0
let workspaceAppImport: Promise<typeof import('./App.svelte')> | null = null

function loadWorkspaceApp(): Promise<typeof import('./App.svelte')> {
  if (!workspaceAppImport) {
    workspaceAppImport = import('./App.svelte').then((module) => {
      // The workspace code is downloaded and run: the load benchmark and field timing read this.
      performance.mark('solus:workspace-code')
      return module
    }, (error) => {
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
async function connectToServer(serverId: string, intent?: BootIntent): Promise<void> {
  const generation = ++connectionGeneration
  toasts.dismiss()
  const primary = serverConnections.setPrimary(serverId)
  installWindowSolusApi(primary.api)
  installServiceWorkerMessageBridge()
  // The server the page opens at is dialed before the rest of the catalog.
  const firstServerId = intent?.firstServerId
    ? serverConnections.resolveId(intent.firstServerId)
    : intent?.runnerHostId ? knownRunnerFor(intent.runnerHostId) : null
  if (firstServerId && firstServerId !== serverId) serverConnections.ensure(firstServerId)
  if (!intent?.opensResource) void prefetchStartupTranscript()
  // Every known host is eagerly desired, not only the one this boot chose.
  serverConnections.startCatalogSupervisors()
  hostCatalog.touchLastConnected(serverId)
  // Remember the choice so a refresh and the servers directory both resume here.
  setActiveServerId(serverId)

  if (pendingNotificationRoute) {
    history.replaceState(null, '', pendingNotificationRoute.replace(/^#/, ''))
    pendingNotificationRoute = null
  }

  await mountWorkspace(generation)
}

async function mountWorkspace(generation: number): Promise<void> {
  try {
    // Pairing and reconnect plumbing live in the small entry chunk; the
    // multi-megabyte shared workspace graph loads lazily behind it.
    // Saved tabs provide the loading state while history arrives in the background.
    const [{ default: App }] = await Promise.all([loadWorkspaceApp(), pageStyled])
    if (generation !== connectionGeneration) return
    // The workspace takes the place of the splash in this same task.
    removeBootSplash()
    solusApp = mount(App, { target: root })
  } catch (error) {
    if (generation !== connectionGeneration) return
    revealPage()
    if (error instanceof Error && isStaleBuildError(error)) reportStaleBuild()
    else toasts.error(error instanceof Error ? error.message : 'Workspace failed to load')
  }
}

function bootHostlessHome(): void {
  const generation = ++connectionGeneration
  toasts.dismiss()
  // Only a browser with no host shows this page, so only that path loads it.
  void Promise.all([import('./routes/HostlessHome.svelte'), pageStyled]).then(([{ default: HostlessHome }]) => {
    if (generation !== connectionGeneration) return
    removeBootSplash()
    mount(HostlessHome, { target: root })
  })
}

installWindowSolusApi(createNoHostSolusApi())

/**
 * A phone that scanned a pairing code with its camera may have the Solus app:
 * it chooses which one pairs, since the code works once. Anything else pairs
 * this browser at once, as before.
 */
function offerAppOrPair(pairToken: string): void {
  const hostUrl = pairHostFromLocation(location.href)
  if (!matchMedia('(pointer: coarse)').matches) {
    void pairFromLocation(pairToken, hostUrl)
    return
  }
  const appLink = appPairLink(location.href)
  history.replaceState({}, '', '/')
  void Promise.all([import('./routes/PairInApp.svelte'), pageStyled]).then(([{ default: PairInApp }]) => {
    removeBootSplash()
    const page = mount(PairInApp, {
      target: root,
      props: {
        appLink,
        onContinue: () => {
          void unmount(page)
          void pairFromLocation(pairToken, hostUrl)
        },
      },
    })
  })
}

async function pairFromLocation(pairToken: string, hostUrl: string | null): Promise<void> {
  history.replaceState({}, '', '/')
  try {
    if (hostUrl && !(await probeServer(hostUrl)).ok) throw new Error('This Tailscale host did not answer.')
    void loadWorkspaceApp().catch(() => {})
    const { server } = await pairServer({
      url: hostUrl ?? location.origin,
      pairToken,
      deviceLabel: defaultDeviceLabel(),
    })
    await hostCatalog.load()
    // Paired at the page's own address, the host is the one the page runs beside: its list is the person's.
    if (!hostUrl) serverConnections.setServingHostId(server.id)
    const { listError } = await hostCatalog.pair(server)
    if (listError) toasts.error(`${server.label} is paired here but not yet on your host list`)
    setActiveServerId(server.id)
    await connectToServer(server.id)
  } catch (err) {
    bootHostlessHome()
    toasts.error(err instanceof Error ? err.message : String(err))
  }
}

/**
 * Reads the account's directory (`hostCatalog.refreshDirectory`), which takes the
 * read the account origin's shell started. A page a host serves has no account, so
 * its directory answers at once with no hosts.
 */
async function adoptCloudDirectory(): Promise<void> {
  // The same bundle is served at `/` by a host and by the account origin; only the
  // account origin's shell names itself (`accountOriginShell`).
  if (!accountShell) cloudOrigin.kind = 'not-cloud'
  else cloudOrigin.kind = (await adoptAccountOrigin(location.origin, webSession, accountShell)).kind
  await hostCatalog.refreshDirectory()
}

/** The account's documents while this page is signed in at the account origin; null otherwise. */
function webAccountDocuments(): AccountDocumentCall | null {
  const account = cloudAccount()
  return account ? accountDocumentCall(webAccountDocumentSend(account.consoleUrl, account.session)) : null
}

async function bootFromCatalog(intent?: BootIntent): Promise<void> {
  if (intent?.opensResource) webState.openedFromLink = true
  await hostCatalog.load()
  const directory = adoptCloudDirectory().catch((error) => {
    console.warn("[solus:boot] cloud directory unavailable", error)
  })
  // A share link that resolves to the workspace starts the import here.
  void loadWorkspaceApp().catch(() => {})
  // The account origin is never a host; only a page a host serves asks whether it is one.
  const serving = accountShell ? null : await probeServingOrigin(location.origin)
  const servingHost = serving?.known ?? serving?.entry
  if (servingHost) {
    // The host that served the page is the one it runs beside (plans/031 D7): it is
    // dialed first, and signed out the person's list is read there. A serving host this
    // browser does not keep is in the catalog for this page only.
    hostCatalog.addPageHost(servingHost)
    // The catalog's device host: never put on its own list, and kept out of §3 Q1 (plans/033).
    serverConnections.setServingHostId(servingHost.id)
  }
  // The person's list (plans/033 §4.5): the account's while signed in at the account
  // origin, the serving host's, or this browser's own at the account origin signed out.
  const list = hostCatalog.useListSource(hostListSourceFor({
    accountDocuments: webAccountDocuments(),
    deviceHost: servingHost
      ? { id: servingHost.id, api: serverConnections.apiFor(servingHost.id), events: serverConnections.eventsFor(servingHost.id) }
      : null,
    deviceStorage: localStorage,
  }))
  // A page a host serves opens on that host at once. With no such host, the page
  // waits for the list and the directory to know a host: nothing is kept from an
  // earlier visit (§3 Q2).
  if (!servingHost) await Promise.all([directory, list])
  let activeId: string | null = null
  try {
    activeId = getActiveServerId()
  } catch {}
  const catalog = serverConnections.catalogServerIds()
  const firstId = catalog.find((serverId) => serverId === activeId) ?? servingHost?.id ?? catalog[0]
  if (firstId) void connectToServer(firstId, intent)
  else if (webSession && intent?.hostlessPage) {
    const [{ default: AccountSettings }] = await Promise.all([import('./routes/AccountSettings.svelte'), pageStyled])
    removeBootSplash()
    mount(AccountSettings, { target: root, props: { page: intent.hostlessPage } })
  } else if (webSession && !intent?.opensResource && !skipsOnboarding(location.search, window)
    && (await startupAccountRead())?.onboardingCompletedAt === null) {
    // Onboarding can create or link the first machine. It needs the workspace
    // context but does not need a host connection to open.
    installServiceWorkerMessageBridge()
    await mountWorkspace(++connectionGeneration)
  } else bootHostlessHome()
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
  const state = webSession?.state()
  const signedIn = webSession && state?.kind === 'signed-in' ? { account: webSession, name: state.identity.name || state.identity.email, userId: state.identity.sub } : null
  // Nothing loads before the resolve: the app's code is hundreds of requests, and a
  // browser that fetches a few at a time sends the resolve only after all of them.
  const token = signedIn ? await signedIn.account.accessToken({ kind: 'api' }) : null
  const opening = shareLinkOpening(await resolveShareLink(location.origin, link.secret, token), link, location.origin)
  if (opening.kind !== 'member') {
    void bootGuest(link, opening, signedIn)
    return
  }
  history.replaceState(null, '', opening.address)
  // The runner is dialed first, once the directory names the known host it is; hosts'
  // tokens are exchanges made at the same time.
  void bootFromCatalog({ firstServerId: null, runnerHostId: opening.runnerHostId, opensResource: true })
}

async function bootGuest(link: GuestLink, opening: GuestOpening, signedIn: { name: string; userId: string } | null): Promise<void> {
  guestBoot.link = link
  guestBoot.displayName = loadGuestIdentity()?.displayName ?? ''
  // A visitor signed in to Solus is not asked who they are: the page's sign-in names them.
  guestBoot.signedInAs = signedIn?.name ?? null
  guestBoot.accountUserId = signedIn?.userId ?? null
  if (opening.kind === 'failed') guestBoot.fail(opening.reason)
  else void loadGuestApp().catch(() => {})
  const [{ default: GuestLanding }] = await Promise.all([import('./routes/GuestLanding.svelte'), pageStyled])
  removeBootSplash()
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
  // The mirror is on the account origin, an `https:` origin of Solus cloud like a tunnel.
  const mirror: HostRoute[] = opening.mirror ? [{ kind: 'tunnel', url: opening.mirror }] : []
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
  hostCatalog.addPageHost({
    id: GUEST_SERVER_ID,
    label: 'Shared resource',
    sessionToken: '',
    installationId: GUEST_SERVER_ID,
    lastConnected: 0,
    routes: opening.host,
    fallbackRoutes: mirror,
    guest: { shareSecret: link.secret, guestId: identity.guestId, displayName: identity.displayName },
  })
  const connection = serverConnections.setPrimary(GUEST_SERVER_ID)
  installWindowSolusApi(connection.api)
  serverConnections.onReadinessChange((serverId, readiness) => {
    if (serverId !== GUEST_SERVER_ID || generation !== connectionGeneration) return
    if (readiness === 'ready') guestBoot.live = !mirror.some((route) => route.url === connection.target.url)
    // The host refused the secret: the link was turned off or regenerated.
    else if (readiness === 'refused' && serverConnections.readinessFor(serverId).refusedReason === 'auth') guestBoot.revoke()
    else if (readiness === 'unreachable' && guestBoot.phase === 'connecting') guestBoot.fail('The computer this was shared from did not answer.')
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

async function startPage(): Promise<void> {
  // The first token request goes before any code loads: the servers token and every
  // host of the shell's directory, in one request (docs/plans/web-session-tokens.md).
  const accountPage = accountSettingsDestination(location.pathname)
  webSession?.start(dialableHostIds())
  if (accountPage && webSession && accountShell && !accountShell.directory?.hosts.length) {
    configureCloudAccount(webCloudAccount(location.origin, webSession, fetch, accountShell.settingsJson), accountShell.account)
    const [{ default: AccountSettings }] = await Promise.all([import('./routes/AccountSettings.svelte'), pageStyled])
    removeBootSplash()
    mount(AccountSettings, { target: root, props: { page: accountPage } })
    return
  }
  const bootPairToken = pairTokenFromLocation(location.href)
  if (bootPairToken) {
    offerAppOrPair(bootPairToken)
    return
  }
  // Only the account origin mints guest links; on a host the same path is a link
  // nobody minted, and the grant request below says so.
  const bootShareLink = parseCloudShareLink(location.pathname, location.hash)
  if (bootShareLink) {
    void openShareLink(bootShareLink)
  } else if (/^\/(w|s)\//.test(location.pathname)) {
    void Promise.all([import('./routes/GuestLanding.svelte'), pageStyled]).then(([{ default: GuestLanding }]) => {
      guestBoot.fail('This link is incomplete. Ask the sharer to copy it again.')
      removeBootSplash()
      mount(GuestLanding, { target: root, props: { onContinue: () => {} } })
    })
  } else {
    // The shell says who is signed in, so the workspace mounts as soon as its code has run.
    void bootFromCatalog(addressedBootIntent(location.pathname))
  }
}

/** The shell's hosts this page may dial: their tokens come with the first answer. */
function dialableHostIds(): string[] {
  const hosts = accountShell?.directory?.hosts ?? []
  return hosts.filter((host) => host.routes.length > 0).map((host) => host.hostId).slice(0, MAX_WEB_TOKEN_HOSTS)
}

void startPage()
