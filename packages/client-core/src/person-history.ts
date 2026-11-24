import type { SolusAPI } from '@solus/contracts/host-api'
import {
  PERSON_HISTORY_BATCH_LIMIT,
  personHistoryKindOf,
  type PersonHistoryEntry,
} from '@solus/contracts/person-history'
import { isSolusApiId } from '@solus/contracts/uplink'
import type { HostEventSubscriber } from './host-event-subscriber'

/**
 * The person's history on this client (docs/plans/person-state.md §4): when
 * they last opened each record, as their home holds it. An open shows at once
 * and goes to the home in one batch a moment later; an open the home did not
 * take stays pending and goes with the next batch. The home keeps the later
 * time of each record, so a retry or a late batch is harmless. Desktop, web,
 * and the phone use this one class.
 */

/**
 * The key of a work in the history. A work id is the same on every client.
 * Matches `recentArtifactKey`, so an open from any surface moves the same entry.
 */
export function workHistoryKey(workId: string): string {
  return `work:${workId}`
}

/**
 * The key of an app in the history. A machine is named by its installation id,
 * which every client of it knows, never by this client's connection id for it
 * (the desktop's own is `local`). Matches `recentArtifactKey` of an app link.
 */
export function appHistoryKey(installationId: string, appId: string): string {
  return `app:${installationId}:${appId}`
}

/** Where the history lives now, and how to reach it. */
export interface PersonHistoryHome {
  /** The connection id of the home. The same id is the same history. */
  serverId: string
  api: Pick<SolusAPI, 'personHistoryRecord' | 'personHistoryList'>
  events: Pick<HostEventSubscriber, 'subscribe'>
}

/** What a home choice reads (docs/plans/person-state.md §3). */
export interface PersonHistoryHomeChoice {
  signedIn: boolean
  /** The Solus API connection of the window's organization; null with none. */
  solusApiId: string | null
  /** The host this client runs beside: the desktop's own, or the one that served the page. */
  deviceHostId: string | null
  /** The window's default host: on a phone, the host it pairs with. */
  defaultServerId: string | null
}

/**
 * The person's home: signed in, the Solus API in their own scope; signed out,
 * the device host, else the default host. Null when the client reaches none.
 */
export function personHistoryHomeId(choice: PersonHistoryHomeChoice): string | null {
  if (choice.signedIn && choice.solusApiId) return choice.solusApiId
  if (choice.deviceHostId) return choice.deviceHostId
  return choice.defaultServerId && !isSolusApiId(choice.defaultServerId) ? choice.defaultServerId : null
}

/** Keys whose time moved, or `reset` when the client now reads another home. */
export type PersonHistoryChange = readonly string[] | 'reset'

export interface PersonHistoryPorts {
  onChange(change: PersonHistoryChange): void
  /** How long an open waits for others to join its batch. */
  batchDelayMs?: number
  now?(): number
}

export class PersonHistory {
  private times = new Map<string, number>()
  private pending = new Map<string, number>()
  private home: PersonHistoryHome | null = null
  private stopListening: (() => void) | null = null
  /** Bumped by each home switch and each read, so an older answer never lands. */
  private readGeneration = 0
  private batchTimer: ReturnType<typeof setTimeout> | null = null
  private sending: Promise<void> | null = null

  constructor(private readonly ports: PersonHistoryPorts) {}

  /** The connection id of the home the history is read from; null with none. */
  get homeServerId(): string | null {
    return this.home?.serverId ?? null
  }

  /** When the person last opened a record, or null. */
  openedAt(key: string): number | null {
    return this.times.get(key) ?? null
  }

  /** Every entry, newest open first. */
  entries(): PersonHistoryEntry[] {
    return [...this.times].map(([key, openedAt]) => ({ key, openedAt })).sort((a, b) => b.openedAt - a.openedAt || a.key.localeCompare(b.key))
  }

  /** The person opened a record now. A key that names no history kind is not kept. */
  record(key: string, at = this.now()): void {
    if (!personHistoryKindOf(key)) return
    this.merge([{ key, openedAt: at }])
    if (at > (this.pending.get(key) ?? -1)) this.pending.set(key, at)
    this.scheduleBatch()
  }

  /**
   * Read the history from `home`. A different home is a different history: what
   * the client held goes, and the pending opens go to the new home. `carryFrom`
   * is the history the person kept before this home (the device host, at
   * sign-in): its entries are recorded into the new home, which keeps the later
   * time of each, so carrying again is harmless.
   */
  async useHome(home: PersonHistoryHome | null, carryFrom?: Pick<SolusAPI, 'personHistoryList'> | null): Promise<void> {
    if (home?.serverId === this.home?.serverId) return
    this.stopListening?.()
    this.stopListening = null
    this.home = home
    this.readGeneration += 1
    this.times.clear()
    this.ports.onChange('reset')
    if (!home) return
    this.stopListening = home.events.subscribe('personHistory.changed', ({ entries }) => {
      if (this.home === home) this.merge(entries)
    })
    if (carryFrom) {
      const carried = await carryFrom.personHistoryList().catch(() => [])
      if (this.home !== home) return
      for (const entry of carried) {
        if (entry.openedAt > (this.pending.get(entry.key) ?? -1)) this.pending.set(entry.key, entry.openedAt)
      }
      this.merge(carried)
    }
    await this.reload()
  }

  /** Read the home again: after a reconnect, when events may have been missed. */
  async reload(): Promise<void> {
    const home = this.home
    if (!home) return
    const generation = ++this.readGeneration
    const answer = await home.api.personHistoryList().catch(() => null)
    if (!answer || generation !== this.readGeneration || this.home !== home) return
    this.merge(answer)
    // The home answers again: opens it did not take before go now.
    this.scheduleBatch()
  }

  /** Send the pending opens now. */
  async flush(): Promise<void> {
    if (this.batchTimer) clearTimeout(this.batchTimer)
    this.batchTimer = null
    while (this.sending) await this.sending
    const home = this.home
    if (!home || this.pending.size === 0) return
    const batch = [...this.pending].map(([key, openedAt]) => ({ key, openedAt }))
    this.pending.clear()
    this.sending = (async () => {
      for (let start = 0; start < batch.length; start += PERSON_HISTORY_BATCH_LIMIT) {
        const part = batch.slice(start, start + PERSON_HISTORY_BATCH_LIMIT)
        try {
          await home.api.personHistoryRecord(part)
        } catch {
          // The home did not take them: they go with the next batch.
          for (const entry of batch.slice(start)) {
            if (entry.openedAt > (this.pending.get(entry.key) ?? -1)) this.pending.set(entry.key, entry.openedAt)
          }
          return
        }
      }
    })()
    await this.sending
    this.sending = null
  }

  private scheduleBatch(): void {
    if (this.batchTimer || !this.home || this.pending.size === 0) return
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null
      void this.flush()
    }, this.ports.batchDelayMs ?? 1_500)
  }

  /** Keep the later time of each entry; tell which keys moved. */
  private merge(entries: readonly PersonHistoryEntry[]): void {
    const moved: string[] = []
    for (const { key, openedAt } of entries) {
      if (openedAt <= (this.times.get(key) ?? -1)) continue
      this.times.set(key, openedAt)
      moved.push(key)
    }
    if (moved.length) this.ports.onChange(moved)
  }

  private now(): number {
    return this.ports.now?.() ?? Date.now()
  }
}
