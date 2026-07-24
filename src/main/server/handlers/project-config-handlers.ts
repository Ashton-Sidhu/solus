import type { ProjectConfig, ProjectIdentity } from '../../../shared/types'
import { resolveRepoRef } from '../../git/git-helpers'
import { loadProjectConfig, saveProjectConfig } from '../../project-config/project-config'
import { deleteProject, listProjects, recordProject } from '../../project-config/projects-manifest'
import { invalidateTaskProvider } from '../../tasks/task-service'
import type { SolusServer } from '../server'

export function registerProjectConfigHandlers(server: SolusServer): void {
  server.register('projectConfigLoad', (args) => {
    const [cwd] = args as [string]
    return loadProjectConfig(cwd)
  })
  server.register('projectConfigSave', async (args) => {
    const [cwd, config] = args as [string, ProjectConfig]
    const saved = await saveProjectConfig(cwd, config)
    // The task provider binding may have changed (provider switched, remote
    // fixed) — drop the cached instance so the next call re-resolves it.
    invalidateTaskProvider(cwd)
    await recordProject(cwd).catch(() => {})
    return saved
  })
  server.register('listProjects', () => listProjects())
  server.register('listProjectIdentities', async () => {
    const projects = await listProjects()
    const identities = await Promise.all(projects.map(async (project): Promise<ProjectIdentity | null> => {
      const repo = await resolveRepoRef(project.path)
      if (!repo) return null
      return {
        path: project.path,
        folderName: project.folderName,
        repoKey: `${repo.host}/${repo.owner}/${repo.repo}`.toLowerCase(),
      }
    }))
    return identities.filter((identity): identity is ProjectIdentity => identity !== null)
  })
  server.register('deleteProject', (args) => {
    const [projectPath] = args as [string]
    return deleteProject(projectPath)
  })
}
