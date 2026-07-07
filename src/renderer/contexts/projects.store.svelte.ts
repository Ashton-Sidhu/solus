import type { ProjectEntry, RecentProject } from '../../shared/types'

export class ProjectsStore {
  projects = $state<ProjectEntry[]>([])
  projectsLoaded = $state(false)
  projectsLoading = $state(false)
  recentProjects = $state<RecentProject[]>([])
  recentProjectsLoaded = $state(false)
  recentProjectsLoading = $state(false)
  recentVersion = $state(0)

  private projectsInFlight: Promise<ProjectEntry[]> | null = null
  private recentProjectsInFlight: Promise<RecentProject[]> | null = null

  async loadProjects(opts: { force?: boolean } = {}): Promise<ProjectEntry[]> {
    if (this.projectsLoaded && !opts.force) return this.projects
    if (this.projectsInFlight && !opts.force) return this.projectsInFlight

    this.projectsLoading = true
    const promise = window.solus
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
    await window.solus.deleteProject(path)
    this.projects = this.projects.filter((project) => project.path !== path)
    this.projectsLoaded = true
  }

  async loadRecentProjects(opts: { force?: boolean } = {}): Promise<RecentProject[]> {
    if (this.recentProjectsLoaded && !opts.force) return this.recentProjects
    if (this.recentProjectsInFlight && !opts.force) return this.recentProjectsInFlight

    this.recentProjectsLoading = true
    const promise = window.solus
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
