import { isRemoteDispatchCheckoutPath, type ProjectEntry, type RecentProject } from '@solus/contracts/types'
import { serverConnections } from '@solus/client-core/server-connections'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import type { HostApi } from '@solus/client-core/host-api'
import { SvelteMap } from 'svelte/reactivity'
import { z } from 'zod'
import { LOCAL_SERVER_ID } from '@solus/client-core/server-registry'
import type { WorkspaceProject } from '@solus/contracts/workspace-projects'
import { localProjectParts, projectKeyOf } from '@solus/client-core/project-identity'
import {
  groupLogicalProjects,
  logicalProjectKeyFor,
  normalizeProjectRoot,
  type LogicalProject,
  type ProjectCatalogEntry,
  type ProjectRef,
} from './project-catalog'
import { projectDirLabel } from '../../lib/paths'

/** The last project list read from each host (docs/plans/project-model.md §2).
 *  A cache for hosts that are away, never a record of its own. */
const STORAGE_KEY = 'solus-host-projects'

const projectEntrySchema = z.object({
  key: z.string(),
  path: z.string(),
  folderName: z.string(),
  addedAt: z.string(),
  lastUsedAt: z.string(),
  repositoryKey: z.string().nullable(),
})
const storedListsSchema = z.object({
  version: z.literal(1),
  hosts: z.array(z.object({ serverId: z.string(), projects: z.array(projectEntrySchema) })),
})

export interface StoredHostList {
  serverId: string
  projects: ProjectEntry[]
}

function loadStoredLists(): StoredHostList[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = storedListsSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data.hosts : []
  } catch {
    return []
  }
}

/** A checkout as every project list reads it, from its host's entry. */
function checkoutOf(serverId: string, project: ProjectEntry): ProjectCatalogEntry {
  return {
    serverId,
    projectRoot: project.path,
    label: project.folderName,
    lastSeenAt: Date.parse(project.lastUsedAt) || Date.parse(project.addedAt) || 0,
    repositoryKey: project.repositoryKey,
  }
}

/** Whether `path` is `root` or a folder inside it. */
function holds(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)
}

type FetchRecentProjects = (serverId: string) => Promise<RecentProject[]>

/** The hosts a removal asks. */
export interface UntrackHosts {
  isConnected(serverId: string): boolean
  untrackProject(serverId: string, path: string): Promise<void>
}

const liveUntrackHosts: UntrackHosts = {
  isConnected: (serverId) => serverConnections.statusFor(serverId) === 'connected',
  untrackProject: (serverId, path) => serverConnections.apiFor(serverId).untrackProject(path),
}

async function fetchHostRecentProjects(serverId: string): Promise<RecentProject[]> {
  if (!serverConnections.localServerId() && serverId === LOCAL_SERVER_ID) return []
  return serverConnections.withTemporaryConnection(serverId, (api) => api.listRecentProjects())
}

/**
 * The project lists of every host, and their recent folders. Each host's list
 * is the only record of which folders are projects (docs/plans/project-model.md
 * §2); this store holds the last list read from each, so a host that is away
 * still names and groups its projects.
 */
