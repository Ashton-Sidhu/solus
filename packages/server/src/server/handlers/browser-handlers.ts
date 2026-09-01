import type { HandlerCtx, SolusServer } from '../server'
import type { HostEventPublisher } from '../../events/host-event-publisher'
import { initBrowserRegistry, type BrowserRegistry } from '../../browser/browser-registry'
import type { BrowserFrameChannel } from '../../browser/browser-frame-channel'
import { discoverBrowserTargets, forgetDiscoveredTargets } from '../../browser/target-scanner'
import { captureEvidence, evidenceOptions } from '../../browser/browser-evidence'
import { setBrowserSpanRecorder } from '../../browser/browser-emitter'
import { endSolusSpan, startSolusSpan } from '../../observability/tracer'

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
 */
export function registerBrowserHandlers(
  server: SolusServer,
  deps: { events: HostEventPublisher; ownPort: () => number; frames: BrowserFrameChannel },
): BrowserRegistry {
  const registry = initBrowserRegistry({
    pageChanged: (page) => deps.events.broadcast('browser.pageChanged', { page }),
    pageClosed: (browserPageId) => deps.events.broadcast('browser.pageClosed', { browserPageId }),
    surfaceRequested: (browserPageId) => deps.events.broadcast('browser.surfaceRequested', { browserPageId }),
  }, deps.frames)

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

  server.register('browserListTargets', async () => {
    // Solus's own port is a listening socket that serves HTML; offering the app
    // its own client as a dev-server target would be absurd but not obviously
    // wrong from the outside, so it is excluded at the source.
    forgetDiscoveredTargets()
    return discoverBrowserTargets({ excludePorts: [deps.ownPort()] })
  })

  server.register('browserListPages', async () => registry.list())

  server.register('browserOpen', async (args) => {
    const [request] = args
    if (request.target.kind === 'url' && !request.target.url.trim()) {
      throw new Error('browserOpen requires a URL')
    }
    return registry.open(request)
  })

  server.register('browserClose', async (args) => registry.close(args[0]))
  server.register('browserNavigate', async (args) => registry.navigate(args[0], args[1]))
  server.register('browserSetViewport', async (args) => registry.setViewport(args[0], args[1]))
  server.register('browserSetAppearance', async (args) => registry.setAppearance(args[0], args[1]))
  server.register('browserSnapshot', async (args) => registry.snapshot(args[0], args[1]))
  server.register('browserInteract', async (args) => registry.interact(args[0], args[1]))
  server.register('browserAttachSurface', async (args) => registry.attachSurface(args[0], args[1]))
  server.register('browserDetachSurface', async (args) => registry.detachSurface(args[0], args[1]))
  server.register('browserReportSurface', async (args) => {
    registry.reportSurface(args[0], args[1])
  })
  server.register('browserClearProfile', async (args) => registry.clearProfile(args[0]))
  server.register('browserSubscribeFrames', async (args, ctx) =>
    registry.subscribeFrames(args[0], requireClientId(ctx)),
  )
  server.register('browserUnsubscribeFrames', async (args, ctx) => {
    await registry.unsubscribeFrames(args[0], requireClientId(ctx))
  })
  server.register('browserCaptureEvidence', async (args) => captureEvidence(args[0]))
  server.register('browserEvidenceOptions', async (args) => evidenceOptions(args[0]))
  server.register('browserOpenDevTools', async (args) => registry.openDevTools(args[0]))
  server.register('browserSetAnnotationTool', async (args) => registry.setAnnotationTool(args[0], args[1]))
  server.register('browserAnnotationState', async (args) => registry.annotationState(args[0]))
  server.register('browserAnnotate', async (args) => registry.annotate(args[0], args[1]))

  return registry
}
