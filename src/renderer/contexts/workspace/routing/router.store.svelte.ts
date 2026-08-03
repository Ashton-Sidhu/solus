import { SvelteMap } from 'svelte/reactivity'
import type { Via } from '../../../../shared/analytics-events'
import type { IpcContext } from '../../../../shared/types'
import { track } from '../../../lib/analytics'
import { parseLocation, serializeLocation } from './codec'
import { BrowserRouteHistory, MemoryRouteHistory, type RouteHistory } from './route-history'
import {
  applyLocation,
  closeOverlay as closePaneOverlay,
  closePane as closeLocationPane,
  focusedPane,
  initialLocation,
  isRouteOpen,
  movePane as moveLocationPane,
  paneById,
  place,
  refFor,
  visibleRef,
  type Location,
  type NavTarget,
  type PaneEntry,
  type PaneId,
} from './location'
import {
  CHAT_ROUTE,
  ROUTES,
  chatTabOf,
  serializeRef,
  type RouteName,
  type RouteParams,
  type RouteRef,
} from './route-registry'

export interface NavigateOptions {
  target?: NavTarget
  /** Overwrite the current history entry instead of pushing a new one. */
  replace?: boolean
  via?: Via
}

/**
 * Budgeted per `docs/plans/resource-utilization-budget.md`: params only, never
 * resolved payloads, so an entry is a short string regardless of what it opened.
 */
const MAX_HISTORY_ENTRIES = 50
/** Resolved payloads are whole PR contexts — capped tight and evicted LRU. */
const MAX_RESOLVED_PAYLOADS = 16

/**
 * The one piece of location state in the renderer.
 *
 * Navigation is imperative only. Nothing here is driven from an `$effect` and
 * the URL is written inside `navigate`, never derived — that one-directional
 * rule is what makes the `effect_update_depth_exceeded` loop the old
 * router↔pane sync effects produced structurally impossible.
 */
export class RouterStore {
  location = $state<Location>(initialLocation())

  /** Bumped on every navigation, including one that lands on a route already
   *  showing. Surfaces that must act on a *request* rather than on a changed
   *  param — the diff panel jumping to a file, which has to move again when the
   *  same file is asked for twice — watch this instead of a hand-rolled
   *  request-id counter. */
  navigationEpoch = $state(0)

  private history: RouteHistory
  private detachHistory: (() => void) | null = null
  private resolved = new SvelteMap<string, unknown>()
  private resolving = new Map<string, Promise<unknown>>()

  constructor(history: RouteHistory = new MemoryRouteHistory('/chat', MAX_HISTORY_ENTRIES)) {
    this.history = history
    applyLocation(this.location, parseLocation(history.current()))
    this.attachHistory(history)
  }

  // ─── Reading the location ───

  get panes(): PaneEntry[] {
    return this.location.panes
  }

  get leadingPane(): PaneEntry {
    return this.location.panes[0]
  }

  get focused(): PaneEntry {
    return focusedPane(this.location)
  }

  get focusedPaneId(): PaneId {
    return this.location.focusedPaneId
  }

  /** Panes after the leading one — the companions the split layout renders. */
  get asidePanes(): PaneEntry[] {
    return this.location.panes.slice(1)
  }

  pane(paneId: PaneId): PaneEntry | null {
    return paneById(this.location, paneId)
  }

  /** Whether this destination is showing anywhere — replaces the `*Open` flags. */
  at(name: RouteName): boolean {
    return isRouteOpen(this.location, name)
  }

  /** The live ref for a destination, so a surface can read its params. */
  ref<K extends RouteName>(name: K): RouteRef<K> | null {
    return refFor(this.location, name) as RouteRef<K> | null
  }

  params<K extends RouteName>(name: K): RouteParams[K] | null {
    return (this.ref(name)?.params ?? null) as RouteParams[K] | null
  }

  /** The chat a pane shows, or null when it isn't showing one. */
  chatTabIn(paneId: PaneId, activeTabId: string): string | null {
    const pane = this.pane(paneId)
    if (!pane || pane.overlay) return null
    // Only the leading pane falls back to the active tab: it is the one the
    // conversation pool renders into.
    if (pane.base?.name !== 'chat') return null
    if (pane.id !== this.leadingPane.id) return pane.base.params.tabId ?? null
    return chatTabOf(pane.base, activeTabId)
  }

  get focusedChatTabId(): string | null {
    return this.chatTabIn(this.focusedPaneId, '')
  }

  // ─── Navigating ───

  navigate(ref: RouteRef, opts: NavigateOptions = {}): PaneEntry {
    const pane = place(this.location, ref, opts.target ?? 'focused')
    this.navigationEpoch += 1
    this.commit(ref, opts)
    return pane
  }

  /** Navigate and take focus even when the route was already open — the palette
   *  and deep links want the pane surfaced, not just present. */
  focusPane(paneId: PaneId): void {
    if (this.location.focusedPaneId === paneId || !this.pane(paneId)) return
    this.location.focusedPaneId = paneId
    this.commit(null, {})
  }

  closePane(paneId: PaneId): void {
    closeLocationPane(this.location, paneId)
    this.commit(null, {})
  }

  closeOverlay(paneId: PaneId = this.overlayPaneId ?? this.focusedPaneId): void {
    closePaneOverlay(this.location, paneId)
    this.commit(null, {})
  }

  /** Where the single overlay currently lives, if any. */
  get overlayPaneId(): PaneId | null {
    return this.location.panes.find((pane) => pane.overlay)?.id ?? null
  }

