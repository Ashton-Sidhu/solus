import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import type { Via } from '@solus/contracts/analytics-events'
import type { IpcContext } from '@solus/contracts/types'
import type { PrReviewTarget } from '@solus/contracts/providers'
import type { HostApi } from '@solus/client-core/host-api'
import { track } from '../../../lib/analytics'
import { parseLocation, parseSurfaces, serializeLocation, serializeSurfaces } from './codec'
import { BrowserRouteHistory, MemoryRouteHistory, type RouteHistory } from './route-history'
import {
  activateSurface,
  activeSurface,
  applyLocation,
  closeCompanion,
  closeSurface,
  closeSurfacesWhere,
  companionOf,
  destinationOf,
  focusedPane,
  initialLocation,
  openDestination,
  openSurface,
  paneById,
  showStrip,
  targetFor,
  type Location,
  type OpenTarget,
  type PaneEntry,
  type PaneId,
} from './location'
import {
  CHAT_ROUTE,
  ROUTES,
  serializeRef,
  surfaceKey,
  type RouteName,
  type RouteParams,
  type RouteRef,
} from './route-registry'

export interface NavigateOptions {
  /** Which pane a route that may sit in either one opens in. Destinations and
   *  surfaces ignore it: their placement decides. */
  target?: OpenTarget
  /** Add a surface to the strip without making it active. */
  background?: boolean
  /** Replace the active surface rather than add one. */
  inPlace?: boolean
  /** The user did not ask for this — an agent did, or the app did on its own.
   *  It never takes the place of a surface the user is reading: beside another
   *  surface it opens in the background, marked unread. */
  automatic?: boolean
  /** Overwrite the current history entry instead of pushing a new one. */
  replace?: boolean
  via?: Via
}

/** The strip a destination owns while another destination is on screen, or
 *  while the companion pane is hidden. */
export interface StoredStrip {
  surfaces: RouteRef[]
  activeSurfaceIndex: number
  isOpen: boolean
}

/** A stored strip as the tab snapshot saves it, with the destination that owns
 *  it (`session:<id>` or `draft:<id>`). */
export interface PersistedStrip {
  destinationKey: string
  surfaces: string
  activeSurfaceIndex: number
  isOpen: boolean
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
 *
 * Each destination owns its companion strip (docs/plans/companion-surfaces.md).
 * The location holds the strip on screen; `strips` holds the others, keyed by
 * destination, until that destination comes back.
 */
export class RouterStore {
  location = $state<Location>(initialLocation())

  /** Bumped on every navigation, including one that lands on a route already
   *  showing. Surfaces that must act on a *request* rather than on a changed
   *  param — the diff panel jumping to a file, which has to move again when the
   *  same file is asked for twice — watch this instead of a hand-rolled
   *  request-id counter. */
  navigationEpoch = $state(0)

  /**
   * What the leading pane rests on once whatever it held closes. Routing only
   * knows the conversation pool; the workspace knows whether that pool has a
   * tab to show, and answers the composer when it does not. Asked only when the
   * leading pane is the one closing, so answering may mint a draft.
   */
  leadingHome: () => RouteRef = () => CHAT_ROUTE

  /**
   * Whether a remembered route can still be shown — a draft that was sent or a
   * tab that was closed cannot. Routing does not know tabs or drafts, so the
   * workspace answers; a route it rejects falls back to home.
   */
  canReturnTo: (ref: RouteRef) => boolean = () => true

  /**
   * The strip key of the conversation the pool shows. The pool's route names
   * no session — which tab is active is the workspace's to know — so the
   * workspace answers, and calls `syncDestination` when the answer changes.
   */
  poolDestinationKey: () => string | null = () => null

  /**
   * Called after every change to what the panes show. Routing names
   * conversations by session; the workspace knows which tabs render them and
   * loads what they need to be shown.
   */
  onLocationChanged: () => void = () => {}

