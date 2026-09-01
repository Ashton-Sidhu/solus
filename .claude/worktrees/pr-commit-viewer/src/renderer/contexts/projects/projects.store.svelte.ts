import type { ProjectEntry, RecentProject } from '../../../shared/types'
import { serverConnections } from '@client-core/server-connections'
import type { HostApi } from '@client-core/host-api'
import { SvelteMap } from 'svelte/reactivity'

export class ProjectsStore {
  // The unqualified fields remain the primary-host cache used by the directory
  // picker. The Settings tab uses the qualified cache below.
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

  async loadProjects(opts: { force?: boolean } = {}): Promise<ProjectEntry[]> {
    if (this.projectsLoaded && !opts.force) return this.projects
    if (this.projectsInFlight && !opts.force) return this.projectsInFlight

    this.projectsLoading = true
    const promise = serverConnections.primaryApi()
      .listProjects()
      .then((projects) => {
        this.projects = projects
        this.projectsLoaded = true
        return projects
      })
      .catch(() => {
        this.projects = []
        this.projectsLoaded = true
        return [] as ProjectEntry[]
      })
      .finally(() => {
        this.projectsLoading = false
        if (this.projectsInFlight === promise) this.projectsInFlight = null
      })
    this.projectsInFlight = promise
    return promise
  }

  async deleteProject(path: string): Promise<void> {
    await serverConnections.primaryApi().deleteProject(path)
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
        return [] as ProjectEntry[]
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

  async loadRecentProjects(opts: { force?: boolean } = {}): Promise<RecentProject[]> {
    if (this.recentProjectsLoaded && !opts.force) return this.recentProjects
    if (this.recentProjectsInFlight && !opts.force) return this.recentProjectsInFlight

    this.recentProjectsLoading = true
    const promise = serverConnections.primaryApi()
      .listRecentProjects()
      .then((projects) => {
        this.recentProjects = projects
        this.recentProjectsLoaded = true
        return projects
      })
      .catch(() => {
        this.recentProjects = []
        this.recentProjectsLoaded = true
        return [] as RecentProject[]
      })
      .finally(() => {
        this.recentProjectsLoading = false
        if (this.recentProjectsInFlight === promise) this.recentProjectsInFlight = null
      })
    this.recentProjectsInFlight = promise
    return promise
  }

  invalidateRecentProjects(): void {
    this.recentProjectsInFlight = null
    this.recentProjectsLoaded = false
    this.recentVersion++
  }
}

export const projectsStore = new ProjectsStore()