export class ProjectsStore {
  private readonly projectsByHost = new SvelteMap<string, ProjectEntry[]>()
  private readonly projectsLoadedByHost = new SvelteMap<string, boolean>()
  private readonly projectsLoadingByHost = new SvelteMap<string, boolean>()
  private readonly projectLoadsByHost = new Map<string, Promise<ProjectEntry[]>>()
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    stored: StoredHostList[] = loadStoredLists(),
    private readonly fetchRecentProjects: FetchRecentProjects = fetchHostRecentProjects,
    private readonly untrackHosts: UntrackHosts = liveUntrackHosts,
  ) {
    for (const host of stored) this.projectsByHost.set(host.serverId, host.projects)
  }

  /** Every checkout on every host, most recently used first. */
  get entries(): ProjectCatalogEntry[] {
    const entries: ProjectCatalogEntry[] = []
    for (const [serverId, projects] of this.projectsByHost) {
      for (const project of projects) entries.push(checkoutOf(serverId, project))
    }
    return entries.sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  }

  /** Every project the pages list: checkouts grouped by repository, with the
   *  organization's cloud projects joined (docs/plans/project-model.md). */
  logicalProjects(cloudProjects: readonly WorkspaceProject[]): LogicalProject[] {
    return groupLogicalProjects(this.entries, cloudProjects)
  }

  /** The listed checkout that is this folder or holds it (a worktree or a
   *  subfolder), the innermost when lists nest. */
  private checkoutHolding(serverId: string, path: string): ProjectCatalogEntry | null {
    const folder = normalizeProjectRoot(path)
    let found: ProjectEntry | null = null
    for (const project of this.projectsFor(serverId)) {
      if (holds(project.path, folder) && (!found || project.path.length > found.path.length)) found = project
    }
    return found ? checkoutOf(serverId, found) : null
  }

  /** The project a folder on a host belongs to (docs/plans/project-model.md
   *  §3): the listed project that is it or holds it, else the repository a
   *  dispatch clone names, else the folder itself as a local-only project. A
   *  path alone never names a project across hosts. */
  projectKeyFor(serverId: string, path: string): string {
    const checkout = this.checkoutHolding(serverId, path)
    return checkout ? logicalProjectKeyFor(checkout) : projectKeyOf({ serverId, path: normalizeProjectRoot(path) })
  }

  /** The repository a folder on a host holds, or null when its host lists no
   *  project holding it or that project has no hosted remote. */
  repositoryKeyFor(serverId: string, path: string): string | null {
    return this.checkoutHolding(serverId, path)?.repositoryKey ?? null
  }

  /** The checkouts of one project across hosts, most recently used first. */
  checkoutsOf(projectKey: string): ProjectCatalogEntry[] {
    return this.entries.filter((entry) => logicalProjectKeyFor(entry) === projectKey)
  }

  /** The folder that holds a project on one host: its listed checkout there,
   *  or the folder a local-only key names on it. Null when the host holds none. */
  checkoutPathOn(serverId: string, projectKey: string): string | null {
    const checkout = this.checkoutsOf(projectKey).find((entry) => entry.serverId === serverId)
    if (checkout) return checkout.projectRoot
    const local = localProjectParts(projectKey)
    return local?.serverId === serverId ? local.path : null
  }

  /** Read each execution host's list as it connects and whenever it says the
   *  list changed. Returns the unsubscribe. */
  listen(isExecutionHost: (serverId: string) => boolean): () => void {
    const load = (serverId: string) => {
      if (!isExecutionHost(serverId)) return
      void this.loadProjectsFor(serverId, serverConnections.apiFor(serverId), { force: true })
    }
    for (const serverId of serverConnections.connectedServerIds()) load(serverId)
    const unsubStatus = serverConnections.onStatusChange((serverId, status) => {
      if (status === 'connected') load(serverConnections.resolveId(serverId))
    })
    const unsubChanged = subscribeAllHosts('projects.changed', (serverId) => load(serverId))
    return () => {
      unsubStatus()
      unsubChanged()
    }
  }

  /** The host's list as last read: live once it has answered, else the copy
   *  kept from an earlier read. */
  projectsFor(serverId: string): ProjectEntry[] {
    return this.projectsByHost.get(serverId) ?? []
  }

  /** Whether the host has answered since this client started. */
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
        // A superseded read cannot replace newer state.
        if (this.projectLoadsByHost.get(serverId) !== promise) return this.projectsFor(serverId)
        this.setProjects(serverId, projects)
        this.projectsLoadedByHost.set(serverId, true)
        return projects
      })
      // A host that cannot answer keeps the list it last gave.
      .catch(() => this.projectsFor(serverId))
      .finally(() => {
        if (this.projectLoadsByHost.get(serverId) !== promise) return
        this.projectLoadsByHost.delete(serverId)
        this.projectsLoadingByHost.set(serverId, false)
      })
    this.projectLoadsByHost.set(serverId, promise)
    return promise
  }

  /**
   * The one way a folder becomes a project: a person opened, cloned, or added
   * it. The host records it; this client lists it at once, then reads the
   * host's list, which decides: the host's entry names the repository, and a
   * host that refused drops the folder again. Running a session in a folder
   * does not add it.
   */
  addProject(
    serverId: string,
    api: Pick<HostApi, 'trackRecentProject' | 'listProjects'>,
    path: string,
  ): ProjectRef | null {
    const projectRoot = normalizeProjectRoot(path)
    if (!serverId || !projectRoot || projectRoot === '~' || isRemoteDispatchCheckoutPath(projectRoot)) return null
    const now = new Date().toISOString()
    this.setProjects(serverId, [
      // The host's own entry replaces this one on the next read; it names the
      // repository, which this client cannot.
      { key: '', path: projectRoot, folderName: projectDirLabel(projectRoot), addedAt: now, lastUsedAt: now, repositoryKey: null },
      ...this.projectsFor(serverId).filter((project) => project.path !== projectRoot),
    ])
    void api.trackRecentProject(projectRoot)
      .catch(() => {})
      .then(() => this.loadProjectsFor(serverId, api, { force: true }))
      .then(() => this.invalidateRecentProjects(serverId))
    return { serverId, projectRoot }
  }

  /**
   * Take every checkout of one project off its host's list (`untrackProject`).
   * Nothing else is deleted: tasks, sessions and files stay. A host that is
   * away, or that refuses, keeps its checkout listed: the list shows what the
   * hosts hold.
   */
  async removeProject(projectKey: string): Promise<void> {
    await Promise.all(this.checkoutsOf(projectKey).map(async (checkout) => {
      if (!this.untrackHosts.isConnected(checkout.serverId)) return
      try {
        await this.untrackHosts.untrackProject(checkout.serverId, checkout.projectRoot)
      } catch {
        return
      }
      this.setProjects(checkout.serverId, this.projectsFor(checkout.serverId).filter((project) => project.path !== checkout.projectRoot))
    }))
  }

  async deleteProjectFor(
    serverId: string,
    api: Pick<HostApi, 'deleteProject'>,
    path: string,
  ): Promise<void> {
    await api.deleteProject(path)
    this.setProjects(serverId, this.projectsFor(serverId).filter((project) => project.path !== path))
  }

  private setProjects(serverId: string, projects: ProjectEntry[]): void {
    this.projectsByHost.set(serverId, projects)
    if (!this.saveTimer) this.saveTimer = setTimeout(() => this.flush(), 400)
  }

  /** Write the kept lists now instead of waiting for the debounce: on page
   *  hide, and from tests that read the stored copy. */
  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    try {
      const hosts: StoredHostList[] = [...this.projectsByHost].map(([serverId, projects]) => ({ serverId, projects }))
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, hosts }))
    } catch {}
  }

  private readonly recentByHost = new SvelteMap<string, RecentProject[]>()
  private readonly recentExpiresAt = new Map<string, number>()
  private readonly recentLoads = new Map<string, Promise<RecentProject[]>>()
  private readonly recentLoading = new SvelteMap<string, boolean>()

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
