import { listProjectIdentities } from '../../project-config/project-identities'
import { loadProjectConfig, saveProjectConfig } from '../../project-config/project-config'
import { deleteProject, listProjects, recordProject } from '../../project-config/projects-manifest'
import type { SolusServer } from '../server'
import { projectsVisibleTo } from './setup-handlers'

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
  // A member's listings are their own workspace (managed-hosts.md §3): a project
  // the picker offers is one they may clone into or open as theirs.
  server.register('listProjects', async (_args, ctx) => projectsVisibleTo(ctx.principal, await listProjects()))
  server.register('listProjectIdentities', async (_args, ctx) => projectsVisibleTo(ctx.principal, await listProjectIdentities()))
  server.register('deleteProject', (args) => {
    const [projectPath] = args
    return deleteProject(projectPath)
  })
}
