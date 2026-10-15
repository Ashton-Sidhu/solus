import { attributionOf } from '../../admission/actor'
import type { CheckoutService } from '../../git/checkout-service'
import type { HandlerCtx, SolusServer } from '../server'
import { BrowserRuntimeInstaller } from '../../browser/browser-runtime'
import type { HostEventPublisher } from '../events/host-event-publisher'
import { initBrowserRegistry, type BrowserRegistry } from '../../browser/browser-registry'
import type { BrowserFrameChannel } from '../../browser/browser-frame-channel'
import { discoverBrowserTargets, forgetDiscoveredTargets } from '../../browser/target-scanner'
import { captureEvidence, evidenceOptions, stopAndFileRecording } from '../../browser/browser-evidence'
import { initBrowserRecorder } from '../../browser/browser-recorder'
import { startRecordingSweep } from '../../browser/recording-retention'
import {
  browserProfileExists,
  browserProfiles,
  createBrowserProfile,
  deleteBrowserProfileRow,
  importBrowserCookies,
  profileForOpen,
  renameBrowserProfile,
  setBrowserDefaultProfile,
} from '../../browser/browser-profiles'
import { discoverCookieSources, requestCookieAccess } from '../../browser/cookie-sources'
import { browserProfilePartition, type BrowserProfileSet } from '@solus/contracts/browser-types'
import { setBrowserSpanRecorder } from '../../browser/browser-emitter'
import { endSolusSpan, startSolusSpan } from '../../execution/observability/tracer'
import { currentPersonKey } from '../../vault/acting-scope'

/**
 * The browser domain's RPC surface.
 *
 * Every method addresses a page by id, never an engine — which is what lets the
 * same call come from a pane the user is looking at, from an agent verb, or
 * from an automation, and mean the same thing.
 *
 * Returns the registry so the caller can drop a client's stream subscriptions
 * when its connection expires — the transport is the only side that learns of
 * that, and a disconnected phone must not keep a guest painting frames.
 *
 * People (docs/plans/member-isolation.md §6). Every handler runs in the caller's
 * acting scope, so `currentPersonKey()` is the caller. A page opens in the
 * caller's jar; only its owner drives it (`drives`), and anyone who may use the
 * browser lists it and watches its frames. The profile methods name a project
 * and a profile id, which is unique only per person, so the gate cannot find a
 * profile from a call: each handler reads and writes the caller's own rows, and
 * another person's profile cannot be named. They are not in
 * `RESOURCE_VERB_OF_METHOD` for that reason.
 */