  /** The route a `returnsOnClose` page replaced. Held only while the leading
   *  pane still shows such a page. */
  private returnTo: RouteRef | null = null
  private strips = new SvelteMap<string, StoredStrip>()
  /** Surfaces opened in the background and not yet looked at, by surface key. */
  private unreadSurfaceKeys = new SvelteSet<string>()
  private shownDestinationKey: string
  private history: RouteHistory
  private detachHistory: (() => void) | null = null
  private resolved = new SvelteMap<string, PrReviewTarget>()
  private resolving = new Map<string, Promise<PrReviewTarget>>()

  constructor(history: RouteHistory = new MemoryRouteHistory('/chat', MAX_HISTORY_ENTRIES)) {
    this.history = history
    applyLocation(this.location, parseLocation(history.current()))
    this.shownDestinationKey = this.destinationKeyFor(this.destination)
    this.attachHistory(history)
  }

  // ─── Reading the location ───

  get panes(): PaneEntry[] {
    return this.location.panes
  }

  get leadingPane(): PaneEntry {
    return this.location.panes[0]
  }

  /** The route the leading pane holds. */
  get destination(): RouteRef {
    return destinationOf(this.location)
  }

  get companionPane(): PaneEntry | null {
    return companionOf(this.location)
  }

  /** The surface the companion pane shows, if it is open. */
  get companionSurface(): RouteRef | null {
    const companion = this.companionPane
    return companion ? activeSurface(companion) : null
  }

  get focused(): PaneEntry {
    return focusedPane(this.location)
  }

  get focusedPaneId(): PaneId {
    return this.location.focusedPaneId
  }

  /** Whether the companion pane is hidden with a strip it can show again. */
  get hasHiddenStrip(): boolean {
    return !this.companionPane && this.strips.has(this.shownDestinationKey)
  }

  pane(paneId: PaneId): PaneEntry | null {
    return paneById(this.location, paneId)
  }

  /** Whether this route is on screen: the destination or the active surface. */
  at(name: RouteName): boolean {
    return this.destination.name === name || this.companionSurface?.name === name
  }

  /** The live ref for a route on screen, so a surface can read its params. */
  ref<K extends RouteName>(name: K): RouteRef<K> | null {
    const surface = this.companionSurface
    if (surface?.name === name) {
      // SAFETY: the surface's name was just matched against this exact route name.
      return surface as RouteRef<K>
    }
    const destination = this.destination
    if (destination.name !== name) return null
    // SAFETY: the destination's name was just matched against this exact route name.
    return destination as RouteRef<K>
  }

  params<K extends RouteName>(name: K): RouteParams[K] | null {
    // SAFETY: ref(name) couples the requested name to its declared parameter type.
    return (this.ref(name)?.params ?? null) as RouteParams[K] | null
  }

  /**
   * The session a pane's chat shows, or null when it shows no chat. The leading
   * pane's chat names no session — it renders whichever conversation the pool
   * is on — so it answers null too, and the workspace fills that in from the
   * active tab. Which tab a session is rendered in is not the router's to know.
   */
  chatSessionIn(paneId: PaneId): string | null {
    const pane = this.pane(paneId)
    const ref = pane ? activeSurface(pane) : null
    return ref?.name === 'chat' ? ref.params.sessionId ?? null : null
  }

  /** Whether this pane is showing a chat at all, pinned or pooled. */
  showsChat(paneId: PaneId): boolean {
    const pane = this.pane(paneId)
    return !!pane && activeSurface(pane)?.name === 'chat'
  }

  // ─── Navigating ───