  get overlay(): RouteRef | null {
    return this.location.panes.find((pane) => pane.overlay)?.overlay ?? null
  }

  movePane(paneId: PaneId, delta: number): void {
    moveLocationPane(this.location, paneId, delta)
    this.commit(null, {})
  }

  /** Close every pane showing this destination, wherever it lives. */
  close(name: RouteName): void {
    for (const pane of [...this.location.panes]) {
      if (pane.overlay?.name === name) closePaneOverlay(this.location, pane.id)
      else if (pane.base?.name === name) closeLocationPane(this.location, pane.id)
    }
    this.commit(null, {})
  }

  /** Close whatever route of this group is open — pages and artifacts are each
   *  single-instance, so this needs no id. */
  closeGroup(group: 'page' | 'artifact'): void {
    for (const pane of [...this.location.panes]) {
      if (pane.base && ROUTES[pane.base.name].exclusiveGroup === group) {
        closeLocationPane(this.location, pane.id)
      }
    }
    this.commit(null, {})
  }

  // ─── History ───

  get canGoBack(): boolean {
    return this.history.canGoBack
  }

  get canGoForward(): boolean {
    return this.history.canGoForward
  }

  back(): boolean {
    return this.history.back()
  }

  forward(): boolean {
    return this.history.forward()
  }

  /** Enter a serialized location wholesale — reload restore, a deep link, a
   *  notification click. Never partially applied: an unparseable pane drops. */
  enter(serialized: string, opts: { replace?: boolean; via?: Via } = {}): void {
    applyLocation(this.location, parseLocation(serialized))
    this.commit(visibleRef(this.focused), { replace: opts.replace, via: opts.via })
  }

  get serialized(): string {
    return serializeLocation(this.location)
  }

  // ─── Resolved payloads ───

  /** The live payload for a route, once its `resolve` has landed. */
  resolvedFor<T>(ref: RouteRef | null | undefined): T | null {
    if (!ref) return null
    return (this.resolved.get(serializeRef(ref)) as T | undefined) ?? null
  }

  /** Seed a payload the caller already has (or is filling in place). */
  setResolved(ref: RouteRef, payload: unknown): void {
    const key = serializeRef(ref)
    // Re-set to refresh recency; Map preserves insertion order, so deleting
    // first is what makes eviction below LRU rather than FIFO.
    this.resolved.delete(key)
    this.resolved.set(key, payload)
    while (this.resolved.size > MAX_RESOLVED_PAYLOADS) {
      const oldest = this.resolved.keys().next().value
      if (oldest === undefined) break
      this.resolved.delete(oldest)
    }
  }

  dropResolved(ref: RouteRef): void {
    this.resolved.delete(serializeRef(ref))
    this.resolving.delete(serializeRef(ref))
  }

  /**
   * Run a route's `resolve` once per params and cache it. Re-entering a
   * destination reuses the payload instead of refetching, which is where the
   * repeated `prOpenReview` on every PR reopen goes.
   */
  async resolve<T>(
    ref: RouteRef,
    ctx: { api: typeof window.solus; ipc: (cwd?: string) => IpcContext },
  ): Promise<T | null> {
    const descriptor = ROUTES[ref.name]
    if (!descriptor.resolve) return null
    const key = serializeRef(ref)
    const cached = this.resolved.get(key)
    if (cached !== undefined) return cached as T
    const inflight = this.resolving.get(key)
    if (inflight) return inflight as Promise<T>

    const promise = (descriptor.resolve as (p: unknown, c: typeof ctx) => Promise<T>)(ref.params, ctx)
      .then((payload) => {
        this.setResolved(ref, payload)
        return payload
      })
      .finally(() => {
        this.resolving.delete(key)
      })
    this.resolving.set(key, promise)
    return promise
  }

  // ─── URL binding ───

  /**
   * Mirror the location into an address bar. Web only: the Electron window has
   * no URL, so it runs on the in-memory history above and nothing else changes.
   */
  bindAddressBar(): void {
    if (typeof window === 'undefined' || this.history instanceof BrowserRouteHistory) return
    const browserHistory = new BrowserRouteHistory(window)
    this.attachHistory(browserHistory)

    if (window.location.hash && browserHistory.current() !== '/') {
      this.applyHistoryLocation(browserHistory.current())
      const canonical = serializeLocation(this.location)
      if (canonical !== browserHistory.current()) browserHistory.replace(canonical)
    } else {
      browserHistory.replace(serializeLocation(this.location))
    }
  }

  destroy(): void {
    this.detachHistory?.()
    this.detachHistory = null
  }

  // ─── Internals ───

  private commit(ref: RouteRef | null, opts: NavigateOptions): void {
    const serialized = serializeLocation(this.location)
    if (opts.replace) this.history.replace(serialized)
    else this.history.push(serialized)
    if (ref) track('route_viewed', { route: ref.name, via: opts.via })
  }

  private attachHistory(history: RouteHistory): void {
    this.detachHistory?.()
    this.history = history
    this.detachHistory = history.subscribe((location) => this.applyHistoryLocation(location))
  }

  private applyHistoryLocation(serialized: string): void {
    const next = parseLocation(serialized)
    if (serializeLocation(this.location) === serializeLocation(next)) return
    applyLocation(this.location, next)
    const ref = visibleRef(this.focused) ?? CHAT_ROUTE
    track('route_viewed', { route: ref.name })
  }
}
