import { SvelteMap } from 'svelte/reactivity'
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
})

function loadCatalog(): ProjectCatalogEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = catalogSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data.entries : []
  } catch {
    return []
  }
}

export class ProjectCatalogStore {
  private readonly entriesByKey = new SvelteMap<string, ProjectCatalogEntry>()
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(initial: ProjectCatalogEntry[] = loadCatalog()) {
    for (const entry of initial) this.entriesByKey.set(projectRefKey(entry), entry)
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
    const existing = this.entriesByKey.get(key)
    if (existing) {
      existing.lastSeenAt = Date.now()
      if (label) existing.label = label
    } else {
      this.entriesByKey.set(key, { serverId: ref.serverId, projectRoot, label: label || projectRoot, lastSeenAt: Date.now() })
    }
    this.scheduleSave()
  }

  /** Explicit history removal — forgets the entry only. Never touches the
   *  project's files, sessions, or server-side records. */
  remove(ref: ProjectRef): void {
    if (!this.entriesByKey.delete(projectRefKey(ref))) return
    this.scheduleSave()
  }

  /** Write now instead of waiting for the debounce — call on page hide, and
   *  from tests that assert on the persisted snapshot. */
  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, entries: this.entries }))
    } catch {}
  }

  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => this.flush(), 400)
  }
}

export const projectCatalog = new ProjectCatalogStore()
