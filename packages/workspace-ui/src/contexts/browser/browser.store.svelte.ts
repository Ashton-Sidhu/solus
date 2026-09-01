import { SvelteMap } from 'svelte/reactivity'
import { resolveViewport } from '@solus/contracts/browser-types'
import type {
  BrowserAnnotateOp,
  BrowserAnnotationState,
  BrowserAnnotationTool,
  BrowserAppearance,
  BrowserCaptureRequest,
  BrowserDetachReason,
  BrowserEvidence,
  BrowserEvidenceOptions,
  BrowserEvidenceTarget,
  BrowserFrameHeader,
  BrowserDiscoveredTarget,
  BrowserInteractOp,
  BrowserInteractResult,
  BrowserNavigateOp,
  BrowserOpenRequest,
  BrowserPage,
  BrowserSurfaceReport,
  BrowserViewport,
  BrowserViewportRequest,
} from '@solus/contracts/browser-types'
import type { BrowserFrameListener } from '@solus/client-core/browser-frame-subscriber'
import { hostKey, splitHostKey } from '@solus/client-core/host-key'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import { serverConnections } from '@solus/client-core/server-connections'

/**
 * The renderer's mirror of the server-owned browser registry.
 *
 * Pages are not created here and their state is not decided here — the host
 * owns both, so an agent driving a page and a user watching it never disagree.
 * What this store adds is client identity: which host a page belongs to, which
 * one the pane is showing, and which client surface currently renders it.
 */

export interface BrowserPageEntry {
  serverId: string
  page: BrowserPage
}

export interface CachedBrowserFrame {
  header: BrowserFrameHeader
  data: ArrayBuffer
}

interface ActiveFrameSubscription {
  errorListeners: Map<symbol, (error: Error) => void>
}

export class BrowserStore {
  /** Keyed by `hostKey(serverId, browserPageId)`: a page id is only unique
   *  within its host, and two hosts can serve the same worktree name. */
  pages = new SvelteMap<string, BrowserPageEntry>()
  targetsByServer = new SvelteMap<string, BrowserDiscoveredTarget[]>()
  /** The page the pane is showing, as a host key. */
  activeKey = $state<string | null>(null)
  loadingTargets = $state(false)
  /** Sizes a gesture asked for, newest per page, and the pages already applying
   *  one. Not reactive: no geometry is drawn from a size still in flight. */
  private queuedViewports = new Map<string, BrowserViewportRequest>()
  private applyingViewports = new Set<string>()
  /** A reconnect can start a new list while an older request is still in
   *  flight. Only the newest answer for a host may reconcile its pages. */
  private pageLoadVersions = new Map<string, number>()
  /** The latest compressed frame per streamed page. A hidden page stops its
   *  subscription, but keeping this one JPEG lets the next selection paint at
   *  once instead of replacing a useful picture with a loading skeleton. */
  private cachedFrames = new Map<string, CachedBrowserFrame>()
  /** One host-side watch per page on this client. Editor and Pill can both show
   *  the page, but the binary subscriber already fans one incoming frame out to
   *  both canvases. Keeping the remote watch singular also lets reconnect reset
   *  it without leaking a second server-side reference. */
  private activeFrameSubscriptions = new Map<string, ActiveFrameSubscription>()
  /**
   * The size a gesture is asking for right now, resolved the way the host will
   *  resolve it — clamped included, so a drag past the limit shows the number it
   *  will actually get.
   *
   * Read only by the chrome that *states* the size. The stage frame and the
   * guest stay on the viewport the host confirmed, so the picture is never a
   * rendering at a size it is not; but the numbers are the user's own request,
   * and making them wait for a round trip is what made a drag feel detached
   * from the pointer.
   */
  private requestedViewports = new SvelteMap<string, BrowserViewport>()

  /** Set by the shell: a page asked for a surface, so open the browser pane on
   *  it. Explicitly invoked by whoever called `browserOpen` — never a
   *  background auto-open. */
  onSurfaceRequested: ((key: string) => void) | null = null

  get entries(): BrowserPageEntry[] {
    return [...this.pages.values()].sort((a, b) => a.page.createdAt - b.page.createdAt)
  }

  get activeEntry(): BrowserPageEntry | null {
    return this.activeKey ? this.pages.get(this.activeKey) ?? null : null
  }

