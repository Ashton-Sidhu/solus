import { listProjectIdentities } from '../../project-config/project-identities'
import { loadProjectConfig, saveProjectConfig } from '../../project-config/project-config'
import { deleteProject, listProjects, recordProject } from '../../project-config/projects-manifest'
import type { SolusServer } from '../server'
import { resolveRepositoryKey } from '../../git/git-helpers'
import { addWorkspaceProject, listWorkspaceProjects, removeWorkspaceProject, updateWorkspaceProject } from '../../projects/workspace-projects'
import { organizationOf } from '../principal'
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
  // Each entry names its repository, so a client groups checkouts of one
  // project across hosts by what they are, not by where they sit.
  server.register('listProjects', async (_args, ctx) => {
    const visible = projectsVisibleTo(ctx.principal, await listProjects())
    return Promise.all(visible.map(async (project) => ({
      ...project,
      repositoryKey: await resolveRepositoryKey(project.path),
    })))
  })
  server.register('listProjectIdentities', async (_args, ctx) => projectsVisibleTo(ctx.principal, await listProjectIdentities()))
  // The organization's project directory (docs/plans/project-model.md §2).
  // Every member reads and adds; a project is found by its repository, so an
  // add is safe to repeat.
  server.register('workspaceProjectList', async (_args, ctx) => listWorkspaceProjects(organizationOf(ctx.principal)))
  server.register('workspaceProjectAdd', async (args, ctx) => {
    const [request] = args
    const author = ctx.principal.kind === 'org-member' ? ctx.principal.userId : null
    return addWorkspaceProject(organizationOf(ctx.principal), request, author)
  })
  server.register('workspaceProjectUpdate', async (args, ctx) => {
    const [projectId, patch] = args
    return updateWorkspaceProject(organizationOf(ctx.principal), projectId, patch)
  })
  server.register('workspaceProjectRemove', async (args, ctx) => {
    const [projectId] = args
    await removeWorkspaceProject(organizationOf(ctx.principal), projectId)
  })
  server.register('deleteProject', (args) => {
    const [projectPath] = args
    return deleteProject(projectPath)
  })
}
