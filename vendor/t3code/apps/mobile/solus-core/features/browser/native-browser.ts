import { addressProblem, navigableAddress } from "@solus/client-core/browser-address"
import type { BrowserFrameListener } from '@solus/client-core/browser-frame-subscriber'
import {
  largestFrameCaps,
  type BrowserAppearance,
  type BrowserCloseResult,
  type BrowserDialogAnswer,
  type BrowserDownload,
  type BrowserFrameCaps,
  type BrowserInteractOp,
  type BrowserInteractResult,
  type BrowserNavigateOp,
  type BrowserPage,
  type BrowserViewportRequest,
} from '@solus/contracts/browser-types'
import type { HostConnection } from '../hosts/host-connections'
import { Listeners } from '../../lib/listeners'
import type { AttachmentIo, PickedFile } from '../conversation/lib/attachments'

/** An agent asked for a page to be shown to the person, as a desktop pane would show it. */
export interface BrowserReveal {
  readonly browserPageId: string
  readonly sessionId: string | undefined
  /** Increases on every request, so the same page asked for twice pops again. */
  readonly requestId: number
}

interface HostBrowser {
  readonly connection: HostConnection
  pages: readonly BrowserPage[]
  loaded: boolean
  error: string | null
  reveal: BrowserReveal | null
  /** Bumped on reset, so an answer from the old socket is not adopted. */
  epoch: number
  stop: () => void
}

interface FrameListener {
  readonly onFrame: BrowserFrameListener
  readonly onError: (error: Error) => void
  /** Null until the viewer has measured itself. */
  caps: BrowserFrameCaps | null
}

interface FrameWatch {
  readonly hostId: string
  readonly browserPageId: string
  readonly listeners: Map<symbol, FrameListener>
  sentCaps: BrowserFrameCaps | null
}

/** One viewer's watch of a page's frames. */
export interface BrowserFrameWatch {
  setCaps(caps: BrowserFrameCaps): void
  stop(): void
}

/**
 * The browser pages of each host, for the phone's browser viewer.
 *
 * Pages belong to the host, not to one session: the desktop pane shows every
 * page too. Frames arrive on the host socket's binary side-channel and are
 * subscribed only while a viewer shows the page, so a page no one watches sends
 * nothing (docs/browser-routing.md).
 */
export class NativeBrowser {
  readonly changes = new Listeners()
  private readonly hosts = new Map<string, HostBrowser>()
  private readonly frameWatches = new Map<string, FrameWatch>()
  private revealRequests = 0

  constructor(
    private readonly connectionFor: (hostId: string) => HostConnection | null,
    /** Sends a picked file's bytes to a signed upload URL; the Expo adapter is `platform/expo.ts`. */
    private readonly uploadFile: AttachmentIo['uploadFile'] | null = null,
  ) {}

  pagesOf = (hostId: string): readonly BrowserPage[] => this.hosts.get(hostId)?.pages ?? NO_PAGES
  loadedOf = (hostId: string): boolean => this.hosts.get(hostId)?.loaded ?? false
  errorOf = (hostId: string): string | null => this.hosts.get(hostId)?.error ?? null
  revealOf = (hostId: string): BrowserReveal | null => this.hosts.get(hostId)?.reveal ?? null

  private host(hostId: string): HostBrowser {
    const connection = this.connectionFor(hostId)
    if (!connection) throw new Error('This host is not connected.')
    const current = this.hosts.get(hostId)
    if (current?.connection === connection) return current
    this.forgetHost(hostId)
    const host: HostBrowser = { connection, pages: NO_PAGES, loaded: false, error: null, reveal: null, epoch: 0, stop: () => {} }
    const stops = [
      connection.events.subscribe('browser.pageChanged', ({ page }) => this.adopt(host, page)),
      connection.events.subscribe('browser.pageClosed', ({ browserPageId }) => {
        host.pages = host.pages.filter((page) => page.browserPageId !== browserPageId)
        this.changes.notify()
      }),
      connection.events.subscribe('browser.surfaceRequested', ({ browserPageId, sessionId }) => {
        host.reveal = { browserPageId, sessionId, requestId: ++this.revealRequests }
        this.changes.notify()
      }),
      connection.onReset(() => {
        host.epoch++
        host.loaded = false
        this.changes.notify()
      }),
      connection.onAccepted(() => {
        void this.load(hostId)
        this.restoreFrames(hostId)
      }),
    ]
    host.stop = () => { for (const stop of stops) stop() }
    this.hosts.set(hostId, host)
    return host
  }

