import { SvelteMap } from 'svelte/reactivity'
import type { AppSignalOccurrence } from '@solus/contracts/apps'
import { serverConnections } from '@solus/client-core/server-connections'
import { subscribeAllHosts } from '@solus/client-core/host-events'

/**
 * The live tail of one signal (docs/plans/apps.md §9.2, Signals): its newest
 * occurrences, kept fresh by `apps.signalOccurred` as the app emits them. A
 * new occurrence goes in at its place and an update of one changes it in
 * place: the list is never built again, and it holds at most `TAIL_LENGTH`.
 * While the tail is paused, what comes is held and shown when it goes on.
 */

/** The occurrences one tail shows. */
export const TAIL_LENGTH = 50

/** One signal's tail. `occurrences` is newest first. */
export interface SignalTail {
  readonly occurrences: AppSignalOccurrence[]
  isPaused: boolean
  /** Why the first read failed; null when it did not. */
  error: string | null
  isLoaded: boolean
}

interface TailEntry {
  tail: SignalTail
  /** What came while the tail was paused, in the order it came. */
  held: AppSignalOccurrence[]
  watchers: number
}

function tailKey(serverId: string, appId: string, signal: string): string {
  return `${serverId}\n${appId}\n${signal}`
}

/** Puts an occurrence in a newest-first list: in place when the list has it, else at its time. Keeps at most `limit`. */
export function placeOccurrence(list: AppSignalOccurrence[], occurrence: AppSignalOccurrence, limit = TAIL_LENGTH): void {
  const index = list.findIndex((existing) => existing.id === occurrence.id)
  if (index !== -1) {
    list[index] = occurrence
    return
  }
  const at = list.findIndex((existing) => existing.emittedAt < occurrence.emittedAt)
  if (at === -1) list.push(occurrence)
  else list.splice(at, 0, occurrence)
  if (list.length > limit) list.splice(limit)
}

export class AppSignalTails {
  private readonly entries = new SvelteMap<string, TailEntry>()
  private stopEvents: (() => void) | null = null

  /** The tail of one signal; undefined while no view watches it. */
  get(serverId: string, appId: string, signal: string): SignalTail | undefined {
    return this.entries.get(tailKey(serverId, appId, signal))?.tail
  }

  /**
   * Reads the newest occurrences of a signal and keeps them fresh while the
   * view holds the watch. Call from an effect and return the result.
   */
  watch(serverId: string, appId: string, signal: string): () => void {
    const key = tailKey(serverId, appId, signal)
    let entry = this.entries.get(key)
    if (!entry) {
      const tail = $state<SignalTail>({ occurrences: [], isPaused: false, error: null, isLoaded: false })
      entry = { tail, held: [], watchers: 0 }
      this.entries.set(key, entry)
      void this.load(serverId, appId, signal, entry)
    }
    entry.watchers += 1
    this.stopEvents ??= subscribeAllHosts('apps.signalOccurred', (eventServerId, event) => this.apply(eventServerId, event.appId, event.occurrence))
    let isReleased = false
    return () => {
      if (isReleased || !entry) return
      isReleased = true
      entry.watchers -= 1
      if (entry.watchers > 0) return
      this.entries.delete(key)
      if (this.entries.size === 0) {
        this.stopEvents?.()
        this.stopEvents = null
      }
    }
  }

  private async load(serverId: string, appId: string, signal: string, entry: TailEntry): Promise<void> {
    try {
      const read = await serverConnections.apiFor(serverId).appSignalOccurrences({ appId, signal, limit: TAIL_LENGTH })
      // An event that came during the read is newer than the read's copy of the same occurrence.
      for (const occurrence of read) {
        if (!entry.tail.occurrences.some((existing) => existing.id === occurrence.id)) placeOccurrence(entry.tail.occurrences, occurrence)
      }
      entry.tail.error = null
    } catch (error) {
      entry.tail.error = error instanceof Error && error.message ? error.message : 'The host did not answer.'
    } finally {
      entry.tail.isLoaded = true
    }
  }

  /** One occurrence from the host: the tail of its signal takes it, or holds it while paused. */
  apply(serverId: string, appId: string, occurrence: AppSignalOccurrence): void {
    const entry = this.entries.get(tailKey(serverId, appId, occurrence.name))
    if (!entry) return
    if (!entry.tail.isPaused) {
      placeOccurrence(entry.tail.occurrences, occurrence)
      return
    }
    const index = entry.held.findIndex((existing) => existing.id === occurrence.id)
    if (index === -1) entry.held.push(occurrence)
    else entry.held[index] = occurrence
    if (entry.held.length > TAIL_LENGTH) entry.held.splice(0, entry.held.length - TAIL_LENGTH)
  }

  /** Pauses the tail, or goes on with what came while it was paused. */
  setPaused(serverId: string, appId: string, signal: string, isPaused: boolean): void {
    const entry = this.entries.get(tailKey(serverId, appId, signal))
    if (!entry || entry.tail.isPaused === isPaused) return
    entry.tail.isPaused = isPaused
    if (isPaused) return
    for (const occurrence of entry.held) placeOccurrence(entry.tail.occurrences, occurrence)
    entry.held = []
  }
}
