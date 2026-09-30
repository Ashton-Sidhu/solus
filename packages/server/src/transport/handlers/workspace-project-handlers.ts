import type { SolusServer } from '../server'
import { addWorkspaceProject, listWorkspaceProjects, removeWorkspaceProject, updateWorkspaceProject } from '../../projects/workspace-projects'
import { organizationForNew, recordScopeOf } from '../../admission/principal'

export function registerWorkspaceProjectHandlers(server: SolusServer): void {
  // The organization's project directory (docs/plans/project-model.md §2).
  // Every member reads and adds; a project is found by its repository, so an
  // add is safe to repeat.
  server.register('workspaceProjectList', async (_args, ctx) => listWorkspaceProjects(recordScopeOf(ctx.principal)))
  server.register('workspaceProjectAdd', async (args, ctx) => {
    const [request] = args
    const author = ctx.principal.kind === 'org-member' ? ctx.principal.userId : null
    return addWorkspaceProject(organizationForNew(ctx.principal), request, author)
  })
  server.register('workspaceProjectUpdate', async (args, ctx) => {
    const [projectId, patch] = args
    return updateWorkspaceProject(recordScopeOf(ctx.principal), projectId, patch)
  })
  server.register('workspaceProjectRemove', async (args, ctx) => {
    const [projectId] = args
    await removeWorkspaceProject(recordScopeOf(ctx.principal), projectId)
  })
}
