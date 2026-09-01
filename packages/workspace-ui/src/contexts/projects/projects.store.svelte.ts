import type { ProjectEntry, RecentProject } from '@solus/contracts/types'
import { serverConnections } from '@solus/client-core/server-connections'
import type { HostApi } from '@solus/client-core/host-api'
import { SvelteMap } from 'svelte/reactivity'
import { projectCatalog } from './project-catalog.store.svelte'
import { normalizeProjectRoot, type ProjectRef } from './project-catalog'
import { projectDirLabel } from '../../lib/paths'

export class ProjectsStore {
  // The unqualified fields remain the single-host cache used by the directory
  // picker; callers name the host that fills it. The Settings tab uses the
  // qualified cache below.
  projects = $state<ProjectEntry[]>([])
  projectsLoaded = $state(false)
  projectsLoading = $state(false)
  recentProjects = $state<RecentProject[]>([])
  recentProjectsLoaded = $state(false)
  recentProjectsLoading = $state(false)
  recentVersion = $state(0)

  private projectsInFlight: Promise<ProjectEntry[]> | null = null
  private recentProjectsInFlight: Promise<RecentProject[]> | null = null
  private readonly projectsByHost = new SvelteMap<string, ProjectEntry[]>()
  private readonly projectsLoadedByHost = new SvelteMap<string, boolean>()
  private readonly projectsLoadingByHost = new SvelteMap<string, boolean>()
  private readonly projectLoadsByHost = new Map<string, Promise<ProjectEntry[]>>()

  async loadProjects(serverId: string, opts: { force?: boolean } = {}): Promise<ProjectEntry[]> {
    if (this.projectsLoaded && !opts.force) return this.projects
    if (this.projectsInFlight && !opts.force) return this.projectsInFlight

    this.projectsLoading = true
    const promise = serverConnections.apiFor(serverId)
      .listProjects()
      .then((projects) => {
        this.projects = projects
        this.projectsLoaded = true
        return projects
      })
      .catch(() => {
        this.projects = []
        this.projectsLoaded = true
        const empty: ProjectEntry[] = []
        return empty
      })
      .finally(() => {
        this.projectsLoading = false
        if (this.projectsInFlight === promise) this.projectsInFlight = null
      })
    this.projectsInFlight = promise
    return promise
  }

  async deleteProject(serverId: string, path: string): Promise<void> {
    await serverConnections.apiFor(serverId).deleteProject(path)
    this.projects = this.projects.filter((project) => project.path !== path)
    this.projectsLoaded = true
  }

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

  async loadRecentProjects(serverId: string, opts: { force?: boolean } = {}): Promise<RecentProject[]> {
    if (this.recentProjectsLoaded && !opts.force) return this.recentProjects
    if (this.recentProjectsInFlight && !opts.force) return this.recentProjectsInFlight

    this.recentProjectsLoading = true
    const promise = serverConnections.apiFor(serverId)
      .listRecentProjects()
      .then((projects) => {
        this.recentProjects = projects
        this.recentProjectsLoaded = true
        return projects
      })
      .catch(() => {
        this.recentProjects = []
        this.recentProjectsLoaded = true
        const empty: RecentProject[] = []
        return empty
      })
      .finally(() => {
        this.recentProjectsLoading = false
        if (this.recentProjectsInFlight === promise) this.recentProjectsInFlight = null
      })
    this.recentProjectsInFlight = promise
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
    return project
  }

  /** Record a project immediately on the client. Opening a folder already
   * tracks it on the host through the session path; this synchronous half keeps
   * every page picker correct before a session starts. */
  recordProject(serverId: string, path: string): ProjectRef | null {
    const projectRoot = normalizeProjectRoot(path)
    if (!serverId || !projectRoot || projectRoot === '~') return null
    const project = { serverId, projectRoot }
    projectCatalog.record(project, projectDirLabel(projectRoot, null))
    this.invalidateRecentProjects()
    return project
  }

  invalidateRecentProjects(): void {
    this.recentProjectsInFlight = null
    this.recentProjectsLoaded = false
    this.recentVersion++
  }
}

export const projectsStore = new ProjectsStore()