export function registerBrowserHandlers(
  server: SolusServer,
  deps: { events: HostEventPublisher; frames: BrowserFrameChannel; checkouts?: CheckoutService },
): BrowserRegistry {
  const runtimeInstaller = new BrowserRuntimeInstaller()
  server.register('browserRuntimeStatus', () => runtimeInstaller.status())
  server.register('browserRuntimeInstall', async () => runtimeInstaller.install())
  const registry = initBrowserRegistry({
    pageChanged: (page) => deps.events.broadcast('browser.pageChanged', { page }),
    pageClosed: (browserPageId) => deps.events.broadcast('browser.pageClosed', { browserPageId }),
    surfaceRequested: (browserPageId) => deps.events.broadcast('browser.surfaceRequested', { browserPageId }),
  }, deps.frames, deps.checkouts)
  const recorder = initBrowserRecorder(registry)
  // Unfiled recordings are deleted a day after they were made: once at host
  // start, then every six hours.
  startRecordingSweep()

  // Browser states what happened; the tracer decides where it lands. Wired here
  // because this is the point at which the domain is known to be running on a
  // host that has observability at all.
  setBrowserSpanRecorder((span) => {
    const started = startSolusSpan({
      kind: span.kind,
      name: span.name,
      service: span.service,
      startedAt: span.startedAt,
      attrs: span.attrs,
      dimensions: span.dimensions,
    })
    endSolusSpan(started, { endedAt: span.endedAt, status: span.status })
  })

  function requireClientId(ctx: HandlerCtx): string {
    if (!ctx.clientId) throw new Error('Streaming a browser page requires a connected client')
    return ctx.clientId
  }

  /** The page's owner may go on; anyone else is refused before the page is touched. */
  function drives(browserPageId: string): void {
    registry.assertDrivableBy(browserPageId, currentPersonKey())
  }

  /** The caller, for a profile method. The host's own work has no profiles. */
  function profileOwner(): string {
    const ownerKey = currentPersonKey()
    if (ownerKey === null) throw new Error("The host's own work has no browser profiles.")
    return ownerKey
  }

  server.register('browserListTargets', async () => {
    forgetDiscoveredTargets()
    return discoverBrowserTargets()
  })

  server.register('browserListPages', async () => registry.list())

  server.register('browserOpen', async (args) => {
    const [request] = args
    // The reserved device variant stays on the wire for compatibility; native
    // devices have their own domain (docs/plans/native-devices.md, D1).
    if (request.target.kind === 'device') {
      throw new Error('Simulators and emulators open in the Devices pane. Use deviceOpen, or device_open for agents.')
    }
    if (request.target.kind === 'url' && !request.target.url.trim()) {
      throw new Error('browserOpen requires a URL')
    }
    const ownerKey = currentPersonKey()
    return registry.open({
      ...request,
      profileId: profileForOpen(
        ownerKey,
        request.target.kind === 'url' ? request.target.projectRoot : undefined,
        request.profileId,
      ),
    }, ownerKey)
  })

  server.register('browserClose', async (args) => {
    drives(args[0])
    return registry.close(args[0], { force: args[1] === true })
  })
  server.register('browserNavigate', async (args) => { drives(args[0]); return registry.navigate(args[0], args[1]) })
  server.register('browserSetViewport', async (args) => { drives(args[0]); return registry.setViewport(args[0], args[1]) })
  server.register('browserSetAppearance', async (args) => { drives(args[0]); return registry.setAppearance(args[0], args[1]) })
  server.register('browserSnapshot', async (args) => { drives(args[0]); return registry.snapshot(args[0], args[1]) })
  server.register('browserInteract', async (args) => { drives(args[0]); return registry.interact(args[0], args[1]) })
  server.register('browserAttachSurface', async (args) => { drives(args[0]); return registry.attachSurface(args[0], args[1]) })
  server.register('browserDetachSurface', async (args) => { drives(args[0]); return registry.detachSurface(args[0], args[1]) })
  server.register('browserReportSurface', async (args) => {
    drives(args[0])
    registry.reportSurface(args[0], args[1])
  })
  server.register('browserClearProfile', async (args) => {
    const [projectRoot, profileId] = args
    const ownerKey = profileOwner()
    if (!browserProfileExists(ownerKey, projectRoot, profileId)) throw new Error(`No browser profile ${profileId} in this project.`)
    await registry.clearProfile(browserProfilePartition(projectRoot, profileId, ownerKey))
  })
  server.register('browserSubscribeFrames', async (args, ctx) =>
    registry.subscribeFrames(args[0], requireClientId(ctx), args[1]),
  )
  server.register('browserUnsubscribeFrames', async (args, ctx) => {
    await registry.unsubscribeFrames(args[0], requireClientId(ctx))
  })
  server.register('browserSetFrameCaps', async (args, ctx) =>
    registry.setFrameCaps(args[0], requireClientId(ctx), args[1]),
  )
  server.register('browserCaptureEvidence', async (args, ctx) => {
    drives(args[0].browserPageId)
    return captureEvidence(args[0], attributionOf(ctx.actor))
  })
  server.register('browserEvidenceOptions', async (args) => evidenceOptions(args[0]))
  server.register('browserRecordingStart', async (args) => { drives(args[0]); return recorder.start(args[0], 'user') })
  server.register('browserRecordingStop', async (args, ctx) => {
    drives(args[0].browserPageId)
    return stopAndFileRecording(recorder, args[0], attributionOf(ctx.actor))
  })
  server.register('browserOpenDevTools', async (args) => { drives(args[0]); return registry.openDevTools(args[0]) })
  server.register('browserSetAnnotationTool', async (args) => { drives(args[0]); return registry.setAnnotationTool(args[0], args[1]) })
  server.register('browserAnnotationState', async (args) => { drives(args[0]); return registry.annotationState(args[0]) })
  server.register('browserAnnotate', async (args) => { drives(args[0]); return registry.annotate(args[0], args[1]) })

  /** Every profile mutation answers with the whole set and sends the same set to
   *  the owner's other clients (the event audience keeps it from everyone else),
   *  so they land on one list rather than on a request result and a stale mirror. */
  function publishProfiles(ownerKey: string, profiles: BrowserProfileSet): BrowserProfileSet {
    deps.events.broadcast('browser.profilesChanged', { ownerKey, profiles })
    return profiles
  }

  server.register('browserListProfiles', async (args) => browserProfiles(profileOwner(), args[0]))
  server.register('browserCreateProfile', async (args) => {
    const ownerKey = profileOwner()
    return publishProfiles(ownerKey, createBrowserProfile(ownerKey, args[0], args[1]))
  })
  server.register('browserRenameProfile', async (args) => {
    const ownerKey = profileOwner()
    return publishProfiles(ownerKey, renameBrowserProfile(ownerKey, args[0], args[1], args[2]))
  })
  server.register('browserSetDefaultProfile', async (args) => {
    const ownerKey = profileOwner()
    return publishProfiles(ownerKey, setBrowserDefaultProfile(ownerKey, args[0], args[1]))
  })

  /** Delete a named profile and everything signed in to it. Refused while a page
   *  is open on it: closing the page first is what makes the deletion deliberate. */
  server.register('browserDeleteProfile', async (args) => {
    const [projectRoot, profileId] = args
    const ownerKey = profileOwner()
    const partition = browserProfilePartition(projectRoot, profileId, ownerKey)
    const open = registry.pagesOnPartition(partition)
    if (open.length > 0) {
      throw new Error(
        `${open.length} browser page${open.length === 1 ? ' is' : 's are'} still open on this profile. `
        + 'Close them first — deleting it signs them out.',
      )
    }
    // The jar goes before the row: a row removed while its cookies survived
    // would strand a signed-in partition nothing can reach or clear.
    await registry.clearProfile(partition)
    return publishProfiles(ownerKey, deleteBrowserProfileRow(ownerKey, projectRoot, profileId))
  })

  server.register('browserListCookieSources', async () => discoverCookieSources())
  server.register('browserRequestCookieAccess', async (args) => requestCookieAccess(args[0]))
  server.register('browserImportCookies', async (args) => importBrowserCookies(profileOwner(), args[0]))

  return registry
}