  navigate(ref: RouteRef, opts: NavigateOptions = {}): PaneEntry {
    let pane: PaneEntry
    if (targetFor(ref, opts.target) === 'leading') {
      const replaced = this.destination
      pane = openDestination(this.location, ref)
      // Remember only the step in from the main workspace. Moving between the
      // page's own tabs replaces it with itself and keeps the first answer.
      if (ROUTES[ref.name].returnsOnClose && !ROUTES[replaced.name].returnsOnClose) {
        this.returnTo = replaced
      }
      this.swapStrip()
    } else {
      this.revealHiddenStrip()
      const shown = this.companionSurface
      const background = opts.background
        || (opts.automatic === true && !!shown && surfaceKey(shown) !== surfaceKey(ref))
      pane = openSurface(this.location, ref, { background, inPlace: opts.inPlace })
      if (background) this.unreadSurfaceKeys.add(surfaceKey(ref))
      else this.unreadSurfaceKeys.delete(surfaceKey(ref))
    }
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

  /** Close what a pane shows: the leading pane falls back to home, and the
   *  companion pane closes its active surface. */
  closePane(paneId: PaneId): void {
    if (paneId === this.leadingPane.id) {
      this.closeDestination()
    } else {
      const companion = this.pane(paneId)
      if (companion) closeSurface(this.location, companion.activeSurfaceIndex)
    }
    this.commit(null, {})
  }

  closeSurface(index: number): void {
    closeSurface(this.location, index)
    this.commit(null, {})
  }

  /** Close every surface except the one at `index`. */
  closeOtherSurfaces(index: number): void {
    const keep = this.companionPane?.surfaces[index]
    if (!keep) return
    closeSurfacesWhere(this.location, (ref) => ref !== keep)
    this.commit(null, {})
  }

  closeSurfacesToRight(index: number): void {
    closeSurfacesWhere(this.location, (_ref, surfaceIndex) => surfaceIndex > index)
    this.commit(null, {})
  }

  /** Close the surfaces a predicate names, wherever they sit in the strip. */
  closeSurfacesWhere(shouldClose: (ref: RouteRef) => boolean): void {
    closeSurfacesWhere(this.location, shouldClose)
    this.commit(null, {})
  }

  /** Whether a surface opened in the background has not been looked at yet. */
  isSurfaceUnread(ref: RouteRef): boolean {
    return this.unreadSurfaceKeys.has(surfaceKey(ref))
  }

  activateSurface(index: number): void {
    const companion = this.companionPane
    if (!companion || companion.activeSurfaceIndex === index) return
    const ref = companion.surfaces[index]
    if (ref) this.unreadSurfaceKeys.delete(surfaceKey(ref))
    activateSurface(this.location, index)
    this.location.focusedPaneId = companion.id
    this.commit(null, {})
  }

  /** Move to the next or previous surface, wrapping at the ends. */
  activateAdjacentSurface(delta: 1 | -1): void {
    const companion = this.companionPane
    if (!companion || companion.surfaces.length < 2) return
    const count = companion.surfaces.length
    this.activateSurface((companion.activeSurfaceIndex + delta + count) % count)
  }

  /** Make a surface that may also lead — a draft, a conversation — the
   *  destination. */
  moveSurfaceToMain(index: number): void {
    const ref = this.companionPane?.surfaces[index]
    if (!ref || ROUTES[ref.name].placement !== 'either') return
    closeSurface(this.location, index)
    this.navigate(ref, { target: 'leading' })
  }

  /** Hide the companion pane and keep its strip, so it can come back. */
  hideCompanion(): void {
    const companion = this.companionPane
    if (!companion) return
    this.strips.set(this.shownDestinationKey, {
      surfaces: companion.surfaces.slice(),
      activeSurfaceIndex: companion.activeSurfaceIndex,
      isOpen: false,
    })
    closeCompanion(this.location)
    this.commit(null, {})
  }

  /** Show the strip `hideCompanion` kept. */
  showCompanion(): void {
    if (!this.revealHiddenStrip()) return
    const companion = this.companionPane
    if (companion) this.location.focusedPaneId = companion.id
    this.commit(null, {})
  }

  /** Close every route of this name: its surfaces, and the destination when it
   *  is the one showing. A `returnsOnClose` page goes back to the route it
   *  replaced when that route can still be shown. */
  close(name: RouteName): void {
    closeSurfacesWhere(this.location, (ref) => ref.name === name)
    if (this.destination.name === name) this.closeDestination()
    this.commit(null, {})
  }

  // ─── Strips ───

  /**
   * Show the strip of the destination now on screen. Navigation calls this
   * itself; the workspace calls it when the active tab changes, because the
   * pool's route stays the same while the conversation it shows does not.
   */
  syncDestination(): void {
    if (this.swapStrip()) this.commit(null, { replace: true })
  }

  /** Give a destination's strip to another key — a draft becoming a session
   *  keeps what the user opened beside it. */
  carryStrip(fromKey: string, toKey: string): void {
    if (this.shownDestinationKey === fromKey) {
      this.shownDestinationKey = toKey
      return
    }
    const stored = this.strips.get(fromKey)
    if (!stored) return
    this.strips.delete(fromKey)
    this.strips.set(toKey, stored)
    // The conversation may already be on screen — starting it is what put the
    // draft's strip away — so its strip shows now.
    if (this.shownDestinationKey === toKey && stored.isOpen && this.revealHiddenStrip()) {
      this.commit(null, { replace: true })
    }
  }

  /** Every route in a strip that is put away — hidden, or owned by a
   *  destination not on screen. */
  get storedSurfaces(): RouteRef[] {
    return [...this.strips.values()].flatMap((strip) => strip.surfaces)
  }

  /** Forget a destination's strip — its tab closed. */
  dropStrip(key: string): void {
    this.strips.delete(key)
  }

  /** The stored strips worth keeping across a restart: a conversation's or a
   *  draft's. A page's strip lives only for the run. */
  get persistedStrips(): PersistedStrip[] {
    const persisted: PersistedStrip[] = []
    for (const [key, strip] of this.strips) {
      if (!key.startsWith('session:') && !key.startsWith('draft:')) continue
      persisted.push({
        destinationKey: key,
        surfaces: serializeSurfaces(strip.surfaces),
        activeSurfaceIndex: strip.activeSurfaceIndex,
        isOpen: strip.isOpen,
      })
    }
    return persisted
  }

  restoreStrips(persisted: readonly PersistedStrip[] | undefined): void {
    if (!persisted) return
    for (const strip of persisted) {
      const surfaces = parseSurfaces(strip.surfaces)
      if (surfaces.length === 0) continue
      this.strips.set(strip.destinationKey, {
        surfaces,
        activeSurfaceIndex: Math.min(Math.max(0, strip.activeSurfaceIndex), surfaces.length - 1),
        isOpen: strip.isOpen,
      })
    }
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
   *  notification click. Never partially applied: an unparseable surface drops. */
  enter(serialized: string, opts: { replace?: boolean; via?: Via } = {}): void {
    this.applySerialized(serialized)
    const focused = activeSurface(this.focused)
    this.commit(focused, { replace: opts.replace, via: opts.via })
  }

  get serialized(): string {
    return serializeLocation(this.location)
  }

  // ─── Resolved payloads ───

  /** The live payload for a route, once its `resolve` has landed. */
  resolvedFor(ref: RouteRef | null | undefined): PrReviewTarget | null {
    if (!ref) return null
    return this.resolved.get(serializeRef(ref)) ?? null
  }

  /** Seed a payload the caller already has (or is filling in place). */
  setResolved(ref: RouteRef<'prReview'>, payload: PrReviewTarget): void {
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
  async resolve(
    ref: RouteRef,
    ctx: { api: HostApi; ipc: (cwd?: string) => IpcContext },
  ): Promise<PrReviewTarget | null> {
    if (ref.name !== 'prReview') return null
    const descriptor = ROUTES.prReview
    if (!descriptor.resolve) return null
    const key = serializeRef(ref)
    const cached = this.resolved.get(key)
    if (cached !== undefined) return cached
    const inflight = this.resolving.get(key)
    if (inflight) return inflight

    const promise = descriptor.resolve(ref.params, ctx)
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
    if (this.history instanceof BrowserRouteHistory) return
    const browserHistory = new BrowserRouteHistory(window)
    this.attachHistory(browserHistory)

    if (window.location.hash.startsWith('#/') || window.location.pathname !== '/') {
      this.applyHistoryLocation(browserHistory.current())
    }
    // At the root, keep the restored workspace. A direct path takes priority.
    // Always replace so a legacy hash link becomes a path without a new entry.
    browserHistory.replace(serializeLocation(this.location))
  }

  destroy(): void {
    this.detachHistory?.()
    this.detachHistory = null
  }

  // ─── Internals ───

  private closeDestination(): void {
    const remembered = this.returnTo && this.canReturnTo(this.returnTo) ? this.returnTo : null
    openDestination(this.location, remembered ?? this.leadingHome())
    this.swapStrip()
  }

  /** Which strip a destination owns: a conversation's, a draft's, or a page's.
   *  A pool with no conversation in it yet owns one strip of its own. */
  private destinationKeyFor(ref: RouteRef): string {
    if (ref.name === 'chat') {
      return ref.params.sessionId ? `session:${ref.params.sessionId}` : (this.poolDestinationKey() ?? 'pool')
    }
    if (ref.name === 'draft') return `draft:${ref.params.draftId}`
    if (ref.name === 'sessionRecord') return `record:${ref.params.sessionId}`
    return `page:${ref.name}`
  }

  /** Put away the strip on screen and show the current destination's. Answers
   *  whether the destination changed. */
  private swapStrip(): boolean {
    const key = this.destinationKeyFor(this.destination)
    if (key === this.shownDestinationKey) return false
    this.stashCompanion()
    this.shownDestinationKey = key
    const stored = this.strips.get(key)
    if (stored?.isOpen) {
      showStrip(this.location, stored.surfaces, stored.activeSurfaceIndex)
      this.strips.delete(key)
    } else {
      closeCompanion(this.location)
    }
    return true
  }

  /** Keep the strip on screen under its destination's key. A hidden strip is
   *  already stored. */
  private stashCompanion(): void {
    const companion = this.companionPane
    if (!companion) return
    this.strips.set(this.shownDestinationKey, {
      surfaces: companion.surfaces.slice(),
      activeSurfaceIndex: companion.activeSurfaceIndex,
      isOpen: true,
    })
  }

  /** Bring back a hidden strip without committing. */
  private revealHiddenStrip(): boolean {
    const key = this.shownDestinationKey
    const stored = this.strips.get(key)
    if (!stored || this.companionPane) return false
    showStrip(this.location, stored.surfaces, stored.activeSurfaceIndex)
    this.strips.delete(key)
    return true
  }

  /** Apply a whole location. Its companion strip is what this destination
   *  shows now, so a stored strip for it either goes (the location has one) or
   *  stays hidden (the location has none). */
  private applySerialized(serialized: string): void {
    this.stashCompanion()
    applyLocation(this.location, parseLocation(serialized))
    const key = this.destinationKeyFor(this.destination)
    this.shownDestinationKey = key
    const stored = this.strips.get(key)
    if (stored) {
      if (this.companionPane) this.strips.delete(key)
      else if (stored.isOpen) this.strips.set(key, { ...stored, isOpen: false })
    }
  }

  /** Drop the remembered route once the leading pane no longer shows the page
   *  that remembered it, so a later visit never returns to an older one. */
  private forgetStaleReturn(): void {
    if (this.returnTo && !ROUTES[this.destination.name].returnsOnClose) this.returnTo = null
  }

  private commit(ref: RouteRef | null, opts: Pick<NavigateOptions, 'replace' | 'via'>): void {
    this.forgetStaleReturn()
    const serialized = serializeLocation(this.location)
    if (opts.replace) this.history.replace(serialized)
    else this.history.push(serialized)
    if (ref) track('route_viewed', { route: ref.name, via: opts.via })
    this.onLocationChanged()
  }

  private attachHistory(history: RouteHistory): void {
    this.detachHistory?.()
    this.history = history
    this.detachHistory = history.subscribe((location) => this.applyHistoryLocation(location))
  }

  private applyHistoryLocation(serialized: string): void {
    if (serializeLocation(this.location) === serializeLocation(parseLocation(serialized))) return
    this.applySerialized(serialized)
    this.forgetStaleReturn()
    const ref = activeSurface(this.focused) ?? CHAT_ROUTE
    track('route_viewed', { route: ref.name })
    this.onLocationChanged()
  }
}
