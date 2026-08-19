import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import type { PaneEntry, PaneId } from '../../../contexts/workspace/routing/location'

/** A closing pane keeps its shell on screen briefly so the split collapses
 *  rather than snapping shut. */
export const COMPANION_EXIT_MS = 140
/** Heavy surfaces mount a frame after the shell so the pane opens as one
 *  movement instead of janking on the surface's first layout. */
export const COMPANION_CONTENT_DELAY_MS = 90

/**
 * Which companion panes are on screen, which of them are still animating out,
 * and what a closing pane should keep showing while it does.
 *
 * The router removes a pane the instant it closes; this holds the last entry a
 * beat longer so the exit has something to render. Keyed by pane id throughout,
 * so it costs nothing to have three companions instead of one.
 */
export class CompanionPanes {
  /** Rendered ids in order, including panes on their way out. */
  ids = $state<PaneId[]>([])
  /** Panes whose surface has passed the entry delay and may mount. */
  readonly settled = new SvelteSet<PaneId>()
  private readonly closing = new SvelteSet<PaneId>()
  private readonly retained = new SvelteMap<PaneId, PaneEntry>()
  private readonly timers = new Map<PaneId, ReturnType<typeof setTimeout>>()

  constructor(private readonly reduceMotion: () => boolean) {}

  isClosing(paneId: PaneId): boolean {
    return this.closing.has(paneId)
  }

  entry(paneId: PaneId): PaneEntry | undefined {
    return this.retained.get(paneId)
  }

  /** Reconcile against the router's companion panes. Call from one effect. */
  sync(live: readonly PaneEntry[]): void {
    const liveIds = new Set(live.map((pane) => pane.id))

    for (const pane of live) {
      this.retained.set(pane.id, pane)
      if (this.closing.delete(pane.id)) this.clearTimer(pane.id)
      if (!this.ids.includes(pane.id)) {
        this.ids.push(pane.id)
        this.schedule(pane.id, COMPANION_CONTENT_DELAY_MS, () => this.settled.add(pane.id))
      }
    }

    for (const id of this.ids) {
      if (liveIds.has(id) || this.closing.has(id)) continue
      this.closing.add(id)
      this.settled.delete(id)
      this.schedule(id, COMPANION_EXIT_MS, () => this.remove(id))
    }
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  private remove(paneId: PaneId): void {
    const index = this.ids.indexOf(paneId)
    if (index !== -1) this.ids.splice(index, 1)
    this.closing.delete(paneId)
    this.settled.delete(paneId)
    this.retained.delete(paneId)
  }

  private schedule(paneId: PaneId, delay: number, run: () => void): void {
    this.clearTimer(paneId)
    if (this.reduceMotion()) {
      run()
      return
    }
    this.timers.set(
      paneId,
      setTimeout(() => {
        this.timers.delete(paneId)
        run()
      }, delay),
    )
  }

  private clearTimer(paneId: PaneId): void {
    const timer = this.timers.get(paneId)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(paneId)
    }
  }
}