  private adopt(host: HostBrowser, page: BrowserPage): void {
    const index = host.pages.findIndex((candidate) => candidate.browserPageId === page.browserPageId)
    host.pages = index < 0 ? [...host.pages, page] : host.pages.map((candidate, at) => at === index ? page : candidate)
    this.changes.notify()
  }

  /** Reads the host's pages. A host without a browser answers with an error, which only the viewer shows. */
  async load(hostId: string): Promise<void> {
    let host: HostBrowser
    try { host = this.host(hostId) } catch { return }
    const epoch = host.epoch
    try {
      const pages = await host.connection.api.browserListPages()
      if (this.hosts.get(hostId) !== host || host.epoch !== epoch) return
      host.pages = [...pages].sort((a, b) => a.createdAt - b.createdAt)
      host.loaded = true
      host.error = null
    } catch (error) {
      if (this.hosts.get(hostId) !== host) return
      host.loaded = true
      host.error = error instanceof Error ? error.message : String(error)
    }
    this.changes.notify()
  }

  private api(hostId: string) { return this.host(hostId).connection.api }

  async open(hostId: string, address: string): Promise<string> {
    const problem = addressProblem(address)
    if (problem) throw new Error(problem)
    const url = navigableAddress(address)
    if (!/^https?:\/\//i.test(url)) throw new Error("Enter an HTTP or HTTPS address.")
    const host = this.host(hostId)
    const page = await host.connection.api.browserOpen({ target: { kind: 'url', url }, requestSurface: true })
    if (this.hosts.get(hostId) === host) this.adopt(host, page)
    return page.browserPageId
  }

  navigate(hostId: string, browserPageId: string, op: BrowserNavigateOp): Promise<void> {
    return this.api(hostId).browserNavigate(browserPageId, op)
  }
  setViewport(hostId: string, browserPageId: string, request: BrowserViewportRequest): Promise<void> {
    return this.api(hostId).browserSetViewport(browserPageId, request)
  }
  setAppearance(hostId: string, browserPageId: string, appearance: BrowserAppearance): Promise<void> {
    return this.api(hostId).browserSetAppearance(browserPageId, appearance)
  }
  interact(hostId: string, browserPageId: string, op: BrowserInteractOp): Promise<BrowserInteractResult> {
    return this.api(hostId).browserInteract(browserPageId, op)
  }
  setZoom(hostId: string, browserPageId: string, zoomFactor: number): Promise<void> {
    return this.api(hostId).browserSetZoom(browserPageId, zoomFactor)
  }
  async answerDialog(hostId: string, browserPageId: string, answer: BrowserDialogAnswer): Promise<void> {
    await this.api(hostId).browserAnswerDialog(browserPageId, answer)
  }

  /**
   * Give the page's file chooser files from this phone, or cancel it with null.
   * Each file goes to the host first, to the page's own upload folder; the page
   * gets the host's copies.
   */
  async answerFileChooser(hostId: string, browserPageId: string, files: readonly PickedFile[] | null): Promise<void> {
    const api = this.api(hostId)
    if (!files) {
      await api.browserAnswerFileChooser(browserPageId, null)
      return
    }
    if (!this.uploadFile) throw new Error('This phone cannot send files.')
    const hostPaths: string[] = []
    for (const file of files) {
      if (file.size === null) throw new Error(`The size of ${file.name} is unknown.`)
      const token = await api.browserFileUploadToken(browserPageId, { name: file.name, mime: file.mimeType ?? 'application/octet-stream', size: file.size })
      const status = await this.uploadFile(new URL(token.relativeUrl, this.httpBaseOf(hostId)).toString(), file.uri)
      if (status < 200 || status >= 300) throw new Error(`The host refused ${file.name} (${status}).`)
      hostPaths.push(token.hostPath)
    }
    await api.browserAnswerFileChooser(browserPageId, hostPaths)
  }

  /** A link the host signs for one of a page's downloads. */
  async downloadUrl(hostId: string, download: BrowserDownload): Promise<string> {
    const signed = await this.api(hostId).assetCreateUrl(undefined, { assetId: download.assetId, name: download.fileName })
    return new URL(signed.relativeUrl, this.httpBaseOf(hostId)).toString()
  }

  private httpBaseOf(hostId: string): string {
    return this.host(hostId).connection.transport.serverUrl.replace(/^ws/, 'http')
  }

  /** Refuses while an agent uses the page, unless `force`; the refusal names the work. */
  close(hostId: string, browserPageId: string, force = false): Promise<BrowserCloseResult> {
    return this.api(hostId).browserClose(browserPageId, force)
  }

  /**
   * Watch one page's frames. The host streams at most the largest caps any
   * viewer of the page asked for. `stop` ends the watch; the last one
   * unsubscribes on the host.
   */
  watchFrames(
    hostId: string,
    browserPageId: string,
    onFrame: BrowserFrameListener,
    onError: (error: Error) => void,
  ): BrowserFrameWatch {
    const connection = this.host(hostId).connection
    const key = frameKey(hostId, browserPageId)
    const id = Symbol(key)
    let watch = this.frameWatches.get(key)
    const first = !watch
    if (!watch) {
      watch = { hostId, browserPageId, listeners: new Map(), sentCaps: null }
      this.frameWatches.set(key, watch)
    }
    const entry: FrameListener = { onFrame, onError, caps: null }
    watch.listeners.set(id, entry)
    const off = connection.transport.frames.subscribe(browserPageId, (header, data) => entry.onFrame(header, data))
    let subscribed = !first
    return {
      setCaps: (caps) => {
        const current = this.frameWatches.get(key)
        if (!current?.listeners.has(id)) return
        entry.caps = caps
        if (!subscribed) {
          subscribed = true
          this.subscribeFrames(hostId, browserPageId)
          return
        }
        // Only growth is sent: a shrinking viewer keeps its sharper stream rather than restarting it.
        const largest = largestCaps(current)
        const sent = current.sentCaps
        if (!largest || (sent && largest.maxWidth <= sent.maxWidth && largest.maxHeight <= sent.maxHeight)) return
        current.sentCaps = sent ? largestFrameCaps([sent, largest]) : largest
        if (current.sentCaps) void this.api(hostId).browserSetFrameCaps(browserPageId, current.sentCaps).catch(() => {})
      },
      stop: () => {
        off()
        const current = this.frameWatches.get(key)
        current?.listeners.delete(id)
        if (current?.listeners.size) return
        this.frameWatches.delete(key)
        void this.connectionFor(hostId)?.api.browserUnsubscribeFrames(browserPageId).catch(() => {})
      },
    }
  }

  private subscribeFrames(hostId: string, browserPageId: string): void {
    const watch = this.frameWatches.get(frameKey(hostId, browserPageId))
    if (!watch) return
    const caps = largestCaps(watch)
    watch.sentCaps = caps
    void this.api(hostId).browserSubscribeFrames(browserPageId, caps ?? undefined).catch((error: Error) => {
      const current = this.frameWatches.get(frameKey(hostId, browserPageId))
      for (const listener of current?.listeners.values() ?? []) listener.onError(error)
    })
  }

  /** A phone can sleep past the host's client expiry: the host forgot the watch, so it is made again. */
  private restoreFrames(hostId: string): void {
    for (const watch of this.frameWatches.values()) {
      if (watch.hostId !== hostId) continue
      void this.api(hostId).browserUnsubscribeFrames(watch.browserPageId)
        .catch(() => {})
        .then(() => this.subscribeFrames(hostId, watch.browserPageId))
    }
  }

  forgetHost(hostId: string): void {
    const host = this.hosts.get(hostId)
    if (!host) return
    host.stop()
    this.hosts.delete(hostId)
    this.changes.notify()
  }
}

const NO_PAGES: readonly BrowserPage[] = []

function frameKey(hostId: string, browserPageId: string): string {
  return `${hostId}\u0000${browserPageId}`
}

function largestCaps(watch: FrameWatch): BrowserFrameCaps | null {
  return largestFrameCaps([...watch.listeners.values()].flatMap((listener) => listener.caps ? [listener.caps] : []))
}