  keyOf(serverId: string, browserPageId: string): string {
    return hostKey(serverId, browserPageId)
  }

  targetsFor(serverId: string): BrowserDiscoveredTarget[] {
    return this.targetsByServer.get(serverId) ?? []
  }

  subscribe(): () => void {
    const unsubscribers = [
      subscribeAllHosts('browser.pageChanged', (serverId, { page }) => {
        this.pages.set(hostKey(serverId, page.browserPageId), { serverId, page })
      }),
      subscribeAllHosts('browser.pageClosed', (serverId, { browserPageId }) => {
        this.forget(hostKey(serverId, browserPageId))
      }),
      subscribeAllHosts('browser.surfaceRequested', (serverId, { browserPageId }) => {
        const key = hostKey(serverId, browserPageId)
        this.activeKey = key
        this.onSurfaceRequested?.(key)
      }),
      serverConnections.onStatusChange((serverId, status) => {
        if (status !== 'connected') return
        void this.loadPages(serverId).catch(() => {})
        this.restoreFrameSubscriptions(serverId)
      }),
    ]
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe()
    }
  }

  async loadPages(serverId: string): Promise<void> {
    const version = (this.pageLoadVersions.get(serverId) ?? 0) + 1
    this.pageLoadVersions.set(serverId, version)
    const pages = await serverConnections.apiFor(serverId).browserListPages()
    if (this.pageLoadVersions.get(serverId) !== version) return
    const present = new Set(
      pages.map((page) => hostKey(serverId, page.browserPageId)),
    )
    for (const [key, entry] of this.pages) {
      if (entry.serverId === serverId && !present.has(key)) this.forget(key)
    }
    for (const page of pages) this.pages.set(hostKey(serverId, page.browserPageId), { serverId, page })
    if (!this.activeKey && pages[0]) this.activeKey = hostKey(serverId, pages[0].browserPageId)
  }

  async loadTargets(serverId: string): Promise<void> {
    this.loadingTargets = true
    try {
      this.targetsByServer.set(serverId, await serverConnections.apiFor(serverId).browserListTargets())
    } finally {
      this.loadingTargets = false
    }
  }

  async open(serverId: string, request: BrowserOpenRequest): Promise<string> {
    const page = await serverConnections.apiFor(serverId).browserOpen(request)
    const key = hostKey(serverId, page.browserPageId)
    this.pages.set(key, { serverId, page })
    this.activeKey = key
    return key
  }

  async close(key: string): Promise<void> {
    const { serverId, path } = splitHostKey(key)
    await serverConnections.apiFor(serverId).browserClose(path)
    this.forget(key)
  }

  /** Drop a page and, when it was the one showing, fall back to another rather
   *  than leaving the pane pointing at nothing. */
  private forget(key: string): void {
    this.pages.delete(key)
    // A size the user asked for on the way out has nowhere to land.
    this.queuedViewports.delete(key)
    this.requestedViewports.delete(key)
    this.annotations.delete(key)
    this.cachedFrames.delete(key)
    if (this.activeKey !== key) return
    const next = this.entries[0]
    this.activeKey = next ? hostKey(next.serverId, next.page.browserPageId) : null
  }

  navigate(key: string, op: BrowserNavigateOp): Promise<void> {
    const { serverId, path } = splitHostKey(key)
    return serverConnections.apiFor(serverId).browserNavigate(path, op)
  }

  setViewport(key: string, request: BrowserViewportRequest): Promise<void> {
    const { serverId, path } = splitHostKey(key)
    return serverConnections.apiFor(serverId).browserSetViewport(path, request)
  }

  /**
   * Ask for a size from a gesture: an edge being dragged, or a pane being
   * resized under a filling page.
   *
   * A gesture produces a size per frame, and each one is real device emulation
   * on the host. Sizes are coalesced rather than queued — while one is being
   * applied the rest collapse to the newest, so the page follows the pointer and
   * the host never works through a backlog of viewports the user already left.
   */
  commitViewport(key: string, request: BrowserViewportRequest, onError: (error: Error) => void): void {
    this.queuedViewports.set(key, request)
    this.requestedViewports.set(key, resolveViewport(request))
    if (this.applyingViewports.has(key)) return
    void this.drainViewports(key, onError)
  }

  private async drainViewports(key: string, onError: (error: Error) => void): Promise<void> {
    this.applyingViewports.add(key)
    try {
      for (;;) {
        const next = this.queuedViewports.get(key)
        if (!next) return
        this.queuedViewports.delete(key)
        await this.setViewport(key, next).catch(onError)
      }
    } finally {
      this.applyingViewports.delete(key)
      // The last request has been answered, so the page's own viewport is the
      // current one and the chrome goes back to reading it.
      this.requestedViewports.delete(key)
    }
  }

  /** The size being asked for, while one is in flight. */
  requestedViewport(key: string | null): BrowserViewport | null {
    return key ? this.requestedViewports.get(key) ?? null : null
  }

  setAppearance(key: string, appearance: BrowserAppearance): Promise<void> {
    const { serverId, path } = splitHostKey(key)
    return serverConnections.apiFor(serverId).browserSetAppearance(path, appearance)
  }

  /** Hand this client's mounted `<webview>` to the host that owns the page.
   *  Only meaningful for the desktop's own local host, where the server can
   *  reach the guest in-process. */
  attachSurface(key: string, webContentsId: number): Promise<void> {
    const { serverId, path } = splitHostKey(key)
    return serverConnections.apiFor(serverId).browserAttachSurface(path, webContentsId)
  }

  /** `crashed` is the client saying the guest died rather than that the pane
   *  closed — the page has no surface either way, but only one of them is
   *  waiting for the next pane. */
  detachSurface(key: string, reason?: BrowserDetachReason): Promise<void> {
    const { serverId, path } = splitHostKey(key)
    return serverConnections.apiFor(serverId).browserDetachSurface(path, reason)
  }

  reportSurface(key: string, report: BrowserSurfaceReport): Promise<void> {
    const { serverId, path } = splitHostKey(key)
    return serverConnections.apiFor(serverId).browserReportSurface(path, report)
  }

  /** Forget the persistent login this project's browser pages share. The way
   *  out of the profile that survives restarts.
   *
   *  Addressed by host rather than by page: a profile belongs to a project, not
   *  to whichever page happens to be open, and the project panel offers this
   *  with no browser page open at all. */
  clearProfile(serverId: string, partition: string): Promise<void> {
    return serverConnections.apiFor(serverId).browserClearProfile(partition)
  }

  /**
   * Start receiving streamed frames for a page, and stop on the returned
   * disposer. This is how a client with no native surface — web, mobile — sees a
   * page: it subscribes to the pixels here and asks the host to start producing
   * them. The host streams only while subscribed, so a surface that unsubscribes
   * when its pane hides costs nothing on the wire.
   *
   * The subscribe RPC can fail (a remote host with no headless engine cannot
   * stream); that answer belongs to the surface that asked, so it is reported
   * rather than swallowed.
   */
  subscribeFrames(key: string, onFrame: BrowserFrameListener, onError: (error: Error) => void): () => void {
    const { serverId, path } = splitHostKey(key)
    const listenerId = Symbol(key)
    let active = this.activeFrameSubscriptions.get(key)
    if (!active) {
      active = { errorListeners: new Map() }
      this.activeFrameSubscriptions.set(key, active)
    }
    active.errorListeners.set(listenerId, onError)
    const off = serverConnections.framesFor(serverId).subscribe(path, (header, data) => {
      this.cachedFrames.set(key, { header, data })
      onFrame(header, data)
    })
    if (active.errorListeners.size === 1) this.startFrameSubscription(key)
    return () => {
      off()
      const current = this.activeFrameSubscriptions.get(key)
      current?.errorListeners.delete(listenerId)
      if (current?.errorListeners.size) return
      this.activeFrameSubscriptions.delete(key)
      void serverConnections.apiFor(serverId).browserUnsubscribeFrames(path).catch(() => {})
    }
  }

  private startFrameSubscription(key: string): void {
    const { serverId, path } = splitHostKey(key)
    void serverConnections.apiFor(serverId).browserSubscribeFrames(path).catch((error: Error) => {
      const active = this.activeFrameSubscriptions.get(key)
      if (!active) return
      for (const listener of active.errorListeners.values()) listener(error)
    })
  }

  /** A phone can sleep past the host's client-expiry window while this Svelte
   *  tree stays mounted. Reset the old watch when the socket returns: unsubscribe
   *  is harmless if the host already expired it, and prevents a retained watch
   *  from gaining a duplicate reference before the fresh subscribe. */
  private restoreFrameSubscriptions(serverId: string): void {
    for (const key of this.activeFrameSubscriptions.keys()) {
      const target = splitHostKey(key)
      if (target.serverId !== serverId) continue
      void serverConnections.apiFor(serverId).browserUnsubscribeFrames(target.path)
        .catch(() => {})
        .then(() => {
          if (this.activeFrameSubscriptions.has(key)) this.startFrameSubscription(key)
        })
    }
  }

  cachedFrame(key: string): CachedBrowserFrame | null {
    return this.cachedFrames.get(key) ?? null
  }

  /**
   * Take the page's picture and file it.
   *
   * The same host call an agent's snapshot uses, so a capture the user took by
   * hand and a capture an agent took are the same kind of thing in the same
   * store — which is the point of the evidence loop.
   */
  captureEvidence(key: string, attach?: BrowserEvidenceTarget, caption?: string): Promise<BrowserEvidence> {
    const { serverId, path } = splitHostKey(key)
    const request: BrowserCaptureRequest = { browserPageId: path }
    if (attach) request.attach = attach
    if (caption) request.caption = caption
    return serverConnections.apiFor(serverId).browserCaptureEvidence(request)
  }

  /** What this page could be filed against. Only the host knows: the pull
   *  request belongs to the branch the page's worktree is on. */
  evidenceOptions(key: string): Promise<BrowserEvidenceOptions> {
    const { serverId, path } = splitHostKey(key)
    return serverConnections.apiFor(serverId).browserEvidenceOptions(path)
  }

  /** Open the browser's own DevTools on this page's guest. Costs the CDP
   *  session while it is open, which the page reports as `devToolsOpen`. */
  openDevTools(key: string): Promise<void> {
    const { serverId, path } = splitHostKey(key)
    return serverConnections.apiFor(serverId).browserOpenDevTools(path)
  }

  /**
   * The marks the user has made on a page.
   *
   * Held in the guest rather than here, because the overlay that captures them
   * is injected into the page — so this store caches the last read rather than
   * owning the state, and the pane re-reads while a tool is armed. A reload
   * clears the marks, which is why nothing here tries to restore them.
   */
  annotations = new SvelteMap<string, BrowserAnnotationState>()

  annotationsFor(key: string | null): BrowserAnnotationState | null {
    return key ? this.annotations.get(key) ?? null : null
  }

  async setAnnotationTool(key: string, tool: BrowserAnnotationTool | null): Promise<void> {
    const { serverId, path } = splitHostKey(key)
    const state = await serverConnections.apiFor(serverId).browserSetAnnotationTool(path, tool)
    this.annotations.set(key, state)
  }

  async refreshAnnotations(key: string): Promise<void> {
    const { serverId, path } = splitHostKey(key)
    this.annotations.set(key, await serverConnections.apiFor(serverId).browserAnnotationState(path))
  }

  async annotate(key: string, op: BrowserAnnotateOp): Promise<void> {
    const { serverId, path } = splitHostKey(key)
    this.annotations.set(key, await serverConnections.apiFor(serverId).browserAnnotate(path, op))
  }

  /** Paint transient box-selection feedback in the guest without rebuilding
   *  the pane's durable annotation state for every remote pointer update. */
  async browserAnnotationRegion(
    key: string,
    rect: { x: number; y: number; width: number; height: number } | null,
  ): Promise<void> {
    const { serverId, path } = splitHostKey(key)
    await serverConnections.apiFor(serverId).browserAnnotate(path, {
      kind: 'browserRegion',
      rect,
    })
  }

  /** Forward one input to the page's guest. A streamed surface maps a pointer to
   *  a CSS-viewport coordinate and sends `clickAt`/`scrollAt`; the same path the
   *  agent verbs use, one page, one owner. */
  interact(key: string, op: BrowserInteractOp): Promise<BrowserInteractResult> {
    const { serverId, path } = splitHostKey(key)
    return serverConnections.apiFor(serverId).browserInteract(path, op)
  }
}

export const browserStore = new BrowserStore()
