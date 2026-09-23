import type { WorkspaceProject, WorkspaceProjectPatch } from '@solus/contracts/workspace-projects'
import { serverConnections } from '@solus/client-core/server-connections'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import { SvelteMap } from 'svelte/reactivity'

/**
 * The organization's projects, read from its workspace service
 * (docs/plans/project-model.md §2). One list per workspace connection; the
 * pages read the list of the organization the account is working in.
 */
export class WorkspaceProjectsStore {
  private readonly projectsByServer = new SvelteMap<string, WorkspaceProject[]>()
  private readonly loads = new Map<string, Promise<WorkspaceProject[]>>()

  projectsFor(serverId: string | null | undefined): WorkspaceProject[] {
    return serverId ? this.projectsByServer.get(serverId) ?? [] : []
  }

  /** Whether this workspace service has answered at least once. */
  hasLoaded(serverId: string | null | undefined): boolean {
    return !!serverId && this.projectsByServer.has(serverId)
  }

  /** The cloud project for a repository, when the organization has one. */
  projectFor(serverId: string | null | undefined, repositoryKey: string | null | undefined): WorkspaceProject | null {
    if (!repositoryKey) return null
    return this.projectsFor(serverId).find((project) => project.repositoryKey === repositoryKey) ?? null
  }

  load(serverId: string, opts: { force?: boolean } = {}): Promise<WorkspaceProject[]> {
    const pending = this.loads.get(serverId)
    if (pending && !opts.force) return pending
    const promise = serverConnections.apiFor(serverId).workspaceProjectList()
      .then((projects) => {
        if (this.loads.get(serverId) === promise) this.projectsByServer.set(serverId, projects)
        return projects
      })
      // The last list stays: a service that cannot answer is not an empty directory.
      .catch(() => this.projectsFor(serverId))
      .finally(() => {
        if (this.loads.get(serverId) === promise) this.loads.delete(serverId)
      })
    this.loads.set(serverId, promise)
    return promise
  }

  async add(serverId: string, repositoryKey: string, displayName?: string): Promise<WorkspaceProject> {
    const project = await serverConnections.apiFor(serverId).workspaceProjectAdd({ repositoryKey, displayName })
    const current = this.projectsFor(serverId)
    if (!current.some((existing) => existing.id === project.id)) this.projectsByServer.set(serverId, [...current, project])
    return project
  }

  async update(serverId: string, projectId: string, patch: WorkspaceProjectPatch): Promise<WorkspaceProject> {
    const project = await serverConnections.apiFor(serverId).workspaceProjectUpdate(projectId, patch)
    this.projectsByServer.set(serverId, this.projectsFor(serverId).map((existing) => existing.id === project.id ? project : existing))
    return project
  }

  async remove(serverId: string, projectId: string): Promise<void> {
    await serverConnections.apiFor(serverId).workspaceProjectRemove(projectId)
    this.projectsByServer.set(serverId, this.projectsFor(serverId).filter((project) => project.id !== projectId))
  }

  /** Load each workspace service's list as it connects, and reload it when
   *  another client changes it. Returns the unsubscribe. */
  listen(isWorkspaceService: (serverId: string) => boolean): () => void {
    for (const serverId of serverConnections.connectedServerIds()) {
      if (isWorkspaceService(serverId)) void this.load(serverId)
    }
    const unsubStatus = serverConnections.onStatusChange((serverId, status) => {
      const resolved = serverConnections.resolveId(serverId)
      if (status === 'connected' && isWorkspaceService(resolved)) void this.load(resolved, { force: true })
    })
    const unsubChanged = subscribeAllHosts('workspaceProjects.changed', (serverId) => {
      if (isWorkspaceService(serverId)) void this.load(serverId, { force: true })
    })
    return () => {
      unsubStatus()
      unsubChanged()
    }
  }
}

export const workspaceProjectsStore = new WorkspaceProjectsStore()
