import type { ProjectConfig } from '../../../shared/types'
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
  server.register('deleteProject', (args) => {
    const [projectPath] = args as [string]
    return deleteProject(projectPath)
  })
}
