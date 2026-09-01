import { listProjectIdentities } from '../../project-config/project-identities'
import { loadProjectConfig, saveProjectConfig } from '../../project-config/project-config'
import { deleteProject, listProjects, recordProject } from '../../project-config/projects-manifest'
import type { SolusServer } from '../server'

export function registerProjectConfigHandlers(server: SolusServer): void {
  server.register('projectConfigLoad', (args) => {
    const [cwd] = args
    return loadProjectConfig(cwd)
  })
  server.register('projectConfigSave', async (args) => {
    const [cwd, config] = args
    const saved = await saveProjectConfig(cwd, config)
    await recordProject(cwd).catch(() => {})
    return saved
  })
  server.register('listProjects', () => listProjects())
  server.register('listProjectIdentities', () => listProjectIdentities())
  server.register('deleteProject', (args) => {
    const [projectPath] = args
    return deleteProject(projectPath)
  })
}
