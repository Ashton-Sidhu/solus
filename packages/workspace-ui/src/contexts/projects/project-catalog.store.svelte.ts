import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { z } from 'zod'
import type { ProjectCatalogEntry, ProjectRef } from './project-catalog'
import { normalizeProjectRoot, projectRefKey } from './project-catalog'

/**
 * The workspace-wide record of every project this client has opened, cloned,
 * adopted, or run a session in — keyed by `(serverId, projectRoot)` so the
 * same path on two hosts stays two entries. Purely client-side: it survives
 * host disconnects and app restarts on its own, independent of whichever
 * hosts happen to be reachable right now, which is what lets a disconnected
 * host's projects keep showing up (marked unavailable) rather than vanish.
 */

const STORAGE_KEY = 'solus-project-catalog'

const catalogEntrySchema = z.object({
  serverId: z.string(),
  projectRoot: z.string(),
  label: z.string(),
  lastSeenAt: z.number(),
})
const catalogSchema = z.object({
  version: z.literal(1),
  entries: z.array(catalogEntrySchema),
  ignoredDiscoveryKeys: z.array(z.string()).optional(),
})

interface StoredCatalog {
  entries: ProjectCatalogEntry[]
  ignoredDiscoveryKeys: string[]
}

function loadCatalog(): StoredCatalog {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { entries: [], ignoredDiscoveryKeys: [] }
    const parsed = catalogSchema.safeParse(JSON.parse(raw))
    return parsed.success
      ? {
          entries: parsed.data.entries,
          ignoredDiscoveryKeys: parsed.data.ignoredDiscoveryKeys ?? [],
        }
      : { entries: [], ignoredDiscoveryKeys: [] }
  } catch {
    return { entries: [], ignoredDiscoveryKeys: [] }
  }
}

export class ProjectCatalogStore {
  private readonly entriesByKey = new SvelteMap<string, ProjectCatalogEntry>()
  private readonly ignoredDiscoveryKeys = new SvelteSet<string>()
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(initial: StoredCatalog = loadCatalog()) {
    for (const entry of initial.entries) this.entriesByKey.set(projectRefKey(entry), entry)
    for (const key of initial.ignoredDiscoveryKeys) this.ignoredDiscoveryKeys.add(key)
  }

  get entries(): ProjectCatalogEntry[] {
    return [...this.entriesByKey.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  }

  has(ref: ProjectRef): boolean {
    return this.entriesByKey.has(projectRefKey(ref))
  }

  /** Record (or touch) a project the user opened, cloned, adopted, or ran a
   *  session in. `'~'` and empty roots are not projects and are ignored. */
  record(ref: ProjectRef, label: string): void {
    const projectRoot = normalizeProjectRoot(ref.projectRoot)
    if (!ref.serverId || !projectRoot || projectRoot === '~') return
    const key = projectRefKey({ serverId: ref.serverId, projectRoot })
    this.ignoredDiscoveryKeys.delete(key)
    this.recordKey(key, ref.serverId, projectRoot, label)
  }

  /** Import host history without undoing an explicit removal. A later real
   *  open or session calls `record` and makes the project visible again. */
  recordDiscovered(ref: ProjectRef, label: string): void {
    const projectRoot = normalizeProjectRoot(ref.projectRoot)
    if (!ref.serverId || !projectRoot || projectRoot === '~') return
    const key = projectRefKey({ serverId: ref.serverId, projectRoot })
    if (this.ignoredDiscoveryKeys.has(key)) return
    this.recordKey(key, ref.serverId, projectRoot, label)
  }

  private recordKey(key: string, serverId: string, projectRoot: string, label: string): void {
    const existing = this.entriesByKey.get(key)
    if (existing) {
      existing.lastSeenAt = Date.now()
      if (label) existing.label = label
    } else {
      this.entriesByKey.set(key, { serverId, projectRoot, label: label || projectRoot, lastSeenAt: Date.now() })
    }
    this.scheduleSave()
  }

  /** Explicit history removal — forgets the entry only. Never touches the
   *  project's files, sessions, or server-side records. */
  remove(ref: ProjectRef): void {
    const key = projectRefKey(ref)
    if (!this.entriesByKey.delete(key)) return
    this.ignoredDiscoveryKeys.add(key)
    this.scheduleSave()
  }

  /** Write now instead of waiting for the debounce — call on page hide, and
   *  from tests that assert on the persisted snapshot. */
  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: 1,
        entries: this.entries,
        ignoredDiscoveryKeys: [...this.ignoredDiscoveryKeys],
      }))
    } catch {}
  }

  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => this.flush(), 400)
  }
}

export const projectCatalog = new ProjectCatalogStore()
