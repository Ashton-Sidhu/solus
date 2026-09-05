import type { ProjectEntry, RecentProject } from '@solus/contracts/types'
import { serverConnections } from '@solus/client-core/server-connections'
import type { HostApi } from '@solus/client-core/host-api'
import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { z } from 'zod'
import { LOCAL_SERVER_ID } from '@solus/client-core/server-registry'
import { normalizeProjectRoot, projectRefKey, type ProjectCatalogEntry, type ProjectRef } from './project-catalog'
import { projectDirLabel } from '../../lib/paths'

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

type FetchRecentProjects = (serverId: string) => Promise<RecentProject[]>

async function fetchHostRecentProjects(serverId: string): Promise<RecentProject[]> {
  if (!serverConnections.localServerId() && serverId === LOCAL_SERVER_ID) return []
  return serverConnections.withTemporaryConnection(serverId, (api) => api.listRecentProjects())
}

/** One owner for persisted project history, host metadata, and recent projects. */
export class ProjectsStore {
  private readonly entriesByKey = new SvelteMap<string, ProjectCatalogEntry>()
  private readonly ignoredDiscoveryKeys = new SvelteSet<string>()
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    initial: StoredCatalog = loadCatalog(),
    private readonly fetchRecentProjects: FetchRecentProjects = fetchHostRecentProjects,
  ) {
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
    this.recentLoads.delete(ref.serverId)
    this.recentLoading.set(ref.serverId, false)
    this.recentExpiresAt.delete(ref.serverId)
    const projects = this.recentProjectsFor(ref.serverId)
    this.recentByHost.set(ref.serverId, [
      { path: projectRoot, folderName: label || projectRoot, lastOpened: new Date().toISOString() },
      ...projects.filter((project) => project.path !== projectRoot),
    ])
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
      this.entriesByKey.set(key, { ...existing, lastSeenAt: Date.now(), label: label || existing.label })
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

  private readonly recentByHost = new SvelteMap<string, RecentProject[]>()
  private readonly recentExpiresAt = new Map<string, number>()
  private readonly recentLoads = new Map<string, Promise<RecentProject[]>>()
  private readonly recentLoading = new SvelteMap<string, boolean>()

  private readonly projectsByHost = new SvelteMap<string, ProjectEntry[]>()
  private readonly projectsLoadedByHost = new SvelteMap<string, boolean>()
  private readonly projectsLoadingByHost = new SvelteMap<string, boolean>()
  private readonly projectLoadsByHost = new Map<string, Promise<ProjectEntry[]>>()

  projectsFor(serverId: string): ProjectEntry[] {
    return this.projectsByHost.get(serverId) ?? []
  }

  projectsLoadedFor(serverId: string): boolean {
    return this.projectsLoadedByHost.get(serverId) === true
  }

  projectsLoadingFor(serverId: string): boolean {
    return this.projectsLoadingByHost.get(serverId) === true
  }

  async loadProjectsFor(
    serverId: string,
    api: Pick<HostApi, 'listProjects'>,
    opts: { force?: boolean } = {},
  ): Promise<ProjectEntry[]> {
    if (this.projectsLoadedFor(serverId) && !opts.force) return this.projectsFor(serverId)
    const pending = this.projectLoadsByHost.get(serverId)
    if (pending && !opts.force) return pending

    this.projectsLoadingByHost.set(serverId, true)
    const promise = api.listProjects()
      .then((projects) => {
        this.projectsByHost.set(serverId, projects)
        this.projectsLoadedByHost.set(serverId, true)
        return projects
      })
      .catch(() => {
        this.projectsByHost.set(serverId, [])
        this.projectsLoadedByHost.set(serverId, true)
        const empty: ProjectEntry[] = []
        return empty
      })
      .finally(() => {
        this.projectsLoadingByHost.set(serverId, false)
        if (this.projectLoadsByHost.get(serverId) === promise) this.projectLoadsByHost.delete(serverId)
      })
    this.projectLoadsByHost.set(serverId, promise)
    return promise
  }

  async deleteProjectFor(
    serverId: string,
    api: Pick<HostApi, 'deleteProject'>,
    path: string,
  ): Promise<void> {
    await api.deleteProject(path)
    this.projectsByHost.set(
      serverId,
      this.projectsFor(serverId).filter((project) => project.path !== path),
    )
    this.projectsLoadedByHost.set(serverId, true)
  }

  recentProjectsFor(serverId: string): RecentProject[] {
    return this.recentByHost.get(serverId) ?? []
  }

  recentProjectsLoadingFor(serverId: string): boolean {
    return this.recentLoading.get(serverId) === true
  }

  async loadRecentProjects(serverId: string, opts: { force?: boolean } = {}): Promise<RecentProject[]> {
    if (!opts.force && (this.recentExpiresAt.get(serverId) ?? 0) > Date.now()) {
      return this.recentProjectsFor(serverId)
    }
    const pending = this.recentLoads.get(serverId)
    if (pending && !opts.force) return pending

    this.recentLoading.set(serverId, true)
    const promise = Promise.resolve()
      .then(() => this.fetchRecentProjects(serverId))
      .then((projects) => {
        // An invalidated or superseded request cannot replace newer state.
        if (this.recentLoads.get(serverId) !== promise) return this.recentProjectsFor(serverId)
        this.recentByHost.set(serverId, projects)
        this.recentExpiresAt.set(serverId, Date.now() + 30_000)
        for (const project of projects) {
          this.recordDiscovered({ serverId, projectRoot: project.path }, project.folderName)
        }
        return projects
      })
      .catch(() => this.recentProjectsFor(serverId))
      .finally(() => {
        if (this.recentLoads.get(serverId) !== promise) return
        this.recentLoads.delete(serverId)
        this.recentLoading.set(serverId, false)
      })
    this.recentLoads.set(serverId, promise)
    return promise
  }

  /**
   * Add a project a person chose from the directory picker, without starting a
   * session in it. The host's recents record it and the client catalog records
   * it, so every page-level project switcher can scope to the project before an
   * agent has ever run there.
   */
  async addProject(
    serverId: string,
    api: Pick<HostApi, 'trackRecentProject'>,
    path: string,
  ): Promise<ProjectRef | null> {
    const project = this.recordProject(serverId, path)
    if (!project) return null
    const { projectRoot } = project
    await api.trackRecentProject(projectRoot).catch(() => {})
    this.invalidateRecentProjects(serverId)
    return project
  }

  /** Record a project immediately on the client. Opening a folder already
   * tracks it on the host through the session path; this synchronous half keeps
   * every page picker correct before a session starts. */
  recordProject(serverId: string, path: string): ProjectRef | null {
    const projectRoot = normalizeProjectRoot(path)
    if (!serverId || !projectRoot || projectRoot === '~') return null
    const project = { serverId, projectRoot }
    this.record(project, projectDirLabel(projectRoot, null))
    return project
  }

  invalidateRecentProjects(serverId?: string): void {
    const hosts = serverId ? [serverId] : new Set([...this.recentByHost.keys(), ...this.recentLoads.keys()])
    for (const host of hosts) {
      this.recentExpiresAt.delete(host)
      this.recentLoads.delete(host)
      this.recentLoading.set(host, false)
      void this.loadRecentProjects(host, { force: true })
    }
  }
}

export const projectsStore = new ProjectsStore()
