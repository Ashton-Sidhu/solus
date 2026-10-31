import type * as Y from 'yjs'
import { z } from 'zod'
import type { LiveOfflineStore } from './work-live-doc.svelte'

/**
 * The device copy of the works open live (docs/plans/work-review-and-live-editing.md,
 * phase 3c): one IndexedDB database per host and work, which every client —
 * desktop, web, and the phone — has. Edits stay there until the host confirms
 * them, across restarts. A small list in local storage names the works that
 * still hold unsent edits, so signing out or removing a host can ask first.
 */

const UNSENT_KEY = 'solus.workLive.unsent'
const storedValue = z.union([z.string(), z.number()]).optional()

export function liveDatabaseName(hostKey: string, workId: string): string {
  return `solus-work-live:${hostKey}:${workId}`
}

// y-indexeddb brings Yjs. Sign-out and host removal read this module, so it
// loads y-indexeddb only when a device copy is opened or deleted.

/** The device copy, where IndexedDB exists; null elsewhere (a test, a locked-down browser). */
export async function indexedDbOffline(name: string): Promise<((doc: Y.Doc) => LiveOfflineStore) | null> {
  if (!('indexedDB' in globalThis)) return null
  const { IndexeddbPersistence } = await import('y-indexeddb')
  return (doc) => {
    const persistence = new IndexeddbPersistence(name, doc)
    return {
      whenLoaded: persistence.whenSynced.then(() => undefined),
      get: async (key) => storedValue.parse(await persistence.get(key)),
      set: async (key, value) => { await persistence.set(key, value) },
      destroy: () => persistence.destroy(),
    }
  }
}

/** A work whose device copy holds edits the host has not confirmed. */
export interface UnsentLiveWork {
  database: string
  serverId: string
  workId: string
  title: string
  unsent: number
}

const unsentListSchema = z.array(z.object({
  database: z.string(),
  serverId: z.string(),
  workId: z.string(),
  title: z.string(),
  unsent: z.number(),
}))

export function unsentLiveWorks(serverId?: string): UnsentLiveWork[] {
  if (!('localStorage' in globalThis)) return []
  try {
    const parsed = unsentListSchema.safeParse(JSON.parse(localStorage.getItem(UNSENT_KEY) ?? '[]'))
    const works = parsed.success ? parsed.data : []
    return serverId ? works.filter((work) => work.serverId === serverId) : works
  } catch {
    return []
  }
}

export function recordUnsentLiveWork(work: UnsentLiveWork): void {
  if (!('localStorage' in globalThis)) return
  const others = unsentLiveWorks().filter((entry) => entry.database !== work.database)
  const next = work.unsent > 0 ? [...others, work] : others
  localStorage.setItem(UNSENT_KEY, JSON.stringify(next))
}

/** Delete the device copies of one host's works (or every host's), unsent edits included. */
export async function clearLiveWorks(serverId?: string): Promise<void> {
  const cleared = unsentLiveWorks(serverId)
  if (cleared.length === 0) return
  const { clearDocument } = await import('y-indexeddb')
  await Promise.all(cleared.map((work) => clearDocument(work.database).catch(() => undefined)))
  if (!('localStorage' in globalThis)) return
  const kept = unsentLiveWorks().filter((work) => !cleared.some((gone) => gone.database === work.database))
  localStorage.setItem(UNSENT_KEY, JSON.stringify(kept))
}
