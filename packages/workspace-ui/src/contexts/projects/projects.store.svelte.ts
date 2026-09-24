import { isRemoteDispatchCheckoutPath, type ProjectEntry, type RecentProject } from '@solus/contracts/types'
import { serverConnections } from '@solus/client-core/server-connections'
import type { HostApi } from '@solus/client-core/host-api'
import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { z } from 'zod'
import { LOCAL_SERVER_ID } from '@solus/client-core/server-registry'
import type { WorkspaceProject } from '@solus/contracts/workspace-projects'
import { localProjectKey } from '@solus/contracts/repository-key'
import {
  groupLogicalProjects,
  logicalProjectKeyFor,
  normalizeProjectRoot,
  projectRefKey,
  type LogicalProject,
  type ProjectCatalogEntry,
  type ProjectRef,
} from './project-catalog'
import { projectDirLabel } from '../../lib/paths'

const STORAGE_KEY = 'solus-project-catalog'

const catalogEntrySchema = z.object({
  serverId: z.string(),
  projectRoot: z.string(),
  label: z.string(),
  lastSeenAt: z.number(),
  repositoryKey: z.string().nullable().optional().catch(undefined),
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

/**
 * Whether a folder can be a project in the catalog. `'~'` names no folder yet,
 * and a dispatch checkout is a clone a host keeps for one paired device: a
 * checkout of the project it was sent from, never a project of its own. The
 * host keeps both out of its own lists; this keeps the device's list the same.
 */
function isCatalogRoot(projectRoot: string): boolean {
  return !!projectRoot && projectRoot !== '~' && !isRemoteDispatchCheckoutPath(projectRoot)
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

  /** Every project the pages list: checkouts grouped by repository, with the
   *  organization's cloud projects joined (docs/plans/project-model.md). */
  logicalProjects(cloudProjects: readonly WorkspaceProject[]): LogicalProject[] {
    return groupLogicalProjects(this.entries, cloudProjects)
  }

  /** The project a folder on a host belongs to: its checkout's repository
   *  once the host has named it, else the folder itself as a local-only
   *  project. A path alone never names a project across hosts. */
  projectKeyFor(serverId: string, path: string): string {
    const projectRoot = normalizeProjectRoot(path)
    const entry = this.entriesByKey.get(projectRefKey({ serverId, projectRoot }))
    return entry ? logicalProjectKeyFor(entry) : localProjectKey(serverId, projectRoot)
  }

  /** The repository a folder on a host holds, or null when its host has not
   *  named one (no hosted remote, or not listed yet). */
  repositoryKeyFor(serverId: string, path: string): string | null {
    const projectRoot = normalizeProjectRoot(path)
    return this.entriesByKey.get(projectRefKey({ serverId, projectRoot }))?.repositoryKey ?? null
  }

  /** The checkouts of one project across hosts, most recently touched first. */
  checkoutsOf(projectKey: string): ProjectCatalogEntry[] {
    return this.entries.filter((entry) => logicalProjectKeyFor(entry) === projectKey)
  }

  /** List each execution host's checkouts as it connects, so every page can
   *  group by repository. Returns the unsubscribe. */
  listen(isExecutionHost: (serverId: string) => boolean): () => void {
    const load = (serverId: string) => {
      if (!isExecutionHost(serverId)) return
      void this.loadProjectsFor(serverId, serverConnections.apiFor(serverId), { force: true })
    }
    for (const serverId of serverConnections.connectedServerIds()) load(serverId)
    return serverConnections.onStatusChange((serverId, status) => {
      if (status === 'connected') load(serverConnections.resolveId(serverId))
    })
  }

  /** Remember which repository a checkout holds, as its host reported it. */
  private stampRepositoryKey(serverId: string, path: string, repositoryKey: string | null): void {
    const key = projectRefKey({ serverId, projectRoot: normalizeProjectRoot(path) })
    const entry = this.entriesByKey.get(key)
    if (!entry || entry.repositoryKey === repositoryKey) return
    this.entriesByKey.set(key, { ...entry, repositoryKey })
    this.scheduleSave()
  }

  has(ref: ProjectRef): boolean {
    return this.entriesByKey.has(projectRefKey(ref))
  }

  /** Write a catalog entry with this label. Product code adds projects
   *  through `addProject`; a root that is not a project is ignored. */
  record(ref: ProjectRef, label: string): void {
    const projectRoot = normalizeProjectRoot(ref.projectRoot)
    if (!ref.serverId || !isCatalogRoot(projectRoot)) return
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
    if (!ref.serverId || !isCatalogRoot(projectRoot)) return
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

  /** Whether an explicit removal must also hide a picker's current-project fallback. */
  isRemoved(ref: ProjectRef): boolean {
    return this.ignoredDiscoveryKeys.has(projectRefKey({
      serverId: ref.serverId,
      projectRoot: normalizeProjectRoot(ref.projectRoot),
    }))
  }

  /** Explicit history removal — forgets the entry only. Never touches the
   *  project's files, sessions, or server-side records. */
  remove(ref: ProjectRef): void {
    const projectRoot = normalizeProjectRoot(ref.projectRoot)
    if (!ref.serverId || !projectRoot || projectRoot === '~') return
    const key = projectRefKey({ serverId: ref.serverId, projectRoot })
    this.entriesByKey.delete(key)
    this.ignoredDiscoveryKeys.add(key)
    this.scheduleSave()
  }

  /** Forget every checkout of one project from this device's history. Never
   *  touches files, sessions, or any host's or cloud's records. */
  removeProject(projectKey: string): void {
    for (const checkout of this.checkoutsOf(projectKey)) this.remove(checkout)
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
        // A host's projects are checkouts the pages group by repository; the
        // host names the repository, the catalog remembers it for when the
        // host is offline.
        for (const project of projects) {
          // Only an unknown checkout is recorded: a listing is not a visit, so
          // it must not reorder the projects the person actually touched.
          const ref = { serverId, projectRoot: project.path }
          if (!this.has({ serverId, projectRoot: normalizeProjectRoot(project.path) })) this.recordDiscovered(ref, project.folderName)
          this.stampRepositoryKey(serverId, project.path, project.repositoryKey)
        }
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
   * The one way a folder becomes a project: a person opened, cloned, or added
   * it. This device's catalog records it at once, so the next surface already
   * lists it; the host records it too, without holding the caller. Running a
   * session in a folder does not add it (`touch` only reorders known ones).
   */
  addProject(
    serverId: string,
    api: Pick<HostApi, 'trackRecentProject'>,
    path: string,
  ): ProjectRef | null {
    const projectRoot = normalizeProjectRoot(path)
    if (!serverId || !isCatalogRoot(projectRoot)) return null
    const project = { serverId, projectRoot }
    this.record(project, projectDirLabel(projectRoot, null))
    void api.trackRecentProject(project.projectRoot)
      .catch(() => {})
      .then(() => this.invalidateRecentProjects(serverId))
    return project
  }

  /** A session ran in this folder: move it up the list if it is a project. */
  touch(ref: ProjectRef): void {
    const projectRoot = normalizeProjectRoot(ref.projectRoot)
    const key = projectRefKey({ serverId: ref.serverId, projectRoot })
    const existing = this.entriesByKey.get(key)
    if (!existing) return
    this.recordKey(key, ref.serverId, projectRoot, existing.label)
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
